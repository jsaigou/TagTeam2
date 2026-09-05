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

/**
 * Japanese-style ringback tone, synthesized (no audio asset): a 400 Hz
 * carrier amplitude-modulated at ~20 Hz (the classic NTT trill), 1 s ring
 * + 2 s pause per cycle. Resolves after `cycles` rings; stop() cuts it short
 * and resolves immediately (the far side "answered").
 */
export function playRingback(cycles = 2): { promise: Promise<void>; stop: () => void } {
  let settled = false;
  let resolveFn!: () => void;
  const promise = new Promise<void>((res) => {
    resolveFn = res;
  });
  const ctx = new AudioContext();
  void ctx.resume();

  const env = ctx.createGain();
  env.gain.value = 0.0001;
  env.connect(ctx.destination);
  const am = ctx.createGain();
  am.gain.value = 0.5;
  am.connect(env);
  const carrier = ctx.createOscillator();
  carrier.frequency.value = 400;
  carrier.connect(am);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 20;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.45;
  lfo.connect(lfoDepth);
  lfoDepth.connect(am.gain);
  carrier.start();
  lfo.start();

  const CYCLE_S = 3;
  const t0 = ctx.currentTime + 0.05;
  for (let i = 0; i < cycles; i++) {
    const at = t0 + i * CYCLE_S;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(0.22, at + 0.03);
    env.gain.setValueAtTime(0.22, at + 0.95);
    env.gain.linearRampToValueAtTime(0.0001, at + 1.0);
  }

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(endTimer);
    carrier.stop();
    lfo.stop();
    void ctx.close().catch(() => {});
    resolveFn();
  };
  const endTimer = setTimeout(finish, cycles * CYCLE_S * 1000 + 200);
  return { promise, stop: finish };
}
