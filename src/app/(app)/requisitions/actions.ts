"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveBarcode } from "@/lib/barcodes/resolve";
import type { ActionResult } from "../documents/actions";

export type RequisitionLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  qty: number;
  uomCode: string;
  note: string | null;
  /** What the warehouse can actually supply right now, for context only. */
  qtyAvailable: number;
};

/**
 * Start a requisition, or resume today's unfinished one.
 *
 * Same reasoning as receiving: the document exists from the first line rather
 * than being assembled in the browser and saved at the end. A requisition is
 * typically raised standing at a machine on a phone, which is exactly where a
 * dropped connection loses work.
 */
export async function ensureDraft(departmentId: string): Promise<ActionResult<string>> {
  const user = await requirePerm("requisition.create");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("requisitions")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .eq("department_id", departmentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("requisitions")
    .insert({
      warehouse_id: user.warehouseId,
      department_id: departmentId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

export async function setHeader(
  id: string,
  fields: { requiredDate?: string | null; notes?: string | null },
): Promise<ActionResult> {
  await requirePerm("requisition.create");
  const supabase = await createClient();

  const { error } = await supabase
    .from("requisitions")
    .update({
      required_date: fields.requiredDate || null,
      notes: fields.notes || null,
    })
    .eq("id", id)
    .eq("status", "draft");

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true };
}

/**
 * Resolve a scan to a product, for the "scan what you need" path.
 *
 * A requisition names products, not bins or lots — the warehouse decides which
 * lot to pick when it fulfils (that is what suggest_picks is for). So a bin or
 * lot scan is reported as the wrong kind of thing rather than silently ignored.
 */
export async function scanProduct(raw: string): Promise<
  ActionResult<{
    productId: string;
    sku: string;
    nameTh: string;
    uomId: string;
    uomCode: string;
  }>
> {
  await requirePerm("requisition.create");

  const resolved = await resolveBarcode(raw);

  if (resolved.kind === "product") {
    return {
      ok: true,
      data: {
        productId: resolved.productId,
        sku: resolved.sku,
        nameTh: resolved.nameTh,
        uomId: resolved.uomId,
        uomCode: resolved.uomCode,
      },
    };
  }

  if (resolved.kind === "lot") {
    // A lot label identifies its product perfectly well, so use it rather than
    // making the person find a different label.
    const supabase = await createClient();
    const { data: product } = await supabase
      .from("products")
      .select("id, sku, name_th, base_uom_id, uoms:base_uom_id(code)")
      .eq("id", resolved.productId)
      .maybeSingle();

    if (product) {
      return {
        ok: true,
        data: {
          productId: product.id,
          sku: product.sku,
          nameTh: product.name_th,
          uomId: product.base_uom_id,
          uomCode: (product.uoms as unknown as { code: string } | null)?.code ?? "",
        },
      };
    }
  }

  if (resolved.kind === "location") return { ok: false, error: "scannedALocation" };
  return { ok: false, error: "unknownBarcode" };
}

export async function addLine(input: {
  requisitionId: string;
  productId: string;
  qty: number;
  uomId: string;
  note?: string;
}): Promise<ActionResult<RequisitionLine>> {
  const user = await requirePerm("requisition.create");
  const supabase = await createClient();

  if (!(input.qty > 0)) return { ok: false, error: "qtyPositive" };

  const { data: lastLine } = await supabase
    .from("requisition_lines")
    .select("line_no")
    .eq("header_id", input.requisitionId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: line, error } = await supabase
    .from("requisition_lines")
    .insert({
      header_id: input.requisitionId,
      line_no: (lastLine?.line_no ?? 0) + 1,
      product_id: input.productId,
      qty: input.qty,
      uom_id: input.uomId,
      note: input.note || null,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [{ data: product }, { data: uom }, { data: stock }] = await Promise.all([
    supabase
      .from("products")
      .select("sku, name_th")
      .eq("id", input.productId)
      .maybeSingle(),
    supabase.from("uoms").select("code").eq("id", input.uomId).maybeSingle(),
    supabase
      .from("stock_by_product")
      .select("qty_available")
      .eq("product_id", input.productId)
      .eq("warehouse_id", user.warehouseId)
      .maybeSingle(),
  ]);

  revalidatePath("/requisitions");
  return {
    ok: true,
    data: {
      id: line.id,
      lineNo: line.line_no,
      sku: product?.sku ?? "",
      nameTh: product?.name_th ?? "",
      qty: Number(line.qty),
      uomCode: uom?.code ?? "",
      note: input.note || null,
      qtyAvailable: Number(stock?.qty_available ?? 0),
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("requisition.create");
  const supabase = await createClient();

  const { error } = await supabase.from("requisition_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/requisitions");
  return { ok: true };
}
