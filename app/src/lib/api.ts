// Thin client to the TagTeam2 backend (proxy /api → :8787 in dev).

import type { PresentationEmotion } from "@perxona/presenter-types";

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

/** Transcribe a WAV buffer to Japanese text (server proxies homelab STT).
 *  `prompt` is a Whisper-style context hint biasing recognition toward
 *  expected vocabulary — pass the known target phrase for a "repeat after
 *  me" drill, where unusual words (e.g. a katakana name) are otherwise easy
 *  for STT to garble with no vocabulary bias at all. */
export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/wav",
  language = "ja",
  prompt?: string,
): Promise<SttResult> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType, language, prompt }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`stt ${res.status}`);
  return res.json();
}

/** Synthesize a Japanese line as TTS-native WAV, played directly (ADR-0009) —
 *  not the presenter's 16 kHz contract, so the server skips the ffmpeg re-encode. */
export async function synthesizeSpeech(text: string, voice?: string): Promise<ArrayBuffer> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(voice ? { voice } : {}) }),
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
  /** LLM-authored emotional tone (practice router only); drives the avatar's
   *  facial expression via present() options. Authored content never sets it. */
  emotion?: PresentationEmotion;
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
  scenario: {
    id: string;
    title: string;
    tagline: string;
    goal: string;
    /** Scenario-neutral UI copy: "the restaurant", "the dental clinic", … */
    place: string;
    /** Who answers the call: "reservation staff", "receptionist", … */
    speaker: string;
    persona: string;
    brief: { stages: string[]; key_info: string[] };
  };
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
  outcome: TurnOutcome;
  /** Ordered lines the avatar speaks this turn (LLM-authored or authored fallback). */
  speak: JaLine[];
  showHint: boolean;
  hint: JaLine | null;
  recoveryStage: number;
  callDone: boolean;
  source: "llm" | "fallback";
  /** Key-info items collected so far this call (label -> short Japanese
   *  value), merged server-side turn over turn — send back on the next
   *  routeTurn call so the router never re-asks for something already given,
   *  even once it's scrolled out of the conversation history window. */
  collected: Record<string, string>;
}

export async function routeTurn(
  nodeId: string,
  transcript: string,
  recoveryStage = 0,
  scenario?: string,
  variant?: string,
  history: { avatar: string; learner: string }[] = [],
  /** The avatar line the learner is replying to — the LLM router authors lines
   *  live, so the authored graph node is stale context; this keeps it honest. */
  lastAvatarLine?: string,
  collected: Record<string, string> = {},
): Promise<RouteTurnResult> {
  const res = await fetch("/api/route-turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, transcript, recoveryStage, scenario, variant, history, lastAvatarLine, collected }),
    signal: AbortSignal.timeout(15_000),
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
  perTurn: {
    turn: number;
    node: string;
    expected: string;
    said: string;
    correct: boolean;
    grade: string;
    notes: string[];
    /** What the learner should have said (LLM-authored Japanese), when the
     *  LLM review path ran and the turn wasn't graded "unclear". Null on the
     *  deterministic fallback path — callers resolve their own fallback. */
    correction: string | null;
  }[];
  overall: string;
  stats: { turns: number; recovered: number; englishCount: number; smoothTurns: number };
}

export async function reviewCall(
  turns: TurnRecord[],
  scenarioId: string,
  variantId: string,
): Promise<ReviewResult> {
  const res = await fetch("/api/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turns, scenario: scenarioId, variant: variantId }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`review ${res.status}`);
  return res.json();
}
