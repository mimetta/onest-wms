/**
 * The AccCloud product-export mapping.
 *
 * Kept as pure functions with no database access, because this is where the
 * import's judgement lives and judgement is what needs testing. The server
 * actions read the file and write rows; everything about *what a row means*
 * happens here.
 *
 * Profiled against the real export on 20 Aug 2026: 731 rows, 17 columns,
 * UTF-8 BOM, Thai headers, 50 rows containing embedded newlines inside quoted
 * fields — which is why the caller must use a real CSV parser and not split on
 * newlines.
 */

/** The export's column headers, exactly as AccCloud writes them. */
export const ACCCLOUD_COLUMNS = {
  rowNo: "เลขที่",
  itemCode: "รหัสสินค้า",
  image: "Image",
  nameTh: "ชื่อสินค้า",
  nameEn: "ชื่อสินค้า (EN)",
  tradeNameTh: "ชื่อทางการค้า",
  tradeNameEn: "ชื่อทางการค้า (Eng.)",
  notes: "หมายเหตุ",
  sizeGroup: "กำหนดกลุ่มขนาดสินค้า",
  uom: "หน่วย",
  groupCode: "รหัสกลุ่มสินค้า",
  groupName: "ชื่อกลุ่มสินค้า",
  typeCode: "รหัสประเภทสินค้า",
  typeName: "ชื่อประเภทสินค้า",
  qc: "QC",
  discontinued: "ยกเลิกการจำหน่ายสินค้าชนิดนี้",
  standardCost: "ต้นทุนมาตรฐาน",
} as const;

/** The columns the import cannot proceed without. */
export const REQUIRED_COLUMNS: string[] = [
  ACCCLOUD_COLUMNS.itemCode,
  ACCCLOUD_COLUMNS.nameTh,
  ACCCLOUD_COLUMNS.uom,
  ACCCLOUD_COLUMNS.groupCode,
];

/**
 * AccCloud unit label → our UOM code.
 *
 * Only the nine values the export actually uses are mapped. An unmapped unit is
 * an ERROR on that row rather than a guess: picking the wrong unit for a
 * chemical silently changes every quantity that follows, and a row we refuse to
 * import is visible while a row we mis-unit is not.
 *
 * `Centimeter` is AccCloud's spelling; ours is CM.
 */
export const UOM_MAP: Record<string, string> = {
  ชิ้น: "PCS",
  SET: "SET",
  GRAM: "GRAM",
  UNIT: "UNIT",
  BOX: "BOX",
  KG: "KG",
  Centimeter: "CM",
  PACK: "PACK",
  SQM: "SQM",
};

/**
 * Groups that are not stock.
 *
 * A default, not a rule — the owner ticks the real set at preview time. These
 * three are pre-unticked because services, fixed assets and transport lines are
 * not things that sit on a shelf, and importing them would put 58 rows into the
 * item master that can never have a quantity.
 */
export const DEFAULT_NON_STOCK_GROUPS = ["SVC", "FA", "TRANS"];

export type RawRow = Record<string, string>;

export type MappedProduct = {
  acccloudItemCode: string;
  sku: string;
  nameTh: string;
  nameEn: string | null;
  uomCode: string;
  groupCode: string;
  groupName: string;
  isActive: boolean;
  /** Null when the export carries no meaningful cost — see below. */
  standardCost: number | null;
  notes: string | null;
};

export type RowOutcome =
  | { kind: "mapped"; product: MappedProduct }
  | { kind: "error"; reason: string; detail?: string }
  | { kind: "excluded"; reason: string; groupCode: string };

const clean = (v: string | undefined | null) => (v ?? "").trim();

/**
 * Interpret one export row.
 *
 * `includedGroups` is the set the owner ticked as inventory. A row outside it is
 * `excluded` rather than `error`: it is a perfectly good AccCloud record that
 * simply is not warehouse stock, and the preview counts the two separately
 * because they need different reactions from a human.
 */
