/**
 * Direct WAV playback for Prep examples: the Japanese lines play as plain audio
 * (homelab BYO-TTS voices), NOT through the presenter — Luna does not speak
 * them. English coaching and the opener stay on Luna via present().
 */
import { synthesizeSpeech } from "./api";

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

// Layered SFX beds (codec easter egg: background morse, a one-shot radio
// blip, a low ambient texture under the dialogue) — a shared AudioContext so
// they can play simultaneously and be faded/stopped independently of
// whatever the presenter's own (separate) audio pipeline is doing.
export interface SfxHandle {
  setVolume: (value: number, rampMs?: number) => void;
  stop: (fadeMs?: number) => void;
}

async function loadAudioBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  const bytes = await res.arrayBuffer();
  return ctx.decodeAudioData(bytes);
}

/** Loops a clip at `volume` until stopped. */
export async function playSfxLoop(ctx: AudioContext, url: string, volume = 1): Promise<SfxHandle> {
  const buffer = await loadAudioBuffer(ctx, url);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start();
  return {
    setVolume(value, rampMs = 0) {
      const now = ctx.currentTime;
      if (rampMs > 0) gain.gain.linearRampToValueAtTime(value, now + rampMs / 1000);
      else gain.gain.setValueAtTime(value, now);
    },
    stop(fadeMs = 0) {
      const now = ctx.currentTime;
      if (fadeMs > 0) {
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.0001, now + fadeMs / 1000);
        src.stop(now + fadeMs / 1000 + 0.05);
      } else {
        src.stop();
      }
    },
  };
}

/** Plays a clip once at `volume`; resolves when it finishes. */
export async function playSfxOnce(ctx: AudioContext, url: string, volume = 1): Promise<void> {
  const buffer = await loadAudioBuffer(ctx, url);
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    src.onended = () => resolve();
    src.start();
  });
}

// "All your base" egg: CATS' lines are Luna's normal TTS voice put through a
// deterministic DSP chain (band-limiting + waveshaper distortion, then a
// ring-mod buzz + bit-crush applied by hand to the rendered samples) rather
// than a pre-baked clip — unlike the codec egg's fixed Colonel line, this
// one's text changes per scenario (see aybTargetWord), so there's no fixed
// asset to bake.
//
// QA caught the first tuning (bandpass Q0.7 @1400Hz, distortion amount 18,
// 6-bit crush) turning "booking" into something that reads as profanity —
// almost certainly the tight bandpass stripping the low-frequency energy
// that distinguishes a "b" plosive burst from an "f" fricative, compounded
// by the distortion/bit-crush adding fricative-like broadband noise on top
// of consonant onsets. Softened below: a wide high/low-pass pair instead of
// a narrow bandpass (keeps more of the low end intact), less distortion,
// finer bit depth, and a shallower ring-mod depth. This is reasoning about
// signal processing, not a listening pass — these are pure DSP math, so
// they're deterministic and could be validated by re-inspecting the
// waveform, but "does it still sound robotic" and "did this fully avoid the
// profanity collision" can't be confirmed without a human ear on the actual
// deployed clip.
const ROBOT_CARRIER_HZ = 50;
const ROBOT_BITS = 8;
// Sped up before the ring-mod/bit-crush stage: shortens sustained vowels and
// reads as a more urgent, crackly transmission. User-specified rate — went
// 1.75x, then 1.25x (too slow), then 2x (too fast), settled on 1.75x. Uses
// timeStretch (below), NOT AudioBufferSourceNode.playbackRate — playbackRate
// changes speed and pitch together (like a tape speed change), which reads
// as "chipmunked"; the user explicitly wanted speed only, pitch untouched.
const ROBOT_SPEED = 1.75;

