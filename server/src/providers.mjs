/**
 * External providers: STT (homelab hosted, OpenAI-compatible) and BYO-TTS
 * (homelab, OpenAI-compatible /audio/speech). TTS output is returned as-is by
 * default; the 16 kHz mono re-encode is opt-in because it exists only for the
 * presenter's codec contract (ADR-0009: Prep audio plays directly, no presenter).
 * Routes probed live in S0 (PLAN.md §2.1).
 */
import { spawn } from "node:child_process";

const NOOP = () => {};

// qwen-tts (voice-design voices like bert/lauren_us) rejects ISO codes
// ("unknown language 'ja'") and needs full names; other engines accept ISO.
const ISO_TO_QWEN_LANGUAGE = {
  ja: "Japanese",
  en: "English",
  zh: "Chinese",
  ko: "Korean",
  fr: "French",
  de: "German",
  ru: "Russian",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
};

function fromEnv() {
  return {
    stt: {
      baseUrl: (process.env.STT_BASE_URL || "https://stt.mango-rockhopper.ts.net/v1").replace(/\/+$/, ""),
      apiKey: process.env.STT_API_KEY || "",
      model: process.env.STT_MODEL || "whisper-1",
      language: process.env.STT_LANGUAGE || "ja",
    },
    tts: {
      baseUrl: (process.env.TTS_BASE_URL || "https://tts.mango-rockhopper.ts.net/v1").replace(/\/+$/, ""),
      apiKey: process.env.TTS_API_KEY || "",
      model: process.env.TTS_MODEL || "kokoro-82m",
      voice: process.env.TTS_VOICE || "ruu",
      language: process.env.TTS_LANGUAGE || "ja",
    },
  };
}

/** Transcribe a WAV buffer to Japanese text via the homelab hosted STT. */
export async function transcribeAudio(buffer, { mimeType = "audio/wav", language } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("No audio data"), { status: 400 });
  }
  const env = fromEnv();
  if (!env.stt.baseUrl) {
    throw Object.assign(new Error("STT not configured (STT_BASE_URL)"), { status: 501 });
  }
  // Hosted STT accepts WAV uploads only; browser recorders send webm/opus.
  const wav = await normalizeTo16kMonoWav(buffer);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", env.stt.model);
  form.append("language", language || env.stt.language);
  form.append("response_format", "json");
  const headers = {};
  if (env.stt.apiKey) headers.Authorization = `Bearer ${env.stt.apiKey}`;
  const res = await fetch(`${env.stt.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw Object.assign(new Error(`STT failed (${res.status}): ${detail}`), { status: 502 });
  }
  const payload = await res.json();
  return { text: String(payload.text ?? "").trim() };
}

/** Synthesize a WAV via homelab BYO-TTS. Returns the TTS-native WAV; with
 *  `normalize: true` re-encodes to 16 kHz mono PCM (the presenter's verified
 *  codec contract) — skip it for audio that plays directly in the browser. */
export async function synthesizeSpeechWav(text, { voice, language, normalize = false } = {}) {
  const env = fromEnv();
  if (!env.tts.baseUrl) {
    throw Object.assign(new Error("TTS not configured (TTS_BASE_URL)"), { status: 501 });
  }
  const headers = { "Content-Type": "application/json" };
  if (env.tts.apiKey) headers.Authorization = `Bearer ${env.tts.apiKey}`;
  const body = {
    model: env.tts.model,
    voice: voice || env.tts.voice,
    response_format: "wav",
    // keep language hint where the backend accepts it
    ...(env.tts.language && language !== "" ? { language: language || env.tts.language } : {}),
    input: text,
  };
  const post = (payload) =>
    fetch(`${env.tts.baseUrl}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  let res = await post(body);
  if (!res.ok && "language" in body) {
    // Retry ladder: some engines reject the ISO code (qwen-tts wants the full
    // language name), others reject any hint at all. Dropping the hint lets
    // the engine guess — for kanji it guesses Chinese, so it is the last resort.
    const mapped = ISO_TO_QWEN_LANGUAGE[body.language];
    if (mapped && mapped !== body.language) {
      res = await post({ ...body, language: mapped });
    }
    if (!res.ok) {
      const { language: _lang, ...rest } = body;
      res = await post(rest);
    }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw Object.assign(new Error(`TTS failed (${res.status}): ${detail}`), { status: 502 });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return normalize ? normalizeTo16kMonoWav(bytes) : bytes;
}

/** Re-encode an audio buffer to 16 kHz mono PCM WAV via ffmpeg (best-effort). */
function normalizeTo16kMonoWav(input) {
  return new Promise((resolve, reject) => {
    const out = [];
    const stderrChunks = [];
    const child = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      "pipe:1",
    ]);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const diag = Buffer.concat(stderrChunks).toString().slice(0, 500);
        return reject(Object.assign(new Error(`ffmpeg normalize failed (exit ${code}): ${diag}`), { status: 502 }));
      }
      resolve(Buffer.concat(out));
    });
    child.stdin.on("error", NOOP);
    child.stdin.end(input);
  });
}