export function mapRow(row: RawRow, includedGroups: Set<string>): RowOutcome {
  const C = ACCCLOUD_COLUMNS;

  const itemCode = clean(row[C.itemCode]);
  if (!itemCode) return { kind: "error", reason: "missingItemCode" };

  const groupCode = clean(row[C.groupCode]);
  if (!groupCode) return { kind: "error", reason: "missingGroup" };

  if (!includedGroups.has(groupCode)) {
    return { kind: "excluded", reason: "groupNotStock", groupCode };
  }

  const nameTh = clean(row[C.nameTh]);
  if (!nameTh) return { kind: "error", reason: "missingName" };

  const rawUom = clean(row[C.uom]);
  const uomCode = UOM_MAP[rawUom];
  if (!uomCode) {
    return { kind: "error", reason: "unknownUom", detail: rawUom || "(blank)" };
  }

  // 'Y' means AccCloud has stopped selling it. Imported as inactive rather than
  // skipped: 31 rows are discontinued, and they may still have stock on a shelf
  // that has to be counted, issued or written off. An item you cannot select
  // for new work but can still account for is exactly what is wanted.
  const isActive = clean(row[C.discontinued]).toUpperCase() !== "Y";

  const nameEn = clean(row[C.nameEn]);

  return {
    kind: "mapped",
    product: {
      acccloudItemCode: itemCode,
      // AccCloud's code is a real, human-readable SKU (BAG-KRAFT-GR-15X20), so
      // it serves as both the WMS sku and the external key rather than
      // inventing a second identifier nobody in the building would recognise.
      sku: itemCode,
      nameTh,
      // Blank on 690 of 731 rows. Left null rather than filled with the Thai
      // name: a copy looks like data and would defeat the point of the column.
      nameEn: nameEn || null,
      uomCode,
      groupCode,
      groupName: clean(row[C.groupName]) || groupCode,
      isActive,
      standardCost: parseCost(row[C.standardCost]),
      notes: clean(row[C.notes]) || null,
    },
  };
}

/**
 * Standard cost, or null.
 *
 * Zero is treated as ABSENT, not as a price. 722 of the 731 rows carry 0, and
 * writing those into product_price_history would bury the nine real costs
 * (0.104–125.0) in noise — worse, a stored 0 reads as "this item is free" to
 * anything that values stock later. An unpriced item is honest; a zero-priced
 * one is a lie with a decimal point.
 *
 * Thousands separators are stripped because AccCloud writes them on larger
 * numbers.
 */
export function parseCost(raw: string | undefined | null): number | null {
  const text = clean(raw).replace(/,/g, "");
  if (!text) return null;

  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return null;
  // A negative standard cost is not a discount, it is a bad export row.
  if (n < 0) return null;

  return n;
}

export type PreviewSummary = {
  total: number;
  create: number;
  update: number;
  excluded: number;
  error: number;
  withCost: number;
  inactive: number;
  /** Every group in the file, with counts, so the owner can tick from reality. */
  groups: { code: string; name: string; rows: number; included: boolean }[];
  /** Distinct unmapped units, so a mapping gap is one message not 94. */
  unknownUoms: { value: string; rows: number }[];
};

/** Group inventory for the tick-list, built from the file rather than assumed. */
export function summariseGroups(
  rows: RawRow[],
  includedGroups: Set<string>,
): PreviewSummary["groups"] {
  const C = ACCCLOUD_COLUMNS;
  const seen = new Map<string, { name: string; rows: number }>();

  for (const row of rows) {
    const code = clean(row[C.groupCode]) || "(blank)";
    const existing = seen.get(code);
    if (existing) existing.rows += 1;
    else seen.set(code, { name: clean(row[C.groupName]) || code, rows: 1 });
  }

  return (
    [...seen.entries()]
      .map(([code, v]) => ({
        code,
        name: v.name,
        rows: v.rows,
        included: includedGroups.has(code),
      }))
      // Largest groups first: the decisions that matter most are the ones
      // affecting hundreds of rows.
      .sort((a, b) => b.rows - a.rows)
  );
}

/** Distinct unmapped units across the file, collapsed for one clear message. */
export function summariseUnknownUoms(rows: RawRow[]): PreviewSummary["unknownUoms"] {
  const C = ACCCLOUD_COLUMNS;
  const seen = new Map<string, number>();

  for (const row of rows) {
    const raw = clean(row[C.uom]);
    if (!UOM_MAP[raw]) seen.set(raw || "(blank)", (seen.get(raw || "(blank)") ?? 0) + 1);
  }

  return [...seen.entries()]
    .map(([value, rows]) => ({ value, rows }))
    .sort((a, b) => b.rows - a.rows);
}
