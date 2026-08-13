import { describe, expect, it } from "vitest";
import {
  gs1CheckDigit,
  guessSymbology,
  isValidEan13,
  isValidItf14,
  suggestCapture,
} from "../src/lib/barcodes/symbology";

describe("GS1 check digits", () => {
  it("computes the check digit for known real EAN-13 codes", () => {
    // Widely published GTINs, check digit removed.
    expect(gs1CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(gs1CheckDigit("501234567890")).toBe(0); // 5012345678900
    expect(gs1CheckDigit("978030640615")).toBe(7); // 9780306406157
  });

  it("accepts valid EAN-13 and rejects a single-digit corruption", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("9780306406157")).toBe(true);
    // Same code with one digit changed: the check digit no longer agrees.
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("4016381333931")).toBe(false);
  });

  it("rejects wrong lengths and non-digits", () => {
    expect(isValidEan13("400638133393")).toBe(false); // 12
    expect(isValidEan13("40063813339311")).toBe(false); // 14
    expect(isValidEan13("400638133393X")).toBe(false);
    expect(isValidEan13("")).toBe(false);
  });

  it("validates ITF-14 with the same algorithm", () => {
    // An EAN-13 packed into a case code: leading indicator digit plus the
    // 12-digit body, with a freshly computed check digit.
    const body = "1400638133393";
    const code = body + String(gs1CheckDigit(body));
    expect(code).toHaveLength(14);
    expect(isValidItf14(code)).toBe(true);
    expect(isValidEan13(code)).toBe(false);
  });
});

describe("capture classification", () => {
  it("defaults a factory EAN-13 to a supplier barcode with no UOM prompt", () => {
    const s = suggestCapture("4006381333931");
    expect(s.symbology).toBe("ean13");
    expect(s.barcodeType).toBe("supplier");
    expect(s.needsUomPrompt).toBe(false);
    expect(s.checkDigitFailed).toBe(false);
  });

  it("treats a valid 14-digit code as a case and asks for the unit", () => {
    const body = "1400638133393";
    const s = suggestCapture(body + String(gs1CheckDigit(body)));
    expect(s.symbology).toBe("itf14");
    expect(s.barcodeType).toBe("case");
    // Guessing pieces here would make every receipt of this code wrong by the
    // case quantity, so the operator is always asked.
    expect(s.needsUomPrompt).toBe(true);
  });

  it("treats our own codes as internal Code 128", () => {
    for (const value of ["RM-SOLV-001", "A-01-01", "L2508-001", "GR-2026-00001"]) {
      const s = suggestCapture(value);
      expect(s.symbology).toBe("code128");
      expect(s.barcodeType).toBe("internal");
      expect(s.needsUomPrompt).toBe(false);
    }
  });

  it("flags a 13-digit code whose check digit fails", () => {
    const s = suggestCapture("4006381333932");
    expect(s.checkDigitFailed).toBe(true);
    // Still capturable — a supplier with a bad barcode is their problem to fix,
    // not a reason to block receiving — but the operator is warned.
    expect(s.barcodeType).toBe("internal");
  });

  it("trims surrounding whitespace, which wedge scanners sometimes append", () => {
    expect(suggestCapture("  4006381333931 ").symbology).toBe("ean13");
  });

  it("guesses nothing for an empty value", () => {
    expect(guessSymbology("")).toBe("unknown");
  });
});

describe("symbology never affects resolution", () => {
  it("classifies without altering the value", () => {
    // The resolver looks the raw string up in product_barcodes; these helpers
    // must not normalise, pad or reformat anything (D-36).
    const values = ["4006381333931", "RM-SOLV-001", "0000000000000"];
    for (const v of values) {
      const before = v;
      suggestCapture(v);
      guessSymbology(v);
      expect(v).toBe(before);
    }
  });
});
