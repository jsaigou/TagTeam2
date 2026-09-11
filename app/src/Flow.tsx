import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ConnectConfig,
  type ContentBundle,
  type DialogueNode,
  type JaLine,
  type ReviewResult,
  type TurnRecord,
  classifyIntake,
  fetchContent,
  reviewCall,
  routeTurn,
  transcribeAudio,
} from "./lib/api";
import { useVad, type VadUtterance } from "./hooks/use-vad";
import { prerenderLine } from "./lib/prerender";
import { drillVerdict as computeDrillVerdict, type DrillVerdict } from "./lib/prep-drill";
import { playPrepExample } from "./lib/prep-audio";
import {
  PREP_VOICES,
  playRingback,
  playSfxLoop,
  playSfxOnce,
  playWav,
  stopWav,
  type SfxHandle,
} from "./lib/audio";
import { getActiveProfile, useProfileStore } from "./lib/profiles";
import {
  ALL_YOUR_BASE,
  aybFinaleAssets,
  aybFinaleLine,
  aybTargetWord,
  CODEC_BRIEFING,
  codecBriefingLines,
  doomFaceRect,
  pickRandomEasterEgg,
  rollEasterEgg,
  useKonamiCode,
  type AybLine,
  type EasterEggId,
} from "./lib/easter-eggs";
import { DoomOverlay } from "./DoomEgg";
import { Doors } from "./Doors";
import { BrandMark } from "./BrandMark";
import type { UsePresenter } from "./hooks/use-presenter";
import { FaCreditCard, FaStethoscope, FaTooth, FaTruck, FaUtensils } from "react-icons/fa6";
import type { IconType } from "react-icons";

type Phase = "welcome" | "intake" | "prep" | "practice" | "review";

// Linear phase order for the back-navigation trampoline (see the "Back
// navigation" block in Flow) — each level forward pushes one synthetic
// history entry so the hardware/gesture back button steps back through the
// app instead of leaving it, instead of encoding real state in the URL.
const PHASE_ORDER: Phase[] = ["welcome", "intake", "prep", "practice", "review"];
const phaseDepth = (p: Phase) => PHASE_ORDER.indexOf(p);
/** What pressing back does from a given phase: a handler to run, "block"
 *  when backing out would be unsafe right now (a live call), or null when
 *  there's nothing to back into (welcome, the app's true root). */
type BackHandler = (() => void) | "block" | null;

// One-tap intake: 5 call types, each with its 3 authored variants as
// sub-types — real content (see content/scenarios/*/*/prep-lines.json
// "label" fields), not invented options. Tapping a type reveals its
// sub-types instead of listing all 15 combinations flat.
interface CallSubtype {
  variant: string;
  title: string;
  detail: string;
}
interface CallType {
  scenario: string;
  title: string;
  subtypes: CallSubtype[];
}
const CALL_TYPES: CallType[] = [
  {
    scenario: "restaurant",
    title: "Restaurant",
    subtypes: [
      { variant: "a", title: "Table booking", detail: "simple reservation" },
      { variant: "b", title: "Anniversary", detail: "special course" },
      { variant: "c", title: "Party", detail: "group booking" },
    ],
  },
  {
    scenario: "dentist",
    title: "Dentist",
    subtypes: [
      { variant: "a", title: "Toothache", detail: "urgent pain" },
      { variant: "b", title: "Cleaning", detail: "routine visit" },
      { variant: "c", title: "Fallen filling", detail: "repair" },
    ],
  },
  {
    scenario: "doctor",
    title: "Doctor",
    subtypes: [
      { variant: "a", title: "Cold", detail: "cold symptoms" },
      { variant: "b", title: "Fever", detail: "high temperature" },
      { variant: "c", title: "Cough", detail: "persistent cough" },
    ],
  },
  {
    scenario: "lost-card",
    title: "Lost card",
    subtypes: [
      { variant: "a", title: "Lost somewhere", detail: "misplaced" },
      { variant: "b", title: "Stolen", detail: "report theft" },
      { variant: "c", title: "Left at a store", detail: "left behind" },
    ],
  },
  {
    scenario: "redelivery",
    title: "Redelivery",
    subtypes: [
      { variant: "a", title: "Missed delivery", detail: "redeliver" },
      { variant: "b", title: "Change address", detail: "reroute" },
      { variant: "c", title: "Never arrived", detail: "investigate" },
    ],
  },
];

// One glyph per call class, keyed by `scenario` so it travels with the data
// above instead of a second parallel list that can drift out of sync.
const CALL_ICONS: Record<string, IconType> = {
  restaurant: FaUtensils,
  dentist: FaTooth,
  doctor: FaStethoscope,
  "lost-card": FaCreditCard,
  redelivery: FaTruck,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// presenter.speakAudio's own "finished" detection can resolve well before a
// clip is actually done playing (confirmed live: a 3.28s line once resolved
// in 235ms) — races it against a known minimum so a line can never be cut
// short, at the cost of occasionally waiting a beat longer than the widget
// alone would have.
async function speakAtLeast(presenter: UsePresenter, audio: ArrayBuffer, text: string, minMs: number) {
  const start = Date.now();
  await presenter.speakAudio(audio, text);
  const remaining = minMs - (Date.now() - start);
  if (remaining > 0) await sleep(remaining);
}

// Same early-finish problem as speakAtLeast above, but for live speakText
// lines where there's no pregenerated clip to measure a minMs from up front
// — confirmed live: Prep's English line was resolving before its own audio
// finished, so the Japanese example that follows (speakPrepLine) started
// talking over its tail end. ~150wpm (~13 chars/sec incl. spaces) is a
// conservative floor for Luna's speaking rate; a little over-wait reads
// better than any overlap.
async function speakTextAtLeast(presenter: UsePresenter, text: string) {
  const start = Date.now();
  await presenter.speakText(text);
  const minMs = Math.max(500, (text.length / 13) * 1000);
  const remaining = minMs - (Date.now() - start);
  if (remaining > 0) await sleep(remaining);
}

// Loose match for the echo-guard: strips whitespace/punctuation so a
// transcript that's the avatar's line plus/minus a trailing 。or space still
// counts as an echo, not a new (mismatched) learner turn.
const normalizeForCompare = (s: string) => s.replace(/[\s、。！？!?,.]/g, "");

// 16 kHz mono 16-bit PCM WAV (see use-vad.ts encodeWav): 32000 bytes/sec,
// 44-byte header. Base64 is ~4/3 the byte size. Debug-only duration estimate
// so a capture mismatch can be pinned to a short/split utterance at a glance.
const estimateWavSeconds = (base64: string) => Math.max(0, (base64.length * 0.75 - 44) / 32000);
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
// Pacing between drill repeats.
const SECTION_PAUSE_MS = 900;
// Pacing between a Prep example's two voice readings (ADR-0009: 0.25s).
const VOICE_GAP_MS = 250;

// What a "repeat after me" drill for a flagged review turn should say: the
// LLM's per-turn correction when the LLM review path ran (Japanese text only —
// no romaji/en), else the node's authored recovery hint (a full JaLine),
// else null when neither exists (that turn isn't drillable).
function resolveDrillTarget(
  t: ReviewResult["perTurn"][number],
  content: ContentBundle | null,
): JaLine | null {
  if (t.correction) return { ja: t.correction, romaji: "", en: "" };
  return content?.dialogue.nodes[t.node]?.recoveries.hint ?? null;
}

// Porthole geometry: 200×200 at rest, 128×128 while reading prep lines.
export const PORTHOLE_SIZE = 200;
// Height of the persistent top bar (rendered by App.tsx). The stage, the
// content band and the phone rect are all measured from the viewport, so
// everything below the bar adds this.
export const HEADER_H = 48;
const READ_SIZE = 128;
// Left gutter reserved for reading Luna (READ_SIZE + gap).
const READ_GUTTER = READ_SIZE + 24;
// Porthole resize/move transition duration (App.tsx's stageView reads this
// too, so the CSS transition and this JS choreography can't drift apart —
// they used to: CSS ran 600ms while this fired the next pose at 380ms,
// cutting the shrink off mid-flight and reading as a jerky direction change).
export const PORTHOLE_TRANSITION_MS = 450;
// How long Luna shrinks/regrows at the title slot before moving, so she
// never sweeps across the line cards while they slide — must be >= the CSS
// transition duration above or the shrink gets cut short.
const STAGE_MS = PORTHOLE_TRANSITION_MS;
// Phone rect move (centered idle -> left-anchored dialing/connected).
export const PHONE_TRANSITION_MS = 350;

// Practice's call screen is bounded to a phone-shaped rect, not the raw
// viewport: on an actual phone the two are nearly identical, but on a wide
// desktop window "full-bleed to the viewport" would stretch the video and
// scatter captions across empty space on either side. Below this width the
// browser viewport already reads as a phone, so the rect just becomes the
// viewport and no bezel is drawn; above it, the rect is capped to a centered
// phone-aspect box and framed with a bezel so video + every overlay bar stay
// inside the same "phone".
const DESKTOP_BREAKPOINT = 640;
const PHONE_ASPECT = 9 / 19.5;

// Left margin for the phone on desktop — matches the gap the caption panel
// uses on the other side, so the whole call screen reads as one composition.
const PHONE_LEFT_MARGIN = 40;

// `centered`: true before dialing (a prominent, inviting first impression),
// false once dialing/connected (left-anchored, matching the gap the caption
// panel uses on the other side so the whole call screen reads as one
// composition once there's something to put beside the phone).
function computePhoneRect(centered: boolean) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // The phone lives below the top bar, never under it.
  const availH = vh - HEADER_H;
  if (vw <= DESKTOP_BREAKPOINT) {
    return { left: 0, top: HEADER_H, width: vw, height: availH, framed: false };
  }
  let height = availH * 0.92;
  let width = height * PHONE_ASPECT;
  if (width > vw - PHONE_LEFT_MARGIN * 2) {
    width = vw - PHONE_LEFT_MARGIN * 2;
    height = width / PHONE_ASPECT;
  }
  const left = centered ? (vw - width) / 2 : PHONE_LEFT_MARGIN;
  return { left, top: HEADER_H + (availH - height) / 2, width, height, framed: true };
}

export interface StageLayout {
  fullscreen: boolean;
  visible: boolean;
  left: number;
  top: number;
  size: number;
  /** Explicit rect for the practice call screen (fullscreen ignores `size`). */
  width?: number;
  height?: number;
  /** True when the call rect is letterboxed inside a wider viewport (desktop) — draw a phone bezel. */
  framed?: boolean;
  animate: boolean;
  /** Content band offset from the viewport top, in px (clears the top bar). */
  bandTop: number;
  /** Active easter egg's decorative treatment on the porthole itself: "codec"
   *  is the green-phosphor CRT filter, "ayb" the cat-costume overlay, "doom"
   *  a mild retro tint (App.tsx's stageView) — all three leave left/top/size
   *  untouched. DOOM's porthole IS repositioned (see the doom branch above),
   *  just never resized, and stays genuinely visible/live — pixelating her
   *  live rendering isn't achievable (tried twice; see DoomEgg.tsx). */
  eggOverlay?: "codec" | "ayb" | "doom";
}

interface FlowProps {
  presenter: UsePresenter;
  token: string;
  config: ConnectConfig;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onStageLayout: (layout: StageLayout) => void;
  /** Reports the current phase's back handler (or null when there's nothing
   *  to go back to / backing out is unsafe) so the header can show a back
   *  chevron that calls exactly the same function the hardware back button
   *  does. */
  onBackAvailable?: (goBack: (() => void) | null) => void;
}

