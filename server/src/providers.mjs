/**
 * External providers: STT (homelab hosted, OpenAI-compatible) and BYO-TTS
 * (homelab, OpenAI-compatible /audio/speech). TTS output is returned as-is by
 * default; the 16 kHz mono re-encode is opt-in because it exists only for the
 * presenter's codec contract (ADR-0009: Prep audio plays directly, no presenter).
 * Routes probed live in S0 (PLAN.md §2.1).
 */
import { spawn } from "node:child_process";

const NOOP = () => {};

// nvidia/nemotron-asr leaks its own per-utterance language-ID token into the
// transcript (observed live 2026-09-06: "分かりました。 <ja-JP>", "Yeah. <en-US>")
// — strip it so it never reaches matching, the router LLM, or the Judge.
export function stripSttArtifacts(text) {
  return String(text ?? "")
    .replace(/<\/?[a-zA-Z]{2}-[a-zA-Z]{2}>/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

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
      model: process.env.STT_MODEL || "nvidia/nemotron-asr",
      language: process.env.STT_LANGUAGE || "ja",
    },
    // Local whisper.cpp server (Kotoba-Whisper, Japanese-only) baked into
    // this container — see docs/adr/0012-local-kotoba-whisper-stt.md. Used
    // for every ja transcription (practice calls, drills) instead of the
    // hosted nemotron-asr, which was found to leak its own per-utterance
    // language-ID guess into the transcript and misfire on short Japanese
    // utterances (see stripSttArtifacts below). Kotoba-Whisper can't
    // produce that failure mode: it has no other language to guess.
    sttLocal: {
      enabled: process.env.STT_LOCAL_ENABLED !== "false",
      baseUrl: (process.env.STT_LOCAL_BASE_URL || "http://127.0.0.1:8090").replace(/\/+$/, ""),
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

/** Transcribe a WAV buffer to text. Japanese goes to the local Kotoba-Whisper
 *  server baked into this container; everything else (currently just
 *  intake's English) goes to the homelab hosted multilingual STT. */
export async function transcribeAudio(buffer, { mimeType = "audio/wav", language, prompt } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error("No audio data"), { status: 400 });
  }
  const env = fromEnv();
  const lang = language || env.stt.language;
  // Hosted STT accepts WAV uploads only; browser recorders send webm/opus.
  const wav = await normalizeTo16kMonoWav(buffer);
  if (env.sttLocal.enabled && lang === "ja") {
    return transcribeLocal(wav, env.sttLocal, { prompt });
  }
  return transcribeHosted(wav, env.stt, { language: lang, prompt });
}

// Whisper's encoder always attends over a fixed window regardless of actual
// clip length (n_audio_ctx=1500 = the full 30s) -- for our short turn-based
// utterances that's mostly silence padding, which costs real latency AND
// measurably hurts accuracy (live test 2026-09-06: a 6s clip at full context
// came back as literal garbage, ",,"; 768 frames = ~15.4s of context gave a
// correct transcript in ~2.5s instead of ~5.5s). 768 leaves generous headroom
// over any real single conversational turn without truncating it.
const LOCAL_STT_AUDIO_CTX = "768";

/** Local whisper.cpp server (Kotoba-Whisper) — same OpenAI-ish {text} shape
 *  as the hosted provider, so stripSttArtifacts is a no-op here in practice
 *  (kept as a shared safety net, not because this model tags languages). */
async function transcribeLocal(wav, sttLocal, { prompt } = {}) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  form.append("audio_ctx", LOCAL_STT_AUDIO_CTX);
  if (prompt) form.append("prompt", prompt);
  const res = await fetch(`${sttLocal.baseUrl}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw Object.assign(new Error(`local STT failed (${res.status}): ${detail}`), { status: 502 });
  }
  const payload = await res.json();
  return { text: stripSttArtifacts(payload.text) };
}

/** Homelab hosted STT (nvidia/nemotron-asr, OpenAI-compatible). */
async function transcribeHosted(wav, stt, { language, prompt } = {}) {
  if (!stt.baseUrl) {
    throw Object.assign(new Error("STT not configured (STT_BASE_URL)"), { status: 501 });
  }
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", stt.model);
  form.append("language", language || stt.language);
  form.append("response_format", "json");
  // Whisper-style context hint: biases recognition toward expected
  // vocabulary. Used by the review "repeat after me" drill, where the target
  // phrase (often an unusual katakana name) is already known.
  if (prompt) form.append("prompt", prompt);
  const headers = {};
  if (stt.apiKey) headers.Authorization = `Bearer ${stt.apiKey}`;
  const res = await fetch(`${stt.baseUrl}/audio/transcriptions`, {
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
  return { text: stripSttArtifacts(payload.text) };
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
  if (bytes.length === 0) {
    // Upstream has returned 200 with an empty body under load (observed live
    // 2026-09-05) — surface it as a provider failure, never as silent audio.
    throw Object.assign(new Error("TTS returned empty audio (upstream 200, 0 bytes)"), { status: 502 });
  }
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
