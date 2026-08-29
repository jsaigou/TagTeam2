import { synthesizeSpeech } from "./api";

/**
 * Pre-render (ADR-0004) audio for known lines: fetch a TTS-native WAV once per
 * distinct line (Clause) × voice and cache it, so replaying a Prep line doesn't
 * re-hit TTS. Smaller unit = a Clause, but for the MVP slice each authored line
 * is a single Clause (per-clause splitting lands with real authored segmentation).
 */
// Audio playback transfers (detaches) the buffer it receives, so every
// playback needs its own copy of the cached bytes.
const cache = new Map<string, Uint8Array>();

export async function prerenderLine(text: string, voice?: string): Promise<ArrayBuffer> {
  const key = voice ? `${voice}\u0000${text}` : text;
  let bytes = cache.get(key);
  if (!bytes) {
    bytes = new Uint8Array(await synthesizeSpeech(text, voice));
    cache.set(key, bytes);
  }
  return bytes.slice().buffer;
}
