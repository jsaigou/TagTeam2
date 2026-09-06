// Pure phase math for the Luna door cover (rendered by Doors.tsx). Everything
// derives from elapsed milliseconds plus the moment the presenter reported
// Ready, so the sequence is deterministic, skippable, and — unlike the prior
// app's fixed-clock doors, which faded on schedule and uncovered a
// still-loading stage — HOLDS while the init is slow instead of lifting early.
export const DRAW_MS = 1000;
/** 150 ms settle after the ink completes, before the brand surface fills. */
export const FILL_START = 1150;
export const FILL_MS = 600;
/** Earliest possible swing: fill complete. Before this, Ready is ignored. */
export const HOLD_START = FILL_START + FILL_MS;
export const OPEN_MS = 900;
export const REVEAL_MS = 700;
export const FADE_MS = 500;
export const DOOR_MAX_DEG = 100;
/** Hard cap from mount: fade anyway and let the normal loading/error UI show. */
export const CAP_MS = 9000;
export const SKIP_FADE_MS = 200;

export type DoorPhase = "draw" | "fill" | "hold" | "open" | "reveal" | "fade" | "done";

export interface DoorFrame {
  phase: DoorPhase;
  /** 0..1 line-art draw progress. */
  draw: number;
  /** 0..1 brand-surface opacity. */
  fill: number;
  /** Line-art opacity — fades out as the surface fills. */
  lineArt: number;
  /** Opaque wall behind the leaves — hides the loading porthole from frame
   *  zero and lifts only as the leaves part. */
  jamb: number;
  /** Per-leaf swing angle in degrees. */
  doorDeg: number;
  /** 0..1 seam breathing pulse, only during hold. */
  glow: number;
  /** Whole-cover opacity. */
  opacity: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const settled = (phase: DoorPhase, doorDeg: number, opacity: number, jamb: number): DoorFrame => ({
  phase,
  draw: 1,
  fill: 1,
  lineArt: 0,
  jamb,
  doorDeg,
  glow: 0,
  opacity,
});

/**
 * @param t elapsed ms since the cover mounted
 * @param openAt the t at which the swing (or forced fade) began, null while held
 * @param swing false for reduced-motion / cap / any no-theatre dismissal
 */
export function computeDoorFrame(t: number, openAt: number | null, swing: boolean): DoorFrame {
  if (t < FILL_START) {
    return { phase: "draw", draw: clamp01(t / DRAW_MS), fill: 0, lineArt: 1, jamb: 1, doorDeg: 0, glow: 0, opacity: 1 };
  }
  if (t < HOLD_START) {
    const fill = clamp01((t - FILL_START) / FILL_MS);
    return { phase: "fill", draw: 1, fill, lineArt: 1 - fill, jamb: 1, doorDeg: 0, glow: 0, opacity: 1 };
  }
  if (openAt === null) {
    return {
      phase: "hold",
      draw: 1,
      fill: 1,
      lineArt: 0,
      jamb: 1,
      doorDeg: 0,
      glow: 0.5 + 0.5 * Math.sin((t - HOLD_START) / 450),
      opacity: 1,
    };
  }
  const o = t - openAt;
  if (swing) {
    if (o < OPEN_MS) {
      const p = easeInOut(o / OPEN_MS);
      return { ...settled("open", p * DOOR_MAX_DEG, 1, 1 - p), glow: 0 };
    }
    if (o < OPEN_MS + REVEAL_MS) return settled("reveal", DOOR_MAX_DEG, 1, 0);
    if (o < OPEN_MS + REVEAL_MS + FADE_MS) {
      return settled("fade", DOOR_MAX_DEG, 1 - easeInOut((o - OPEN_MS - REVEAL_MS) / FADE_MS), 0);
    }
    return settled("done", DOOR_MAX_DEG, 0, 0);
  }
  if (o < FADE_MS) {
    const fade = 1 - easeInOut(o / FADE_MS);
    return settled("fade", 0, fade, fade);
  }
  return settled("done", 0, 0, 0);
}