function distortionCurve(amount: number): Float32Array {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

/** Speeds up `samples` by `factor` (>1) WITHOUT shifting pitch, using
 *  overlap-add (OLA) time-scale modification: overlapping Hann-windowed
 *  frames are read from the input `factor` times faster than they're written
 *  to the output, so the input's own frequency content (pitch) is
 *  untouched — only the time positions of frames compress. This is a plain
 *  OLA, not phase-aligned WSOLA, so fast/short frames can pick up a faint
 *  "phasy" warble at frame boundaries; for this egg's already-distorted comm
 *  voice that reads as more transmission artifact than defect. Deterministic
 *  DSP math — verifiable by inspecting the output waveform, not by ear. */
function timeStretch(samples: Float32Array, factor: number): Float32Array {
  if (factor === 1) return samples;
  const frameSize = 2048;
  const synthesisHop = Math.floor(frameSize / 4);
  const analysisHop = Math.round(synthesisHop * factor);
  const outLength = Math.floor(samples.length / factor);
  const out = new Float32Array(outLength + frameSize);
  const norm = new Float32Array(outLength + frameSize);
  const window = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  }
  let inPos = 0;
  let outPos = 0;
  while (inPos + frameSize <= samples.length && outPos + frameSize <= out.length) {
    for (let i = 0; i < frameSize; i++) {
      const w = window[i];
      out[outPos + i] += samples[inPos + i] * w;
      norm[outPos + i] += w;
    }
    inPos += analysisHop;
    outPos += synthesisHop;
  }
  for (let i = 0; i < out.length; i++) {
    if (norm[i] > 1e-6) out[i] /= norm[i];
  }
  return out.slice(0, outLength);
}

/** Encodes mono float samples as a 16-bit PCM WAV (see use-vad.ts's twin of
 *  this — kept separate since that one is hardcoded to 16 kHz for the mic
 *  capture path, while this preserves whatever sample rate it was given). */
function encodeWavAt(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

async function robotize(raw: ArrayBuffer): Promise<{ audio: ArrayBuffer; durationMs: number }> {
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(raw.slice(0));
  } finally {
    void decodeCtx.close().catch(() => {});
  }

  const offline = new OfflineAudioContext(1, decoded.length, decoded.sampleRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  // Wide high/low-pass pair instead of a narrow bandpass: trims the extremes
  // for a "comm channel" feel without gutting the low-frequency energy that
  // separates a "b" plosive from an "f" fricative (see note above).
  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 250;
  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 3800;
  const shaper = offline.createWaveShaper();
  shaper.curve = distortionCurve(8) as Float32Array<ArrayBuffer>;
  src.connect(highpass).connect(lowpass).connect(shaper).connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();

  const stretched = timeStretch(rendered.getChannelData(0), ROBOT_SPEED);
  const sr = rendered.sampleRate;
  const levels = 2 ** ROBOT_BITS;
  const out = new Float32Array(stretched.length);
  for (let i = 0; i < stretched.length; i++) {
    const carrier = Math.sin((2 * Math.PI * ROBOT_CARRIER_HZ * i) / sr);
    const modulated = stretched[i] * (0.75 + 0.25 * carrier);
    const crushed = Math.round(modulated * levels) / levels;
    out[i] = Math.max(-1, Math.min(1, crushed * 1.35));
  }
  return { audio: encodeWavAt(out, sr), durationMs: (out.length / sr) * 1000 };
}

// Cache keyed by voice+text (mirrors prerenderLine's Map cache in
// prerender.ts) — the "all your base" egg's fixed lines (everything but the
// scenario-aware finale) are identical across every run within a session, so
// repeated triggers don't re-hit TTS + re-run the DSP chain for the same text.
const robotVoiceCache = new Map<string, { bytes: Uint8Array; durationMs: number }>();

/** Synthesizes `text` (homelab TTS, 16 kHz mono to match presenter.speakAudio's
 *  contract), robotizes it, and speeds it up — the "all your base" egg's CATS
 *  voice. Returns the duration alongside the audio so the caller can race
 *  presenter.speakAudio against it (see Flow.tsx's speakAtLeast — its
 *  "finished" signal fires early). Cached per (voice, text): callers should
 *  prerender every line a run will need (Promise.all) before starting the
 *  performance rather than fetching line-by-line mid-sequence. */
export async function synthesizeRobotVoice(
  text: string,
  voice = "bert",
): Promise<{ audio: ArrayBuffer; durationMs: number }> {
  const key = `${voice} ${text}`;
  let cached = robotVoiceCache.get(key);
  if (!cached) {
    const raw = await synthesizeSpeech(text, voice, true);
    const { audio, durationMs } = await robotize(raw);
    cached = { bytes: new Uint8Array(audio), durationMs };
    robotVoiceCache.set(key, cached);
  }
  return { audio: cached.bytes.slice().buffer, durationMs: cached.durationMs };
}
