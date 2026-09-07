import { useEffect, useSyncExternalStore } from "react";

/**
 * Prep-page easter eggs (gag screens shown while prepping a call). Two today
 * (the MGS-codec briefing, the "all your base" briefing) — trigger logic
 * always picks from this list at random rather than special-casing "the only
 * egg". Each can be individually enabled/disabled from Settings; with both
 * enabled the roll is a 50/50 between them.
 */
export const EASTER_EGG_IDS = ["codec-briefing", "all-your-base"] as const;
export type EasterEggId = (typeof EASTER_EGG_IDS)[number];

export const EASTER_EGG_LABELS: Record<EasterEggId, string> = {
  "codec-briefing": "Codec briefing",
  "all-your-base": "All your base",
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

// Second egg: the Zero Wing "all your base are belong to us" intro, played as
// a CATS transmission Luna performs. Text is the real (famously mistranslated)
// game script, trimmed per user request to open on "main screen turn on"
// rather than the earlier "we get signal" lead-in. Only the final line is
// scenario-aware (see aybTargetWord) — everything before it is fixed flavor
// text, same as the codec egg's fixed Colonel line. Every line here is voiced
// (see Flow.tsx's runAllYourBase) — nothing is silent typed-only text.
export const ALL_YOUR_BASE = {
  preRevealLines: ["OPERATOR: MAIN SCREEN TURN ON.", "CAPTAIN: IT'S YOU !!"],
  catsLines: [
    "CATS: HOW ARE YOU GENTLEMEN !!",
    "CATS: ALL YOUR BASE ARE BELONG TO US.",
    "CATS: YOU ARE ON THE WAY TO DESTRUCTION.",
    "CAPTAIN: WHAT YOU SAY !!",
  ],
  laughText: "CATS: HA HA HA HA ....",
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
