"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One input pipeline, two hardware paths.
 *
 * A keyboard-wedge scanner "types" its payload and presses Enter. A camera scan
 * produces a string from a video frame. Both arrive here, so every screen built
 * on this hook works with either without knowing which is in use.
 *
 * Wedge detection is by TIMING, not by content: a scanner emits characters far
 * faster than a human types. Content-based detection would be wrong the moment
 * someone types a short SKU by hand, which is a normal fallback when a label is
 * damaged.
 */

/** Gap above which two keystrokes are assumed to be human, in milliseconds. */
const HUMAN_GAP_MS = 60;

/** Minimum characters before a fast burst is treated as a scan. */
const MIN_SCAN_LENGTH = 3;

/** A repeat of the same code inside this window is one scan, not two. */
const DUPLICATE_WINDOW_MS = 700;

export type ScanSource = "wedge" | "camera" | "manual";

export type ScanEvent = { value: string; source: ScanSource };

export function useScanner({
  onScan,
  enabled = true,
}: {
  onScan: (event: ScanEvent) => void;
  enabled?: boolean;
}) {
  const buffer = useRef("");
  const lastKeyAt = useRef(0);
  const lastScan = useRef<{ value: string; at: number } | null>(null);
  const [lastSource, setLastSource] = useState<ScanSource | null>(null);

  const emit = useCallback(
    (value: string, source: ScanSource) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // Scanners bounce: a second read of the same label microseconds later is
      // the same physical event, and would otherwise add a duplicate line.
      const now = Date.now();
      const previous = lastScan.current;
      if (
        previous &&
        previous.value === trimmed &&
        now - previous.at < DUPLICATE_WINDOW_MS
      ) {
        return;
      }
      lastScan.current = { value: trimmed, at: now };

      setLastSource(source);
      onScan({ value: trimmed, source });
    },
    [onScan],
  );

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const now = Date.now();
      const gap = now - lastKeyAt.current;
      lastKeyAt.current = now;

      if (event.key === "Enter") {
        const captured = buffer.current;
        buffer.current = "";
        if (captured.length >= MIN_SCAN_LENGTH) {
          // Enter after a fast burst: a scan. Suppressed so it does not also
          // submit whatever form the field sits in.
          event.preventDefault();
          emit(captured, "wedge");
        }
        return;
      }

      // Ignore modifiers, arrows, function keys — anything that is not a
      // single printable character.
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // A slow keystroke means a human started typing: drop whatever partial
      // burst was accumulating rather than splicing the two together.
      if (gap > HUMAN_GAP_MS) {
        buffer.current = event.key;
      } else {
        buffer.current += event.key;
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, emit]);

  /** Feed a value in from the camera reader or a manual entry field. */
  const submit = useCallback(
    (value: string, source: ScanSource = "manual") => emit(value, source),
    [emit],
  );

  return { submit, lastSource };
}
