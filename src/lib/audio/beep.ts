"use client";

/**
 * Scan feedback tones, synthesised with WebAudio.
 *
 * No audio files: a tone generated in the browser cannot fail to load on poor
 * warehouse Wi-Fi, needs no cache warming, and adds nothing to the bundle.
 *
 * Accept and reject differ in PITCH, LENGTH and RHYTHM — not just volume.
 * A warehouse is loud and a worker may be wearing ear protection, so a single
 * distinguishing feature is not enough: the reject tone is low, longer, and
 * double, which is recognisable even when half heard.
 */

let context: AudioContext | null = null;

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!context) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  }
  // iOS suspends the context until a user gesture; a scan is a gesture, so
  // resuming here is both allowed and the earliest useful moment.
  if (context.state === "suspended") void context.resume();
  return context;
}

function tone(frequency: number, durationMs: number, startOffsetMs = 0) {
  const ctx = ensureContext();
  if (!ctx) return;

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = "square"; // carries further than a sine in a noisy room
  oscillator.frequency.value = frequency;

  const start = ctx.currentTime + startOffsetMs / 1000;
  const end = start + durationMs / 1000;

  // A short ramp instead of a hard start and stop: an abrupt square wave
  // clicks, which on a cheap handheld speaker sounds like a fault.
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.18, start + 0.008);
  gain.gain.setValueAtTime(0.18, end - 0.01);
  gain.gain.linearRampToValueAtTime(0, end);

  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(end);
}

/** Short, high, single. "Got it, keep going." */
export function beepAccept() {
  tone(1180, 70);
}

/** Low, long, double. Unmistakably not the accept tone. */
export function beepReject() {
  tone(340, 160);
  tone(280, 220, 200);
}

/**
 * A distinct third tone for "recognised, but you cannot use it" — a lot that
 * has not passed QC, a bin that blocks issue. Falling two-note figure: not an
 * error, but not a green light either.
 */
export function beepWarn() {
  tone(880, 90);
  tone(660, 140, 110);
}
