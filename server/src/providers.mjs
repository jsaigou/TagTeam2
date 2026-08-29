/**
 * External providers: STT (homelab hosted, OpenAI-compatible) and BYO-TTS
 * (homelab, OpenAI-compatible /audio/speech → 16 kHz mono WAV for the presenter).
 * Routes probed live in S0 (PLAN.md §2.1).
 */
import { spawn } from "node:child_process";

const NOOP = () => {};

function fromEnv() {
  return {
    connect: {
      baseUrl: process.env.PERXONA_API_BASE_URL || "https://console.perxona.ai/asia",
      email: process.env.PERXONA_CONNECT_EMAIL || "",
      password: process.env.PERXONA_CONNECT_PASSWORD || "",
    },
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
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), "audio.wav");
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

/** Synthesize a WAV via homelab BYO-TTS and normalize to 16 kHz mono PCM
 *  (the presenter's verified codec contract). Resolves to a Buffer. */
export async function synthesizeSpeechWav(text, { voice, language } = {}) {
  const env = fromEnv();
  if (!env.tts.baseUrl) {
    throw Object.assign(new Error("TTS not configured (TTS_BASE_URL)"), { status: 501 });
  }
  const headers = { "Content-Type": "application/json" };
  if (env.tts.apiKey) headers.Authorization = `Bearer ${env.tts.apiKey}`;
  const res = await fetch(`${env.tts.baseUrl}/audio/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: env.tts.model,
      voice: voice || env.tts.voice,
      response_format: "wav",
      // keep language hint where the backend accepts it
      ...(env.tts.language && language !== "" ? { language: language || env.tts.language } : {}),
      input: text,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw Object.assign(new Error(`TTS failed (${res.status}): ${detail}`), { status: 502 });
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return normalizeTo16kMonoWav(bytes);
}

/** Re-encode an audio buffer to 16 kHz mono PCM WAV via ffmpeg (best-effort). */
function normalizeTo16kMonoWav(input) {
  return new Promise((resolve, reject) => {
    const out = [];
    const child = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      "pipe:1",
    ]);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", NOOP);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(Object.assign(new Error("ffmpeg normalize failed"), { status: 502 }));
      }
      resolve(Buffer.concat(out));
    });
    child.stdin.on("error", NOOP);
    child.stdin.end(input);
  });
}
