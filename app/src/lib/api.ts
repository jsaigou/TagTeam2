// Thin client to the TagTeam2 backend (proxy /api → :8787 in dev).

export interface ConnectConfig {
  connect_token: string;
  presenterUrl: string;
  coach: { avatar_id: string; scene_id: string; voice_id: string };
  practice: { avatar_id: string; scene_id: string; voice_id: string };
}

/** Mints a connect_token + fixed-target config from the server. */
export async function fetchConnectConfig(): Promise<ConnectConfig> {
  const res = await fetch("/api/connect/config", { signal: AbortSignal.timeout(10_000) });
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  return res.json();
}

/** Synthesize a 16 kHz mono WAV for a Japanese line (server proxies homelab TTS). */
export async function synthesizeSpeech(text: string): Promise<ArrayBuffer> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.arrayBuffer();
}

// ---- Pre-authored content + practice endpoints (P1 vertical slice) ----

export interface JaLine {
  ja: string;
  romaji: string;
  en: string;
}
export interface PrepLine extends JaLine {}
export interface DialogueNode {
  id: string;
  line: JaLine;
  expected: { match: string[]; next: string; feedback: string }[];
  recoveries: { repeat: string; hint: JaLine | null; help: string };
}
export interface ContentBundle {
  common: {
    fillers: Record<string, JaLine>;
    no_english_rejection: JaLine;
  };
  scenario: { id: string; title: string; tagline: string; goal: string };
  role: { avatar_id: string; scene_id: string; voice_id: string };
  variant: { id: string; label: string; lines: JaLine[] };
  prep_lines: PrepLine[];
  intro: { line: JaLine };
  dialogue: { start_node: string; goal_node: string; nodes: Record<string, DialogueNode> };
  summary: { success_line: JaLine };
}

export async function fetchContent(scenario?: string, variant?: string): Promise<ContentBundle> {
  const params = new URLSearchParams();
  if (scenario) params.set("scenario", scenario);
  if (variant) params.set("variant", variant);
  const qs = params.toString();
  const res = await fetch(`/api/content${qs ? "?" + qs : ""}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`content ${res.status}`);
  return res.json();
}

export interface ClassifyResult {
  scenarioId: string;
  variant: string;
  confidence: number;
  confirmed: boolean;
  note: string;
  slots: Record<string, unknown>;
}

export async function classifyIntake(transcript: string): Promise<ClassifyResult> {
  const res = await fetch("/api/classify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`classify ${res.status}`);
  return res.json();
}

export type TurnOutcome =
  | "advance"
  | "repeat"
  | "hint"
  | "help"
  | "reject_english";

export interface RouteTurnResult {
  nodeId: string;
  decision: {
    outcome: TurnOutcome;
    showHint: boolean;
    hint: JaLine | null;
    nextNodeId: string;
    recoveryStage: number;
  };
  nextNode: DialogueNode | null;
}

export async function routeTurn(
  nodeId: string,
  transcript: string,
  recoveryStage = 0,
  scenario?: string,
  variant?: string,
): Promise<RouteTurnResult> {
  const res = await fetch("/api/route-turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, transcript, recoveryStage, scenario, variant }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`route-turn ${res.status}`);
  return res.json();
}

export interface TurnRecord {
  nodeId: string;
  lineJa: string;
  transcript: string;
  correct: boolean;
  recoveryOutcome?: string;
}

export interface ReviewResult {
  perTurn: { turn: number; node: string; expected: string; said: string; correct: boolean; grade: string; notes: string[] }[];
  overall: string;
  stats: { turns: number; recovered: number; englishCount: number; smoothTurns: number };
}

export async function reviewCall(turns: TurnRecord[]): Promise<ReviewResult> {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turns }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`review ${res.status}`);
  return res.json();
}
