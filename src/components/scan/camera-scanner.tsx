"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

/**
 * Camera scanning.
 *
 * Formats are restricted deliberately. ZXing will happily attempt every
 * symbology it knows, which is slower and — worse — more likely to misread a
 * blurry frame as some format we never use. The list below is exactly what the
 * warehouse actually encounters (D-36):
 *
 *   EAN-13   factory GTIN on most products
 *   EAN-8    small consumer packs
 *   ITF      14-digit case codes on outer cartons
 *   CODE_128 our own internal labels: SKU, lot, bin
 *   QR       the COA codes on some raw-material drums
 *
 * Wedge scanners do their own decoding, so none of this applies to them.
 */
const FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.ITF,
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
];

export function CameraScanner({
  onScan,
  onClose,
}: {
  onScan: (value: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("scan");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
    const reader = new BrowserMultiFormatReader(hints);

    let controls: { stop: () => void } | undefined;
    let cancelled = false;

    (async () => {
      try {
        controls = await reader.decodeFromVideoDevice(
          // undefined = let the browser choose, which picks the rear camera on
          // a phone. Naming a device id would break on every other handset.
          undefined,
          videoRef.current!,
          (result) => {
            if (result && !cancelled) onScan(result.getText());
          },
        );
      } catch {
        // Almost always a denied permission or a device with no camera. Either
        // way the wedge scanner still works, so this is a degraded state and
        // not a failure of the screen.
        if (!cancelled) setError(t("cameraUnavailable"));
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [onScan, t]);

  return (
    <div className="border-brand-border relative overflow-hidden rounded-[10px] border bg-black">
      <video
        ref={videoRef}
        className="aspect-[4/3] w-full object-cover"
        muted
        playsInline
      />

      {/* Aiming guide: a barcode centred in this box is in focus range. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-24 w-4/5 rounded border-2 border-white/70" />
      </div>

      {error && (
        <p className="bg-danger-bg text-destructive px-3 py-2 text-sm">{error}</p>
      )}

      <button
        type="button"
        onClick={onClose}
        className="absolute top-2 right-2 rounded-md bg-black/60 px-3 py-1.5 text-sm text-white"
      >
        {t("closeCamera")}
      </button>
    </div>
  );
}
