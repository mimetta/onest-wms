"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "../documents/actions";
import type { Suggestion } from "../issues/actions";

export type DeliveryLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  fromCode: string;
  toCode: string | null;
};

/**
 * Create the draft delivery note.
 *
 * `isConsignment` decides where the stock ends up, and it cannot be changed
 * afterwards without invalidating every line: an outright sale sends stock out
 * of the company (to_location null), while a consignment move sends it to the
 * customer's site location, where it is still ours until settled. Those are
 * different destinations, so the choice is made once, up front.
 */
export async function ensureDraft(
  partnerId: string,
  isConsignment: boolean,
): Promise<ActionResult<string>> {
  const user = await requirePerm("delivery_note.create");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("delivery_notes")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .eq("partner_id", partnerId)
    .eq("is_consignment", isConsignment)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("delivery_notes")
    .insert({
      warehouse_id: user.warehouseId,
      partner_id: partnerId,
      is_consignment: isConsignment,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

export async function setHeader(
  id: string,
  fields: { soReference?: string | null; notes?: string | null },
): Promise<ActionResult> {
  await requirePerm("delivery_note.create");
  const supabase = await createClient();

  const { error } = await supabase
    .from("delivery_notes")
    .update({
      so_reference: fields.soReference || null,
      notes: fields.notes || null,
    })
    .eq("id", id)
    .eq("status", "draft");

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true };
}

/** Pick suggestions, same FEFO/FIFO ordering as an issue (D-50). */
export async function getSuggestions(
  productId: string,
  qty: number,
): Promise<ActionResult<Suggestion[]>> {
  const user = await requirePerm("delivery_note.create");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("suggest_picks", {
    p_product_id: productId,
    p_qty: qty,
    p_warehouse_id: user.warehouseId,
    p_lot_id: null,
  });

  if (error) return { ok: false, error: "errorLoad", detail: error.message };

  return {
    ok: true,
    data: (data ?? []).map(
      (r: Record<string, string | null>) => ({
        locationId: r.location_id as string,
        locationCode: r.location_code as string,
        lotId: r.lot_id,
        lotNo: r.lot_no,
        serialId: r.serial_id,
        expiryDate: r.expiry_date,
        qtySuggested: Number(r.qty_suggested),
        qtyAtBin: Number(r.qty_at_bin),
        strategy: r.strategy as "fefo" | "fifo",
      }),
    ),
  };
}

/**
 * The consignment site location for a customer, if they have one.
 *
 * A consignment delivery moves stock to a location we still own; an outright
 * sale sends it nowhere (to_location null, i.e. out of the company — D-02). So
 * the destination is derived from the header rather than chosen per line, which
 * makes it impossible to build a note where some lines were sold and others
 * consigned.
 */
async function consignmentSiteFor(partnerId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("locations")
    .select("id")
    .eq("partner_id", partnerId)
    .eq("type", "consignment_site")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  return data?.id ?? null;
}

export async function addLine(input: {
  deliveryNoteId: string;
  productId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  uomId: string;
}): Promise<ActionResult<DeliveryLine>> {
  await requirePerm("delivery_note.create");
  const supabase = await createClient();

  if (!(input.qty > 0)) return { ok: false, error: "qtyPositive" };

  const { data: header } = await supabase
    .from("delivery_notes")
    .select("partner_id, is_consignment")
    .eq("id", input.deliveryNoteId)
    .maybeSingle();

  if (!header) return { ok: false, error: "notFound" };

  let toLocationId: string | null = null;
  if (header.is_consignment) {
    toLocationId = await consignmentSiteFor(header.partner_id);
    if (!toLocationId) return { ok: false, error: "noConsignmentSite" };
  }

  const { data: lastLine } = await supabase
    .from("delivery_note_lines")
    .select("line_no")
    .eq("header_id", input.deliveryNoteId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: line, error } = await supabase
    .from("delivery_note_lines")
    .insert({
      header_id: input.deliveryNoteId,
      line_no: (lastLine?.line_no ?? 0) + 1,
      product_id: input.productId,
      lot_id: input.lotId,
      serial_id: input.serialId,
      qty: input.qty,
      uom_id: input.uomId,
      from_location_id: input.locationId,
      to_location_id: toLocationId,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [{ data: product }, { data: uom }, { data: from }, { data: to }, { data: lot }, { data: serial }] =
    await Promise.all([
      supabase.from("products").select("sku, name_th").eq("id", input.productId).maybeSingle(),
      supabase.from("uoms").select("code").eq("id", input.uomId).maybeSingle(),
      supabase.from("locations").select("code").eq("id", input.locationId).maybeSingle(),
      toLocationId
        ? supabase.from("locations").select("code").eq("id", toLocationId).maybeSingle()
        : Promise.resolve({ data: null }),
      input.lotId
        ? supabase.from("lots").select("lot_no").eq("id", input.lotId).maybeSingle()
        : Promise.resolve({ data: null }),
      input.serialId
        ? supabase.from("serials").select("serial_no").eq("id", input.serialId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  revalidatePath("/delivery-notes");
  return {
    ok: true,
    data: {
      id: line.id,
      lineNo: line.line_no,
      sku: product?.sku ?? "",
      nameTh: product?.name_th ?? "",
      lotNo: (lot as { lot_no: string } | null)?.lot_no ?? null,
      serialNo: (serial as { serial_no: string } | null)?.serial_no ?? null,
      qty: Number(line.qty),
      uomCode: uom?.code ?? "",
      fromCode: from?.code ?? "",
      toCode: (to as { code: string } | null)?.code ?? null,
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("delivery_note.create");
  const supabase = await createClient();

  const { error } = await supabase.from("delivery_note_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/delivery-notes");
  return { ok: true };
}
