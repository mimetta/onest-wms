"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type ReceiptLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  toLocationCode: string;
  /** True when the product's requires_qc routed this line to QC hold. */
  toQcHold: boolean;
};

export type ActionResult<T = undefined> =
  { ok: true; data?: T } | { ok: false; error: string; detail?: string };

/**
 * Create the draft receipt, or return today's existing one for this user.
 *
 * The document exists from the first scan rather than being assembled in the
 * browser and saved at the end: a dropped connection, a dead battery or a
 * closed tab mid-receipt must not lose forty scanned lines.
 */
export async function ensureDraft(): Promise<ActionResult<string>> {
  const user = await requirePerm("goods_receipt.create");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("goods_receipts")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("goods_receipts")
    .insert({ warehouse_id: user.warehouseId, created_by: user.id })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

export async function setReceiptHeader(
  receiptId: string,
  partnerId: string | null,
  poReference: string | null,
): Promise<ActionResult> {
  await requirePerm("goods_receipt.create");
  const supabase = await createClient();

  const { error } = await supabase
    .from("goods_receipts")
    .update({ partner_id: partnerId, po_reference: poReference })
    .eq("id", receiptId)
    .eq("status", "draft");

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true };
}

export type AddLineInput = {
  receiptId: string;
  productId: string;
  /** Bin the receiver scanned. Overridden to QC hold when the product needs QC. */
  locationId: string;
  qty: number;
  uomId: string;
  lotNo?: string;
  expiryDate?: string;
  serialNo?: string;
};

/**
 * Add one line to the draft.
 *
 * Two things happen here that the receiver never has to think about:
 *
 *  - a lot-tracked product's lot is created if it does not exist, with the
 *    expiry defaulted from the product's shelf life
 *  - a product with requires_qc is routed to the QC hold bin regardless of
 *    which bin was scanned
 *
 * The second is the QC gate applied at the point of entry: a receiver cannot
 * put unapproved stock into pickable storage, because the destination comes
 * from the product's own configuration rather than from their scan.
 */
