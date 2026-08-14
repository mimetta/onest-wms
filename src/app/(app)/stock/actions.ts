"use server";

import { revalidatePath } from "next/cache";
import { requirePerm, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { resolveBarcode, type ScanResolution } from "@/lib/barcodes/resolve";
import { suggestCapture } from "@/lib/barcodes/symbology";

export type OnHandRow = { label: string; lotNo: string | null; qty: number };

/** One hop in the movement path: where from, where to, who, when, which document. */
export type MovementRow = {
  id: number;
  occurredAt: string;
  sku: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  fromCode: string | null;
  toCode: string | null;
  documentType: string;
  userName: string;
  deviceId: string | null;
};

export type ScanOutcome = {
  resolution: ScanResolution;
  onHand?: OnHandRow[];
  /** Set when the stock lookup itself failed, so the UI can say so rather than
   *  showing an empty list that looks like "no stock". */
  onHandError?: boolean;
  /** Capture hints, populated only when the value resolved to nothing. */
  capture?: ReturnType<typeof suggestCapture>;
  /** The movement path — every hop, most recent first. */
  movements?: MovementRow[];
};

/**
 * Stock rows for one scan.
 *
 * Note the deliberate absence of embedded selects. `stock_on_hand` is a VIEW,
 * and PostgREST cannot infer foreign-key relationships for a view — so
 * `.select("qty, products(sku)")` errors rather than returning data. Resolving
 * the display names with a second query is both correct and, at under 500 SKUs,
 * cheaper than it looks.
 */
async function loadOnHand(
  supabase: Awaited<ReturnType<typeof createClient>>,
  filter: { locationId?: string; productId?: string; lotId?: string },
): Promise<{ rows: OnHandRow[]; failed: boolean }> {
  let query = supabase
    .from("stock_on_hand")
    .select("qty, product_id, lot_id, location_id");

  if (filter.locationId) query = query.eq("location_id", filter.locationId);
  if (filter.productId) query = query.eq("product_id", filter.productId);
  if (filter.lotId) query = query.eq("lot_id", filter.lotId);

  const { data, error } = await query;
  if (error) return { rows: [], failed: true };
  if (!data || data.length === 0) return { rows: [], failed: false };

  // A location scan wants product names down the left; a product or lot scan
  // wants bin codes. Only the needed lookup is issued.
  const byLocation = Boolean(filter.locationId);

  const lotIds = [...new Set(data.map((r) => r.lot_id).filter(Boolean))] as string[];
  const [names, lots] = await Promise.all([
    byLocation
      ? supabase
          .from("products")
          .select("id, sku, name_th")
          .in("id", [...new Set(data.map((r) => r.product_id))])
      : supabase
          .from("locations")
          .select("id, code, is_virtual")
          .in("id", [...new Set(data.map((r) => r.location_id))]),
    lotIds.length
      ? supabase.from("lots").select("id, lot_no").in("id", lotIds)
      : Promise.resolve({ data: [] as { id: string; lot_no: string }[] }),
  ]);

  const nameById = new Map(
    (names.data ?? []).map((row) => {
      const r = row as { id: string; sku?: string; name_th?: string; code?: string };
      return [r.id, r.code ?? `${r.sku} · ${r.name_th}`];
    }),
  );
  const lotById = new Map((lots.data ?? []).map((l) => [l.id, l.lot_no]));

  // Virtual bins are excluded from the explorer. OPENING holds the negative of
  // everything that predates the ledger (D-21), so including it nets every
  // product's total to zero — arithmetically true and operationally useless.
  // A person asking "where is this stock" means physical shelves.
  const virtualIds = new Set(
    (names.data ?? [])
      .filter((row) => (row as { is_virtual?: boolean }).is_virtual)
      .map((row) => (row as { id: string }).id),
  );

  return {
    failed: false,
    rows: data
      .filter((row) => byLocation || !virtualIds.has(row.location_id))
      .map((row) => ({
        label: nameById.get(byLocation ? row.product_id : row.location_id) ?? "—",
        lotNo: row.lot_id ? (lotById.get(row.lot_id) ?? null) : null,
        qty: Number(row.qty),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * Resolve one scan and gather just enough stock context to be useful.
 *
 * Runs on the server so RLS applies to every read exactly as it would anywhere
 * else, and so the resolution logic stays in one place.
 */
export async function scan(raw: string): Promise<ScanOutcome> {
  await requirePerm("report.read");

  const resolution = await resolveBarcode(raw);

  if (resolution.kind === "unknown") {
    // Classify only now, to default the capture form. Resolution itself never
    // looked at the value's shape (D-36).
    return { resolution, capture: suggestCapture(resolution.value) };
  }

  const supabase = await createClient();

  const filter =
    resolution.kind === "location"
      ? { locationId: resolution.locationId }
      : resolution.kind === "lot"
        ? { productId: resolution.productId, lotId: resolution.lotId }
        : { productId: resolution.productId };

  const { rows, failed } = await loadOnHand(supabase, filter);
  const movements = await loadMovements(supabase, resolution);

  return { resolution, onHand: rows, onHandError: failed, movements };
}

/**
 * The movement path: every hop this stock has made.
 *
 * Reads stock_movement_path, which already resolves location codes and user
 * names — the whole point of the from/to movement shape (D-02) is that history
 * reads as a path rather than as pairs of half-entries to reassemble.
 *
 * Scoped to the narrowest thing the scan identified: a lot scan shows that
 * lot's history, not every movement of the product.
 */
async function loadMovements(
  supabase: Awaited<ReturnType<typeof createClient>>,
  resolution: ScanResolution,
): Promise<MovementRow[]> {
  if (resolution.kind === "unknown") return [];

  let query = supabase
    .from("stock_movement_path")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(50);

  if (resolution.kind === "location") {
    // Both directions: stock that arrived here and stock that left.
    query = query.or(
      `from_location_id.eq.${resolution.locationId},to_location_id.eq.${resolution.locationId}`,
    );
  } else if (resolution.kind === "lot") {
    query = query.eq("lot_id", resolution.lotId);
  } else {
    query = query.eq("product_id", resolution.productId);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((row) => ({
    id: Number(row.movement_id),
    occurredAt: row.occurred_at,
    sku: row.sku,
    lotNo: row.lot_no,
    serialNo: row.serial_no,
    qty: Number(row.qty),
    uomCode: row.uom_code,
    fromCode: row.from_location_code,
    toCode: row.to_location_code,
    documentType: row.document_type,
    userName: row.user_name,
    deviceId: row.device_id,
  }));
}

export type LinkBarcodeState = { error?: string; linkedTo?: string };

/**
 * Attach an unrecognised barcode to a product.
 *
 * This is how the system learns supplier barcodes (D-35): AccCloud supplies
 * none, so the first time a delivery arrives the receiver links the code and
 * every later delivery of it scans natively. Turning the dead end into the
 * capture mechanism is the whole point.
 */
export async function linkBarcode(
  _prev: LinkBarcodeState,
  formData: FormData,
): Promise<LinkBarcodeState> {
  const user = await requireUser();

  // Deliberately NOT master_data.write: a receiver holds goods_receipt.create
  // and needs to link a code at the moment of receiving, without an admin.
  if (
    !user.permissions.has("goods_receipt.create") &&
    !user.permissions.has("master_data.write")
  ) {
    return { error: "notAllowed" };
  }

  const barcode = String(formData.get("barcode") ?? "").trim();
  const productId = String(formData.get("product_id") ?? "");
  const uomId = String(formData.get("uom_id") ?? "");
  const type = String(formData.get("type") ?? "supplier");

  if (!barcode || !productId || !uomId) return { error: "errorRequired" };

  const supabase = await createClient();

  const { data: product } = await supabase
    .from("products")
    .select("sku")
    .eq("id", productId)
    .maybeSingle();

  const { error } = await supabase.from("product_barcodes").insert({
    product_id: productId,
    barcode,
    uom_id: uomId,
    type,
    // Never primary: the primary barcode is our own internal code, and a
    // supplier's code arriving later must not displace it.
    is_primary: false,
  });

  if (error) {
    return { error: error.code === "23505" ? "alreadyLinked" : "errorSave" };
  }

  revalidatePath("/stock");
  return { linkedTo: product?.sku ?? productId };
}
