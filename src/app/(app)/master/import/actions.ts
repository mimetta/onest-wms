"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  ACCCLOUD_COLUMNS,
  DEFAULT_NON_STOCK_GROUPS,
  REQUIRED_COLUMNS,
  mapRow,
  summariseGroups,
  summariseUnknownUoms,
  type MappedProduct,
  type RawRow,
} from "@/lib/import/acccloud-products";
import type { ActionResult } from "@/app/(app)/documents/actions";

export type UploadResult = {
  batchId: string;
  filename: string;
  rowCount: number;
  groups: { code: string; name: string; rows: number; included: boolean }[];
  unknownUoms: { value: string; rows: number }[];
  alreadyImported: boolean;
};

/**
 * Parse the file and record it, mapping nothing yet.
 *
 * Upload and interpretation are separate steps on purpose. The raw rows are
 * stored verbatim in erp_import_rows.raw, so the mapping can be re-run with a
 * different group selection without re-uploading, and so a disagreement later
 * can be settled by looking at what the file actually said rather than at what
 * we concluded.
 */
export async function uploadCsv(formData: FormData): Promise<ActionResult<UploadResult>> {
  const user = await requirePerm("master_data.create");
  const supabase = await createClient();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "noFile" };
  }

  const text = await file.text();

  // Papa rather than a hand-rolled split: 50 of the export's 731 rows carry
  // newlines inside quoted fields, so splitting on newlines would produce
  // hundreds of half-rows and quietly corrupt the item master.
  const parsed = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    // The BOM otherwise stays glued to the first header, making that column
    // unfindable by name.
    transformHeader: (h) => h.replace(/^﻿/, "").trim(),
  });

  const rows = parsed.data.filter((r) =>
    Object.values(r).some((v) => (v ?? "").toString().trim() !== ""),
  );

  if (rows.length === 0) return { ok: false, error: "emptyFile" };

  const headers = Object.keys(rows[0]);
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return { ok: false, error: "missingColumns", detail: missing.join(", ") };
  }

  // Hashing the content, not the name: the same export saved twice under
  // different names is the same import, and re-importing it by accident is a
  // thing that happens at 7am on go-live day.
  const fileHash = createHash("sha256").update(text).digest("hex");

  const { data: prior } = await supabase
    .from("erp_import_batches")
    .select("id, status")
    .eq("file_hash", fileHash)
    .eq("status", "committed")
    .limit(1)
    .maybeSingle();

  const { data: batch, error } = await supabase
    .from("erp_import_batches")
    .insert({
      source: "csv",
      entity_type: "product",
      filename: file.name,
      file_hash: fileHash,
      // The preset is recorded on the batch, so what a past import meant by
      // each column is answerable later without guessing.
      column_mapping: ACCCLOUD_COLUMNS as unknown as Record<string, string>,
      status: "uploaded",
      uploaded_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  // Inserted in chunks: 731 rows in one statement is fine, but the same code
  // path has to survive a 20,000-row export later without a payload limit.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((raw, n) => ({
      batch_id: batch.id,
      row_no: i + n + 1,
      raw,
      action: "skip" as const,
    }));

    const { error: rowError } = await supabase.from("erp_import_rows").insert(chunk);
    if (rowError) {
      await supabase
        .from("erp_import_batches")
        .update({ status: "failed", error_text: rowError.message })
        .eq("id", batch.id);
      return { ok: false, error: "errorSave", detail: rowError.message };
    }
  }

  const defaultIncluded = new Set(
    summariseGroups(rows, new Set())
      .map((g) => g.code)
      .filter((c) => !DEFAULT_NON_STOCK_GROUPS.includes(c)),
  );

  return {
    ok: true,
    data: {
      batchId: batch.id,
      filename: file.name,
      rowCount: rows.length,
      groups: summariseGroups(rows, defaultIncluded),
      unknownUoms: summariseUnknownUoms(rows),
      alreadyImported: Boolean(prior),
    },
  };
}

