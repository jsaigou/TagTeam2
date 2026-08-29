/**
 * Direct WAV playback for Prep examples: the Japanese lines play as plain audio
 * (homelab BYO-TTS voices), NOT through the presenter — Luna does not speak
 * them. English coaching and the opener stay on Luna via present().
 */

// Homelab TTS voices for the Prep examples (probed live on tts.mango-rockhopper.ts.net):
// female first, then male — each example plays once per voice.
export const PREP_VOICES = ["lauren_us", "bert"] as const;

let active: { el: HTMLAudioElement; url: string; cancel: () => void } | null = null;

/** Play a WAV buffer directly. Resolves when playback ends (or is stopped). */
export function playWav(buffer: ArrayBuffer): Promise<void> {
  stopWav();
  return new Promise<void>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    const el = new Audio(url);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      el.onended = null;
      el.onerror = null;
      el.pause();
      URL.revokeObjectURL(url);
      if (active?.el === el) active = null;
      if (err) reject(err);
      else resolve();
    };
    active = { el, url, cancel: () => finish() };
    el.onended = () => finish();
    el.onerror = () => finish(new Error("audio playback failed"));
    el.play().catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/** Stop the currently playing Prep audio, resolving its playWav() promise. */
export function stopWav(): void {
  active?.cancel();
}
