import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BrandMark } from "./BrandMark";
import { CAP_MS, computeDoorFrame, DRAW_MS, HOLD_START, SKIP_FADE_MS, type DoorFrame } from "./lib/door-timeline";

export interface DoorRect {
  left: number;
  top: number;
  size: number;
}

/** Overscan so the porthole's white bezel can never peek past the cover,
 *  even for a frame while the band's phase offset settles. */
const PAD = 12;

interface DoorsProps {
  /** Reads the porthole rect live — the cover tracks the band's scroll. */
  measure: () => DoorRect | null;
  ready: boolean;
  onDismiss: () => void;
}

// Line art, drawn one stroke at a time in weight order (viewBox 200×200).
const STROKES: { d: string; start: number; dur: number }[] = [
  { d: "M8 8 H192 V192 H8 Z", start: 0, dur: 550 },
  { d: "M100 8 V192", start: 550, dur: 250 },
  { d: "M86 100 a7 7 0 1 0 0.1 0", start: 800, dur: 100 },
  { d: "M114 100 a7 7 0 1 0 0.1 0", start: 900, dur: 100 },
];

/**
 * Luna's door: an opaque cover over exactly the porthole rect that masks
 * presenter.initialize(). The swing-open is gated on `ready` (the prior app's
 * doors ran a fixed clock and uncovered a still-loading stage); a slow init
 * holds the doors shut with a breathing seam until CAP_MS, and tap / Enter /
 * Space skips. Portaled to <body>: the content band and stage are stacking
 * contexts, so an overlay rendered inside them would paint BELOW the
 * presenter's opaque canvas. Position is applied imperatively (no state) so
 * the cover can track the scrolling band without re-rendering.
 */
