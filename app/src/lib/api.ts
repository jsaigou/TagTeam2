// Thin client to the TagTeam2 backend (proxy /api → :8787 in dev).

export interface ConnectConfig {
  connect_token: string;
  presenterUrl: string;
  coach: { avatar_id: string; scene_id: string; voice_id: string };
  practice: { avatar_id: string; scene_id: string; voice_id: string };
}

/** Mints a connect_token + fixed-target config from the server. */
export async function fetchConnectConfig(): Promise<ConnectConfig> {
  const res = await fetch("/api/connect/config");
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

export interface SttResult {
  text: string;
}

/** Transcribe a WAV buffer to Japanese text (server proxies homelab STT). */
export async function transcribeAudio(audioBase64: string, mimeType = "audio/wav"): Promise<SttResult> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType, language: "ja" }),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  return res.json();
}

/** Synthesize a 16 kHz mono WAV for a Japanese line (server proxies homelab TTS). */
export async function synthesizeSpeech(text: string): Promise<ArrayBuffer> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: "ruu", language: "ja" }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.arrayBuffer();
}
