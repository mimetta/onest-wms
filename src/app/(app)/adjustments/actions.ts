"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveBarcode } from "@/lib/barcodes/resolve";
import type { ActionResult } from "../documents/actions";

export type ReasonOption = {
  id: string;
  code: string;
  nameTh: string;
  direction: "increase" | "decrease" | "both";
  isDisposal: boolean;
};

/** One thing in the scanned bin, as a candidate to adjust down. */
export type BinItem = {
  productId: string;
  sku: string;
  nameTh: string;
  lotId: string | null;
  lotNo: string | null;
  serialId: string | null;
  serialNo: string | null;
  qty: number;
  baseUomId: string;
  baseUomCode: string;
  qcStatus: string | null;
};

export type AdjustmentLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  qty: number;
  uomCode: string;
  /** Exactly one of these is set — the direction is a property of the line. */
  fromCode: string | null;
  toCode: string | null;
};

/**
 * Start an adjustment, or resume the open draft for this reason code.
 *
 * The reason code is fixed at creation rather than per line. An adjustment
 * answers "why did this stock change?", and a document mixing found-stock with
 * write-offs answers it twice, which is to say not at all.
 */
export async function ensureDraft(reasonCodeId: string): Promise<ActionResult<string>> {
  const user = await requirePerm("adjustment.create");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("adjustments")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .eq("reason_code_id", reasonCodeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("adjustments")
    .insert({
      warehouse_id: user.warehouseId,
      reason_code_id: reasonCodeId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

export async function setNotes(id: string, notes: string): Promise<ActionResult> {
  await requirePerm("adjustment.create");
  const supabase = await createClient();

  const { error } = await supabase
    .from("adjustments")
    .update({ notes: notes || null })
    .eq("id", id)
    .eq("status", "draft");

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true };
}

/**
 * Read back what is in a scanned bin.
 *
 * Uses `stock_on_hand`, not `stock_available`: an adjustment exists precisely to
 * correct stock wherever it sits, including QC hold and quarantine, which
 * availability excludes by design (D-13). No embedded selects — it is a VIEW
 * (D-55).
 */
export async function readBin(
  raw: string,
): Promise<ActionResult<{ locationId: string; code: string; items: BinItem[] }>> {
  const user = await requirePerm("adjustment.create");

  const resolved = await resolveBarcode(raw);
  if (resolved.kind !== "location") return { ok: false, error: "notABin" };

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("stock_on_hand")
    .select("product_id, lot_id, serial_id, qty")
    .eq("location_id", resolved.locationId)
    .eq("warehouse_id", user.warehouseId)
    .gt("qty", 0);

  if (error) return { ok: false, error: "errorLoad", detail: error.message };

  const rows = data ?? [];
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const lotIds = [...new Set(rows.map((r) => r.lot_id))].filter((v): v is string =>
    Boolean(v),
  );
  const serialIds = [...new Set(rows.map((r) => r.serial_id))].filter((v): v is string =>
    Boolean(v),
  );

  const [{ data: products }, { data: lots }, { data: serials }] = await Promise.all([
    productIds.length
      ? supabase
          .from("products")
          .select("id, sku, name_th, base_uom_id, uoms:base_uom_id(code)")
          .in("id", productIds)
      : Promise.resolve({ data: [] }),
    lotIds.length
      ? supabase.from("lots").select("id, lot_no, qc_status").in("id", lotIds)
      : Promise.resolve({ data: [] }),
    serialIds.length
      ? supabase.from("serials").select("id, serial_no").in("id", serialIds)
      : Promise.resolve({ data: [] }),
  ]);

  type ProductRow = {
    id: string;
    sku: string;
    name_th: string;
    base_uom_id: string;
    uoms: { code: string } | null;
  };

  const productById = new Map(
    ((products ?? []) as unknown as ProductRow[]).map((p) => [p.id, p]),
  );
  const lotById = new Map(
    ((lots ?? []) as { id: string; lot_no: string; qc_status: string }[]).map((l) => [
      l.id,
      l,
    ]),
  );
  const serialById = new Map(
    ((serials ?? []) as { id: string; serial_no: string }[]).map((s) => [s.id, s]),
  );

  const items: BinItem[] = rows.map((r) => {
    const product = productById.get(r.product_id);
    const lot = r.lot_id ? lotById.get(r.lot_id) : null;
    const serial = r.serial_id ? serialById.get(r.serial_id) : null;
    return {
      productId: r.product_id,
      sku: product?.sku ?? "",
      nameTh: product?.name_th ?? "",
      lotId: r.lot_id,
      lotNo: lot?.lot_no ?? null,
      serialId: r.serial_id,
      serialNo: serial?.serial_no ?? null,
      qty: Number(r.qty),
      baseUomId: product?.base_uom_id ?? "",
      baseUomCode: product?.uoms?.code ?? "",
      qcStatus: lot?.qc_status ?? null,
    };
  });

  return {
    ok: true,
    data: { locationId: resolved.locationId, code: resolved.code, items },
  };
}

/**
 * Add one line.
 *
 * The caller never supplies a direction or a sign. `direction` comes from the
 * document's reason code, and decides which endpoint the quantity hangs off:
 *
 *   increase → to_location   = the bin   (stock appears there)
 *   decrease → from_location = the bin   (stock leaves there)
 *
 * That is D-02's shape doing the work: quantity is always positive and the
 * meaning lives in the endpoints, so there is no sign for an operator to get
 * backwards and no negative number anywhere in the ledger.
 */
export async function addLine(input: {
  adjustmentId: string;
  productId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  uomId: string;
}): Promise<ActionResult<AdjustmentLine>> {
  await requirePerm("adjustment.create");
  const supabase = await createClient();

  if (!(input.qty > 0)) return { ok: false, error: "qtyPositive" };

  const { data: header } = await supabase
    .from("adjustments")
    .select("reason_code_id, adjustment_reasons(direction)")
    .eq("id", input.adjustmentId)
    .maybeSingle();

  if (!header) return { ok: false, error: "notFound" };

  const direction = (header.adjustment_reasons as unknown as { direction: string } | null)
    ?.direction;

  // 'both' is a reason code that has not made up its mind. Rather than guess a
  // direction, the screen refuses to use such a code for a line — the fix is a
  // properly directed reason code, which is master data, not a runtime choice.
  if (direction !== "increase" && direction !== "decrease") {
    return { ok: false, error: "reasonNeedsDirection" };
  }

  const { data: lastLine } = await supabase
    .from("adjustment_lines")
    .select("line_no")
    .eq("header_id", input.adjustmentId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: line, error } = await supabase
    .from("adjustment_lines")
    .insert({
      header_id: input.adjustmentId,
      line_no: (lastLine?.line_no ?? 0) + 1,
      product_id: input.productId,
      lot_id: input.lotId,
      serial_id: input.serialId,
      qty: input.qty,
      uom_id: input.uomId,
      from_location_id: direction === "decrease" ? input.locationId : null,
      to_location_id: direction === "increase" ? input.locationId : null,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [{ data: product }, { data: uom }, { data: location }, { data: lot }] =
    await Promise.all([
      supabase
        .from("products")
        .select("sku, name_th")
        .eq("id", input.productId)
        .maybeSingle(),
      supabase.from("uoms").select("code").eq("id", input.uomId).maybeSingle(),
      supabase.from("locations").select("code").eq("id", input.locationId).maybeSingle(),
      input.lotId
        ? supabase.from("lots").select("lot_no").eq("id", input.lotId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  revalidatePath("/adjustments");
  return {
    ok: true,
    data: {
      id: line.id,
      lineNo: line.line_no,
      sku: product?.sku ?? "",
      nameTh: product?.name_th ?? "",
      lotNo: (lot as { lot_no: string } | null)?.lot_no ?? null,
      qty: Number(line.qty),
      uomCode: uom?.code ?? "",
      fromCode: direction === "decrease" ? (location?.code ?? "") : null,
      toCode: direction === "increase" ? (location?.code ?? "") : null,
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("adjustment.create");
  const supabase = await createClient();

  const { error } = await supabase.from("adjustment_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/adjustments");
  return { ok: true };
}

/**
 * Products, for the increase case.
 *
 * A found-stock adjustment names something the ledger does not know is there, so
 * it cannot be picked from a bin listing — the whole point is that the bin
 * listing is wrong.
 */
export async function productOptions(): Promise<
  ActionResult<
    {
      id: string;
      sku: string;
      nameTh: string;
      baseUomId: string;
      baseUomCode: string;
      trackingMode: "none" | "lot" | "serial";
    }[]
  >
> {
  await requirePerm("adjustment.create");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("products")
    .select("id, sku, name_th, base_uom_id, tracking_mode, uoms:base_uom_id(code)")
    .eq("is_active", true)
    .order("sku");

  if (error) return { ok: false, error: "errorLoad", detail: error.message };

  return {
    ok: true,
    data: (data ?? []).map((p) => ({
      id: p.id,
      sku: p.sku,
      nameTh: p.name_th,
      baseUomId: p.base_uom_id,
      baseUomCode: (p.uoms as unknown as { code: string } | null)?.code ?? "",
      trackingMode: p.tracking_mode as "none" | "lot" | "serial",
    })),
  };
}

/**
 * Find or create the lot for a found-stock line.
 *
 * A drum discovered behind a pallet has its batch number printed on it, and that
 * number may or may not exist in the system yet. Both cases are ordinary: the
 * lot might be one we received and lost track of, or one that predates the
 * system entirely.
 *
 * `mfg_date` is set so the database derives the expiry from the product's shelf
 * life, exactly as receiving does — a found drum should not end up with a
 * different expiry rule than a received one.
 */
export async function resolveLot(
  productId: string,
  lotNo: string,
): Promise<ActionResult<{ lotId: string; lotNo: string; created: boolean }>> {
  await requirePerm("adjustment.create");
  const supabase = await createClient();

  const trimmed = lotNo.trim();
  if (!trimmed) return { ok: false, error: "lotRequired" };

  const { data: existing } = await supabase
    .from("lots")
    .select("id, lot_no")
    .eq("product_id", productId)
    .eq("lot_no", trimmed)
    .maybeSingle();

  if (existing) {
    return {
      ok: true,
      data: { lotId: existing.id, lotNo: existing.lot_no, created: false },
    };
  }

  const { data, error } = await supabase
    .from("lots")
    .insert({
      product_id: productId,
      lot_no: trimmed,
      mfg_date: new Date().toISOString().slice(0, 10),
    })
    .select("id, lot_no")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  // Deliberately left at the default pending_qc. Stock nobody knew about has by
  // definition not been inspected, and a found drum is exactly the case where
  // assuming it passed would be unsafe (D-14).
  return { ok: true, data: { lotId: data.id, lotNo: data.lot_no, created: true } };
}
