import { useEffect, useSyncExternalStore } from "react";

/**
 * Prep-page easter eggs (gag screens shown while prepping a call). One today
 * (the MGS-codec briefing); more land here later — trigger logic always picks
 * from this list at random rather than special-casing "the only egg".
 */
export const EASTER_EGG_IDS = ["codec-briefing"] as const;
export type EasterEggId = (typeof EASTER_EGG_IDS)[number];

export function pickRandomEasterEgg(): EasterEggId {
  return EASTER_EGG_IDS[Math.floor(Math.random() * EASTER_EGG_IDS.length)];
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
  screamText: "SNAKE!",
  screamAudio: "/easter-eggs/codec-snake.wav",
  screamDurationMs: 880,
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

// Default odds an egg fires when Prep loads. The Settings "always show" toggle
// forces this to 100% instead, for showing them off without waiting on the roll.
const AUTO_TRIGGER_CHANCE = 0.1;

const STORAGE_KEY = "tagteam.easterEggsAlways";

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let state = load();
const listeners = new Set<() => void>();

export function getEasterEggsAlways(): boolean {
  return state;
}

export function setEasterEggsAlways(value: boolean) {
  state = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
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

/** Call once per Prep load to decide whether an egg should fire now. */
export function rollEasterEgg(): boolean {
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
