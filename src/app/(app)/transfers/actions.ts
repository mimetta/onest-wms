"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveBarcode } from "@/lib/barcodes/resolve";
import type { ActionResult } from "../documents/actions";

/** One thing physically present in a bin, offered as a candidate to move. */
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

export type TransferLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  fromCode: string;
  toCode: string;
};

export async function ensureDraft(): Promise<ActionResult<string>> {
  const user = await requirePerm("transfer.create");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("transfers")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("transfers")
    .insert({
      warehouse_id: user.warehouseId,
      // Same warehouse both ends: this screen builds internal moves, which post
      // in one step (D-44). The cross-warehouse two-leg path exists in the
      // database and is tested, but has no screen because the company runs one
      // warehouse — building an interface for a second site before it exists
      // would be guessing at how it works.
      from_warehouse_id: user.warehouseId,
      to_warehouse_id: user.warehouseId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

/**
 * Scan a bin and read back what is in it.
 *
 * This is the putaway flow's first step and its safety check at once: the
 * operator proves they are at the bin, and the screen can then offer only what
 * is actually there rather than a product list they have to search.
 *
 * Uses stock_on_hand, not stock_available: a putaway moves stock OUT of
 * receiving and QC hold, which stock_available deliberately excludes (D-13).
 * Filtering by availability here would hide exactly the stock this screen
 * exists to move.
 */
export async function readBin(
  raw: string,
): Promise<
  ActionResult<{ locationId: string; code: string; type: string; items: BinItem[] }>
> {
  const user = await requirePerm("transfer.create");

  const resolved = await resolveBarcode(raw);
  if (resolved.kind !== "location") return { ok: false, error: "notABin" };

  const supabase = await createClient();

  // No embedded selects. `stock_on_hand` is a VIEW, and PostgREST cannot infer
  // foreign-key relationships for a view — `.select("qty, products(sku)")`
  // errors rather than returning data. This is the same trap that made the stock
  // explorer render "no stock" in Phase 1, so the names are resolved with a
  // second round of lookups instead.
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
    data: {
      locationId: resolved.locationId,
      code: resolved.code,
      type: resolved.locationType,
      items,
    },
  };
}

/** Resolve a destination bin scan. Any bin in this warehouse is legal. */
export async function readDestination(
  raw: string,
): Promise<ActionResult<{ locationId: string; code: string; type: string }>> {
  await requirePerm("transfer.create");

  const resolved = await resolveBarcode(raw);
  if (resolved.kind !== "location") return { ok: false, error: "notABin" };

  return {
    ok: true,
    data: {
      locationId: resolved.locationId,
      code: resolved.code,
      type: resolved.locationType,
    },
  };
}

export async function addLine(input: {
  transferId: string;
  productId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  uomId: string;
  fromLocationId: string;
  toLocationId: string;
}): Promise<ActionResult<TransferLine>> {
  await requirePerm("transfer.create");
  const supabase = await createClient();

  if (!(input.qty > 0)) return { ok: false, error: "qtyPositive" };
  if (input.fromLocationId === input.toLocationId) {
    return { ok: false, error: "sameBin" };
  }

  const { data: lastLine } = await supabase
    .from("transfer_lines")
    .select("line_no")
    .eq("header_id", input.transferId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: line, error } = await supabase
    .from("transfer_lines")
    .insert({
      header_id: input.transferId,
      line_no: (lastLine?.line_no ?? 0) + 1,
      product_id: input.productId,
      lot_id: input.lotId,
      serial_id: input.serialId,
      qty: input.qty,
      uom_id: input.uomId,
      from_location_id: input.fromLocationId,
      to_location_id: input.toLocationId,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [
    { data: product },
    { data: uom },
    { data: from },
    { data: to },
    { data: lot },
    { data: serial },
  ] = await Promise.all([
    supabase
      .from("products")
      .select("sku, name_th")
      .eq("id", input.productId)
      .maybeSingle(),
    supabase.from("uoms").select("code").eq("id", input.uomId).maybeSingle(),
    supabase
      .from("locations")
      .select("code")
      .eq("id", input.fromLocationId)
      .maybeSingle(),
    supabase.from("locations").select("code").eq("id", input.toLocationId).maybeSingle(),
    input.lotId
      ? supabase.from("lots").select("lot_no").eq("id", input.lotId).maybeSingle()
      : Promise.resolve({ data: null }),
    input.serialId
      ? supabase
          .from("serials")
          .select("serial_no")
          .eq("id", input.serialId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  revalidatePath("/transfers");
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
      toCode: to?.code ?? "",
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("transfer.create");
  const supabase = await createClient();

  const { error } = await supabase.from("transfer_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/transfers");
  return { ok: true };
}
