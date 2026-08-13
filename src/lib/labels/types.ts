/**
 * The label service is split into "what to print" and "how to render it", so a
 * ZPL/Zebra driver can be added later without touching a caller (D-32).
 *
 * Labelling policy (D-35) decides which of these actually gets used:
 *  - a product with a factory EAN-13 is scanned as-is and never relabelled
 *  - lot labels are the primary scan target: one per drum or handling unit
 *  - a product with no barcode at all gets a SHELF-EDGE label at its bin,
 *    not a sticker on every piece
 */

export type LabelKind = "product" | "shelf" | "lot" | "location";

/** Small print rendered as label/value pairs. */
export type LabelField = { label: string; value: string };

/**
 * The QC block on a drum label is a BLANK FORM completed by pen when QC passes
 * (D-37): an empty checkbox plus ruled lines for the inspector's name and the
 * date. No status text, no name, no date is printed.
 *
 * Printing the status would create a second source of truth that goes stale the
 * moment QC changes its mind — and a wrong label is more dangerous than no
 * label, because people believe it. A blank box cannot be wrong: either someone
 * ticked it or they did not, and the system holds the detail.
 *
 * This type carries no data on purpose. It exists so a caller can say "this
 * label gets the QC box" without being able to put anything in it.
 */
export type LabelQcBox = true;

export type LabelSpec = {
  kind: LabelKind;
  /** The value encoded in the barcode. Must be ASCII 32-126 (Code 128 subset B). */
  barcode: string;
  /** Large text under the barcode — usually the same as `barcode`. */
  primary: string;
  /** Product or location name. May be Thai; it is never encoded, only printed. */
  secondary?: string;
  details?: LabelField[];
  /** Larger fields for the 100x150 drum label. */
  fields?: LabelField[];
  /** Print the empty hand-tick QC box (drum labels only). */
  qcBox?: LabelQcBox;
};

export type LabelSize = {
  id: string;
  widthMm: number;
  heightMm: number;
  columns: number;
  rows: number;
  /** Which kinds this stock is appropriate for. */
  kinds: LabelKind[];
};

/**
 * Sizes are data so the admin screen can add more without a code change.
 * A4 is 210 x 297 mm, which is what the row and column counts assume.
 */
export const LABEL_SIZES: Record<string, LabelSize> = {
  // Drum and handling-unit label: the big one, with the QC block.
  "100x150": {
    id: "100x150",
    widthMm: 100,
    heightMm: 150,
    columns: 2,
    rows: 1,
    kinds: ["lot"],
  },
  "100x50": {
    id: "100x50",
    widthMm: 100,
    heightMm: 50,
    columns: 2,
    rows: 5,
    kinds: ["product", "lot"],
  },
  // Shelf-edge strip: goes on the bin, not on the goods.
  "100x30": {
    id: "100x30",
    widthMm: 100,
    heightMm: 30,
    columns: 2,
    rows: 9,
    kinds: ["shelf", "product", "location"],
  },
  "50x25": {
    id: "50x25",
    widthMm: 50,
    heightMm: 25,
    columns: 4,
    rows: 10,
    kinds: ["location", "product"],
  },
};

export const DEFAULT_SIZE_FOR: Record<LabelKind, string> = {
  product: "100x50",
  shelf: "100x30",
  lot: "100x150",
  location: "50x25",
};

export function sizesFor(kind: LabelKind): LabelSize[] {
  return Object.values(LABEL_SIZES).filter((s) => s.kinds.includes(kind));
}

export interface LabelRenderer {
  readonly id: string;
  render(labels: LabelSpec[], size: LabelSize): unknown;
}