export async function addLine(input: AddLineInput): Promise<ActionResult<ReceiptLine>> {
  const user = await requirePerm("goods_receipt.create");
  const supabase = await createClient();

  const { data: product } = await supabase
    .from("products")
    .select("id, sku, name_th, tracking_mode, requires_qc, shelf_life_days")
    .eq("id", input.productId)
    .maybeSingle();

  if (!product) return { ok: false, error: "productNotFound" };

  // --- destination -------------------------------------------------------
  let locationId = input.locationId;
  let toQcHold = false;

  if (product.requires_qc) {
    const { data: qcBin } = await supabase
      .from("locations")
      .select("id")
      .eq("warehouse_id", user.warehouseId)
      .eq("type", "qc_hold")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (!qcBin) return { ok: false, error: "noQcBin" };
    locationId = qcBin.id;
    toQcHold = true;
  }

  // --- lot ---------------------------------------------------------------
  let lotId: string | null = null;
  if (product.tracking_mode === "lot" || product.tracking_mode === "serial") {
    if (!input.lotNo && product.tracking_mode === "lot") {
      return { ok: false, error: "lotRequired" };
    }

    if (input.lotNo) {
      const { data: existingLot } = await supabase
        .from("lots")
        .select("id")
        .eq("product_id", product.id)
        .eq("lot_no", input.lotNo)
        .maybeSingle();

      if (existingLot) {
        lotId = existingLot.id;
      } else {
        const { data: newLot, error: lotError } = await supabase
          .from("lots")
          .insert({
            product_id: product.id,
            lot_no: input.lotNo,
            // mfg_date lets the database default the expiry from shelf life,
            // so the receiver confirms a date rather than calculating one.
            mfg_date: new Date().toISOString().slice(0, 10),
            expiry_date: input.expiryDate || null,
          })
          .select("id")
          .single();

        if (lotError) {
          return { ok: false, error: "errorSave", detail: lotError.message };
        }
        lotId = newLot.id;
      }
    }
  }

  // --- serial ------------------------------------------------------------
  let serialId: string | null = null;
  if (product.tracking_mode === "serial") {
    if (!input.serialNo) return { ok: false, error: "serialRequired" };

    const { data: existingSerial } = await supabase
      .from("serials")
      .select("id")
      .eq("product_id", product.id)
      .eq("serial_no", input.serialNo)
      .maybeSingle();

    if (existingSerial) {
      // A serial already in stock cannot be received again — it would exist in
      // two places at once, which post_document() would reject anyway.
      return { ok: false, error: "serialExists" };
    }

    const { data: newSerial, error: serialError } = await supabase
      .from("serials")
      .insert({ product_id: product.id, lot_id: lotId, serial_no: input.serialNo })
      .select("id")
      .single();

    if (serialError) {
      return { ok: false, error: "errorSave", detail: serialError.message };
    }
    serialId = newSerial.id;
  }

  // --- line --------------------------------------------------------------
  const { data: lastLine } = await supabase
    .from("goods_receipt_lines")
    .select("line_no")
    .eq("header_id", input.receiptId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lineNo = (lastLine?.line_no ?? 0) + 1;

  const { data: line, error } = await supabase
    .from("goods_receipt_lines")
    .insert({
      header_id: input.receiptId,
      line_no: lineNo,
      product_id: product.id,
      lot_id: lotId,
      serial_id: serialId,
      qty: input.qty,
      uom_id: input.uomId,
      to_location_id: locationId,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [{ data: location }, { data: uom }] = await Promise.all([
    supabase.from("locations").select("code").eq("id", locationId).maybeSingle(),
    supabase.from("uoms").select("code").eq("id", input.uomId).maybeSingle(),
  ]);

  return {
    ok: true,
    data: {
      id: line.id,
      lineNo: line.line_no,
      sku: product.sku,
      nameTh: product.name_th,
      lotNo: input.lotNo ?? null,
      serialNo: input.serialNo ?? null,
      qty: Number(line.qty),
      uomCode: uom?.code ?? "",
      toLocationCode: location?.code ?? "",
      toQcHold,
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("goods_receipt.create");
  const supabase = await createClient();

  const { error } = await supabase.from("goods_receipt_lines").delete().eq("id", lineId);

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true };
}

/**
 * Post the receipt.
 *
 * Goods receipts have no separate approver (D-22): the receiver approves and
 * posts in one action, and the compensating control is the dashboard review.
 * The status hop to `approved` is still made explicitly, because
 * post_document() refuses anything that is not approved and that guard should
 * stay meaningful rather than being special-cased away.
 */
export async function postReceipt(receiptId: string): Promise<ActionResult<string>> {
  await requirePerm("goods_receipt.post");
  const supabase = await createClient();

  const { count } = await supabase
    .from("goods_receipt_lines")
    .select("id", { count: "exact", head: true })
    .eq("header_id", receiptId);

  if (!count) return { ok: false, error: "noLines" };

  // Via the RPC, not a direct UPDATE: RLS only permits editing a document
  // while it is `draft`, so approve_document() is the only legal path to
  // `approved` (D-38). A receiver may do this themselves because they hold
  // goods_receipt.approve (D-22).
  const { error: approveError } = await supabase.rpc("approve_document", {
    p_doc_type: "goods_receipt",
    p_doc_id: receiptId,
  });

  if (approveError) {
    return { ok: false, error: "approveFailed", detail: approveError.message };
  }

  const { data, error } = await supabase.rpc("post_document", {
    p_doc_type: "goods_receipt",
    p_doc_id: receiptId,
  });

  if (error) {
    // The whole post is one transaction, so nothing landed. The document is
    // left approved rather than reverted to draft: an operator seeing
    // "approved but not posted" is closer to the truth than one seeing a draft
    // that silently swallowed a failure.
    return { ok: false, error: "postFailed", detail: error.message };
  }

  revalidatePath("/receive");
  return { ok: true, data: String(data) };
}