export function Doors({ measure, ready, onDismiss }: DoorsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<SVGSVGElement | null>(null);
  const strokeRefs = useRef<(SVGPathElement | null)[]>([]);
  const fillRefs = useRef<(HTMLDivElement | null)[]>([]);
  const leafRefs = useRef<(HTMLDivElement | null)[]>([]);
  const seamRef = useRef<HTMLDivElement | null>(null);
  const jambRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const skipRef = useRef<() => void>(() => {});
  const measureRef = useRef(measure);
  const readyRef = useRef(ready);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    measureRef.current = measure;
  }, [measure]);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // Position before first paint; the rAF loop keeps it synced to the band.
  // Held invisible until the first tick: at mount the band's phase offset has
  // not always settled, and one frame of mis-positioned cover would flash the
  // porthole bezel past its edge.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.visibility = "hidden";
    const rect = measureRef.current();
    if (rect) {
      root.style.left = `${rect.left - PAD}px`;
      root.style.top = `${rect.top - PAD}px`;
      root.style.width = `${rect.size + PAD * 2}px`;
      root.style.height = `${rect.size + PAD * 2}px`;
    }
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let start: number | null = null;
    let lastT = 0;
    let openAt: number | null = null;
    let swing = !reduced;
    let gaveUp = false;
    let skipAt: number | null = null;
    let frozenDeg = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      dismissRef.current();
    };

    const position = () => {
      const rect = measureRef.current();
      const root = rootRef.current;
      if (!rect || !root) return;
      root.style.left = `${rect.left - PAD}px`;
      root.style.top = `${rect.top - PAD}px`;
      root.style.width = `${rect.size + PAD * 2}px`;
      root.style.height = `${rect.size + PAD * 2}px`;
    };

    const apply = (frame: DoorFrame, opacity: number) => {
      const root = rootRef.current;
      if (!root) return;
      root.style.opacity = String(opacity);
      if (jambRef.current) jambRef.current.style.opacity = String(frame.jamb);
      if (lineRef.current) lineRef.current.style.opacity = String(frame.lineArt);
      const drawMs = frame.draw * DRAW_MS;
      strokeRefs.current.forEach((el, i) => {
        if (!el) return;
        const stroke = STROKES[i];
        const p = Math.max(0, Math.min(1, (drawMs - stroke.start) / stroke.dur));
        el.style.strokeDashoffset = String(1 - p);
        // Round caps would leave a dot at offset 1 — hide untouched strokes.
        el.style.visibility = p <= 0 ? "hidden" : "visible";
      });
      fillRefs.current.forEach((el) => {
        if (el) el.style.opacity = String(frame.fill);
      });
      leafRefs.current.forEach((el, i) => {
        if (el) el.style.transform = `rotateY(${(i === 0 ? -1 : 1) * frame.doorDeg}deg)`;
      });
      if (seamRef.current) seamRef.current.style.opacity = String(frame.glow * 0.9);
      if (statusRef.current) {
        if (frame.phase === "away") {
          statusRef.current.textContent = "Luna is away right now — tap to continue.";
          statusRef.current.style.visibility = "visible";
        } else {
          statusRef.current.style.visibility = frame.phase === "hold" ? "visible" : "hidden";
        }
      }
    };

    const tick = (now: number) => {
      if (start === null) start = now;
      let t = now - start;
      // Reduced motion: no draw/fill theatre — a plain opaque panel that
      // cross-fades once Luna is ready (or at the cap).
      if (reduced) t = Math.max(t, HOLD_START);
      if (openAt === null && readyRef.current && t >= HOLD_START) openAt = t;
      if (openAt === null && t >= CAP_MS) {
        openAt = t;
        swing = false;
        gaveUp = true;
      }
      // Ready can still arrive after CAP_MS (real connects run well past
      // it) — swing open for real instead of leaving "Luna is away" up
      // over someone who actually made it in.
      if (gaveUp && readyRef.current) {
        gaveUp = false;
        swing = !reduced;
        openAt = t;
      }
      lastT = t;
      position();
      if (rootRef.current) rootRef.current.style.visibility = "visible";
      if (skipAt !== null) {
        const p = Math.min(1, (t - skipAt) / SKIP_FADE_MS);
        apply({ ...computeDoorFrame(t, openAt, swing, gaveUp), doorDeg: frozenDeg }, 1 - p);
        if (p >= 1) {
          finish();
          return;
        }
      } else {
        const frame = computeDoorFrame(t, openAt, swing, gaveUp);
        frozenDeg = frame.doorDeg;
        apply(frame, frame.opacity);
        if (frame.phase === "done") {
          finish();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };

    skipRef.current = () => {
      if (skipAt === null) skipAt = lastT;
    };
    raf = requestAnimationFrame(tick);
    // No programmatic focus: the default focus ring traced the root's edge
    // (a white arc under the door), and stealing focus on mount is rude.
    // Keyboard users can still Tab to it (tabIndex + key handler below).
    return () => cancelAnimationFrame(raf);
    // Deliberately mount-once: restarting the rAF clock on a prop change would
    // replay the draw over an already-revealed Luna.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-label="Luna’s door is opening — tap to skip"
      onPointerDown={() => skipRef.current()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          skipRef.current();
        }
      }}
      className="fixed"
      style={{ perspective: "1100px", zIndex: 2147483647 }}
    >
      {/* Opaque wall from frame zero — hides the loading porthole (and its
          white bezel) behind the doorway; lifts only as the leaves part. */}
      <div ref={jambRef} className="absolute inset-0" style={{ background: "var(--background)" }} />
      {[0, 1].map((i) => (
        <div
          key={i}
          ref={(el) => {
            leafRefs.current[i] = el;
          }}
          className="absolute top-0 h-full overflow-hidden"
          style={{
            left: i === 0 ? 0 : "50%",
            width: "50%",
            transformOrigin: i === 0 ? "left center" : "right center",
            backfaceVisibility: "hidden",
          }}
        >
          <div
            ref={(el) => {
              fillRefs.current[i] = el;
            }}
            className="absolute inset-0"
            style={{
              background: "var(--primary)",
              opacity: 0,
              boxShadow: [
                "inset 0 0 0 3px var(--border)",
                "inset 0 2px 0 rgb(255 255 255 / 0.14)",
                "inset 0 -3px 0 rgb(0 0 0 / 0.22)",
              ].join(", "),
            }}
          >
            {/* Brushed-grain texture — two offset stripe layers keep it from
                reading as a uniform repeat; brand-token fill underneath, not
                the prior app's literal walnut (ADR-0011). */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: [
                  "repeating-linear-gradient(97deg, rgb(0 0 0 / 0.08) 0px, rgb(0 0 0 / 0.08) 1px, transparent 1px, transparent 5px)",
                  "repeating-linear-gradient(97deg, rgb(255 255 255 / 0.06) 0px, rgb(255 255 255 / 0.06) 1px, transparent 1px, transparent 11px)",
                ].join(", "),
                mixBlendMode: "overlay",
              }}
            />
            {/* Recessed panel, echoing the porthole's own raised-bezel bevel. */}
            <div
              className="absolute rounded-sm"
              style={{
                inset: 14,
                boxShadow: "inset 0 0 0 2px rgb(0 0 0 / 0.18), inset 0 1px 0 rgb(255 255 255 / 0.14)",
              }}
            />
            {/* A plaque bearing the TagTeam mark, centered on the whole door
                (not the leaf) so the two halves meet exactly at the seam — a
                medallion set into both leaves, per-leaf so it swings open
                with them rather than sitting flat above the theatre. The
                mark keeps its original fixed favicon palette (gradient
                bubble, not a theme token): the door leaf itself is already
                --primary, so a token-matched mark would vanish into it in
                one theme or the other — the cream plaque guarantees contrast
                either way, like a cast medallion rather than a flat sticker. */}
            <div
              className="absolute inset-y-0 flex items-center justify-center"
              style={{ left: i === 0 ? 0 : "-100%", width: "200%" }}
            >
              <div
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 60,
                  height: 60,
                  background: "#f2e8cf",
                  boxShadow:
                    "0 2px 6px rgb(0 0 0 / 0.4), inset 0 1px 0 rgb(255 255 255 / 0.5), inset 0 0 0 2px rgb(56 102 65 / 0.3)",
                }}
              >
                <BrandMark className="h-10 w-10" variant="fixed" />
              </div>
            </div>
            <div
              className="absolute top-1/2 -translate-y-1/2 rounded-full"
              style={{
                [i === 0 ? "right" : "left"]: 12,
                width: 10,
                height: 10,
                background: "var(--accent)",
              }}
            />
          </div>
        </div>
      ))}
      <div
        ref={seamRef}
        className="absolute top-2 bottom-2 left-1/2 -translate-x-1/2 w-0.5"
        style={{ background: "var(--accent)", opacity: 0, filter: "blur(1px)" }}
      />
      <svg
        ref={lineRef}
        viewBox="0 0 200 200"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        {STROKES.map((stroke, i) => (
          <path
            key={stroke.d}
            ref={(el) => {
              strokeRefs.current[i] = el;
            }}
            d={stroke.d}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={3}
            strokeLinecap="round"
          />
        ))}
      </svg>
      <p
        ref={statusRef}
        role="status"
        className="absolute inset-x-0 text-center text-xs"
        style={{ top: "calc(100% - 30px)", color: "var(--primary-foreground)", visibility: "hidden" }}
      >
        waking Luna…
      </p>
    </div>,
    document.body,
  );
}
