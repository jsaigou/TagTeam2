import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { playWav, stopWav } from "./lib/audio";

/**
 * Prep-page easter egg: a Metal Gear Solid (PS1) codec-style briefing —
 * green-phosphor CRT takeover, the Colonel's line, a cough, then a snap back
 * to normal. Audio is pre-rendered (baked WAV files, not live TTS) so the gag
 * fires instantly and never depends on the TTS server being warm.
 *
 * Full-viewport via a portal: a fixed-position overlay would otherwise be
 * pinned to whichever ancestor's stacking context it renders under.
 */

const COLONEL_TEXT = "スネーク、聞こえるか？こちらは大佐だ。";
const COUGH_TEXT = "ゴホッ、ゴホッ……";
const COLONEL_AUDIO = "/easter-eggs/codec-colonel-line.wav";
const COUGH_AUDIO = "/easter-eggs/codec-cough.wav";

const CRT_STYLE = `
@keyframes codec-flicker { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.55; } }
@keyframes codec-refresh { 0% { top: -4px; } 100% { top: 100%; } }
`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWav(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

type Stage = "in" | "line" | "cough" | "out";

export function CodecBriefing({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<Stage>("in");
  const [text, setText] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await sleep(320);
      if (cancelled) return;
      setStage("line");
      setText(COLONEL_TEXT);
      try {
        await playWav(await fetchWav(COLONEL_AUDIO));
      } catch {
        // Missing/failed audio still lets the beat land silently.
      }
      if (cancelled) return;
      await sleep(300);
      if (cancelled) return;
      setStage("cough");
      setText(COUGH_TEXT);
      try {
        await playWav(await fetchWav(COUGH_AUDIO));
      } catch {
        // as above
      }
      if (cancelled) return;
      setStage("out");
      await sleep(280);
      if (cancelled) return;
      onDone();
    })();
    return () => {
      cancelled = true;
      stopWav();
    };
  }, [onDone]);

  const visible = stage !== "out";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black font-mono"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 280ms ease" }}
      role="status"
      aria-live="polite"
    >
      <style>{CRT_STYLE}</style>

      {/* Green-phosphor filter, matching the earlier CRT-effect spike:
          bloom (drop-shadow) applied first, scanlines/vignette/flicker on top. */}
      <div
        className="absolute inset-0"
        style={{
          filter:
            "sepia(1) hue-rotate(55deg) saturate(4.5) brightness(1.25) contrast(1.15) " +
            "drop-shadow(0 0 10px rgba(0,255,0,0.7)) drop-shadow(0 0 28px rgba(0,255,0,0.3))",
        }}
      >
        <div className="flex h-full w-full items-center justify-center">
          <div className="w-full max-w-md rounded-md border-2 border-green-500 bg-[#001200] px-6 py-8 text-center shadow-[0_0_40px_rgba(0,255,0,0.25)]">
            <p className="text-[11px] tracking-[0.3em] text-green-500">140.85 MHz — INCOMING CALL</p>
            <p className="mt-6 min-h-16 text-xl leading-relaxed text-green-300">{text}</p>
            <p className="mt-6 text-[10px] tracking-wide text-green-600">— 大佐 (THE COLONEL) —</p>
          </div>
        </div>
      </div>

      {/* Bloom bleed */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at 50% 45%, rgba(0,255,0,0.14), transparent 65%)",
          mixBlendMode: "screen",
        }}
      />
      {/* Scanlines */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "repeating-linear-gradient(to bottom, transparent 0px, transparent 3px, rgba(0,0,0,0.4) 3px, rgba(0,0,0,0.4) 6px)",
        }}
      />
      {/* Vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.85) 100%)" }}
      />
      {/* Flicker */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "rgba(0,255,0,0.03)", animation: "codec-flicker 0.12s infinite" }}
      />
      {/* Refresh line */}
      <div
        className="pointer-events-none absolute inset-x-0"
        style={{
          height: "3px",
          background: "linear-gradient(to bottom, transparent, rgba(0,255,0,0.2), transparent)",
          animation: "codec-refresh 5s linear infinite",
        }}
      />
    </div>,
    document.body,
  );
}
