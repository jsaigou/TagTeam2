import { synthesizeSpeech } from "./api";

/**
 * Pre-render (ADR-0004) audio for known lines: fetch a 16 kHz mono WAV once per
 * distinct line (Clause) and cache it, so replaying a Prep line twice doesn't
 * re-hit TTS. Smaller unit = a Clause, but for the MVP slice each authored line
 * is a single Clause (per-clause splitting lands with real authored segmentation).
 */
const cache = new Map<string, ArrayBuffer>();

export async function prerenderLine(text: string): Promise<ArrayBuffer> {
  const hit = cache.get(text);
  if (hit) return hit;
  const wav = await synthesizeSpeech(text);
  cache.set(text, wav);
  return wav;
}

export function hasPrerendered(text: string): boolean {
  return cache.has(text);
}
