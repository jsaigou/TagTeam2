import { synthesizeSpeech } from "./api";

/**
 * Pre-render (ADR-0004) audio for known lines: fetch a 16 kHz mono WAV once per
 * distinct line (Clause) and cache it, so replaying a Prep line twice doesn't
 * re-hit TTS. Smaller unit = a Clause, but for the MVP slice each authored line
 * is a single Clause (per-clause splitting lands with real authored segmentation).
 */
// presentWithAudio() transfers (detaches) the buffer it receives, so every
// playback needs its own copy of the cached bytes.
const cache = new Map<string, Uint8Array>();

export async function prerenderLine(text: string): Promise<ArrayBuffer> {
  let bytes = cache.get(text);
  if (!bytes) {
    bytes = new Uint8Array(await synthesizeSpeech(text));
    cache.set(text, bytes);
  }
  return bytes.slice().buffer;
}

export function hasPrerendered(text: string): boolean {
  return cache.has(text);
}