export type PreviewRow = {
  rowNo: number;
  action: "create" | "update" | "skip" | "error";
  sku: string;
  nameTh: string;
  uomCode: string;
  groupCode: string;
  isActive: boolean;
  cost: number | null;
  detail: string | null;
  /** Fields that differ from what the WMS already holds, for an update. */
  changes: string[];
};

export type PreviewResult = {
  create: number;
  update: number;
  excluded: number;
  error: number;
  withCost: number;
  inactive: number;
  uomFrozen: number;
  rows: PreviewRow[];
};

/**
 * Work out what committing would do, and write that decision onto every row.
 *
 * Nothing is applied here. The point of a preview is that a human sees the plan
 * before the item master changes, and the plan is stored rather than recomputed
 * so the thing they approved is the thing that runs.
 */
export async function previewBatch(
  batchId: string,
  includedGroups: string[],
): Promise<ActionResult<PreviewResult>> {
  await requirePerm("master_data.create");
  const supabase = await createClient();

  const { data: rowData, error } = await supabase
    .from("erp_import_rows")
    .select("id, row_no, raw")
    .eq("batch_id", batchId)
    .order("row_no");

  if (error) return { ok: false, error: "errorLoad", detail: error.message };

  const included = new Set(includedGroups);
  const mapped: { id: string; rowNo: number; product: MappedProduct }[] = [];
  const preview: PreviewRow[] = [];
  const updates: {
    id: string;
    action: PreviewRow["action"];
    mapped: MappedProduct | null;
    matched_on: string | null;
    target_id: string | null;
    error_text: string | null;
  }[] = [];

  for (const row of rowData ?? []) {
    const outcome = mapRow(row.raw as RawRow, included);

    if (outcome.kind === "error") {
      preview.push({
        rowNo: row.row_no,
        action: "error",
        sku: ((row.raw as RawRow)[ACCCLOUD_COLUMNS.itemCode] ?? "").trim(),
        nameTh: "",
        uomCode: "",
        groupCode: "",
        isActive: false,
        cost: null,
        detail: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason,
        changes: [],
      });
      updates.push({
        id: row.id,
        action: "error",
        mapped: null,
        matched_on: null,
        target_id: null,
        error_text: outcome.detail
          ? `${outcome.reason}: ${outcome.detail}`
          : outcome.reason,
      });
      continue;
    }

    if (outcome.kind === "excluded") {
      updates.push({
        id: row.id,
        action: "skip",
        mapped: null,
        matched_on: null,
        target_id: null,
        error_text: null,
      });
      continue;
    }

    mapped.push({ id: row.id, rowNo: row.row_no, product: outcome.product });
  }

  // Existing products, looked up in one query rather than per row.
  const codes = mapped.map((m) => m.product.acccloudItemCode);
  const existing = new Map<
    string,
    { id: string; base_uom: string | null; has_movements: boolean }
  >();

  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await supabase
      .from("products")
      .select("id, acccloud_item_code, base_uom_id, uoms:base_uom_id(code)")
      .in("acccloud_item_code", codes.slice(i, i + 200));

    for (const p of data ?? []) {
      existing.set(p.acccloud_item_code as string, {
        id: p.id,
        base_uom: (p.uoms as unknown as { code: string } | null)?.code ?? null,
        has_movements: false,
      });
    }
  }

  // Which of those have ever moved. A product with movements cannot have its
  // base unit changed — every historical quantity is denominated in it, so
  // switching KG to GRAM would silently multiply the ledger by a thousand.
  const existingIds = [...existing.values()].map((e) => e.id);
  if (existingIds.length > 0) {
    for (let i = 0; i < existingIds.length; i += 200) {
      const { data } = await supabase
        .from("stock_movements")
        .select("product_id")
        .in("product_id", existingIds.slice(i, i + 200));

      const moved = new Set((data ?? []).map((m) => m.product_id));
      for (const e of existing.values()) if (moved.has(e.id)) e.has_movements = true;
    }
  }

  let uomFrozen = 0;

  for (const m of mapped) {
    const prior = existing.get(m.product.acccloudItemCode);
    const changes: string[] = [];
    let action: PreviewRow["action"] = "create";
    let errorText: string | null = null;

    if (prior) {
      action = "update";
      if (prior.base_uom && prior.base_uom !== m.product.uomCode) {
        if (prior.has_movements) {
          // Refused rather than applied: the ledger is denominated in the old
          // unit and cannot be retro-converted (D-66).
          action = "error";
          errorText = `uomChangeBlocked: ${prior.base_uom} → ${m.product.uomCode}`;
          uomFrozen += 1;
        } else {
          changes.push(`uom ${prior.base_uom} → ${m.product.uomCode}`);
        }
      }
    }

    preview.push({
      rowNo: m.rowNo,
      action,
      sku: m.product.sku,
      nameTh: m.product.nameTh,
      uomCode: m.product.uomCode,
      groupCode: m.product.groupCode,
      isActive: m.product.isActive,
      cost: m.product.standardCost,
      detail: errorText,
      changes,
    });

    updates.push({
      id: m.id,
      action,
      mapped: m.product,
      matched_on: prior ? "acccloud_item_code" : null,
      target_id: prior?.id ?? null,
      error_text: errorText,
    });
  }

  // Persist the plan per row, so commit applies what was previewed.
  for (const u of updates) {
    await supabase
      .from("erp_import_rows")
      .update({
        action: u.action,
        mapped: u.mapped as unknown as Record<string, unknown> | null,
        matched_on: u.matched_on,
        target_id: u.target_id,
        error_text: u.error_text,
      })
      .eq("id", u.id);
  }

  const result: PreviewResult = {
    create: preview.filter((p) => p.action === "create").length,
    update: preview.filter((p) => p.action === "update").length,
    excluded:
      (rowData ?? []).length -
      mapped.length -
      preview.filter((p) => p.action === "error").length,
    error: preview.filter((p) => p.action === "error").length,
    withCost: preview.filter((p) => p.cost !== null).length,
    inactive: preview.filter((p) => !p.isActive && p.action !== "error").length,
    uomFrozen,
    rows: preview.sort((a, b) => a.rowNo - b.rowNo),
  };

  await supabase
    .from("erp_import_batches")
    .update({
      status: "validated",
      stats: {
        ...result,
        rows: undefined,
        included_groups: includedGroups,
      } as unknown as Record<string, unknown>,
    })
    .eq("id", batchId);

  return { ok: true, data: result };
}

