import { useEffect, useSyncExternalStore } from "react";

/**
 * Prep-page easter eggs (gag screens shown while prepping a call). Three
 * today (the MGS-codec briefing, the "all your base" briefing, the DOOM
 * invasion) — trigger logic always picks from this list at random rather
 * than special-casing "the only egg". Each can be individually
 * enabled/disabled from Settings; with all enabled the roll is a 1-in-3.
 */
export const EASTER_EGG_IDS = ["codec-briefing", "all-your-base", "doom-invasion"] as const;
export type EasterEggId = (typeof EASTER_EGG_IDS)[number];

export const EASTER_EGG_LABELS: Record<EasterEggId, string> = {
  "codec-briefing": "Codec briefing",
  "all-your-base": "All your base",
  "doom-invasion": "DOOM invasion",
};

/** Picks uniformly among the currently-enabled eggs; null if none are. */
export function pickRandomEasterEgg(): EasterEggId | null {
  const enabled = getEnabledEasterEggs();
  if (enabled.length === 0) return null;
  return enabled[Math.floor(Math.random() * enabled.length)];
}

// Dialogue is pre-rendered (baked WAV, not live TTS) so the gag fires
// instantly and never depends on the TTS server being warm. Spoken through
// the live presenter (presenter.speakAudio) so Luna performs it, same
// pipeline Review's "repeat after me" drill already uses for pregenerated
// audio. SFX beds (morse/transceiver/ambient) are free clips from otologic.jp
// (CC-style, credit-to-use license), trimmed with ffmpeg.
// `colonelDurationMs`/`screamDurationMs`: the actual clip lengths (measured
// once, hardcoded — these are fixed baked assets). presenter.speakAudio's
// own "finished" detection (use-presenter.ts's waitForFinished, keyed off
// ALL_PERFORMANCE_FINISHED/PERFORMANCE_STATE) can resolve well before the
// clip is actually done — confirmed live: the Colonel's 3.28s line once
// resolved in 235ms, cutting it off. Callers should race speakAudio against
// this minimum instead of trusting it alone (see Flow.tsx's speakAtLeast).
export const CODEC_BRIEFING = {
  colonelText: "スネーク、聞こえるか？こちらは大佐だ。",
  colonelAudio: "/easter-eggs/codec-colonel-line.wav",
  colonelDurationMs: 3280,
  screamText: "SNAKE! SNAAAAAKE!",
  screamAudio: "/easter-eggs/codec-snake.wav",
  screamDurationMs: 1840,
  morseAudio: "/easter-eggs/codec-morse.mp3",
  transceiverAudio: "/easter-eggs/codec-transceiver.mp3",
  ambientAudio: "/easter-eggs/codec-ambient.mp3",
};

/** Uppercase mission-briefing lines, built from the real scenario content
 *  (place + goal) rather than invented flavor text. */
export function codecBriefingLines(place: string, goal: string): [string, string] {
  return [
    `MISSION BRIEFING: ESTABLISH CONTACT WITH OPERATIVES IN ${place.toUpperCase()}.`,
    `OBJECTIVE: ${goal.toUpperCase()}`,
  ];
}

/** One line of the AYB script: `speaker` is a display-only label (shown in
 *  the on-screen text box, e.g. "CATS: HOW ARE YOU GENTLEMEN !!") — it must
 *  never be passed to TTS, or the voice literally reads "CATS colon" out
 *  loud. `text` is what actually gets spoken (through `voice`, then the
 *  robot-voice DSP — see synthesizeRobotVoice). Each named part gets its own
 *  base voice: OPERATOR is the engineer, CAPTAIN and CATS are separate
 *  characters, so one flat "everyone sounds like Luna" voice would blur them
 *  together. */
export interface AybLine {
  speaker: string;
  text: string;
  voice: string;
}

