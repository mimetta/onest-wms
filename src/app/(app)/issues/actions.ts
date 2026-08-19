"use server";

import { revalidatePath } from "next/cache";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveBarcode } from "@/lib/barcodes/resolve";
import type { ActionResult } from "../documents/actions";

/** One suggested pick, as suggest_picks() returns it. */
export type Suggestion = {
  locationId: string;
  locationCode: string;
  lotId: string | null;
  lotNo: string | null;
  serialId: string | null;
  expiryDate: string | null;
  qtySuggested: number;
  qtyAtBin: number;
  strategy: "fefo" | "fifo";
};

export type IssueLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  fromLocationCode: string;
};

/** What still needs picking for one product on the issue. */
export type Requirement = {
  productId: string;
  sku: string;
  nameTh: string;
  baseUomId: string;
  baseUomCode: string;
  trackingMode: "none" | "lot" | "serial";
  qtyRequested: number;
  qtyPicked: number;
};

/**
 * Create the draft issue.
 *
 * `requisitionId` null means a direct issue, which needs issue.create_direct
 * (D-46). That is enforced by RLS; checking it here as well means the operator
 * gets a sentence instead of a policy violation, and the button can be hidden
 * before they press it.
 */
export async function ensureDraft(
  departmentId: string,
  requisitionId: string | null,
): Promise<ActionResult<string>> {
  const user = await requirePerm("issue.create");

  if (!requisitionId && !can(user, "issue.create_direct")) {
    return { ok: false, error: "requisitionRequired" };
  }

  const supabase = await createClient();

  // Resume an unfinished draft for the SAME requisition, or the same
  // department when this is a direct issue. A draft against a *different*
  // requisition is left alone: two requests must not silently merge into one
  // issue slip, because then neither can be reconciled against what it asked
  // for.
  const base = supabase
    .from("issues")
    .select("id")
    .eq("status", "draft")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false })
    .limit(1);

  const { data: existing } = requisitionId
    ? await base.eq("requisition_id", requisitionId).maybeSingle()
    : await base
        .eq("department_id", departmentId)
        .is("requisition_id", null)
        .maybeSingle();

  if (existing) return { ok: true, data: existing.id };

  const { data, error } = await supabase
    .from("issues")
    .insert({
      warehouse_id: user.warehouseId,
      department_id: departmentId,
      requisition_id: requisitionId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };
  return { ok: true, data: data.id };
}

/**
 * Ask the database where to pick from.
 *
 * Thin wrapper over suggest_picks() (D-50). The ordering logic lives in SQL
 * because it reads the availability view under the caller's own RLS, and
 * because a second implementation in TypeScript would be a second thing to keep
 * in step with the posting guard.
 */
