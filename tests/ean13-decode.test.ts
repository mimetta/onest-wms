import { describe, expect, it } from "vitest";
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";

/**
 * Does the scanner's decoder configuration actually read an EAN-13?
 *
 * A field report said a real product barcode would not scan on an iPhone,
 * while the camera preview worked and manual entry worked. That leaves two
 * possible layers: the DECODER (wrong formats configured, hints not reaching
 * it) or the CAMERA (frames never delivered, resolution too low, wrong lens).
 *
 * This test isolates the first. It builds a real EAN-13 bitmap in memory and
 * feeds it through exactly the hints the scanner uses. If this passes, the
 * decoder is fine and the fault is in the camera layer — which is not
 * something a unit test can reach, but knowing which half to fix is most of
 * the work.
 */

// EAN-13 module patterns, from the GS1 specification.
const L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const G = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];
const R = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];

/** Which of the first six digits use G rather than L, keyed by the lead digit. */
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

/** Build the 95-module bit string for a 13-digit code. */
function ean13Modules(code: string): string {
  const d = [...code].map(Number);
  const parity = PARITY[d[0]];

  let bits = "101"; // start guard
  for (let i = 1; i <= 6; i++) {
    bits += parity[i - 1] === "L" ? L[d[i]] : G[d[i]];
  }
  bits += "01010"; // centre guard
  for (let i = 7; i <= 12; i++) {
    bits += R[d[i]];
  }
  bits += "101"; // end guard

  return bits;
}

/**
 * Render the bit string as a greyscale bitmap with a quiet zone, at a given
 * module width — the same variable that decides whether a printed label scans.
 *
 * One LUMINANCE byte per pixel, not RGBA: RGBLuminanceSource takes either an
 * Int32Array of ARGB or a Uint8ClampedArray of luminances, and handing it RGBA
 * makes it read four pixels' worth of bytes as four separate pixels. (Which is
 * how the first version of this test "reproduced" the field bug — a reminder
 * that a failing test is only evidence once you have checked the test.)
 */
function renderBitmap(
  bits: string,
  moduleWidth: number,
  height: number,
  quietModules = 10,
) {
  const width = (bits.length + quietModules * 2) * moduleWidth;
  const data = new Uint8ClampedArray(width * height).fill(255);

  for (let x = 0; x < width; x++) {
    const moduleIndex = Math.floor(x / moduleWidth) - quietModules;
    const dark =
      moduleIndex >= 0 && moduleIndex < bits.length && bits[moduleIndex] === "1";
    if (!dark) continue;

    for (let y = 0; y < height; y++) {
      data[y * width + x] = 0;
    }
  }

  return { data, width, height };
}

/** The exact hints the CameraScanner component configures. */
function scannerHints() {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.ITF,
    BarcodeFormat.CODE_128,
    BarcodeFormat.QR_CODE,
  ]);
  return hints;
}

function decode(code: string, moduleWidth = 3, hints = scannerHints()) {
  const { data, width, height } = renderBitmap(ean13Modules(code), moduleWidth, 120);
  const source = new RGBLuminanceSource(data, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));

  const reader = new MultiFormatReader();
  reader.setHints(hints);

  // decodeWithState(), NOT decode(). MultiFormatReader.decode(image) compares
  // its stored hints against the (undefined) argument, decides they differ, and
  // resets them — silently trying every symbology it knows. BrowserMultiFormat-
  // Reader overrides decodeBitmap to call decodeWithState for exactly this
  // reason, so this matches what the scanner actually does.
  return reader.decodeWithState(bitmap);
}

describe("EAN-13 decoding with the scanner's configuration", () => {
  it("decodes the barcode from the field report", () => {
    // The exact value the warehouse tried to scan: a Thai GS1 prefix (885).
    const result = decode("8859921000383");
    expect(result.getText()).toBe("8859921000383");
    expect(result.getBarcodeFormat()).toBe(BarcodeFormat.EAN_13);
  });

  it("decodes other real-world EAN-13 values", () => {
    for (const code of ["4006381333931", "5012345678900", "9780306406157"]) {
      expect(decode(code).getText()).toBe(code);
    }
  });

  it("still decodes at a narrow module width", () => {
    // A 4cm label prints roughly 2-3 pixels per module in a 640px camera frame.
    // If this fails, the field failure is about resolution rather than config.
    expect(decode("8859921000383", 2).getText()).toBe("8859921000383");
  });

  it("fails when EAN-13 is not in the allowed formats", () => {
    // Proves the format restriction is doing something — if the scanner ever
    // stops listing EAN_13, this is the failure mode users would see.
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128]);
    expect(() => decode("8859921000383", 3, hints)).toThrow();
  });
});