// Reusable line card component showing kanji + romaji + english.
// `playing` adds an underglow while the example's audio is playing. Used by
// Practice captions and Review's target line; Prep's line list has its own
// opaque dark-plaque markup (see the "prep" phase render) since that one
// also has to share its panel with the play/dismiss button column.
function LineCard({
  line,
  accent = false,
  playing = false,
}: {
  line: JaLine;
  accent?: boolean;
  playing?: boolean;
}) {
  const tone = playing
    ? "border-ring bg-card shadow-[0_18px_30px_-12px_var(--ring)]"
    : accent
      ? "border-primary bg-accent/20"
      : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-3 transition-shadow duration-300 ${tone}`}>
      <p className="text-lg leading-snug">{line.ja}</p>
      <p className="text-sm text-muted-foreground">{line.romaji}</p>
      <p className="text-xs text-muted-foreground/80 italic">{line.en}</p>
    </div>
  );
}

function BigButton({
  onClick,
  disabled,
  children,
  variant = "primary",
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  variant?: "primary" | "ghost";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        variant === "primary"
          ? "px-5 py-2 rounded-lg bg-primary text-primary-foreground font-medium disabled:opacity-40"
          : "px-5 py-2 rounded-lg border border-border bg-card disabled:opacity-40"
      }
    >
      {children}
    </button>
  );
}

const CRT_KEYFRAMES = `
@keyframes codec-flicker { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.55; } }
@keyframes codec-refresh { 0% { top: -4px; } 100% { top: 100%; } }
`;

// Codec easter egg's decorative backdrop: green-phosphor scanlines/vignette/
// bloom/flicker across the whole viewport, portaled to <body> so it isn't
// clipped by any ancestor. Deliberately does NOT touch the live porthole
// avatar's own element (see runCodecBriefing above) — an earlier version
// resized/filtered the avatar itself to "fill the screen," which broke the
// third-party presenter widget's internal rendering (it went solid black and
// stayed that way after the egg ended). z-15 sits below the porthole's z-20,
// so Luna's small window still shows through on top, untouched and safe.
function CodecOverlay({
  introLines,
  introTyping,
  caption,
}: {
  /** Mission-briefing lines that have finished typing. */
  introLines: string[];
  /** The briefing line currently being typed (partial). */
  introTyping: string;
  /** Luna's current spoken line, once she's talking. */
  caption: string;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[15] overflow-hidden pointer-events-none font-mono">
      <style>{CRT_KEYFRAMES}</style>
      <div className="absolute inset-0 bg-black" />
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 50% 45%, rgba(0,255,0,0.14), transparent 65%)",
          mixBlendMode: "screen",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.4) 3px, rgba(0,0,0,0.4) 6px)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.85) 100%)" }}
      />
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,255,0,0.03)", animation: "codec-flicker 0.12s infinite" }}
      />
      <div
        className="absolute inset-x-0"
        style={{
          height: 3,
          background: "linear-gradient(to bottom, transparent, rgba(0,255,0,0.2), transparent)",
          animation: "codec-refresh 5s linear infinite",
        }}
      />
      <div className="absolute inset-x-0 top-3 flex justify-center">
        <span className="rounded border border-green-900/60 bg-black/70 px-3 py-1 text-[11px] tracking-[0.25em] text-green-400">
          140.85 MHz — INCOMING CALL
        </span>
      </div>
      {(introLines.length > 0 || introTyping) && (
        // Offset by the same porthole-slot width Luna's window actually sits
        // in (see prep's own spacer div) rather than centering across the
        // full viewport — centered text clipped under her close-up crop on
        // narrower screens since her window sits top-left, not centered.
        <div className="absolute inset-x-0 top-16 flex justify-center px-4 sm:px-6">
          <div className="w-full max-w-2xl flex items-start gap-4">
            <div style={{ width: PORTHOLE_SIZE }} className="shrink-0" aria-hidden />
            <div className="flex-1 flex flex-col items-start gap-1 text-left">
              {introLines.map((line, i) => (
                <p key={i} className="max-w-lg text-[42px] text-green-300">
                  {line}
                </p>
              ))}
              {introTyping && (
                <p className="max-w-lg text-[42px] text-green-300">
                  {introTyping}
                  <span className="animate-pulse">▌</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      {caption && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center px-4 sm:px-6">
          <div className="w-full max-w-2xl flex items-end gap-4">
            <div style={{ width: PORTHOLE_SIZE }} className="shrink-0" aria-hidden />
            <div className="flex-1 flex flex-col items-start gap-1 text-left">
              <p className="min-h-10 rounded border border-green-900/50 bg-black/70 px-4 py-2 text-sm text-green-300">
                {caption}
              </p>
              <p className="text-[10px] tracking-wide text-green-600">— 大佐 (THE COLONEL) —</p>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

const AYB_KEYFRAMES = `
@keyframes ayb-box-flash { 0%, 90%, 100% { opacity: 1; } 93%, 97% { opacity: 0.75; } }
@keyframes ayb-silhouette-flash { 0% { opacity: 0; } 20% { opacity: 0.85; } 70% { opacity: 0.85; } 100% { opacity: 0; } }
`;

// (The older hand-drawn control-room indicator-light grid was removed — the
// generated pixel-art backdrop ayb-control-room.jpg is detailed enough.)

// "All your base" egg's decorative backdrop: a control room (dark paneling,
// blinking indicator lights, panel seams) rather than the earlier starfield,
// portaled to <body> same as CodecOverlay — also never touches Luna's
// actual element. Unlike the codec briefing's accumulating typewriter, the
// source material cuts between discrete full screens, so `line` replaces
// rather than appends; centered/lower placement means it's clear of Luna's
// top-left porthole without needing the codec overlay's reserved spacer.
// `silhouetteFlash`: bumped by Flow.tsx once per non-CATS line — keying the
// flash element on it forces a remount, restarting the CSS flash animation
// even on back-to-back lines (a bare boolean toggle wouldn't retrigger).
function AybOverlay({
  line,
  caption,
  silhouetteFlash,
}: {
  line: string;
  caption: string;
  silhouetteFlash: number;
}) {
// Scene (control-room backdrop + silhouette flash) sits at z-[15] BEHIND the
// CATS cloak (z-[21], App.tsx's AybCostume), while the dialogue boxes render at
// z-[30] so the caption is always IN FRONT of the big cloak — the cloak now
// extends far beyond the porthole and would otherwise cover the text.
const scene = (
<div className="fixed inset-0 z-[15] overflow-hidden pointer-events-none font-mono">
<style>{AYB_KEYFRAMES}</style>
<div
className="absolute inset-0 bg-cover bg-center"
style={{ backgroundImage: "url(/easter-eggs/ayb-control-room.jpg)" }}
/>
// (Panel seam lines and blinking indicator lights removed — the generated
// control-room backdrop is already detailed; only a soft vignette is added.)
<div
className="absolute inset-0"
style={{ background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.65) 100%)" }}
/>
{/* Quick flash generic silhouette while a non-CATS line plays —
plain decorative bust shape (circle head + shoulder wedge), not
any specific character, standing in for "someone else on the line". */}
{silhouetteFlash > 0 && (
<div
key={silhouetteFlash}
className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center"
style={{ animation: "ayb-silhouette-flash 0.5s ease-out forwards", opacity: 0 }}
>
<div style={{ width: 120, height: 150, position: "relative" }}>
<div
className="absolute rounded-full"
style={{ left: 30, top: 0, width: 60, height: 60, background: "#05070a" }}
/>
<div
className="absolute"
style={{
left: 0,
top: 55,
width: 120,
height: 95,
background: "#05070a",
borderRadius: "60px 60px 0 0",
}}
/>
</div>
</div>
)}
</div>
);
const dialogue = (
<div className="fixed inset-0 z-[30] overflow-hidden pointer-events-none font-mono">
{line && (
<div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex justify-center px-4 sm:px-6">
<div
className="max-w-xl w-full border-4 border-white px-6 py-4 text-center"
style={{ background: "#0000aa", animation: "ayb-box-flash 3s steps(1) infinite" }}
>
<p className="text-base sm:text-xl font-bold tracking-wide text-white" style={{ textShadow: "2px 2px 0 #000" }}>
{line}
</p>
</div>
</div>
)}
{caption && (
<div className="absolute inset-x-0 bottom-10 flex justify-center px-4 sm:px-6">
<div className="max-w-xl w-full border-4 border-white px-6 py-4 text-center" style={{ background: "#0000aa" }}>
<p className="text-base sm:text-xl font-bold tracking-wide text-white" style={{ textShadow: "2px 2px 0 #000" }}>
{caption}
</p>
<p className="mt-1 text-[10px] tracking-[0.3em] text-cyan-300">— CATS —</p>
</div>
</div>
)}
</div>
);
return createPortal(<>{scene}{dialogue}</>, document.body);
}

export default function Flow({ presenter, token, config, scrollRef, onStageLayout, onBackAvailable }: FlowProps) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [status, setStatus] = useState("");
  // Cosmetic-only learner identity (ADR-0010): names greet the learner but are
  // never sent to the Router/Judge, so rules.mjs's "never assume the learner's
  // name" guard stays intact.
  const activeProfile = getActiveProfile(useProfileStore());
  // Luna's door cover: masks presenter.initialize() over the porthole while
  // Intake is already live underneath (see Doors.tsx).
  const [doorsOn, setDoorsOn] = useState(false);
  const dismissDoors = useCallback(() => setDoorsOn(false), []);

  // Intake's own VAD session (English, single-utterance) — same mic-status
  // language as practice's call VAD, not a push-to-talk record/stop toggle.
  const intakeProcessRef = useRef<(u: VadUtterance) => void | Promise<void>>(() => {});
  const [intakeTalking, setIntakeTalking] = useState(false);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const {
    speech: intakeVadSpeech,
    error: intakeVadError,
    start: intakeVadStart,
    stop: intakeVadStop,
  } = useVad((u) => intakeProcessRef.current(u));

  // Call ritual: idle (Dial button) → dialing (ringback) → connected (VAD talk).
  const [callState, setCallState] = useState<"idle" | "dialing" | "connected">("idle");
  const [callSeconds, setCallSeconds] = useState(0);
  // Bumped on every dial()/cancelDial() so a stale dial that finishes ringing
  // after the learner cancelled can bail instead of landing the call anyway.
  const dialTokenRef = useRef(0);
  const ringStopRef = useRef<(() => void) | null>(null);
  const processingRef = useRef(false);
  // Reactive twin of processingRef — true only while a turn is transcribing
  // or routing, so the mic indicator can say "Processing…" instead of "Mic
  // off" during that brief gate (the VAD is genuinely paused, not dead).
  const [turnBusy, setTurnBusy] = useState(false);
  const processRef = useRef<(u: VadUtterance) => void | Promise<void>>(() => {});
  // Utterance captured while a turn is still unwinding (barge-in) — one slot.
  const pendingRef = useRef<VadUtterance | null>(null);
  // Set when the learner barges in; breaks the avatar's remaining speak lines.
  const bargeRef = useRef(false);
  // The avatar line the learner is currently answering. The router authors
  // lines live, so the authored graph node is stale — this is what the router
  // and the Review's "expected" column must see.
  const lastSpokenRef = useRef("");
  const {
    listening: vadListening,
    speech: vadSpeech,
    error: vadError,
    start: vadStart,
    stop: vadStop,
    setPaused: vadPause,
  } = useVad((u) => processRef.current(u));

  // Practice state
  const [currentNodeId, setCurrentNodeId] = useState<string>("greeting");
  const [recoveryStage, setRecoveryStage] = useState(0);
  const [hintShown, setHintShown] = useState<JaLine | null>(null);
  const [avatarLine, setAvatarLine] = useState<JaLine | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  // Key-info the router has confirmed the learner already gave this call
  // (label -> short Japanese value) — sent back on every routeTurn call so
  // it never re-asks for something already given. See rules.mjs routeTurnP4LLM.
  const [collected, setCollected] = useState<Record<string, string>>({});
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [intakeText, setIntakeText] = useState("");
  // Which call-type tile is expanded to show its sub-type options (null =
  // showing the 5 top-level types).
  const [expandedCall, setExpandedCall] = useState<string | null>(null);

  // Review "repeat after me" drills — one open at a time, keyed by turn number.
  const [drillTurn, setDrillTurn] = useState<number | null>(null);
  const [drillStep, setDrillStep] = useState<"playing" | "handoff" | "listening" | "done">("playing");
  const [drillRep, setDrillRep] = useState(1);
  const [drillHeard, setDrillHeard] = useState<string | null>(null);
  const [drillVerdict, setDrillVerdict] = useState<DrillVerdict | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  // Bumped on every startDrill()/close so a stale drill loop that resolves
  // after the learner moved on (closed it, opened another turn) can bail
  // instead of clobbering the new one — same idiom as dialTokenRef.
  const drillGenRef = useRef(0);
  // Set imperatively by startDrill (not through an effect, so it can't race
  // processUtterance's own effect) — the practice VAD dispatcher below reads
  // this while phase === "review" instead of routing into the dialogue engine.
  const drillProcessRef = useRef<(u: VadUtterance) => void | Promise<void>>(() => {});

  const [speechBusy, setSpeechBusy] = useState(false);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const prepAutoPlayed = useRef(false);

  // Prep-page easter egg: rolled fresh each time Prep is entered, computed
  // during render off a phase-transition comparison (React's "adjusting state
  // when a prop changes" pattern) rather than a useEffect, so entering Prep
  // and rolling the egg land in the same commit instead of an extra render.
  // The Konami code forces one immediately, bypassing the roll.
  const [activeEgg, setActiveEgg] = useState<EasterEggId | null>(null);
  const [eggPhase, setEggPhase] = useState(phase);
  if (phase !== eggPhase) {
    setEggPhase(phase);
    if (phase === "prep") setActiveEgg(rollEasterEgg() ? pickRandomEasterEgg() : null);
  }
  useKonamiCode(
    useCallback(() => {
      if (phase === "prep" && !activeEgg) setActiveEgg(pickRandomEasterEgg());
    }, [phase, activeEgg]),
  );
  // Leaving Prep mid-egg (an edge case — "I'M READY!" tapped while the
  // Colonel's still talking) cancels the in-flight run and clears the egg,
  // so it can't keep speaking through Luna once Practice starts.
  useEffect(() => {
    if (phase !== "prep" && activeEgg) {
      eggGenRef.current++;
      presenter.interruptPresentation();
      setActiveEgg(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- presenter/activeEgg read via closure, only `phase` should retrigger this
  }, [phase]);

  // Codec briefing sequence:
  //   1. Luna hidden; a looping morse-code bed plays under a typewriter
  //      mission briefing (built from the real scenario's place + goal).
  //   2. Once "OPERATIVES IN {place}" finishes typing, Luna is revealed and a
  //      handheld-transceiver blip fires; the briefing keeps typing its
  //      second (objective) line over her.
  //   3. As she starts talking, the morse bed fades out and a very low
  //      ambient texture fades in underneath her for the rest of her lines.
  //   4. She speaks the Colonel's line, then screams "SNAKE! SNAKE!".
  //   5. All SFX beds stop the moment her dialogue ends.
  // Guarded by a generation token (prepPlayGenRef's sibling) rather than a
  // useEffect cleanup/restart: `presenter` is a fresh object every render, so
  // an effect keyed on it would restart this from scratch mid-sequence —
  // exactly what shipped broken once already (silent, stuck forever).
  // Close-up crop for the reveal (see use-presenter.ts's setZoom): much
  // tighter than the reading-porthole default (1.6x) so her face fills most
  // of the small window, and slower than the default 300ms transition (the
  // shrink read as too abrupt) — both scoped to this call only, the reading
  // crop elsewhere keeps its own already-tuned scale/speed untouched.
  const EGG_ZOOM_SCALE = 2.6;
  const EGG_ZOOM_MS = 500;
  const eggGenRef = useRef(0);
  const eggStartedRef = useRef<EasterEggId | null>(null);
  // True for the CRT/scanline/filter/overlay trappings specifically — turned
  // off a beat before `activeEgg` itself clears, so Luna already looks and
  // sounds normal for her post-egg "oh, hi there" line instead of talking
  // through a green filter. `activeEgg` stays set until that line finishes,
  // purely to keep Prep's own line-autoplay from starting underneath it.
  const [eggCrtActive, setEggCrtActive] = useState(false);
  const [eggLunaVisible, setEggLunaVisible] = useState(true);
  const [introLines, setIntroLines] = useState<string[]>([]);
  const [introTyping, setIntroTyping] = useState("");
  const [crtCaption, setCrtCaption] = useState("");
  // AYB egg: bumped once per non-CATS line so AybOverlay can key a fresh
  // "flash the silhouette of another person" CSS animation each time (React
  // remounts the animated element when its key changes, restarting the
  // animation reliably — a plain toggle wouldn't retrigger on repeat lines).
  const [silhouetteFlash, setSilhouetteFlash] = useState(0);
  const runCodecBriefing = useCallback(async () => {
    eggGenRef.current++;
    const gen = eggGenRef.current;
    const live = () => eggGenRef.current === gen;
    // Cuts off Prep's line autoplay if it's already talking (e.g. the Konami
    // code fired mid-autoplay) — the roll-time guard below stops it from ever
    // starting concurrently, but this covers the manual-trigger case too.
    presenter.interruptPresentation();
    setEggCrtActive(true);
    setEggLunaVisible(false);
    setIntroLines([]);
    setIntroTyping("");
    setCrtCaption("");
    const ctx = new AudioContext();
    let morse: SfxHandle | null = null;
    let ambient: SfxHandle | null = null;
    const safeStop = (h: SfxHandle | null, fadeMs = 0) => {
      try {
        h?.stop(fadeMs);
      } catch {
        // Already stopped (e.g. its own scheduled fade already ran).
      }
    };
    const typeLine = async (text: string) => {
      for (let i = 1; i <= text.length; i++) {
        if (!live()) return false;
        setIntroTyping(text.slice(0, i));
        await sleep(18);
      }
      return true;
    };
    try {
      await ctx.resume();
      morse = await playSfxLoop(ctx, CODEC_BRIEFING.morseAudio, 0.5);
      if (!live()) return;

      const [line1, line2] = codecBriefingLines(
        content?.scenario.place ?? "the field",
        content?.scenario.goal ?? "make contact.",
      );

      if (!(await typeLine(line1))) return;
      setIntroLines([line1]);
      setIntroTyping("");

      // Reveal Luna once "OPERATIVES IN {place}" is fully on screen — close
      // in on her face rather than the resting full-porthole framing.
      setEggLunaVisible(true);
      presenter.setZoom(true, EGG_ZOOM_SCALE, EGG_ZOOM_MS);
      void playSfxOnce(ctx, CODEC_BRIEFING.transceiverAudio, 0.7);

      if (!(await typeLine(line2))) return;
      setIntroLines([line1, line2]);
      setIntroTyping("");
      if (!live()) return;
      await sleep(400);
      if (!live()) return;

      // Handoff: morse fades as she starts talking; a low ambient bed rises
      // under her for the rest of her dialogue.
      safeStop(morse, 600);
      ambient = await playSfxLoop(ctx, CODEC_BRIEFING.ambientAudio, 0.06);
      if (!live()) return;

      setCrtCaption(CODEC_BRIEFING.colonelText);
      const colonelRes = await fetch(CODEC_BRIEFING.colonelAudio);
      const colonel = await colonelRes.arrayBuffer();
      if (!live()) return;
      await speakAtLeast(presenter, colonel, CODEC_BRIEFING.colonelText, CODEC_BRIEFING.colonelDurationMs);
      if (!live()) return;
      await sleep(300);
      if (!live()) return;

      setCrtCaption(CODEC_BRIEFING.screamText);
      const screamRes = await fetch(CODEC_BRIEFING.screamAudio);
      const scream = await screamRes.arrayBuffer();
      if (!live()) return;
      await speakAtLeast(presenter, scream, CODEC_BRIEFING.screamText, CODEC_BRIEFING.screamDurationMs);
      if (!live()) return;
      await sleep(280);
    } catch {
      // Missing/failed audio still lets the beat land, just silently.
    } finally {
      safeStop(morse, 200);
      safeStop(ambient, 250);
      void ctx.close().catch(() => {});
      presenter.setZoom(false, undefined, EGG_ZOOM_MS);
      if (eggGenRef.current === gen) {
        setCrtCaption("");
        setIntroLines([]);
        setIntroTyping("");
        setEggLunaVisible(true);
        // Visuals/audio end here, but `activeEgg` stays set through the
        // trailing line below — Prep's line-autoplay watches `activeEgg`,
        // not `eggCrtActive`, so it can't start underneath her.
        setEggCrtActive(false);
      }
    }
    // Luna catching herself mid-act, back in her own voice (native TTS, not
    // a pregenerated clip — same "voice change signals it's really her"
    // idiom Review's drill uses after its own performed reps). Guarded by
    // `live()`/phase so a learner who backs out mid-egg or taps "I'M READY!"
    // in the gap right after doesn't get talked over into Practice.
    if (live() && phaseRef.current === "prep") {
      try {
        await presenter.speakText("Oh... hi there! I didn't see you. Um, let's get back to practice.");
      } catch {
        // Not critical — the egg itself already landed.
      }
    }
    if (eggGenRef.current === gen) setActiveEgg(null);
  }, [presenter, content]);

  // "All your base" briefing sequence: opens on an explosion + a looping BGM
  // bed (both free CC clips, see ALL_YOUR_BASE) over a control-room backdrop
  // (AybOverlay). Every line's audio is a pre-rendered WAV (see ALL_YOUR_BASE),
  // Promise.all) up front, concurrently with the explosion/BGM landing, so
  // no line — including Luna's first — ever waits on TTS/DSP mid-sequence.
  // Only CATS' lines are performed BY Luna (presenter.speakAudio, so her
  // lips move and the CATS costume is visible); every other speaker
  // (operator, captain) plays as plain background audio (playWav — no
  // presenter call, so her mouth never moves for a line she isn't "in") while
  // a silhouette flashes to sell "someone else is talking" and Luna's own
  // porthole stays hidden. Same generation-token guard as runCodecBriefing,
  // for the same reason (`presenter` is a fresh object every render; an
  // effect keyed on it would restart this mid-sequence).
  const AYB_ZOOM_SCALE = 1.8;
  const AYB_ZOOM_MS = 500;
  const runAllYourBase = useCallback(async () => {
    eggGenRef.current++;
    const gen = eggGenRef.current;
    const live = () => eggGenRef.current === gen;
    presenter.interruptPresentation();
    setEggCrtActive(true);
    setEggLunaVisible(false);
    setIntroLines([]);
    setCrtCaption("");

    const finaleAssets = aybFinaleAssets(aybTargetWord(content?.scenario.id));
    const finaleLine: AybLine = {
      speaker: "CATS",
      text: aybFinaleLine(aybTargetWord(content?.scenario.id)),
      voice: "susan",
      audio: finaleAssets.audio,
      durationMs: finaleAssets.durationMs,
    };
const script: AybLine[] = [...ALL_YOUR_BASE.preRevealLines, ...ALL_YOUR_BASE.catsLines, finaleLine];

// Every line is a pre-rendered WAV (no runtime TTS — see ALL_YOUR_BASE), so we
// fetch the clips up front in parallel for an immediate start, then await them
// in order in the loop. Attach a catch so an early exit leaves no unhandled
// rejection; the awaits still throw to the surrounding catch on a real failure.
const clipPromises = script.map((l) =>
  fetch(l.audio).then((r) => r.arrayBuffer()).then((buf) => ({ audio: buf, durationMs: l.durationMs ?? 0 })),
);
const laughClipPromise = fetch(ALL_YOUR_BASE.laughAudio)
  .then((r) => r.arrayBuffer())
  .then((buf) => ({ audio: buf, durationMs: ALL_YOUR_BASE.laughDurationMs }));
clipPromises.forEach((p) => p.catch(() => {}));
laughClipPromise.catch(() => {});

const ctx = new AudioContext();
    let bgm: SfxHandle | null = null;
    const safeStop = (h: SfxHandle | null, fadeMs = 0) => {
      try {
        h?.stop(fadeMs);
      } catch {
        // Already stopped (e.g. its own scheduled fade already ran).
      }
    };
    try {
      await ctx.resume();
      void playSfxOnce(ctx, ALL_YOUR_BASE.explosionAudio, 0.8);
      bgm = await playSfxLoop(ctx, ALL_YOUR_BASE.bgmAudio, 0.12);
if (!live()) return;

for (let i = 0; i < script.length; i++) {
const line = script[i];
const clip = await clipPromises[i];
        const isFinale = i === script.length - 1;
        const isCats = line.speaker === "CATS";
        if (!live()) return;
        if (isCats) {
          setEggLunaVisible(true);
          presenter.setZoom(true, AYB_ZOOM_SCALE, AYB_ZOOM_MS);
          if (isFinale) {
            setIntroLines([]);
            setCrtCaption(line.text);
          } else {
            setIntroLines([`${line.speaker}: ${line.text}`]);
          }
          await speakAtLeast(presenter, clip.audio, line.text, clip.durationMs);
        } else {
          setEggLunaVisible(false);
          setSilhouetteFlash((k) => k + 1);
          setIntroLines([`${line.speaker}: ${line.text}`]);
          await playWav(clip.audio);
        }
        if (!live()) return;
        await sleep(isFinale ? 300 : 250);
        if (!live()) return;
      }

setEggLunaVisible(true);
setCrtCaption(ALL_YOUR_BASE.laughText);
const laughClip = await laughClipPromise;
await speakAtLeast(presenter, laughClip.audio, ALL_YOUR_BASE.laughAudioText, laughClip.durationMs);
      if (!live()) return;
      await sleep(280);
    } catch {
      // Missing/failed audio still lets the beat land, just silently.
    } finally {
      safeStop(bgm, 400);
      void ctx.close().catch(() => {});
      presenter.setZoom(false, undefined, AYB_ZOOM_MS);
      if (eggGenRef.current === gen) {
        setCrtCaption("");
        setIntroLines([]);
        setSilhouetteFlash(0);
        setEggLunaVisible(true);
        setEggCrtActive(false);
      }
    }
    if (live() && phaseRef.current === "prep") {
      try {
        await presenter.speakText("...sorry, must've crossed wires with another channel there. Right — where were we?");
      } catch {
        // Not critical — the egg itself already landed.
      }
    }
    if (eggGenRef.current === gen) setActiveEgg(null);
  }, [presenter, content]);

  // Third egg: a genuinely playable DOOM-style minigame (DoomEgg.tsx owns the
  // canvas/game loop/input — this just arms it and tears it down). Unlike the
  // two scripted sequences above there's no async script to run: entering the
  // "on" state is synchronous, and <DoomOverlay> below drives its own
  // lifecycle, calling finishDoomInvasion when it's done (death, escape/✕
  // tap, or the untouched-demo timing out). Luna's own porthole stays
  // VISIBLE and LIVE for the whole run, repositioned to the bottom-center
  // HUD slot (eggOverlay: "doom" in computeLayout below, never resized) with
  // only a mild retro CSS filter — per user direction, real reactions/lip-
  // sync beat literal pixelation, and pixelating her actual rendering turned
  // out not to be achievable anyway (tried twice: reading her canvas comes
  // back blank regardless of timing, and separately nothing drawn in front
  // of her actually composites on top of her — see DoomEgg.tsx's main-effect
  // comment for the full story).
  const runDoomInvasion = useCallback(() => {
    eggGenRef.current++;
    presenter.interruptPresentation();
    setEggCrtActive(true);
    setEggLunaVisible(true);
  }, [presenter]);
  const finishDoomInvasion = useCallback(async () => {
    const gen = eggGenRef.current;
    setEggCrtActive(false);
    if (eggGenRef.current === gen && phaseRef.current === "prep") {
      try {
        await presenter.speakText("Whew — mice everywhere! Anyway... where were we?");
      } catch {
        // Not critical — the egg itself already landed.
      }
    }
    if (eggGenRef.current === gen) setActiveEgg(null);
  }, [presenter]);

  useEffect(() => {
    if (activeEgg === "codec-briefing" && eggStartedRef.current !== "codec-briefing") {
      eggStartedRef.current = "codec-briefing";
      void runCodecBriefing();
    }
    if (activeEgg === "all-your-base" && eggStartedRef.current !== "all-your-base") {
      eggStartedRef.current = "all-your-base";
      void runAllYourBase();
    }
    if (activeEgg === "doom-invasion" && eggStartedRef.current !== "doom-invasion") {
      eggStartedRef.current = "doom-invasion";
      runDoomInvasion();
    }
    if (activeEgg === null) eggStartedRef.current = null;
  }, [activeEgg, runCodecBriefing, runAllYourBase, runDoomInvasion]);

  // Prep's practice-line pool: each variant's prep-lines.json is now a
  // curated, real 20-line library (see content/scenarios/*/*/prep-lines.json),
  // so the pool is just that — de-duplicated by exact text defensively, but
  // no longer padded out with dialogue recovery hints or variant intro lines
  // (those skew trivial — e.g. bare name statements — since they're authored
  // for in-conversation nudging, not standalone practice).
  const prepPool = useMemo<JaLine[]>(() => {
    if (!content) return [];
    const pool: JaLine[] = [];
    const seen = new Set<string>();
    for (const line of content.prep_lines) {
      if (!seen.has(line.ja)) {
        pool.push(line);
        seen.add(line.ja);
      }
    }
    return pool;
  }, [content]);

  // Which pool indices are on screen (display order) and which have ever been
  // shown this session (so More/Dismiss never repeat a line). Reset
  // synchronously during render when `content` changes (React's "adjusting
  // state when a prop changes" pattern) rather than in a useEffect — an
  // effect here would
  // commit one render late, after the "autoplay on enter prep" effect below
  // already ran (and latched its once-only guard) against an empty
  // `displayed`, silently skipping the read-through on every fresh scenario.
  const [displayed, setDisplayed] = useState<number[]>([]);
  const [usedPool, setUsedPool] = useState<Set<number>>(new Set());
  const [prepPoolFor, setPrepPoolFor] = useState<ContentBundle | null>(null);
  if (content !== prepPoolFor) {
    setPrepPoolFor(content);
    const initial = [0, 1, 2].filter((i) => i < prepPool.length);
    setDisplayed(initial);
    setUsedPool(new Set(initial));
  }

  const moreAvailable = displayed.length < 5 && usedPool.size < prepPool.length;

  // Generation token guarding in-flight prep audio (playPrepLine, further
  // below): incrementing it invalidates whatever prerenderLine()/playWav()
  // is still resolving, so dismissing (or More-ing away) the line that's
  // currently playing can't have its now-stale audio land and play anyway.
  const prepPlayGenRef = useRef(0);
  const stopPrepPlayback = useCallback(() => {
    prepPlayGenRef.current++;
    stopWav();
    setPlayingIdx(null);
    setSpeechBusy(false);
  }, []);

  const showMore = useCallback(() => {
    const next = prepPool.findIndex((_, i) => !usedPool.has(i));
    if (next === -1) return;
    setDisplayed((d) => [...d, next]);
    setUsedPool((s) => new Set(s).add(next));
  }, [prepPool, usedPool]);

  const dismissLine = useCallback(
    (pos: number) => {
      if (playingIdx === pos) stopPrepPlayback();
      const next = prepPool.findIndex((_, i) => !usedPool.has(i));
      setDisplayed((d) => {
        const copy = [...d];
        if (next === -1) copy.splice(pos, 1);
        else copy[pos] = next;
        return copy;
      });
      if (next !== -1) setUsedPool((s) => new Set(s).add(next));
    },
    [prepPool, usedPool, playingIdx, stopPrepPlayback],
  );
  const phaseRef = useRef(phase);
  const intakeRef = useRef<HTMLElement | null>(null);
  // The reserved porthole slot inside Intake's title row. computeLayout and
  // the door cover must both measure THIS, not the section: the section's rect
  // shifts with the band's per-phase offset, which once left the porthole
  // posed 24px off its slot.
  const slotRef = useRef<HTMLDivElement | null>(null);
  // The door cover tracks this rect live (same slot computeLayout poses the
  // porthole at) so it follows the band's scroll without re-rendering. Viewport
  // rects of band-relative targets are only valid once the band's per-phase top
  // offset has committed, which happens in response to the pose push itself —
  // so rebase onto the band and add the phase's known offset to get the settled
  // position immediately.
  const measureDoorRect = () => {
    const r = slotRef.current?.getBoundingClientRect();
    if (!r) return null;
    const band = scrollRef.current?.getBoundingClientRect().top ?? 0;
    return { left: r.left, top: r.top - band + (HEADER_H + 16), size: PORTHOLE_SIZE };
  };
  const prepRef = useRef<HTMLElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Review's own porthole-follows-the-open-drill-card tracking — a separate
  // ref/effect pair from Prep's (below), not folded into it: Prep's staged
  // rAF+timeout choreography is delicate and already shipped, so this stays
  // isolated rather than risk a regression there.
  const reviewLineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const reviewSlotRef = useRef<{ loc: "center" | "line"; size: number }>({
    loc: "center",
    size: PORTHOLE_SIZE,
  });
  const wasDrillingRef = useRef(false);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // The content band scrolls; reset to top on phase changes so controls are in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [phase, scrollRef]);

  // Call timer for the connected-state top bar. callSeconds is reset at each
  // callState transition away from "connected" (dial/cancelDial/goToReview),
  // not here — this effect only owns starting/stopping the tick.
  useEffect(() => {
    if (callState !== "connected") return;
    const id = window.setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [callState]);

  // Porthole posing: hidden on welcome; intake/prep anchored top-left beside
  // the section title; review centered. In prep the slot ref tracks whether
  // Luna is at the title or down the gutter so scroll re-measures stay put.
  const prepSlotRef = useRef<{ loc: "title" | "line"; size: number }>({
    loc: "title",
    size: PORTHOLE_SIZE,
  });
  const wasReadingRef = useRef(false);

  const computeLayout = useCallback(
    (animate: boolean): StageLayout => {
      const vw = window.innerWidth;
      const centered = (visible: boolean): StageLayout => ({
        fullscreen: false,
        visible,
        left: (vw - PORTHOLE_SIZE) / 2,
        top: HEADER_H + 16,
        size: PORTHOLE_SIZE,
        animate,
        bandTop: HEADER_H + 240,
      });
      if (phase === "practice") {
        // Call screen: the band shares the exact same rect as the video so
        // status/caption/control bars can never land outside it. Idle/dialing
        // keep the video itself hidden — it's still whatever avatar was last
        // loaded (the coach) until dial() finishes re-initializing it to the
        // practice avatar — but the rect (and, on desktop, its bezel) stays
        // up the whole time so the call reads as one phone throughout.
        const rect = computePhoneRect(callState === "idle");
        return {
          fullscreen: true,
          visible: callState === "connected",
          left: rect.left,
          top: rect.top,
          size: 0,
          width: rect.width,
          height: rect.height,
          framed: rect.framed,
          animate,
          bandTop: 0,
        };
      }
      if (phase === "intake") {
        const r = slotRef.current?.getBoundingClientRect() ?? intakeRef.current?.getBoundingClientRect();
        if (!r) return { ...centered(true), bandTop: HEADER_H + 16 };
        const band = scrollRef.current?.getBoundingClientRect().top ?? 0;
        return {
          fullscreen: false,
          // While the door cover holds, the stage stays invisible: the doors
          // are the porthole's surface until the swing reveals her (the prior
          // app hid the stage for the same reason). Also avoids any bezel
          // peeking past the cover while the pose settles.
          visible: doorsOn ? presenter.ready : true,
          left: r.left,
          top: r.top - band + (HEADER_H + 16),
          size: PORTHOLE_SIZE,
          animate,
          bandTop: HEADER_H + 16,
        };
      }
      if (phase === "prep") {
        if (activeEgg === "doom-invasion" && eggCrtActive) {
          // Bottom-center "status bar" slot — same PORTHOLE_SIZE as always,
          // only left/top move (see DOOM_FACE_SIZE's comment on why that's
          // the safe half of repositioning her live element). Stays
          // genuinely visible/live here — pixelating her rendering was
          // tried twice and isn't achievable (see DoomEgg.tsx's main-effect
          // comment) — with only a mild retro filter (eggOverlay: "doom" in
          // App.tsx's stageView), the same safe direct-filter mechanism
          // codec/ayb already use.
          const vh = window.innerHeight;
          const rect = doomFaceRect(vw, vh);
          return {
            fullscreen: false,
            visible: true,
            left: rect.left,
            top: rect.top,
            size: rect.size,
            animate,
            bandTop: HEADER_H + 16,
            eggOverlay: "doom",
          };
        }
        const s = prepRef.current?.getBoundingClientRect();
        const eggOverlay = eggCrtActive ? (activeEgg === "all-your-base" ? ("ayb" as const) : ("codec" as const)) : undefined;
        const visible = eggCrtActive ? eggLunaVisible : true;
        if (!s) return { ...centered(visible), bandTop: HEADER_H + 16, eggOverlay };
        const band = scrollRef.current?.getBoundingClientRect().top ?? 0;
        const slot = prepSlotRef.current;
        let top = s.top - band + (HEADER_H + 16);
        if (slot.loc === "line" && playingIdx !== null) {
          const row = lineRefs.current[playingIdx]?.getBoundingClientRect();
          if (row) top = row.top + (row.height - READ_SIZE) / 2 - band + (HEADER_H + 16);
        }
        return {
          fullscreen: false,
          visible,
          left: s.left,
          top,
          size: slot.size,
          animate,
          bandTop: HEADER_H + 16,
          // Active egg's treatment of Luna's own window, in place (see App.tsx's
          // stageView) — deliberately NOT resizing/repositioning her (that
          // broke the presenter widget's rendering permanently once already,
          // see the easter-eggs project memory) — same left/top/size as always.
          eggOverlay,
        };
      }
      if (phase === "review") {
        if (drillTurn === null) return centered(true);
        const row = reviewLineRefs.current[drillTurn]?.getBoundingClientRect();
        if (!row) return { ...centered(true), bandTop: HEADER_H + 16 };
        const band = scrollRef.current?.getBoundingClientRect().top ?? 0;
        const slot = reviewSlotRef.current;
        return {
          fullscreen: false,
          visible: true,
          left: row.left,
          top: row.top + (row.height - slot.size) / 2 - band + (HEADER_H + 16),
          size: slot.size,
          animate,
          bandTop: HEADER_H + 16,
        };
      }
      // welcome: porthole hidden, so the content can sit higher
      return { ...centered(false), bandTop: HEADER_H + 40 };
    },
    [phase, playingIdx, callState, doorsOn, presenter.ready, scrollRef, drillTurn, eggCrtActive, eggLunaVisible, activeEgg],
  );

  // Local mirror of the last layout pushed to App — needed so the practice
  // screen can decide, at render time, whether it's framed (desktop) and
  // where the phone rect sits, e.g. to place captions beside it rather than
  // inside it.
  const [myLayout, setMyLayout] = useState<StageLayout | null>(null);
  const pushLayout = useCallback(
    (next: StageLayout) => {
      setMyLayout(next);
      onStageLayout(next);
    },
    [onStageLayout],
  );

  // Measured a frame late so the band offset has committed first. Reading
  // transitions are staged: shrink (or regrow) at the title slot, then move —
  // Luna never crosses the cards while they slide.
  useEffect(() => {
    let inner = 0;
    let timer = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const reading = phase === "prep" && playingIdx !== null;
        const staged = phase === "prep" && reading !== wasReadingRef.current;
        if (staged) presenter.setZoom(reading);
        wasReadingRef.current = reading;
        if (staged) {
          prepSlotRef.current = { loc: "title", size: READ_SIZE };
          pushLayout(computeLayout(true));
          timer = window.setTimeout(() => {
            prepSlotRef.current = reading
              ? { loc: "line", size: READ_SIZE }
              : { loc: "title", size: PORTHOLE_SIZE };
            pushLayout(computeLayout(true));
          }, STAGE_MS);
        } else {
          if (reading) prepSlotRef.current = { loc: "line", size: READ_SIZE };
          else if (phase === "prep") prepSlotRef.current = { loc: "title", size: PORTHOLE_SIZE };
          pushLayout(computeLayout(true));
        }
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(timer);
    };
  }, [computeLayout, pushLayout, content, phase, playingIdx]);

  // Same staged shrink-then-move choreography as Prep's effect above, but
  // for Review's "repeat after me" drill — kept as its own effect/ref pair
  // (reviewSlotRef/wasDrillingRef) rather than folded into Prep's, so this
  // addition can't regress Prep's already-shipped behavior.
  useEffect(() => {
    let inner = 0;
    let timer = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const drilling = phase === "review" && drillTurn !== null;
        const staged = phase === "review" && drilling !== wasDrillingRef.current;
        if (staged) presenter.setZoom(drilling);
        wasDrillingRef.current = drilling;
        if (staged) {
          reviewSlotRef.current = { loc: "center", size: READ_SIZE };
          pushLayout(computeLayout(true));
          timer = window.setTimeout(() => {
            reviewSlotRef.current = drilling
              ? { loc: "line", size: READ_SIZE }
              : { loc: "center", size: PORTHOLE_SIZE };
            pushLayout(computeLayout(true));
          }, STAGE_MS);
        } else {
          if (drilling) reviewSlotRef.current = { loc: "line", size: READ_SIZE };
          else if (phase === "review") reviewSlotRef.current = { loc: "center", size: PORTHOLE_SIZE };
          pushLayout(computeLayout(true));
        }
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(timer);
    };
  }, [computeLayout, pushLayout, phase, drillTurn]);

  // Scroll/resize move the measured targets; re-pose without animation.
  useEffect(() => {
    const scroller = scrollRef.current;
    const report = () => pushLayout(computeLayout(false));
    scroller?.addEventListener("scroll", report);
    window.addEventListener("resize", report);
    return () => {
      scroller?.removeEventListener("scroll", report);
      window.removeEventListener("resize", report);
    };
  }, [computeLayout, pushLayout, scrollRef]);

  // While the door cover is up, keep re-asserting the pose on a timer: the
  // pushes that hide the stage and commit the band offset are rAF-gated, so in
  // a tab that isn't painting (backgrounded, or a capture harness) the gate
  // and the pose could otherwise lag behind the cover. 100 ms bounds it.
  useEffect(() => {
    if (!doorsOn) return;
    let last = "";
    const push = () => {
      const next = { ...computeLayout(false), visible: presenter.ready };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        pushLayout(next);
      }
    };
    push();
    const id = window.setInterval(push, 100);
    return () => window.clearInterval(id);
  }, [doorsOn, presenter.ready, computeLayout, pushLayout]);

  // Load authored content once.
  useEffect(() => {
    let alive = true;
    fetchContent()
      .then((c) => alive && setContent(c))
      .catch((e) => alive && setStatus(`content error: ${(e as Error).message}`));
    return () => {
      alive = false;
    };
  }, []);

  // BYO-TTS (ADR-0004): prerender Japanese audio via homelab TTS and play it
  // directly — Prep examples are NOT spoken by Luna. English coaching stays on
  // native present() via speakText.

  // ---- Welcome ----
  // Intake is entered immediately and the door cover masks the init over the
  // porthole; the doors' swing is gated on presenter.ready, so a slow asset
  // load holds them shut instead of being revealed mid-load.
  const begin = useCallback(async () => {
    setStatus("warming up Luna…");
    setDoorsOn(true);
    setPhase("intake");
    try {
      await presenter.resumeAudio();
      await presenter.initialize(token, {
        avatarId: config.coach.avatar_id,
        sceneId: config.coach.scene_id,
        voiceId: config.coach.voice_id || undefined,
      });
      await presenter.waitReady();
      // waitReady() falls through on timeout rather than throwing (by
      // design) — check the real flag so a connect that never actually
      // completed doesn't get treated as a success (same trap noted on
      // runIntake below).
      if (!presenter.ready) {
        throw new Error("connection never completed");
      }
      // Bust shot for the small porthole, matching the full-bleed call screen.
      presenter.setCameraAngle("halfbody");
      setStatus("");
    } catch (err) {
      // Leave doorsOn alone: the door cover is still up and, since
      // presenter.ready stayed false, its own CAP_MS give-up takes over —
      // drawn shut with a "Luna is away" message instead of this abruptly
      // revealing the stalled/blank porthole. This status is what's behind
      // the doors for whenever the learner taps through.
      setStatus(`Luna is away right now — ${(err as Error).message}`);
    }
  }, [presenter, token, config]);

  // ---- Intake (confirmation stub) ----
  const runIntake = useCallback(
    async (transcript: string) => {
      // presenter.waitReady() below falls through on timeout rather than
      // throwing (by design), so a call that finishes before the Perxona
      // scene has actually loaded silently proceeds into a guaranteed
      // presentation failure. The door cover's own 9s cap (door-timeline.ts
      // CAP_MS) can already reveal Intake before that load — measured
      // 12-33s against cdn.perxona.ai — well before presenter.ready is
      // actually true, so this isn't a rare race. Check the real flag
      // instead of trusting waitReady() alone.
      if (!presenter.ready) {
        setStatus("Luna is still getting ready — one moment…");
        return;
      }
      setStatus("Luna is confirming…");
      try {
        const result = await classifyIntake(transcript);
        setIntakeText(transcript);
        let title = content?.scenario.title ?? "your call";
        if (result.scenarioId !== content?.scenario.id || result.variant !== content?.variant.id) {
          const newContent = await fetchContent(result.scenarioId, result.variant);
          setContent(newContent);
          title = newContent.scenario.title;
        }
        // classifyIntake's LLM round-trip usually gives the presenter enough
        // idle time to settle, but that's incidental, not a guarantee.
        await presenter.waitReady();
        // speakTextAtLeast, not a raw speakText: setPhase("prep") right below
        // triggers the egg roll and runPrepAuto's own speakText on the very
        // next render, and both can grab the presenter's single audio
        // channel (the egg via an explicit interruptPresentation()) the
        // instant this line's promise resolves — which, per speakTextAtLeast's
        // own comment, can be well before the audio is actually done. Without
        // the floor here, this line went out mostly or entirely silent.
        await speakTextAtLeast(
          presenter,
          `Got it — ${title.toLowerCase()}. I'll put together some practice sentences.`,
        );
        setStatus("");
        setPhase("prep");
      } catch (err) {
        setStatus(`classify error: ${(err as Error).message}`);
      }
    },
    [presenter, content],
  );

  // One-tap intake: skip the classifier entirely for a known (scenario, variant).
  const quickPick = useCallback(
    async (scenarioId: string, variantId: string) => {
      // See the same guard + comment in runIntake above.
      if (!presenter.ready) {
        setStatus("Luna is still getting ready — one moment…");
        return;
      }
      setStatus("Luna is confirming…");
      try {
        const newContent = await fetchContent(scenarioId, variantId);
        setContent(newContent);
        // No LLM round-trip here to accidentally buy the presenter settling
        // time the way classifyIntake does — wait for it explicitly.
        await presenter.waitReady();
        // See the speakTextAtLeast comment in runIntake above — same fix,
        // same reason (egg roll / runPrepAuto stealing the audio channel the
        // instant setPhase("prep") below commits).
        await speakTextAtLeast(
          presenter,
          `Got it — ${newContent.scenario.title.toLowerCase()}. I'll put together some practice sentences.`,
        );
        setStatus("");
        setPhase("prep");
      } catch (err) {
        setStatus(`content error: ${(err as Error).message}`);
      }
    },
    [presenter],
  );

  const speakIntakeAudio = useCallback(async () => {
    try {
      await presenter.speakText(
        activeProfile
          ? `Hi ${activeProfile.name}! I'm Luna. What phone call would you like to practice today? For example, calling a clinic or booking a restaurant.`
          : "Hi! I'm Luna. What phone call would you like to practice today? For example, calling a clinic or booking a restaurant.",
      );
    } catch (err) {
      setStatus(`audio error: ${(err as Error).message}`);
    }
  }, [presenter, activeProfile]);

  // Intake's VAD session: one utterance, same auto-detect language as the
  // practice call (see .mic-status) instead of a manual record/stop toggle.
  const startIntakeTalk = useCallback(async () => {
    // Same guard as quickPick/runIntake — recording an utterance the
    // presenter can't yet respond to just delays the same failure.
    if (!presenter.ready) {
      setStatus("Luna is still getting ready — one moment…");
      return;
    }
    setIntakeTalking(true);
    setStatus("listening…");
    presenter.setListening(true);
    try {
      await intakeVadStart();
    } catch (err) {
      setIntakeTalking(false);
      presenter.setListening(false);
      setStatus(`intake mic error: ${(err as Error).message}`);
    }
  }, [intakeVadStart, presenter]);

  const cancelIntakeTalk = useCallback(() => {
    intakeVadStop();
    setIntakeTalking(false);
    presenter.setListening(false);
    setStatus("");
  }, [intakeVadStop, presenter]);

  const processIntakeUtterance = useCallback(
    async ({ base64, mimeType }: VadUtterance) => {
      intakeVadStop();
      setIntakeTalking(false);
      presenter.setListening(false);
      setIntakeBusy(true);
      try {
        setStatus("transcribing…");
        // Intake is spoken in English — tag the STT accordingly (practice is ja).
        const { text } = await transcribeAudio(base64, mimeType, "en");
        if (!text.trim()) {
          setStatus("Didn't catch that — try again, or type it in.");
          return;
        }
        await runIntake(text);
      } catch (err) {
        setStatus(`intake mic error: ${(err as Error).message}`);
      } finally {
        setIntakeBusy(false);
      }
    },
    [runIntake, presenter, intakeVadStop],
  );

  useEffect(() => {
    intakeProcessRef.current = processIntakeUtterance;
  }, [processIntakeUtterance]);

  // Safety net: leaving intake closes its mic, whichever way the phase changed.
  // intakeTalking is already false by the time phase actually moves on (every
  // real transition goes through processIntakeUtterance or quickPick, both of
  // which clear it themselves) — this only guards the VAD instance itself.
  useEffect(() => {
    if (phase !== "intake") intakeVadStop();
  }, [phase, intakeVadStop]);

  // ---- Prep ----
  // Live mirror of `displayed` for the auto-sequence below to consult —
  // a plain closure over React state would freeze at whatever `displayed`
  // was when the async loop started, which is exactly the earlier bug
  // (dismissing line 3 while line 1 was playing still played the *old* line
  // 3 once the loop reached it, because the loop had snapshotted the whole
  // list up front). Reading this ref fresh at the top of every iteration
  // means a Dismiss/More that lands mid-sequence is picked up correctly.
  const displayedRef = useRef<number[]>(displayed);
  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  // Speaks one line's English (Luna's own voice), then plays its Japanese
  // audio once per voice in `voices` (ADR-0009: auto-narration plays both —
  // female then male — tap-to-replay plays just the female voice) — shared
  // by both the auto-sequence and the on-demand Play button, so "she always
  // says the English before the example" holds either way. `index` is the
  // line's position in its variant's prep_lines array (== prepPool's index,
  // since the pool is that array verbatim) — the address pre-baked Prep
  // audio is keyed by; see prep-audio.ts. Returns false if invalidated
  // mid-flight (a Dismiss/teardown bumped the generation token via
  // stopPrepPlayback) so a caller looping over several lines/voices knows to
  // stop rather than continue on stale state.
  const speakPrepLine = useCallback(
    async (line: JaLine, index: number, gen: number, voices: readonly string[]) => {
      if (!content) return false;
      if (prepPlayGenRef.current !== gen) return false;
      await speakTextAtLeast(presenter, line.en);
      for (let i = 0; i < voices.length; i++) {
        if (prepPlayGenRef.current !== gen) return false;
        await playPrepExample(content.scenario.id, content.variant.id, index, voices[i], line.ja);
        if (i < voices.length - 1) {
          if (prepPlayGenRef.current !== gen) return false;
          await sleep(VOICE_GAP_MS);
        }
      }
      return prepPlayGenRef.current === gen;
    },
    [presenter, content],
  );

  // On entering Prep, Luna narrates straight through whatever's displayed
  // (English then Japanese per line) — once per scenario, same as before;
  // "Read lines again" and the end-of-run status text are gone (per QA), but
  // the auto-narration itself stays. Safe against Dismiss/More landing
  // mid-sequence via displayedRef + the generation-token guard above.
  const runPrepAuto = useCallback(async () => {
    if (!content) return;
    prepPlayGenRef.current++;
    const gen = prepPlayGenRef.current;
    setSpeechBusy(true);
    try {
      if (phaseRef.current !== "prep") return;
      await presenter.speakText("Now let's practice some key vocabulary.");
      for (let pos = 0; pos < displayedRef.current.length; pos++) {
        if (phaseRef.current !== "prep" || prepPlayGenRef.current !== gen) return;
        const index = displayedRef.current[pos];
        const line = prepPool[index];
        if (!line) continue;
        setPlayingIdx(pos);
        const ok = await speakPrepLine(line, index, gen, PREP_VOICES);
        if (!ok) return;
        if (pos < displayedRef.current.length - 1) await sleep(SECTION_PAUSE_MS);
      }
    } catch (err) {
      if (phaseRef.current === "prep") setStatus(`prep audio error: ${(err as Error).message}`);
    } finally {
      if (prepPlayGenRef.current === gen) {
        setPlayingIdx(null);
        setSpeechBusy(false);
      }
    }
  }, [content, presenter, prepPool, speakPrepLine]);

  // Held off while the codec egg is active (both fought over the same
  // presenter audio channel — Luna's briefing line was getting talked over
  // by the line autoplay starting mid-egg), then given a 1s gap once the egg
  // clears so the two don't read as one continuous, jarring handoff.
  //
  // runPrepAuto is read via a ref, and deliberately left out of the effect's
  // deps: runPrepAuto closes over `presenter`, a fresh object every render,
  // so its identity churns constantly — with it in the deps, the scheduled
  // setTimeout below got torn down by React's cleanup before it ever fired,
  // and the delayed autoplay silently never started at all.
  const runPrepAutoRef = useRef(runPrepAuto);
  useEffect(() => {
    runPrepAutoRef.current = runPrepAuto;
  }, [runPrepAuto]);
  const eggBlockedAutoplayRef = useRef(false);
  useEffect(() => {
    if (phase !== "prep" || !content || prepAutoPlayed.current) return;
    if (activeEgg) {
      eggBlockedAutoplayRef.current = true;
      return;
    }
    prepAutoPlayed.current = true;
    const gapMs = eggBlockedAutoplayRef.current ? 1000 : 0;
    eggBlockedAutoplayRef.current = false;
    const timer = window.setTimeout(() => void runPrepAutoRef.current(), gapMs);
    return () => window.clearTimeout(timer);
  }, [phase, content, activeEgg]);

  // On-demand replay: tapping Play speaks the English then the Japanese
  // example once, female voice only (ADR-0009) — auto-narration is the only
  // place both voices play. Guarded by the same generation token so
  // dismissing (or More-ing away) the line that's currently playing can't
  // have its now-stale audio finish and stomp on whatever's playing next —
  // see stopPrepPlayback near the pool state above.
  const playPrepLine = useCallback(
    async (pos: number) => {
      const index = displayed[pos];
      const line = prepPool[index];
      if (!line) return;
      prepPlayGenRef.current++;
      const gen = prepPlayGenRef.current;
      setSpeechBusy(true);
      setPlayingIdx(pos);
      try {
        await speakPrepLine(line, index, gen, [PREP_VOICES[0]]);
      } catch (err) {
        if (prepPlayGenRef.current === gen) setStatus(`audio error: ${(err as Error).message}`);
      } finally {
        if (prepPlayGenRef.current === gen) {
          setPlayingIdx(null);
          setSpeechBusy(false);
        }
      }
    },
    [prepPool, displayed, speakPrepLine],
  );

  // ---- Review "repeat after me" drills: Luna speaks the target line 3x on
  // our own pregenerated TTS (piped through the avatar via speakAudio, so it
  // looks like she's saying it), then listens once via the shared VAD/STT
  // pipeline and shows what it heard. Torn down from enterPractice/resetFlow
  // (the only two ways to leave Review) rather than a phase-watching effect —
  // it's the event that ends Review, not a derived reaction to it.
  const stopDrill = useCallback(() => {
    drillGenRef.current++;
    presenter.interruptPresentation();
    vadPause(true);
    presenter.setListening(false);
    setDrillTurn(null);
  }, [presenter, vadPause]);

  const startDrill = useCallback(
    async (t: ReviewResult["perTurn"][number]) => {
      const target = resolveDrillTarget(t, content);
      if (!target) return;
      drillGenRef.current++;
      const gen = drillGenRef.current;
      presenter.interruptPresentation();
      setDrillTurn(t.turn);
      setDrillStep("playing");
      setDrillRep(1);
      setDrillHeard(null);
      setDrillVerdict(null);
      setDrillError(null);
      try {
        for (let rep = 1; rep <= 2; rep++) {
          if (drillGenRef.current !== gen) return;
          setDrillRep(rep);
          const audio = await prerenderLine(target.ja, PREP_VOICES[0]);
          if (drillGenRef.current !== gen) return;
          await presenter.speakAudio(audio, target.ja);
          if (drillGenRef.current !== gen) return;
          if (rep < 2) await sleep(SECTION_PAUSE_MS);
        }
        if (drillGenRef.current !== gen) return;
        // Her native voice, deliberately not speakAudio — the voice change
        // itself signals the reps are over and it's the learner's turn.
        setDrillStep("handoff");
        await presenter.speakText("Now it's your turn.");
        if (drillGenRef.current !== gen) return;
        setDrillStep("listening");
        presenter.setListening(true);
        drillProcessRef.current = async ({ base64, mimeType }) => {
          if (drillGenRef.current !== gen) return;
          vadPause(true);
          presenter.setListening(false);
          try {
            // No reason to ever hear English here — the learner is repeating
            // a known Japanese line — and the prompt hint biases recognition
            // toward the target's own vocabulary (crucial for an unusual
            // katakana name, which a bare language hint doesn't help with).
            const { text } = await transcribeAudio(base64, mimeType, "ja", target.ja);
            if (drillGenRef.current !== gen) return;
            setDrillHeard(text);
            setDrillVerdict(computeDrillVerdict(target.ja, text));
            setDrillStep("done");
          } catch (err) {
            if (drillGenRef.current !== gen) return;
            setDrillError((err as Error).message);
            setDrillStep("done");
          }
        };
        await vadStart();
        if (drillGenRef.current !== gen) return;
        vadPause(false);
      } catch (err) {
        if (drillGenRef.current === gen) setDrillError((err as Error).message);
      }
    },
    [content, presenter, vadStart, vadPause],
  );

  // Enter (or re-enter) practice at the Dial button — the call ritual
  // (dial → ringback → answer → VAD conversation) starts from `dial()`.
  const enterPractice = useCallback(() => {
    if (!content) return;
    stopDrill();
    stopWav();
    vadStop();
    presenter.setListening(false);
    processingRef.current = false;
    pendingRef.current = null;
    bargeRef.current = false;
    lastSpokenRef.current = "";
    setTurnBusy(false);
    setPhase("practice");
    setCallState("idle");
    setCallSeconds(0);
    setCurrentNodeId(content.dialogue.start_node);
    setRecoveryStage(0);
    setHintShown(null);
    setTurns([]);
    setCollected({});
    setReview(null);
    setAvatarLine(null);
    setStatus(`Press Dial to call ${content.scenario.place}.`);
  }, [content, presenter, vadStop, stopDrill]);

  // Dial → ringback (which also masks the presenter re-init) → the
  // far side answers with the authored start line → open the VAD mic.
  const dial = useCallback(async () => {
    if (!content) return;
    const myToken = ++dialTokenRef.current;
    setCallState("dialing");
    setCallSeconds(0);
    setStatus("ringing…");
    setSpeechBusy(true);
    const ring = playRingback(2);
    ringStopRef.current = ring.stop;
    try {
      // Everything slow hides behind the ringback: presenter re-init, the
      // Silero/ONNX load and the mic permission prompt. The VAD is paused the
      // instant the mic opens so the ring itself can never be heard as an
      // utterance, and stays paused until the greeting finishes.
      await Promise.all([
        (async () => {
          await presenter.initialize(token, {
            avatarId: config.practice.avatar_id,
            sceneId: config.practice.scene_id,
            voiceId: config.practice.voice_id || undefined,
          });
          await presenter.waitReady();
        })(),
        vadStart().then(() => vadPause(true)),
        ring.promise, // the far side "answers" when the ring finishes
      ]);
      // Cancelled while ringing — the token has moved on, don't land the call.
      if (dialTokenRef.current !== myToken) return;
      setCallState("connected");
      // Half-body framing for the full-bleed call screen — same bust shot the
      // small porthole uses elsewhere, just filling the phone rect instead.
      presenter.setCameraAngle("halfbody");
      const first = content.dialogue.nodes[content.dialogue.start_node];
      if (first) {
        setAvatarLine(first.line);
        lastSpokenRef.current = first.line.ja;
        await presenter.speakText(first.line.ja);
      }
      if (dialTokenRef.current !== myToken) return;
      vadPause(false);
      // Listening pose stays up for the whole conversation (Talking overrides
      // it while the avatar speaks and it resumes after).
      presenter.setListening(true);
      setStatus("Your turn — speak in Japanese.");
    } catch (err) {
      if (dialTokenRef.current !== myToken) return;
      ring.stop();
      // Return to the Dial button — otherwise the UI sits on "Ringing…" forever.
      setCallState("idle");
      setStatus(`call error: ${(err as Error).message}`);
    } finally {
      if (dialTokenRef.current === myToken) setSpeechBusy(false);
      ringStopRef.current = null;
    }
  }, [content, presenter, token, config, vadStart, vadPause]);

  // Hang up while still ringing — stops the ringback immediately and lets the
  // stale dial() bail out via dialTokenRef once its awaits resolve.
  const cancelDial = useCallback(() => {
    dialTokenRef.current++;
    ringStopRef.current?.();
    vadStop();
    setSpeechBusy(false);
    setCallState("idle");
    setCallSeconds(0);
    setStatus(content ? `Press Dial to call ${content.scenario.place}.` : "");
  }, [vadStop, content]);

  // ---- Back navigation (one level per phase; see goBack below). Both of
  // these are thin: the existing "leaving intake"/"leaving practice"
  // safety-net effects already handle mic teardown regardless of which
  // direction the phase changed.
  const backToIntake = useCallback(() => {
    presenter.interruptPresentation();
    stopWav();
    setPhase("intake");
  }, [presenter]);

  const backToPrep = useCallback(() => {
    if (callState === "dialing") cancelDial();
    setPhase("prep");
  }, [callState, cancelDial]);

  // ---- End of call: swap back to Luna and let her speak the feedback. The
  // Judge runs in parallel — its latency hides behind Luna's re-init and
  // lead-in; speech trouble must never hide the written review.
  const goToReview = useCallback(
    async (finalTurns: TurnRecord[]) => {
      vadStop();
      presenter.setListening(false);
      stopWav();
      setCallState("idle");
      setCallSeconds(0);
      setPhase("review");
      setStatus("ending the call…");
      const judge = reviewCall(finalTurns, content?.scenario.id ?? "", content?.variant.id ?? "").catch((err) => {
        setStatus(`review error: ${(err as Error).message}`);
        return null;
      });
      try {
        await presenter.initialize(token, {
          avatarId: config.coach.avatar_id,
          sceneId: config.coach.scene_id,
          voiceId: config.coach.voice_id || undefined,
        });
        // Luna must be Ready before present() — otherwise every speak fails
        // with PRESENTER_NOT_READY and the review plays silent.
        await presenter.waitReady();
        // Back to the small porthole's bust-shot framing, same as welcome/intake/prep.
        presenter.setCameraAngle("halfbody");
        setStatus("Luna is reviewing your call…");
        let speechError = "";
        await presenter
          .speakText("Good work! Let's look at how the call went.")
          .catch((err) => {
            speechError = `Luna couldn't speak: ${(err as Error).message}`;
          });
        const reviewData = await judge;
        if (reviewData) {
          setReview(reviewData);
          await presenter.speakText(reviewData.overall).catch((err) => {
            speechError = speechError || `Luna couldn't speak the summary: ${(err as Error).message}`;
          });
        }
        setStatus(speechError);
      } catch (err) {
        const reviewData = await judge;
        if (reviewData) setReview(reviewData);
        setStatus(`review audio error: ${(err as Error).message}`);
      }
    },
    [presenter, token, config, vadStop, content],
  );

  // ---- Practice turn handling (P4: the router authors the avatar's lines).
  // VAD-driven: fires when an utterance ends. The mic is gated only while
  // transcribing/routing; it stays live while the avatar speaks so the learner
  // can barge in (interrupt + queue their utterance as the next turn).
  const processUtterance = useCallback(
    async ({ base64, mimeType }: VadUtterance) => {
      if (!content || phaseRef.current !== "practice") return;
      if (processingRef.current) {
        // Barge-in: the avatar is still unwinding its interrupted turn — hold
        // the utterance; the finally block below drains it.
        pendingRef.current = { base64, mimeType };
        return;
      }
      processingRef.current = true;
      setTurnBusy(true);
      // Gated during transcribe + route only; the mic goes live again while
      // the avatar speaks so the learner can barge in.
      vadPause(true);
      const node: DialogueNode | undefined = content.dialogue.nodes[currentNodeId];
      try {
        setStatus("transcribing…");
        const { text } = await transcribeAudio(base64, mimeType);
        console.log(`[turn] utterance ~${estimateWavSeconds(base64).toFixed(2)}s → "${text}"`);
        if (!text.trim()) {
          // Noise blip without words — re-open the mic without spending a turn.
          setStatus("Your turn — speak in Japanese.");
          return;
        }
        // Barge-in keeps the mic live while the avatar speaks; an AEC leak of
        // the avatar's own line would otherwise be recorded as the learner's
        // turn and show up in the review as a mistake that never happened.
        if (lastSpokenRef.current && normalizeForCompare(text) === normalizeForCompare(lastSpokenRef.current)) {
          console.log("[turn] discarded — matches avatar's own line (echo)");
          setStatus("Your turn — speak in Japanese.");
          return;
        }
        setStatus("routing…");
        const history = turns.map((t) => ({ avatar: t.lineJa, learner: t.transcript }));
        const result = await routeTurn(
          currentNodeId,
          text,
          recoveryStage,
          content.scenario.id,
          content.variant.id,
          history,
          lastSpokenRef.current || undefined,
          collected,
        );
        setCollected(result.collected || {});

        // Record the turn for the Review — lineJa is the line actually being
        // answered (the router authors lines live; the graph node stays put).
        const turnRecord: TurnRecord = {
          nodeId: currentNodeId,
          lineJa: lastSpokenRef.current || node?.line.ja || "",
          transcript: text,
          correct: result.outcome === "advance",
          recoveryOutcome: result.outcome === "advance" ? undefined : result.outcome,
        };
        setTurns((prev) => [...prev, turnRecord]);
        setHintShown(result.showHint && result.hint ? result.hint : null);
        setRecoveryStage(result.recoveryStage || 0);

        setSpeechBusy(true);
        setStatus("avatar speaking…");
        bargeRef.current = false;
        setTurnBusy(false);
        vadPause(false);
        for (const line of result.speak) {
          if (bargeRef.current) break; // learner talked over the avatar
          setAvatarLine(line);
          lastSpokenRef.current = line.ja;
          await presenter.speakText(line.ja, line.emotion ? { emotion: line.emotion } : undefined);
        }
        setSpeechBusy(false);

        // Call ended (goal achieved or help branch reached the goal).
        if (result.callDone) {
          await goToReview([...turns, turnRecord]);
          return;
        }
        setStatus("Your turn — speak in Japanese.");
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
        setSpeechBusy(false);
      } finally {
        processingRef.current = false;
        setTurnBusy(false);
        vadPause(false);
        const pending = pendingRef.current;
        if (pending && phaseRef.current === "practice") {
          pendingRef.current = null;
          void processRef.current(pending);
        }
      }
    },
    [content, currentNodeId, recoveryStage, turns, presenter, vadPause, goToReview, collected],
  );

  useEffect(() => {
    // Review's "repeat after me" drills reuse this same VAD instance (it's
    // idle by the time Review starts — goToReview already called vadStop()).
    // Dispatch on phase so a drill never has to fight this effect for
    // processRef.current.
    processRef.current = (u) => (phaseRef.current === "review" ? drillProcessRef.current(u) : processUtterance(u));
  }, [processUtterance]);

  // Barge-in: sustained real speech (Silero past its misfire threshold) while
  // the avatar talks cuts the performance; the finished utterance queues as
  // the next turn. The browser echo canceller keeps the avatar's own voice
  // out of the mic feed.
  useEffect(() => {
    if (vadSpeech && speechBusy && callState === "connected" && phaseRef.current === "practice") {
      bargeRef.current = true;
      presenter.interruptPresentation();
    }
  }, [vadSpeech, speechBusy, callState, presenter]);

  const endCallEarly = useCallback(() => {
    // Same interrupt used for learner barge-in (line ~1320): breaks the
    // avatar out of its speak loop immediately so hanging up mid-sentence
    // doesn't race goToReview's presenter.initialize() against a still-
    // in-flight speakText().
    bargeRef.current = true;
    presenter.interruptPresentation();
    void goToReview(turns);
  }, [turns, goToReview, presenter]);

  const resetFlow = useCallback(() => {
    stopDrill();
    prepAutoPlayed.current = false;
    setDoorsOn(false);
    setPhase("welcome");
    setTurns([]);
    setCollected({});
    setReview(null);
    setStatus("");
    setIntakeText("");
    setExpandedCall(null);
    setRecoveryStage(0);
    setHintShown(null);
    setAvatarLine(null);
    setCallState("idle");
  }, [stopDrill]);

  // ---- Back navigation: one synthetic history entry per phase level so the
  // hardware/gesture back button steps back through the app instead of
  // leaving it. Never encodes real state in the URL — popstate is purely a
  // same-tab trampoline; getBackHandler always resolves from live refs, never
  // a value captured from the URL/history itself.
  const callStateRef = useRef(callState);
  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  const getBackHandler = useCallback((): BackHandler => {
    switch (phaseRef.current) {
      case "intake":
        return resetFlow;
      case "prep":
        return backToIntake;
      case "practice":
        return callStateRef.current === "connected" ? "block" : backToPrep;
      case "review":
        return enterPractice;
      default:
        return null;
    }
  }, [resetFlow, backToIntake, backToPrep, enterPractice]);

  // Always-current handle for the popstate listener below (registered once,
  // empty deps) — same ref-indirection idiom as processRef/intakeProcessRef.
  const getBackHandlerRef = useRef(getBackHandler);
  useEffect(() => {
    getBackHandlerRef.current = getBackHandler;
  }, [getBackHandler]);

  // Report the on-screen chevron's handler — null (hidden) for welcome and
  // for a connected call, matching what the hardware button does.
  useEffect(() => {
    const handler = getBackHandler();
    onBackAvailable?.(handler === "block" ? null : handler);
  }, [phase, callState, getBackHandler, onBackAvailable]);

  // Keep the browser's history depth mirroring phase's depth: push one
  // synthetic entry per level advanced; collapse it back when a phase
  // regression happens via a direct action (a button, e.g. "Practice again"
  // or "Start over") rather than a real back press, which already consumed
  // one entry itself — viaPopRef tells this effect which case it is.
  const historyDepthRef = useRef(0);
  const viaPopRef = useRef(false);
  const prevPhaseRef = useRef<Phase>(phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (phase === prev) return;
    const prevDepth = phaseDepth(prev);
    const nextDepth = phaseDepth(phase);
    if (nextDepth > prevDepth) {
      for (let i = prevDepth; i < nextDepth; i++) {
        historyDepthRef.current++;
        window.history.pushState({ depth: historyDepthRef.current }, "", window.location.href);
      }
    } else if (nextDepth < prevDepth) {
      if (viaPopRef.current) {
        viaPopRef.current = false; // already consumed by the real back press
      } else if (historyDepthRef.current > 0) {
        const dropped = Math.min(prevDepth - nextDepth, historyDepthRef.current);
        historyDepthRef.current -= dropped;
        window.history.go(-dropped);
      }
    }
  }, [phase]);

  // The actual back-button/gesture listener.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const poppedDepth = (event.state as { depth?: number } | null)?.depth ?? 0;
      if (poppedDepth > historyDepthRef.current) {
        // Forward/redo — not supported (nothing to restore into). Cancel it
        // back out; the resulting popstate lands exactly back on the current
        // depth, which the branch below (poppedDepth === current) no-ops on.
        window.history.back();
        return;
      }
      if (poppedDepth === historyDepthRef.current) return;
      const handler = getBackHandlerRef.current();
      if (handler === "block") {
        // A live call — replant the exact entry just consumed (same depth,
        // not incremented) so repeated accidental back presses never grow
        // the stack; only the explicit hang-up button ends the call.
        window.history.pushState({ depth: historyDepthRef.current }, "", window.location.href);
        return;
      }
      if (!handler) return; // welcome: nothing to trap, let it be.
      viaPopRef.current = true;
      historyDepthRef.current = poppedDepth;
      handler();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Safety net: leaving practice closes the VAD mic and clears the listening
  // pose, whichever way the phase changed.
  useEffect(() => {
    if (phase !== "practice") {
      vadStop();
      presenter.setListening(false);
    }
  }, [phase, vadStop, presenter]);

  if (!content) {
    return (
      <main className="text-foreground p-6 max-w-2xl mx-auto">
        <p>Loading lesson…</p>
        {status && <p className="text-muted-foreground text-sm">{status}</p>}
      </main>
    );
  }

  // On desktop (framed), captions live beside the phone, not inside it — the
  // phone rect is narrow by design, and cramming subtitles into it just to
  // keep them "in call chrome" wastes the whole rest of the screen.
  const isFramed = !!myLayout?.framed;
  const captionPanelRect =
    isFramed && myLayout
      ? (() => {
          const gap = 32;
          const margin = 32;
          const left = myLayout.left + (myLayout.width ?? 0) + gap;
          // Now that the phone sits at the left margin instead of centered,
          // this actually gets the freed-up width — cap at 960 for reading
          // comfort, not "fill the rest of an ultrawide monitor".
          const width = Math.max(0, Math.min(960, window.innerWidth - margin - left));
          return { left, top: myLayout.top, width, height: myLayout.height ?? 0 };
        })()
      : null;

  return (
    <main className="text-foreground h-full">
      {phase === "welcome" && (
        <section className="max-w-2xl mx-auto p-4 sm:p-6 text-center space-y-6 py-12">
          <div className="flex flex-col items-center gap-2">
            <BrandMark className="h-16 w-16" />
            <h1 className="wordmark text-5xl sm:text-6xl leading-tight">
              Tag<span className="text-primary">Team</span>
            </h1>
            <p className="text-sm text-muted-foreground">Rehearse before you dial.</p>
          </div>
          <p className="text-muted-foreground">
            {activeProfile
              ? `Welcome back, ${activeProfile.name}. Tell Luna what call you need to make, and she'll prep you before you place it.`
              : "Tell Luna what call you need to make, and she'll prep you before you place it."}
          </p>
          <button
            type="button"
            onClick={begin}
            disabled={!presenter.mounted}
            className="shimmer-cta px-12 py-4 rounded-lg bg-primary text-primary-foreground font-medium text-lg disabled:opacity-40"
          >
            Start
          </button>
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "intake" && (
        <section ref={intakeRef} className="max-w-2xl mx-auto p-4 sm:p-6 space-y-5">
          <div>
            <h2 className="text-xl font-semibold">Tell Luna</h2>
            <p className="text-sm text-muted-foreground">What call do you want to practice?</p>
            {/* The avatar can still be loading here even once Intake itself
                is showing (the door cover gives up waiting after 9s so the
                UI never hangs indefinitely) — say so honestly instead of
                leaving the disabled tiles unexplained. */}
            {!presenter.ready && <p className="text-xs text-muted-foreground mt-1">Luna is still getting ready…</p>}
          </div>

          {/* Spacer reserves the porthole slot; the Talk control sits to
              Luna's immediate right so starting a call reads as "talk to
              her", not a form field buried further down. Tapping the avatar
              itself replaces the old standalone "Hear Luna" button. */}
          <div className="flex items-center gap-5">
            <div
              ref={slotRef}
              style={{ width: PORTHOLE_SIZE, height: PORTHOLE_SIZE }}
              className={`shrink-0 rounded-[2rem] ${intakeTalking || !presenter.ready ? "" : "cursor-pointer"}`}
              role="button"
              tabIndex={intakeTalking || !presenter.ready ? -1 : 0}
              aria-label="Hear Luna"
              aria-disabled={intakeTalking || !presenter.ready}
              onClick={() => !intakeTalking && presenter.ready && speakIntakeAudio()}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !intakeTalking && presenter.ready) {
                  e.preventDefault();
                  speakIntakeAudio();
                }
              }}
            />
            <div className="flex flex-col items-start gap-2">
              {intakeTalking || intakeBusy ? (
                <>
                  <div
                    className={`mic-status large ${intakeBusy ? "processing" : intakeVadSpeech ? "hearing" : "listening"}`}
                    role="status"
                  >
                    <span className="dot" aria-hidden />
                    <span>{intakeBusy ? "Processing…" : intakeVadSpeech ? "Hearing you" : "Listening"}</span>
                  </div>
                  {!intakeBusy && (
                    <button type="button" onClick={cancelIntakeTalk} className="text-xs text-muted-foreground underline">
                      Cancel
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={startIntakeTalk}
                  disabled={!presenter.ready}
                  className="mic-status large off shimmer-cta cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  <span className="dot" aria-hidden />
                  <span>Talk</span>
                </button>
              )}
            </div>
          </div>

          {/* "Or describe it" chat entry, above the common-calls grid so the
              conversational path with Luna reads before the tap-to-pick one. */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Or describe it</p>
            <div className="flex gap-2 items-center">
              <input
                value={intakeText}
                onChange={(e) => setIntakeText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && intakeText.trim() && runIntake(intakeText.trim())}
                placeholder="e.g. I need to book a restaurant"
                className="flex-1 px-3 py-2 rounded border border-border bg-card"
              />
              <BigButton
                onClick={() => intakeText.trim() && runIntake(intakeText.trim())}
                disabled={!intakeText.trim() || !presenter.ready}
              >
                Go
              </BigButton>
            </div>
          </div>

          <div className="space-y-2">
            {expandedCall ? (
              (() => {
                const type = CALL_TYPES.find((t) => t.scenario === expandedCall);
                if (!type) return null;
                return (
                  <>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedCall(null)}
                        className="text-xs text-muted-foreground hover:text-foreground"
                        aria-label="Back to call types"
                      >
                        ← Back
                      </button>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {type.title} — pick one
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {type.subtypes.map((s) => (
                        <button
                          key={s.variant}
                          type="button"
                          onClick={() => quickPick(type.scenario, s.variant)}
                          disabled={intakeTalking || intakeBusy || !presenter.ready}
                          className="glass-card hover:border-primary"
                        >
                          <p className="text-sm font-medium">{s.title}</p>
                          <p className="text-xs text-muted-foreground">{s.detail}</p>
                        </button>
                      ))}
                    </div>
                  </>
                );
              })()
            ) : (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Common calls</p>
                <div className="grid grid-cols-3 gap-2">
                  {CALL_TYPES.map((t) => {
                    const Icon = CALL_ICONS[t.scenario];
                    return (
                      <button
                        key={t.scenario}
                        type="button"
                        onClick={() => setExpandedCall(t.scenario)}
                        disabled={intakeTalking || intakeBusy || !presenter.ready}
                        className="glass-card hover:border-primary"
                      >
                        {Icon && <Icon className="glass-icon" aria-hidden />}
                        {/* No specific example here (e.g. "toothache") — that
                            read as a direct pick and tapping it opened a
                            submenu instead, which was the reported bug. A
                            generic "N options ›" makes clear this expands. */}
                        <p className="text-sm font-medium flex items-center justify-between gap-1">
                          <span>{t.title}</span>
                          <span className="text-muted-foreground" aria-hidden>
                            ›
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">{t.subtypes.length} options</p>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {intakeVadError && <p className="text-sm text-destructive">{intakeVadError}</p>}
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "prep" && eggCrtActive && activeEgg === "codec-briefing" && (
        <CodecOverlay introLines={introLines} introTyping={introTyping} caption={crtCaption} />
      )}
      {phase === "prep" && eggCrtActive && activeEgg === "all-your-base" && (
        <AybOverlay line={introLines[0] ?? ""} caption={crtCaption} silhouetteFlash={silhouetteFlash} />
      )}
      {phase === "prep" && eggCrtActive && activeEgg === "doom-invasion" && (
        <DoomOverlay presenter={presenter} onFinished={finishDoomInvasion} headerH={HEADER_H} />
      )}

      {phase === "prep" && (
        <section ref={prepRef} className="max-w-2xl mx-auto p-4 sm:p-6 space-y-3">
          {/* Spacer reserves the porthole slot beside the title so the lines
              below start under Luna instead of behind her. Play all/I'M READY
              live up here (top right) rather than at the bottom, so they're
              reachable without scrolling past the line list. Kept mounted
              (with the same ref) during the codec egg too, rather than swapped
              for a separate section — Luna's porthole position is measured off
              this element, and swapping it out mid-egg made her jump on exit. */}
          <div className="flex items-start gap-4">
            <div style={{ width: PORTHOLE_SIZE, height: PORTHOLE_SIZE }} className="shrink-0" aria-hidden />
            <div className="flex-1 flex items-start justify-between gap-3 flex-wrap">
              <h2 className="text-2xl font-semibold">Prep — key sentences</h2>
              {!eggCrtActive && (
                <div className="flex gap-2 shrink-0">
                  <BigButton variant="ghost" onClick={runPrepAuto} disabled={speechBusy}>
                    Play all
                  </BigButton>
                  <BigButton onClick={enterPractice}>I'M READY!</BigButton>
                </div>
              )}
            </div>
          </div>
          {!eggCrtActive && (
            // While a line is read, the gutter slides the lines right and narrows
            // them as Luna shrinks down beside the active line. The close is
            // delayed so the cards never slide under her on the way back up.
            <div
              className="space-y-2 transition-[padding-left] ease-[cubic-bezier(0.77,0,0.175,1)]"
              style={{
                paddingLeft: playingIdx !== null ? READ_GUTTER : 0,
                transitionDuration: `${STAGE_MS}ms`,
                transitionDelay: playingIdx !== null ? "0ms" : `${STAGE_MS + 100}ms`,
              }}
            >
            {displayed.map((poolIdx, pos) => {
              const line = prepPool[poolIdx];
              if (!line) return null;
              return (
                <div
                  key={poolIdx}
                  ref={(el) => {
                    lineRefs.current[pos] = el;
                  }}
                  className={`line-card-dark p-3 flex items-stretch gap-3 transition-shadow duration-300 ${playingIdx === pos ? "playing" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-2xl leading-snug">{line.ja}</p>
                    <p className="text-base opacity-80">{line.romaji}</p>
                    <p className="text-sm opacity-65 italic">{line.en}</p>
                  </div>
                  {/* Large (44px), icon-only, generously spaced, stacked in a
                      column to the right — small text buttons here were too
                      easy to mis-tap, and Dismiss has no undo. */}
                  <div className="flex flex-col items-center justify-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => playPrepLine(pos)}
                      disabled={speechBusy}
                      aria-label={`Play example ${pos + 1}: ${line.en}`}
                      className="w-11 h-11 rounded-full border border-border bg-card flex items-center justify-center text-xl text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-40 transition-colors"
                    >
                      ▶
                    </button>
                    <button
                      type="button"
                      onClick={() => dismissLine(pos)}
                      aria-label="Dismiss this line"
                      className="w-11 h-11 rounded-full border border-border bg-card text-muted-foreground flex items-center justify-center text-xl hover:border-destructive hover:text-destructive transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
            {moreAvailable && (
              <button
                type="button"
                onClick={showMore}
                className="w-full rounded-lg border border-dashed border-border py-2 text-base text-muted-foreground hover:border-primary hover:text-primary transition-colors"
              >
                + More examples ({displayed.length}/5)
              </button>
            )}
          </div>
          )}
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "practice" && (
        <section className="h-full flex flex-col px-4 sm:px-6 py-4">
          {callState === "idle" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
              <div
                className="w-24 h-24 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-4xl"
                aria-hidden
              >
                📞
              </div>
              <div>
                <p className="text-lg font-semibold">{content.scenario.place}</p>
                {status && <p className="text-sm text-muted-foreground">{status}</p>}
              </div>
              <button
                type="button"
                onClick={dial}
                disabled={speechBusy}
                aria-label={`Call ${content.scenario.place}`}
                className="mt-2 w-16 h-16 rounded-full bg-accent text-accent-foreground text-2xl shadow-lg flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
              >
                📞
              </button>
            </div>
          )}

          {callState === "dialing" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
              <p className="text-3xl animate-pulse" aria-hidden>
                📞
              </p>
              <p className="text-lg font-semibold">{content.scenario.place}</p>
              {status && <p className="text-sm text-muted-foreground">{status}</p>}
              {vadError && <p className="text-sm text-destructive">{vadError}</p>}
              <button
                type="button"
                onClick={cancelDial}
                aria-label="Cancel call"
                className="mt-4 w-14 h-14 rounded-full bg-destructive text-destructive-foreground text-xl shadow-lg flex items-center justify-center active:scale-95 transition-transform"
              >
                <span aria-hidden className="inline-block rotate-[135deg]">
                  📞
                </span>
              </button>
            </div>
          )}

          {callState === "connected" && (
            <>
              {/* Status bar: floats over the full-bleed avatar video. */}
              <div className="flex items-center justify-between rounded-full bg-card/90 backdrop-blur px-4 py-2 shadow">
                <span className="text-sm font-medium">{content.scenario.place}</span>
                <span className="text-sm tabular-nums text-muted-foreground">{fmtTime(callSeconds)}</span>
              </div>

              {/* Middle spacer shows the avatar video through. On a real phone
                  (or the mobile-width case) captions pin to its bottom, over
                  the video, since there's nowhere else for them to go. On
                  desktop the phone is narrow by design — captions render in
                  the wide side panel below instead, never squeezed in here. */}
              {isFramed ? (
                <div className="flex-1" />
              ) : (
                <div className="flex-1 flex flex-col justify-end gap-2 py-3 min-h-0 overflow-y-auto">
                  {avatarLine && (
                    <div className="bg-card/90 backdrop-blur rounded-lg shadow p-3">
                      <p className="text-xs text-muted-foreground mb-1">
                        {content.scenario.speaker.charAt(0).toUpperCase() + content.scenario.speaker.slice(1)}:
                      </p>
                      <LineCard line={avatarLine} accent />
                    </div>
                  )}
                  {hintShown && (
                    <div className="rounded-lg border border-accent bg-accent/20 backdrop-blur p-3 shadow">
                      <p className="text-xs font-medium">Expected phrase (hint):</p>
                      <LineCard line={hintShown} />
                    </div>
                  )}
                  {(status || vadError) && (
                    <p className="self-center text-xs text-center bg-card/90 backdrop-blur rounded-full px-3 py-1 shadow text-muted-foreground">
                      {vadError ?? status}
                    </p>
                  )}
                </div>
              )}

              {/* Bottom control bar: mic status + hang-up, phone-call style.
                  Text pill, not an icon — color/glow/shimmer carry the state
                  (see .mic-status in index.css). */}
              <div className="flex items-center justify-center gap-6 pb-1">
                <div
                  className={`mic-status ${
                    turnBusy ? "processing" : vadSpeech ? "hearing" : vadListening ? "listening" : "off"
                  }`}
                  role="status"
                >
                  <span className="dot" aria-hidden />
                  <span>{turnBusy ? "Processing…" : vadSpeech ? "Hearing you" : vadListening ? "Listening" : "Mic off"}</span>
                </div>
                <button
                  type="button"
                  onClick={endCallEarly}
                  aria-label="End call"
                  className="w-16 h-16 rounded-full bg-destructive text-destructive-foreground text-2xl shadow-lg flex items-center justify-center disabled:opacity-40 active:scale-95 transition-transform"
                >
                  <span aria-hidden className="inline-block rotate-[135deg]">
                    📞
                  </span>
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Desktop caption panel: beside the phone, not inside it. Large type —
          this is the space the phone's own width can't spare. */}
      {phase === "practice" && callState === "connected" && isFramed && captionPanelRect && captionPanelRect.width > 0 && (
        <div
          className="fixed z-10 flex flex-col justify-center gap-5"
          style={{
            left: captionPanelRect.left,
            top: captionPanelRect.top,
            width: captionPanelRect.width,
            height: captionPanelRect.height,
          }}
        >
          {avatarLine && (
            <div className="rounded-2xl border border-border bg-card shadow-lg p-6">
              <p className="text-sm text-muted-foreground mb-2">
                {content.scenario.speaker.charAt(0).toUpperCase() + content.scenario.speaker.slice(1)}:
              </p>
              <p className="text-3xl leading-snug">{avatarLine.ja}</p>
              <p className="text-lg text-muted-foreground mt-2">{avatarLine.romaji}</p>
              <p className="text-base text-muted-foreground/80 italic mt-1">{avatarLine.en}</p>
            </div>
          )}
          {hintShown && (
            <div className="rounded-2xl border border-accent bg-accent/20 shadow-lg p-6">
              <p className="text-sm font-medium mb-2">Expected phrase (hint):</p>
              <p className="text-2xl leading-snug">{hintShown.ja}</p>
              <p className="text-base text-muted-foreground mt-2">{hintShown.romaji}</p>
              <p className="text-sm text-muted-foreground/80 italic mt-1">{hintShown.en}</p>
            </div>
          )}
          {(status || vadError) && (
            <p className="text-base text-center text-muted-foreground">{vadError ?? status}</p>
          )}
        </div>
      )}

      {phase === "review" && (
        <section className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
          <h2 className="text-xl font-semibold">Call Review</h2>
          {review && (
            <>
              <div className="rounded-lg bg-primary/10 p-4">
                <p className="text-sm leading-relaxed">{review.overall}</p>
              </div>
              <div className="space-y-3">
                {review.perTurn.map((t) => {
                  const target = resolveDrillTarget(t, content);
                  const drillable = t.grade !== "good" && !!target;
                  const drillOpen = drillTurn === t.turn;
                  return (
                    <div
                      key={t.turn}
                      ref={(el) => {
                        reviewLineRefs.current[t.turn] = el;
                      }}
                      onClick={drillable && !drillOpen ? () => void startDrill(t) : undefined}
                      className={`rounded-lg border border-border bg-card p-3 transition-[color,background-color,border-color,padding-left] ease-[cubic-bezier(0.77,0,0.175,1)] ${
                        drillable ? "review-flag cursor-pointer hover:border-primary/60 hover:shadow-md" : ""
                      }`}
                      style={{
                        // Luna parks at this card's own (fixed) left edge while
                        // she reads the drill line — same gutter trick Prep
                        // uses (READ_GUTTER) — so the card's own content slides
                        // right out from under her instead of her covering it.
                        paddingLeft: drillOpen ? READ_GUTTER : undefined,
                        transitionDuration: `${STAGE_MS}ms`,
                        transitionDelay: drillOpen ? "0ms" : `${STAGE_MS + 100}ms`,
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Turn {t.turn} · {t.node}</span>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                          t.grade === "good" ? "bg-primary/15 text-primary" :
                          t.grade === "teineigo" ? "bg-warning/15 text-warning" :
                          t.grade === "english" ? "bg-destructive/15 text-destructive" :
                          "bg-muted text-muted-foreground"
                        }`}>
                          {t.grade === "good" ? "✓ good" :
                           t.grade === "teineigo" ? "⚠ polite form" :
                           t.grade === "english" ? "✗ English" :
                           t.grade === "unclear" ? "? unclear" :
                           "— silent"}
                        </span>
                      </div>
                      {!drillOpen && (
                        <>
                          <div className="mt-2">
                            <p className="text-xs text-muted-foreground">
                              {content.scenario.speaker.charAt(0).toUpperCase() + content.scenario.speaker.slice(1)} said:
                            </p>
                            <p className="text-sm">{t.expected}</p>
                          </div>
                          <div className="mt-1">
                            <p className="text-xs text-muted-foreground">You said:</p>
                            <p className="text-sm italic">“{t.said}”</p>
                          </div>
                          {t.notes.length > 0 && (
                            <div className="mt-2 space-y-1">
                              {t.notes.map((n, i) => (
                                <p key={i} className="text-xs text-muted-foreground">• {n}</p>
                              ))}
                            </div>
                          )}
                          {drillable && (
                            <p className="mt-2 text-xs font-medium text-primary">Tap to practice — repeat after me</p>
                          )}
                        </>
                      )}
                      {drillOpen && target && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-3 rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2"
                        >
                          <p className="text-sm font-semibold">Repeat after me</p>
                          <LineCard line={target} />
                          {drillStep === "playing" && (
                            <p className="text-xs text-muted-foreground">Listen — repeat {drillRep} of 2…</p>
                          )}
                          {drillStep === "handoff" && (
                            <p className="text-xs text-muted-foreground">Luna: “Now it's your turn.”</p>
                          )}
                          {drillStep === "listening" && (
                            <div className="mic-status listening" role="status">
                              <span className="dot" aria-hidden />
                              <span>Your turn — say it</span>
                            </div>
                          )}
                          {drillStep === "done" && (
                            <div className="space-y-1">
                              {drillHeard !== null && (
                                <p className="text-sm">
                                  <span className="text-xs text-muted-foreground">I heard: </span>
                                  “{drillHeard || "(nothing)"}”
                                </p>
                              )}
                              {drillVerdict === "good" && (
                                <p className="text-xs font-medium text-primary">✓ Close enough!</p>
                              )}
                              {drillVerdict === "retry" && (
                                <p className="text-xs font-medium text-muted-foreground">Keep practicing this one.</p>
                              )}
                              {drillError && <p className="text-xs text-destructive">{drillError}</p>}
                            </div>
                          )}
                          <div className="flex gap-2 pt-1">
                            {drillStep === "done" && (
                              <BigButton onClick={() => void startDrill(t)}>Try again</BigButton>
                            )}
                            <BigButton variant="ghost" onClick={stopDrill}>Close</BigButton>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {!review && <p className="text-sm">Preparing your review…</p>}
          {status && <p className="text-sm">{status}</p>}
          <div className="flex gap-2">
            <BigButton onClick={enterPractice}>Practice again</BigButton>
            <BigButton variant="ghost" onClick={resetFlow}>Start over</BigButton>
          </div>
        </section>
      )}
      {doorsOn && phase === "intake" && (
        <Doors measure={measureDoorRect} ready={presenter.ready} onDismiss={dismissDoors} />
      )}
    </main>
  );
}