// Second egg: the Zero Wing "all your base are belong to us" intro, played as
// a CATS transmission Luna performs (voicing every part). Text is the real
// (famously mistranslated) game script, trimmed per user request to open on
// "main screen turn on" rather than the earlier "we get signal" lead-in.
// Only the final line is scenario-aware (see aybTargetWord) — everything
// before it is fixed flavor text, same as the codec egg's fixed Colonel line.
// Every line here is voiced (see Flow.tsx's runAllYourBase) — nothing is
// silent typed-only text.
export const ALL_YOUR_BASE = {
  preRevealLines: [
    { speaker: "OPERATOR", text: "MAIN SCREEN TURN ON.", voice: "jm_kumo" },
    { speaker: "CAPTAIN", text: "IT'S YOU !!", voice: "nathan_us" },
  ] as AybLine[],
  catsLines: [
    { speaker: "CATS", text: "HOW ARE YOU GENTLEMEN !!", voice: "susan" },
    { speaker: "CATS", text: "ALL YOUR BASE ARE BELONG TO US.", voice: "susan" },
    { speaker: "CATS", text: "YOU ARE ON THE WAY TO DESTRUCTION.", voice: "susan" },
    { speaker: "CAPTAIN", text: "WHAT YOU SAY !!", voice: "nathan_us" },
  ] as AybLine[],
  laughText: "HA HA HA HA ....",
  laughVoice: "susan",
  // Free CC-licensed clips from otologic.jp (same source/license as the codec
  // egg's SFX beds) — a one-shot explosion opener and a 12s seamless-loop BGM
  // bed under the whole sequence.
  explosionAudio: "/easter-eggs/ayb-explosion.mp3",
  bgmAudio: "/easter-eggs/ayb-bgm.mp3",
};

/** Scenario -> the noun CATS threatens instead of "time" (real objective,
 *  same "use the actual content, not invented flavor" rule as codecBriefingLines).
 *  "booking" was here originally but the robot-voice DSP (synthesizeRobotVoice)
 *  mangled it into something that reads as profanity — confirmed by QA listening
 *  to the deployed clip — so the restaurant case uses "reservation" instead,
 *  a longer/more distinct word less prone to collapsing under distortion. */
export function aybTargetWord(scenarioId: string | undefined): string {
  switch (scenarioId) {
    case "restaurant":
      return "reservation";
    case "dentist":
    case "doctor":
      return "appointment";
    case "lost-card":
      return "new card";
    case "redelivery":
      return "redelivery";
    default:
      return "time";
  }
}

export function aybFinaleLine(word: string): string {
  return `YOU HAVE NO CHANCE TO SURVIVE. MAKE YOUR ${word.toUpperCase()}.`;
}