/**
 * Apply the previewed plan.
 *
 * Only rows the preview marked `create` or `update` are touched. Error rows are
 * left alone and remain visible on the batch — an import that silently dropped
 * the rows it could not understand would be worse than one that refuses them.
 */
export async function commitBatch(
  batchId: string,
): Promise<ActionResult<{ created: number; updated: number; priced: number }>> {
  const user = await requirePerm("master_data.create");
  const supabase = await createClient();

  const { data: batch } = await supabase
    .from("erp_import_batches")
    .select("status")
    .eq("id", batchId)
    .maybeSingle();

  if (!batch) return { ok: false, error: "notFound" };
  if (batch.status === "committed") return { ok: false, error: "alreadyCommitted" };
  if (batch.status !== "validated") return { ok: false, error: "previewFirst" };

  const { data: rows } = await supabase
    .from("erp_import_rows")
    .select("id, row_no, action, mapped, target_id")
    .eq("batch_id", batchId)
    .in("action", ["create", "update"])
    .order("row_no");

  if (!rows || rows.length === 0) return { ok: false, error: "nothingToApply" };

  // UOM and category lookups, resolved once.
  const { data: uomRows } = await supabase.from("uoms").select("id, code");
  const uomByCode = new Map((uomRows ?? []).map((u) => [u.code, u.id]));

  const products = rows.map((r) => r.mapped as unknown as MappedProduct);

  // Categories for the included groups, created if absent. The group is how the
  // business already classifies its items, so keeping it means the filter used
  // at import time stays visible afterwards.
  const groups = new Map(products.map((p) => [p.groupCode, p.groupName]));
  const { data: catRows } = await supabase
    .from("product_categories")
    .select("id, code")
    .in("code", [...groups.keys()]);

  const catByCode = new Map((catRows ?? []).map((c) => [c.code, c.id]));

  for (const [code, name] of groups) {
    if (catByCode.has(code)) continue;
    const { data: created } = await supabase
      .from("product_categories")
      .insert({ code, name_th: name, name_en: code })
      .select("id")
      .single();
    if (created) catByCode.set(code, created.id);
  }

  let created = 0;
  let updated = 0;
  let priced = 0;

  for (const row of rows) {
    const p = row.mapped as unknown as MappedProduct;
    const uomId = uomByCode.get(p.uomCode);
    if (!uomId) continue;

    if (row.action === "create") {
      const { data: newProduct, error } = await supabase
        .from("products")
        .insert({
          sku: p.sku,
          name_th: p.nameTh,
          name_en: p.nameEn,
          base_uom_id: uomId,
          category_id: catByCode.get(p.groupCode) ?? null,
          acccloud_item_code: p.acccloudItemCode,
          source: "acccloud",
          acccloud_linked_at: new Date().toISOString(),
          is_active: p.isActive,
          // requires_qc is deliberately NOT set from the file. The export's QC
          // column is 'N' on all 731 rows, so importing it would mark every
          // chemical as needing no inspection. QC routing is a WMS decision,
          // made per product after import (D-66).
        })
        .select("id")
        .single();

      if (error) {
        await supabase
          .from("erp_import_rows")
          .update({ action: "error", error_text: error.message })
          .eq("id", row.id);
        continue;
      }

      created += 1;
      if (p.standardCost !== null && newProduct) {
        await recordPrice(supabase, newProduct.id, p.standardCost, user.id);
        priced += 1;
      }
    } else if (row.target_id) {
      // Only the fields AccCloud owns. requires_qc, tracking_mode, min/max and
      // barcodes are WMS-side decisions and a re-import must not undo them
      // (D-33: AccCloud is the master for identity, the WMS for behaviour).
      const { error } = await supabase
        .from("products")
        .update({
          name_th: p.nameTh,
          name_en: p.nameEn,
          category_id: catByCode.get(p.groupCode) ?? null,
          is_active: p.isActive,
          source: "acccloud",
          acccloud_linked_at: new Date().toISOString(),
        })
        .eq("id", row.target_id);

      if (error) {
        await supabase
          .from("erp_import_rows")
          .update({ action: "error", error_text: error.message })
          .eq("id", row.id);
        continue;
      }

      updated += 1;
      if (p.standardCost !== null) {
        await recordPrice(supabase, row.target_id, p.standardCost, user.id);
        priced += 1;
      }
    }
  }

  await supabase
    .from("erp_import_batches")
    .update({
      status: "committed",
      committed_by: user.id,
      committed_at: new Date().toISOString(),
      stats: { created, updated, priced } as unknown as Record<string, unknown>,
    })
    .eq("id", batchId);

  revalidatePath("/master/products");
  revalidatePath("/master/import");
  return { ok: true, data: { created, updated, priced } };
}

/**
 * Append a standard cost.
 *
 * product_price_history is append-only (D-34), so this records what AccCloud
 * said today rather than overwriting what it said before. Only non-zero costs
 * reach here — a zero would read as "free" to anything valuing stock.
 */
async function recordPrice(
  supabase: Awaited<ReturnType<typeof createClient>>,
  productId: string,
  cost: number,
  userId: string,
) {
  await supabase.from("product_price_history").insert({
    product_id: productId,
    price: cost,
    source: "import",
    // effective_date defaults to bkk_today(); left to the database so an
    // import run late at night lands on the Bangkok day, not the UTC one.
    created_by: userId,
    note: "AccCloud ต้นทุนมาตรฐาน",
  });
}
