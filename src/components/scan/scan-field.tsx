"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useScanner, type ScanEvent } from "@/hooks/use-scanner";
import { CameraScanner } from "./camera-scanner";

/**
 * The scan input every scan-driven screen is built from.
 *
 * Three input paths, one handler:
 *   - a keyboard-wedge scanner, detected by keystroke timing anywhere on the page
 *   - the camera, for a phone with no scanner attached
 *   - typing, for when a label is damaged and someone reads it out
 *
 * The field keeps focus and clears itself after every scan, so a receiver can
 * scan twenty items without touching anything. Autofocus is aggressive on
 * purpose: on these screens, the input losing focus is the bug.
 */
export function ScanField({
  onScan,
  label,
  disabled = false,
  autoFocus = true,
}: {
  onScan: (event: ScanEvent) => void;
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const t = useTranslations("scan");
  const inputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [value, setValue] = useState("");

  const handle = useCallback(
    (event: ScanEvent) => {
      setValue("");
      onScan(event);
    },
    [onScan],
  );

  // The wedge listener is on the window, not the input: a scanner fires
  // wherever focus happens to be, and a receiver who has tapped a button
  // should not have to click back into the field before scanning again.
  const { submit } = useScanner({ onScan: handle, enabled: !disabled && !cameraOpen });

  useEffect(() => {
    if (autoFocus && !disabled && !cameraOpen) inputRef.current?.focus();
  }, [autoFocus, disabled, cameraOpen]);

  return (
    <div className="flex flex-col gap-2">
      {label && (
        <label htmlFor="scan-input" className="text-brand-dark text-sm font-medium">
          {label}
        </label>
      )}

      <div className="flex gap-2">
        <input
          id="scan-input"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Manual entry: the wedge path already consumed fast bursts, so an
            // Enter arriving here is a human finishing typing.
            if (e.key === "Enter") {
              e.preventDefault();
              submit(value, "manual");
            }
          }}
          onBlur={() => {
            // Refocus unless the camera took over. Warehouse handhelds fire
            // stray touch events; losing the field mid-receipt is worse than
            // being mildly insistent.
            if (autoFocus && !disabled && !cameraOpen) {
              setTimeout(() => inputRef.current?.focus(), 0);
            }
          }}
          disabled={disabled}
          placeholder={t("placeholder")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          // Big target and big text: this is read and tapped at arm's length
          // (D-25 — legibility beats palette on scan screens).
          className="border-brand-border text-brand-dark placeholder:text-brand-subtle h-14 min-w-0 flex-1 rounded-md border-2 bg-white px-4 font-mono text-lg"
        />

        <button
          type="button"
          onClick={() => setCameraOpen((v) => !v)}
          disabled={disabled}
          className="border-brand-border text-brand-dark hover:bg-brand-cream h-14 shrink-0 rounded-md border-2 px-4 text-sm"
        >
          {cameraOpen ? t("closeCamera") : t("useCamera")}
        </button>
      </div>

      {cameraOpen && (
        <CameraScanner
          onScan={(scanned) => {
            submit(scanned, "camera");
            // Closing after a hit prevents the same label being read again as
            // the operator lowers the phone.
            setCameraOpen(false);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