// Third egg: a playable 1993-DOOM-style minigame. Luna (a cat) fends off
// "demonic" cartoon mice in a tiny raycast level loosely modeled on E1M1's
// hangar-into-courtyard shape. Unlike the scripted codec/AYB eggs above this
// one is genuinely interactive — DoomEgg.tsx owns the game loop/canvas/input;
// this file only holds level data, weapon tuning, and Luna's taunt lines,
// the same "content separate from the sequence runner" split as
// CODEC_BRIEFING/ALL_YOUR_BASE vs. Flow.tsx's runCodecBriefing/runAllYourBase.
// 1 = wall, 0 = floor. Verified by hand to be fully connected (no isolated
// pockets) via a column-1 shaft linking the top corridor, the mid pockets,
// and the bottom arena where mice spawn.
export const DOOM_MAP: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1],
  [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
  [1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1],
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1],
  [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
  [1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
];

export const DOOM_PLAYER_START = { x: 1.5, y: 1.5, angle: 0 };

export const DOOM_MOUSE_SPAWNS: { x: number; y: number }[] = [
  { x: 6.5, y: 3.5 },
  { x: 9.5, y: 3.5 },
  { x: 6.5, y: 7.5 },
  { x: 3.5, y: 9.5 },
  { x: 7.5, y: 9.5 },
  { x: 11.5, y: 9.5 },
];

export const DOOM_WEAPONS = ["claws", "cheese", "trap"] as const;
export type DoomWeapon = (typeof DOOM_WEAPONS)[number];
export const DOOM_WEAPON_LABELS: Record<DoomWeapon, string> = {
  claws: "CLAWS",
  cheese: "CHEESE",
  trap: "TRAPS",
};

// Luna's barks, grouped by trigger. Picked at random (pickDoomTaunt) rather
// than cycled, same "gag, not a script" idiom as the rest of this file.
// Written pumped-up/exclamatory on purpose — per user direction the
// delivery reads as genuinely excited, not just fast (see DOOM_TAUNT_SPEED:
// speed-only via a pitch-preserving time-stretch can't fake enthusiasm, the
// words have to carry it).
export const DOOM_TAUNTS_START = [
  "ALRIGHT, VERMIN — CLEAR OUT OR GET CLAWED OUT!!",
  "NINE LIVES, LET'S GOOO!!",
  "WHO LET THE MICE IN?! NOT IT — LET'S DO THIS!!",
];
export const DOOM_TAUNTS_KILL = [
  "SQUEAK THIS!!",
  "ONE DOWN, LET'S GOOO!!",
  "THAT'S WHAT YOU GET, YEAH!!",
  "NAILED IT!! CLAWED IT!! WOO!!",
  "NOT SO TOUGH NOW, HUH?! HAH!!",
];
export const DOOM_TAUNTS_HURT = ["HEY! WATCH THE FUR!!", "OKAY THAT ONE HURT, BRING IT!!", "RUDE! MY TURN!!"];
export const DOOM_TAUNTS_IDLE = ["COME ON OUT, I KNOW YOU'RE HIDING!!", "THIS IS MY HANGAR NOW!!", "CHEESE WHEELS LOCKED AND LOADED, BABY!!"];
export const DOOM_TAUNTS_VICTORY = ["THAT'S WHY YOU DON'T MESS WITH A CAT!! WOO!!", "TERRITORY DEFENDED!! LET'S GOOO!!"];
export const DOOM_TAUNTS_DEATH = ["OKAY OKAY — TACTICAL RETREAT!!", "I REGRET NOTHING!! MOSTLY!!"];

export function pickDoomTaunt(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

// Homelab TTS voice for Luna's DOOM taunts — same reasoning as the AYB egg's
// per-character voice swap: presenter.speakAudio (pre-rendered, sped-up
// clips) is a different pipeline from her native Perxona voice
// (presenter.speakText), so "her voice" here is necessarily a homelab voice
// standing in for her, not literally her real one. `lauren_us` is the
// established female Prep-example voice (already validated elsewhere in the
// app), reused here rather than introducing an untested new voice.
export const DOOM_TAUNT_VOICE = "lauren_us";
// Speed-up factor for prerendered taunts, applied via the same pitch-
// preserving OLA time-stretch as the AYB egg's robot voice (timeStretch in
// audio.ts) — NOT AudioBufferSourceNode.playbackRate, which would shift
// pitch too (a "chipmunk" effect the user explicitly doesn't want). Plain
// speech holds up at a faster rate than the heavily-processed AYB voice
// (1.75x) since there's no distortion/bit-crush stacking artifacts on top.
export const DOOM_TAUNT_SPEED = 1.6;

// Bottom-of-screen "status bar" placement for Luna's own live porthole during
// this egg — Doom-guy's-face-in-the-HUD, but achieved the safe way: only
// left/top move, size stays exactly PORTHOLE_SIZE (Flow.tsx). Repositioning
// without resizing is the proven-safe half of the presenter widget's known
// failure mode (see feedback-presenter-resize-breaks-rendering memory) —
// this never touches width/height/filter on the element itself. 200 here
// must stay equal to Flow's PORTHOLE_SIZE (duplicated as a literal to avoid
// a Flow<->easter-eggs circular import).
export const DOOM_FACE_SIZE = 200;
export const DOOM_FACE_MARGIN = 16;
export function doomFaceRect(vw: number, vh: number) {
  return {
    left: (vw - DOOM_FACE_SIZE) / 2,
    top: vh - DOOM_FACE_SIZE - DOOM_FACE_MARGIN,
    size: DOOM_FACE_SIZE,
    margin: DOOM_FACE_MARGIN,
  };
}

// If the learner hasn't touched a control this long, the level plays itself
// (Luna's own autopilot AI) for DOOM_DEMO_MS, then the egg ends. Any control
// press before or during the demo hands off to live play immediately.
export const DOOM_IDLE_TRIGGER_MS = 4000;
export const DOOM_DEMO_MS = 6000;

// Doom-style armor: a flat pool that absorbs part of every hit before health
// starts dropping (classic Doom green armor absorbs 1/3; DOOM_ARMOR_ABSORB
// here is more generous at 1/2 since there's no pickup to refill it mid-run
// — it's a one-time buffer for the whole fight, not a resource to manage).
export const DOOM_START_ARMOR = 50;
export const DOOM_ARMOR_ABSORB = 0.5;

// Head-shot crop for the pixelated HUD portrait — presenter.setZoom's CSS
// transform (proven safe, see doomFaceRect's comment), tighter than the
// codec egg's 2.6x reveal since this is a permanent tight mugshot rather
// than a "close in for a reveal" beat.
export const DOOM_ZOOM_SCALE = 3.2;
export const DOOM_ZOOM_MS = 400;

// Default odds an egg fires when Prep loads. The Settings "always show" toggle
// forces this to 100% instead, for showing them off without waiting on the roll.
const AUTO_TRIGGER_CHANCE = 0.1;

const ALWAYS_STORAGE_KEY = "tagteam.easterEggsAlways";
const ENABLED_STORAGE_KEY = "tagteam.easterEggsEnabled";

function loadAlways(): boolean {
  try {
    return localStorage.getItem(ALWAYS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// Defaults to every known egg enabled — a fresh install (or one from before
// this per-egg toggle existed) behaves exactly like today: whichever eggs
// exist all take part in the roll.
function loadEnabled(): Set<EasterEggId> {
  try {
    const raw = localStorage.getItem(ENABLED_STORAGE_KEY);
    if (raw === null) return new Set(EASTER_EGG_IDS);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(EASTER_EGG_IDS);
    return new Set(parsed.filter((id): id is EasterEggId => (EASTER_EGG_IDS as readonly string[]).includes(id)));
  } catch {
    return new Set(EASTER_EGG_IDS);
  }
}

let alwaysState = loadAlways();
let enabledState = loadEnabled();
// useSyncExternalStore requires getSnapshot() to return a referentially
// stable value when nothing changed — recomputing this array on every call
// (e.g. via .filter() inline) triggers React error #185 (infinite render
// loop, blank white screen: confirmed live 2026-09-07). Cached here and only
// ever reassigned when the enabled set actually changes.
let enabledArray: EasterEggId[] = EASTER_EGG_IDS.filter((id) => enabledState.has(id));
const listeners = new Set<() => void>();

export function getEasterEggsAlways(): boolean {
  return alwaysState;
}

export function setEasterEggsAlways(value: boolean) {
  alwaysState = value;
  try {
    localStorage.setItem(ALWAYS_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Private-browsing / storage-full: keep working in memory only.
  }
  listeners.forEach((listener) => listener());
}

/** Snapshot of which eggs currently take part in the roll — stable reference
 *  across calls until setEasterEggEnabled actually changes something. */
export function getEnabledEasterEggs(): EasterEggId[] {
  return enabledArray;
}

export function setEasterEggEnabled(id: EasterEggId, enabled: boolean) {
  const next = new Set(enabledState);
  if (enabled) next.add(id);
  else next.delete(id);
  enabledState = next;
  enabledArray = EASTER_EGG_IDS.filter((eggId) => enabledState.has(eggId));
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Private-browsing / storage-full: keep working in memory only.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Settings-panel binding: whether every Prep load should fire an egg. */
export function useEasterEggsAlways(): boolean {
  return useSyncExternalStore(subscribe, getEasterEggsAlways);
}

/** Settings-panel binding: which eggs currently take part in the roll. */
export function useEnabledEasterEggs(): EasterEggId[] {
  return useSyncExternalStore(subscribe, getEnabledEasterEggs);
}

/** Call once per Prep load to decide whether an egg should fire now. Eggs the
 *  learner disabled entirely never fire, even with "always show" on. */
export function rollEasterEgg(): boolean {
  if (getEnabledEasterEggs().length === 0) return false;
  return getEasterEggsAlways() || Math.random() < AUTO_TRIGGER_CHANCE;
}

// The Konami code — forces an egg without waiting on the 1-in-10 roll, so it
// still does something useful once "always show" makes the roll moot.
const KONAMI_SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

export function useKonamiCode(onMatch: () => void) {
  useEffect(() => {
    let pos = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === KONAMI_SEQUENCE[pos]) {
        pos++;
        if (pos === KONAMI_SEQUENCE.length) {
          pos = 0;
          onMatch();
        }
      } else {
        pos = key === KONAMI_SEQUENCE[0] ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onMatch]);
}