export async function getSuggestions(
  productId: string,
  qty: number,
  /** The draft being built, so its own un-posted lines are not offered again. */
  issueId: string,
): Promise<ActionResult<Suggestion[]>> {
  const user = await requirePerm("issue.create");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("suggest_picks", {
    p_product_id: productId,
    p_qty: qty,
    p_warehouse_id: user.warehouseId,
    p_lot_id: null,
    p_exclude_doc_type: "issue",
    p_exclude_doc_id: issueId,
  });

  if (error) return { ok: false, error: "errorLoad", detail: error.message };

  return {
    ok: true,
    data: (data ?? []).map(
      (r: {
        location_id: string;
        location_code: string;
        lot_id: string | null;
        lot_no: string | null;
        serial_id: string | null;
        expiry_date: string | null;
        qty_suggested: string;
        qty_at_bin: string;
        strategy: string;
      }) => ({
        locationId: r.location_id,
        locationCode: r.location_code,
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

/** A lot physically present in the scanned bin, for the override case. */
export type BinLot = {
  lotId: string | null;
  lotNo: string | null;
  qty: number;
  expiryDate: string | null;
};

/**
 * Check a scanned bin against the pick the operator was asked to make, and
 * report what is actually in it.
 *
 * Returns whether it matches rather than refusing outright. Overriding a
 * suggestion is legitimate — the suggested drum may be behind a pallet, or
 * damaged — and the honest design is to let the operator record what they
 * actually took and flag the divergence, not to insist on a fiction. The QC and
 * sufficiency guards still apply at posting either way (D-13, D-14).
 *
 * The bin's contents come back with it so the caller can re-derive the lot
 * rather than discarding it, which is what made an overridden line unpostable.
 */
export async function verifyBinScan(
  raw: string,
  expectedLocationId: string,
  productId: string,
): Promise<
  ActionResult<{
    locationId: string;
    code: string;
    matches: boolean;
    blocksConsumption: boolean;
    /** What this product actually has in the scanned bin. */
    lots: BinLot[];
    trackingMode: "none" | "lot" | "serial";
  }>
> {
  const user = await requirePerm("issue.create");

  const resolved = await resolveBarcode(raw);
  if (resolved.kind !== "location") return { ok: false, error: "notABin" };

  const supabase = await createClient();

  const { data: product } = await supabase
    .from("products")
    .select("tracking_mode")
    .eq("id", productId)
    .maybeSingle();

  // What is really in that bin, read back from the ledger.
  //
  // The override path used to drop the lot on the reasoning that a different
  // bin holds different stock. That is true, and it is exactly why the lot has
  // to be re-derived rather than discarded: for a lot-tracked product a
  // lot-less line can never post at all, because the ledger refuses any
  // movement of a tracked product without one. The operator would have found
  // that out at posting, having already carried the drum.
  //
  // No embedded selects: stock_on_hand is a VIEW and PostgREST cannot infer its
  // relationships (D-55).
  const { data: rows } = await supabase
    .from("stock_on_hand")
    .select("lot_id, qty")
    .eq("location_id", resolved.locationId)
    .eq("product_id", productId)
    .eq("warehouse_id", user.warehouseId)
    .gt("qty", 0);

  const lotIds = [...new Set((rows ?? []).map((r) => r.lot_id))].filter(
    (v): v is string => Boolean(v),
  );

  const { data: lotRows } = lotIds.length
    ? await supabase
        .from("lots")
        .select("id, lot_no, expiry_date, qc_status")
        .in("id", lotIds)
    : { data: [] };

  const lotById = new Map(
    (
      (lotRows ?? []) as {
        id: string;
        lot_no: string;
        expiry_date: string | null;
        qc_status: string;
      }[]
    ).map((l) => [l.id, l]),
  );

  const lots: BinLot[] = (rows ?? [])
    // A lot that has not passed QC is not offered even as an override: the
    // posting gate would refuse it (D-14), so proposing it would only produce
    // a failure later.
    .filter((r) => !r.lot_id || lotById.get(r.lot_id)?.qc_status === "passed")
    .map((r) => ({
      lotId: r.lot_id,
      lotNo: r.lot_id ? (lotById.get(r.lot_id)?.lot_no ?? null) : null,
      qty: Number(r.qty),
      expiryDate: r.lot_id ? (lotById.get(r.lot_id)?.expiry_date ?? null) : null,
    }))
    // Earliest expiry first, so a bin holding several lots still presents them
    // in the order FEFO would want them taken.
    .sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999"));

  return {
    ok: true,
    data: {
      locationId: resolved.locationId,
      code: resolved.code,
      matches: resolved.locationId === expectedLocationId,
      blocksConsumption: resolved.blocksConsumption,
      lots,
      trackingMode: (product?.tracking_mode ?? "none") as "none" | "lot" | "serial",
    },
  };
}

export async function addLine(input: {
  issueId: string;
  productId: string;
  locationId: string;
  lotId: string | null;
  serialId: string | null;
  qty: number;
  uomId: string;
}): Promise<ActionResult<IssueLine>> {
  await requirePerm("issue.create");
  const supabase = await createClient();

  if (!(input.qty > 0)) return { ok: false, error: "qtyPositive" };

  const { data: lastLine } = await supabase
    .from("issue_lines")
    .select("line_no")
    .eq("header_id", input.issueId)
    .order("line_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: line, error } = await supabase
    .from("issue_lines")
    .insert({
      header_id: input.issueId,
      line_no: (lastLine?.line_no ?? 0) + 1,
      product_id: input.productId,
      lot_id: input.lotId,
      serial_id: input.serialId,
      qty: input.qty,
      uom_id: input.uomId,
      from_location_id: input.locationId,
      // Always null: an issue consumes stock, so it leaves the company (D-02).
      to_location_id: null,
    })
    .select("id, line_no, qty")
    .single();

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  const [
    { data: product },
    { data: uom },
    { data: location },
    { data: lot },
    { data: serial },
  ] = await Promise.all([
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
    input.serialId
      ? supabase
          .from("serials")
          .select("serial_no")
          .eq("id", input.serialId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  revalidatePath("/issues");
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
      fromLocationCode: location?.code ?? "",
    },
  };
}

export async function removeLine(lineId: string): Promise<ActionResult> {
  await requirePerm("issue.create");
  const supabase = await createClient();

  const { error } = await supabase.from("issue_lines").delete().eq("id", lineId);
  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/issues");
  return { ok: true };
}
