/**
 * Prep example playback: every sentence in a variant's prep-lines.json is
 * pre-rendered offline (see server/scripts/render-prep-audio.mjs) to a static
 * MP3 under app/public/prep-audio/, keyed by (scenario, variant, pool index,
 * voice) — stable because Flow.tsx's prepPool is exactly content.prep_lines
 * in file order, so pool index === the line's index in that array.
 *
 * Falls back to live BYO-TTS (prerenderLine + playWav, the pre-bake's own
 * pre-existing runtime cache) for any line the render pass hasn't covered
 * yet — new/edited content plays correctly from the first deploy, just
 * without the instant-playback win until the next render pass.
 */
import { prerenderLine } from "./prerender";
import { playAudioUrl, playWav } from "./audio";

function prepAudioPath(scenarioId: string, variantId: string, index: number, voice: string): string {
  return `/prep-audio/${scenarioId}-${variantId}-${index}-${voice}.mp3`;
}

export async function playPrepExample(
  scenarioId: string,
  variantId: string,
  index: number,
  voice: string,
  ja: string,
): Promise<void> {
  const ok = await playAudioUrl(prepAudioPath(scenarioId, variantId, index, voice));
  if (ok) return;
  await playWav(await prerenderLine(ja, voice));
}
