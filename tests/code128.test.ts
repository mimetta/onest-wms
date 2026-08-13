import { describe, expect, it } from "vitest";
import {
  Code128Error,
  code128Modules,
  code128PathData,
  encodeCode128B,
} from "../src/lib/labels/code128";

/**
 * A wrong barcode is worse than no barcode: it scans, it resolves to nothing,
 * and the receiver blames the scanner. These tests check the encoding against
 * values computed by hand from the Code 128 specification.
 */
describe("Code 128 subset B", () => {
  it("encodes the canonical example from the specification", () => {
    // "PJJ123C" is the worked example in the Code 128 standard, whose check
    // character is 54. Start(104) P(48) J(42) J(42) 1(17) 2(18) 3(19) C(35)
    // checksum = (104 + 48*1 + 42*2 + 42*3 + 17*4 + 18*5 + 19*6 + 35*7) % 103
    //          = (104 + 48 + 84 + 126 + 68 + 90 + 114 + 245) % 103
    //          = 879 % 103 = 54
    const widths = encodeCode128B("PJJ123C");

    // 8 symbols + checksum + stop = 10 patterns of 6, plus the trailing bar.
    expect(widths).toHaveLength(10 * 6 + 1);
    expect(widths.at(-1)).toBe(2);
  });

  it("starts with Start B and ends with the stop pattern's final bar", () => {
    const widths = encodeCode128B("A");
    // Start B is code value 104, pattern 211214. (211412 is Start A, 103 —
    // an easy pair to transpose, which is why this test pins the value.)
    expect(widths.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]);
    // Stop is 2331112: six digits from the table plus the trailing 2-module bar.
    expect(widths.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
  });

  it("produces a different symbol for every distinct input", () => {
    const seen = new Map<string, string>();
    for (const value of [
      "A-01-01",
      "A-01-02",
      "RM-SOLV-001",
      "RM-SOLV-002",
      "8850000000038",
    ]) {
      const key = encodeCode128B(value).join("");
      expect(seen.has(key)).toBe(false);
      seen.set(key, value);
    }
  });

  it("handles every character our codes actually use", () => {
    const realistic = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-. /";
    expect(() => encodeCode128B(realistic)).not.toThrow();
  });

  it("rejects characters outside subset B", () => {
    // Thai product names are never encoded — labels carry the SKU, not the name.
    expect(() => encodeCode128B("ตัวทำละลาย")).toThrow(Code128Error);
  });

  it("rejects an empty value", () => {
    expect(() => encodeCode128B("")).toThrow(Code128Error);
  });

  it("reports a module count matching the width list", () => {
    const value = "A-01-01";
    const total = encodeCode128B(value).reduce((a, b) => a + b, 0);
    expect(code128Modules(value)).toBe(total);
  });

  it("renders path data whose bar count matches the encoding", () => {
    const value = "GR-2026-00001";
    const widths = encodeCode128B(value);
    const path = code128PathData(value, 1, 40);

    // Bars are the even-indexed entries; each contributes one "M…z" subpath.
    const expectedBars = widths.filter((_, i) => i % 2 === 0).length;
    expect(path.split("z").length - 1).toBe(expectedBars);
  });

  it("scales module width into the path geometry", () => {
    const wide = code128PathData("A", 2, 40);
    const narrow = code128PathData("A", 1, 40);
    expect(wide).not.toBe(narrow);
    // First bar of Start B is 2 modules: 4 units at moduleWidth 2, 2 at 1.
    expect(wide.startsWith("M0 0h4v40")).toBe(true);
    expect(narrow.startsWith("M0 0h2v40")).toBe(true);
  });
});

/**
 * Round-trip decoding.
 *
 * The tests above check structure — that the symbol is shaped like Code 128.
 * These decode the widths back into characters using an independent reading of
 * the pattern table, which is the closest thing to putting a scanner on the
 * printed label. A barcode that looks right and scans wrong is the failure this
 * catches.
 */
describe("Code 128 round trip", () => {
  // Rebuilt from the module widths rather than imported, so a corrupted table
  // in the encoder cannot make its own output look correct.
  function decode(widths: number[]): string {
    // Drop the trailing 2-module bar that belongs to the stop pattern.
    const body = widths.slice(0, -1);
    expect(body.length % 6).toBe(0);

    const values: number[] = [];
    for (let i = 0; i < body.length; i += 6) {
      values.push(patternValue(body.slice(i, i + 6).join("")));
    }

    const start = values.shift();
    const stop = values.pop();
    const check = values.pop();

    expect(start).toBe(104); // Start B
    expect(stop).toBe(106); // Stop

    // Recompute the check character exactly as a scanner would.
    let sum = 104;
    values.forEach((v, i) => (sum += v * (i + 1)));
    expect(check).toBe(sum % 103);

    return values.map((v) => String.fromCharCode(v + 32)).join("");
  }

  function patternValue(pattern: string): number {
    const index = TABLE.indexOf(pattern);
    if (index === -1) throw new Error(`unknown pattern ${pattern}`);
    return index;
  }

  // Independent copy of the pattern table, read from the specification.
  const TABLE =
    "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 233111".split(
      " ",
    );

  it.each([
    "A-01-01",
    "RM-SOLV-001",
    "8850000000038",
    "GR-2026-00001",
    "L2508-001",
    "EQ-PUMP-01-SN0004",
  ])("decodes %s back to itself", (value) => {
    expect(decode(encodeCode128B(value))).toBe(value);
  });
});
