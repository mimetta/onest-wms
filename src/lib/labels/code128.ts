/**
 * Code 128 encoder, subset B.
 *
 * Hand-written rather than pulled from a package on purpose. The popular
 * JavaScript barcode libraries render into a DOM or a canvas, which makes them
 * awkward to use in a Server Component; and this project needs the *bar widths*
 * rather than a picture, because a ZPL driver later will want the same encoded
 * data expressed differently (D-32). Owning ~90 lines of well-specified logic
 * beats bending a rendering library into a data source.
 *
 * Subset B covers ASCII 32–126: uppercase, lowercase, digits and punctuation.
 * That is every character our SKUs, lot numbers and bin codes use. Subset C
 * would pack pairs of digits more tightly, but the extra complexity buys
 * nothing at these code lengths.
 */

/**
 * The 107 Code 128 patterns.
 *
 * Each entry is six digits: alternating bar and space widths in modules,
 * starting with a bar. Index = the symbol's code value. Taken from the Code 128
 * specification; verified by the check-digit tests in tests/code128.test.ts.
 */
const PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "233111",
] as const;

const START_B = 104;
const STOP = 106;

/** Lowest and highest character this subset can express. */
const MIN_CHAR = 32;
const MAX_CHAR = 126;

export class Code128Error extends Error {}

/**
 * Encode `value` into a run-length list of module widths.
 *
 * The returned array always starts with a bar and alternates bar, space, bar,
 * space… Each number is a width in modules (1–4).
 */
export function encodeCode128B(value: string): number[] {
  if (value.length === 0) {
    throw new Code128Error("cannot encode an empty string");
  }

  const codes: number[] = [START_B];

  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point < MIN_CHAR || point > MAX_CHAR) {
      throw new Code128Error(
        `character ${JSON.stringify(char)} is outside Code 128 subset B (ASCII 32-126)`,
      );
    }
    codes.push(point - MIN_CHAR);
  }

  // Checksum: start value, plus each data value weighted by its 1-based
  // position, modulo 103.
  let checksum = START_B;
  for (let i = 1; i < codes.length; i++) {
    checksum += codes[i] * i;
  }
  codes.push(checksum % 103);
  codes.push(STOP);

  const widths: number[] = [];
  for (const code of codes) {
    for (const digit of PATTERNS[code]) {
      widths.push(Number(digit));
    }
  }

  // The stop pattern carries a final 2-module bar that is not part of the
  // six-digit pattern table.
  widths.push(2);

  return widths;
}

/** Total width of the symbol in modules — useful for sizing before rendering. */
export function code128Modules(value: string): number {
  return encodeCode128B(value).reduce((sum, w) => sum + w, 0);
}

/**
 * Build SVG path data for the bars only. Spaces are left as background, so the
 * caller controls the quiet zone and colours.
 *
 * Rendering as a single `<path>` rather than one `<rect>` per bar keeps the
 * markup small: a 20-character code is ~200 modules, which would otherwise be
 * fifty separate elements on every label on a sheet of forty.
 */
export function code128PathData(
  value: string,
  moduleWidth: number,
  height: number,
): string {
  const widths = encodeCode128B(value);
  const parts: string[] = [];
  let x = 0;
  let isBar = true;

  for (const modules of widths) {
    const w = modules * moduleWidth;
    if (isBar) {
      parts.push(`M${round(x)} 0h${round(w)}v${round(height)}h-${round(w)}z`);
    }
    x += w;
    isBar = !isBar;
  }

  return parts.join("");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
