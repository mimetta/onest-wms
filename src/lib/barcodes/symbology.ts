/**
 * Barcode symbology helpers.
 *
 * The system treats a scanned string as an OPAQUE VALUE resolved through
 * `product_barcodes` (D-36). Nothing here decides what a barcode *means* — that
 * is a database lookup. These functions only classify a value at CAPTURE time,
 * when a human is being asked "what did you just scan?", so the form can offer
 * a sensible default instead of an empty dropdown.
 *
 * Most products carry a factory GS1 EAN-13. Those are scanned as-is and never
 * relabelled, so the majority of scans never touch our own Code 128 at all.
 */

export type GuessedSymbology = "ean13" | "itf14" | "code128" | "unknown";

/**
 * GS1 modulo-10 check digit, used by both EAN-13 and ITF-14.
 *
 * Weights alternate 3,1,3,1… reading right-to-left from the digit before the
 * check digit. Implemented over the reversed body so the same code serves both
 * lengths rather than special-casing each.
 */
export function gs1CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const reversed = [...digitsWithoutCheck].reverse();

  reversed.forEach((char, index) => {
    const digit = Number(char);
    sum += index % 2 === 0 ? digit * 3 : digit;
  });

  return (10 - (sum % 10)) % 10;
}

function isAllDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

/** True when `value` is 13 digits with a valid GS1 check digit. */
export function isValidEan13(value: string): boolean {
  if (value.length !== 13 || !isAllDigits(value)) return false;
  return gs1CheckDigit(value.slice(0, 12)) === Number(value[12]);
}

/** True when `value` is 14 digits with a valid GS1 check digit. */
export function isValidItf14(value: string): boolean {
  if (value.length !== 14 || !isAllDigits(value)) return false;
  return gs1CheckDigit(value.slice(0, 13)) === Number(value[13]);
}

/**
 * Best guess at what was scanned, for defaulting the capture form only.
 *
 * A wrong guess costs one dropdown change. It never affects resolution, which
 * is why this is allowed to be a heuristic rather than a certainty.
 */
export function guessSymbology(value: string): GuessedSymbology {
  if (isValidEan13(value)) return "ean13";
  if (isValidItf14(value)) return "itf14";
  if (value.length > 0) return "code128";
  return "unknown";
}

export type CaptureSuggestion = {
  symbology: GuessedSymbology;
  /** What `product_barcodes.type` should default to. */
  barcodeType: "internal" | "supplier" | "case" | "other";
  /**
   * True when the operator must be asked which unit this code represents. A
   * 14-digit ITF is almost always a case or outer carton, and guessing the unit
   * would silently make every receipt of that code wrong by a factor of the
   * case quantity.
   */
  needsUomPrompt: boolean;
  /** Digits-only value that failed its check digit — worth warning about. */
  checkDigitFailed: boolean;
};

/**
 * Classify a freshly captured barcode.
 *
 * Rules agreed with the owner:
 *  - 13 digits with a valid check digit → factory EAN-13, default `supplier`
 *  - 14 digits with a valid check digit → likely a case code, prompt for UOM
 *  - anything else → treated as an internal Code 128 value
 */
export function suggestCapture(value: string): CaptureSuggestion {
  const trimmed = value.trim();

  if (isValidEan13(trimmed)) {
    return {
      symbology: "ean13",
      barcodeType: "supplier",
      needsUomPrompt: false,
      checkDigitFailed: false,
    };
  }

  if (isValidItf14(trimmed)) {
    return {
      symbology: "itf14",
      barcodeType: "case",
      needsUomPrompt: true,
      checkDigitFailed: false,
    };
  }

  // Right length to be GS1, wrong check digit: usually a misread or a typo, and
  // worth surfacing rather than silently storing as an internal code.
  const looksGs1 =
    (trimmed.length === 13 || trimmed.length === 14) && isAllDigits(trimmed);

  return {
    symbology: "code128",
    barcodeType: "internal",
    // A long digit string that is not valid GS1 might still be a case code, so
    // ask rather than assume pieces.
    needsUomPrompt: looksGs1,
    checkDigitFailed: looksGs1,
  };
}
