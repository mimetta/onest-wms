"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

/**
 * Camera scanning.
 *
 * Formats are restricted deliberately. ZXing will otherwise attempt every
 * symbology it knows, which is slower and more likely to misread a blurry
 * frame as a format we never use. The list is exactly what the warehouse meets
 * (D-36): EAN-13 on most products, EAN-8 on small packs, ITF-14 case codes,
 * our own Code 128, and the COA QR codes on raw-material drums.
 *
 * Wedge scanners decode in hardware, so none of this applies to them.
 *
 * ---
 *
 * Camera constraints are explicit rather than left to the browser (D-42). A
 * field report of "preview works, nothing ever decodes" on an iPhone was traced
 * past the decoder — a synthetic EAN-13 decodes fine through these exact hints,
 * proven in tests/ean13-decode.test.ts — which leaves resolution and lens
 * choice. The browser's default is often 640x480, and an EAN-13 is 95 modules
 * wide: at that resolution, a barcode filling a third of the frame gives about
 * two pixels per module, which is at the edge of readable and past it once
 * focus is imperfect.
 */

const FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.ITF,
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
];

/**
 * Ask for 1080p from the rear camera, and let the browser fall back.
 *
 * `ideal` rather than `exact` throughout: an exact constraint that a device
 * cannot satisfy fails the whole getUserMedia call, which would turn a
 * degraded scan into no camera at all.
 */
const CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    // iOS honours this and it materially helps a 1D barcode held still.
    focusMode: { ideal: "continuous" },
  } as MediaTrackConstraints,
  audio: false,
};

type Diagnostics = {
  attempts: number;
  resolution: string;
  cameraLabel: string;
  lastError: string | null;
};

export function CameraScanner({
  onScan,
  onClose,
  debug = false,
}: {
  onScan: (value: string) => void;
  onClose: () => void;
  /** Set by ?debug=1 — shows what the camera and decoder are actually doing. */
  debug?: boolean;
}) {
  const t = useTranslations("scan");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diagnostics>({
    attempts: 0,
    resolution: "—",
    cameraLabel: "—",
    lastError: null,
  });

  useEffect(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
    // TRY_HARDER costs CPU per frame and buys a lot on 1D barcodes held by
    // hand: it lets the decoder attempt more rotations and scan lines rather
    // than giving up on the first pass.
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new BrowserMultiFormatReader(hints, {
      // Default is 500ms. A picker holds a barcode still for about a second,
      // so this is the difference between two attempts and ten.
      delayBetweenScanAttempts: 100,
    });

    let controls: { stop: () => void } | undefined;
    let cancelled = false;
    let attempts = 0;

    (async () => {
      try {
        controls = await reader.decodeFromConstraints(
          CONSTRAINTS,
          videoRef.current!,
          (result, decodeError) => {
            if (cancelled) return;

            // The callback fires on EVERY attempt, with an error when nothing
            // was found. Counting here is what makes "is the decoder even
            // running?" answerable from the warehouse floor.
            attempts += 1;

            if (result) {
              onScan(result.getText());
              return;
            }

            if (debug && attempts % 5 === 0) {
              const video = videoRef.current;
              const track = (
                video?.srcObject as MediaStream | null
              )?.getVideoTracks?.()[0];

              setDiag({
                attempts,
                resolution: video ? `${video.videoWidth}×${video.videoHeight}` : "—",
                cameraLabel: track?.label ?? "—",
                lastError: decodeError?.name ?? null,
              });
            }
          },
        );
      } catch {
        // Almost always a denied permission or no camera. The wedge scanner
        // still works, so this is degraded rather than broken.
        if (!cancelled) setError(t("cameraUnavailable"));
      }
    })();

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [onScan, t, debug]);

  return (
    <div className="border-brand-border relative overflow-hidden rounded-[10px] border bg-black">
      <video
        ref={videoRef}
        className="aspect-[4/3] w-full object-cover"
        muted
        playsInline
      />

      {/* Aiming guide. Cosmetic only — the decoder sees the whole frame, so a
          barcode outside this box still scans. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-24 w-4/5 rounded border-2 border-white/70" />
      </div>

      {error && (
        <p className="bg-danger-bg text-destructive px-3 py-2 text-sm">{error}</p>
      )}

      {debug && (
        <dl className="absolute bottom-0 left-0 bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-white">
          <div>attempts {diag.attempts}</div>
          <div>frame {diag.resolution}</div>
          <div className="max-w-[60vw] truncate">cam {diag.cameraLabel}</div>
          <div>last {diag.lastError ?? "—"}</div>
        </dl>
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
