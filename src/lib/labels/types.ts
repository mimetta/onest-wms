/**
 * The label service is deliberately split into "what to print" and "how to
 * render it", so a ZPL/Zebra driver can be added later without touching a
 * single caller (D-32).
 *
 * A screen builds LabelSpec objects; a LabelRenderer turns them into output.
 * Phase 1 ships only the browser-printable renderer, because no printer has
 * been bought yet and an A4 sheet of labels works on any office printer.
 */

export type LabelKind = "product" | "lot" | "location";

/** One physical label. */
export type LabelSpec = {
  kind: LabelKind;
  /** The value encoded in the barcode. Must be ASCII 32-126 (Code 128 subset B). */
  barcode: string;
  /** Large text under the barcode — usually the same as `barcode`. */
  primary: string;
  /** Product or location name. May be Thai; it is never encoded, only printed. */
  secondary?: string;
  /** Lot number, expiry date, unit — small print, at most three entries. */
  details?: { label: string; value: string }[];
};

export type LabelSize = {
  id: string;
  /** Millimetres — label stock is specified in mm everywhere in the trade. */
  widthMm: number;
  heightMm: number;
  /** Labels across and down a single A4 sheet. */
  columns: number;
  rows: number;
};

/**
 * Two sizes to start, both from the palette doc's defaults. Sizes are data so
 * the admin screen can add more without a code change.
 */
export const LABEL_SIZES: Record<string, LabelSize> = {
  "100x50": { id: "100x50", widthMm: 100, heightMm: 50, columns: 2, rows: 5 },
  "50x25": { id: "50x25", widthMm: 50, heightMm: 25, columns: 4, rows: 10 },
};

export const DEFAULT_SIZE_FOR: Record<LabelKind, string> = {
  product: "100x50",
  lot: "100x50",
  location: "50x25",
};

export interface LabelRenderer {
  readonly id: string;
  /**
   * Render a batch. The browser renderer returns markup; a future ZPL renderer
   * would return a command string for the printer, from the same input.
   */
  render(labels: LabelSpec[], size: LabelSize): unknown;
}
