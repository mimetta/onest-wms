import { createClient } from "@/lib/supabase/server";

/**
 * Barcode resolution.
 *
 * A scanned string is an OPAQUE VALUE (D-36). Nothing here inspects its length,
 * its symbology or its format — it is looked up as typed. That matters because
 * most products carry a factory GS1 EAN-13, some carry an ITF-14 case code,
 * bins carry our Code 128, and a rule like "13 digits means a product" would be
 * wrong the first time a supplier's case code collided with it.
 *
 * `product_barcodes.barcode` is unique globally and `locations.barcode` is
 * unique too, so a scan resolves to exactly one thing or to nothing.
 */

export type ScanResolution =
  | {
      kind: "product";
      productId: string;
      sku: string;
      nameTh: string;
      trackingMode: "none" | "lot" | "serial";
      requiresQc: boolean;
      /** The unit this particular barcode represents — a case code is not a piece. */
      uomId: string;
      uomCode: string;
      barcodeType: string;
      matchedBarcode: string;
    }
  | {
      kind: "location";
      locationId: string;
      code: string;
      locationType: string;
      countsAsAvailable: boolean;
      blocksConsumption: boolean;
      zoneName: string | null;
    }
  | {
      kind: "lot";
      lotId: string;
      lotNo: string;
      productId: string;
      sku: string;
      nameTh: string;
      qcStatus: string;
      expiryDate: string | null;
    }
  | { kind: "unknown"; value: string };

/**
 * Resolve one scanned value.
 *
 * Order matters only for speed, not correctness — the three namespaces cannot
 * collide, because a product barcode, a bin barcode and a lot number are each
 * unique in their own table and a value in two of them would be a data error
 * worth finding. Products first because they are the most common scan.
 */
export async function resolveBarcode(raw: string): Promise<ScanResolution> {
  // Wedge scanners sometimes append whitespace or a stray carriage return.
  // Trimming is the ONLY normalisation applied: no case folding, no padding,
  // no stripping of leading zeros — a GTIN's leading zero is significant.
  const value = raw.trim();
  if (!value) return { kind: "unknown", value: raw };

  const supabase = await createClient();

  const { data: barcode } = await supabase
    .from("product_barcodes")
    .select(
      "barcode, type, uom_id, uoms(code), products(id, sku, name_th, tracking_mode, requires_qc, is_active)",
    )
    .eq("barcode", value)
    .maybeSingle();

  if (barcode) {
    const product = barcode.products as unknown as {
      id: string;
      sku: string;
      name_th: string;
      tracking_mode: "none" | "lot" | "serial";
      requires_qc: boolean;
      is_active: boolean;
    } | null;
    const uom = barcode.uoms as unknown as { code: string } | null;

    // An inactive product is treated as unknown rather than returned: offering
    // it would let a discontinued SKU back into a receipt.
    if (product?.is_active) {
      return {
        kind: "product",
        productId: product.id,
        sku: product.sku,
        nameTh: product.name_th,
        trackingMode: product.tracking_mode,
        requiresQc: product.requires_qc,
        uomId: barcode.uom_id,
        uomCode: uom?.code ?? "",
        barcodeType: barcode.type,
        matchedBarcode: barcode.barcode,
      };
    }
  }

  const { data: location } = await supabase
    .from("locations")
    .select(
      "id, code, type, counts_as_available, blocks_consumption, is_active, zones(name_th)",
    )
    .eq("barcode", value)
    .maybeSingle();

  if (location?.is_active) {
    const zone = location.zones as unknown as { name_th: string } | null;
    return {
      kind: "location",
      locationId: location.id,
      code: location.code,
      locationType: location.type,
      countsAsAvailable: location.counts_as_available,
      blocksConsumption: location.blocks_consumption,
      zoneName: zone?.name_th ?? null,
    };
  }

  // Lot numbers are the primary scan target on drums (D-35), and a lot resolves
  // its product, so scanning a drum label is enough to identify both.
  const { data: lot } = await supabase
    .from("lots")
    .select("id, lot_no, qc_status, expiry_date, products(id, sku, name_th)")
    .eq("lot_no", value)
    .limit(1)
    .maybeSingle();

  if (lot) {
    const product = lot.products as unknown as {
      id: string;
      sku: string;
      name_th: string;
    } | null;
    if (product) {
      return {
        kind: "lot",
        lotId: lot.id,
        lotNo: lot.lot_no,
        productId: product.id,
        sku: product.sku,
        nameTh: product.name_th,
        qcStatus: lot.qc_status,
        expiryDate: lot.expiry_date,
      };
    }
  }

  return { kind: "unknown", value };
}
