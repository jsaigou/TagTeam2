import { useCallback, useEffect, useRef, useState } from "react";
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
import { useRecorder } from "./hooks/use-recorder";
import { prerenderLine } from "./lib/prerender";
import { PREP_VOICES, playWav, stopWav } from "./lib/audio";
import type { UsePresenter } from "./hooks/use-presenter";

type Phase = "welcome" | "intake" | "prep" | "practice" | "review";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Pacing between the two voice readings of a line, and between lines.
const REPEAT_PAUSE_MS = 500;
const SECTION_PAUSE_MS = 2000;

interface FlowProps {
  presenter: UsePresenter;
  token: string;
  config: ConnectConfig;
  onFullscreenStage: (fullscreen: boolean) => void;
}

// Reusable line card component showing kanji + romaji + english.
// `playing` adds an underglow while the example's audio is playing.
function LineCard({ line, accent = false, playing = false }: { line: JaLine; accent?: boolean; playing?: boolean }) {
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

export default function Flow({ presenter, token, config, onFullscreenStage }: FlowProps) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [status, setStatus] = useState("");

  const { recording, error: micError, start: recStart, stop: recStop, cancel: recCancel } = useRecorder();

  // Practice state
  const [currentNodeId, setCurrentNodeId] = useState<string>("greeting");
  const [recoveryStage, setRecoveryStage] = useState(0);
  const [hintShown, setHintShown] = useState<JaLine | null>(null);
  const [avatarLine, setAvatarLine] = useState<JaLine | null>(null);
  const [turns, setTurns] = useState<TurnRecord[]>([]);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [intakeText, setIntakeText] = useState("");

  const [speechBusy, setSpeechBusy] = useState(false);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const stopRecordingRef = useRef<(() => void) | null>(null);
  const prepAutoPlayed = useRef(false);
  const mainRef = useRef<HTMLElement | null>(null);
  const phaseRef = useRef(phase);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // The content band scrolls; reset to top on phase changes so controls are in view.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [phase]);

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
  const begin = useCallback(async () => {
    setStatus("warming up Luna…");
    try {
      await presenter.resumeAudio();
      await presenter.initialize(token, {
        avatarId: config.coach.avatar_id,
        sceneId: config.coach.scene_id,
        voiceId: config.coach.voice_id || undefined,
      });
      setPhase("intake");
      setStatus("");
    } catch (err) {
      setStatus(`init error: ${(err as Error).message}`);
    }
  }, [presenter, token, config]);

  // ---- Intake (confirmation stub) ----
  const runIntake = useCallback(
    async (transcript: string) => {
      setStatus("Luna is confirming…");
      try {
        const result = await classifyIntake(transcript);
        setIntakeText(transcript);
        let title = content?.scenario.title ?? "dentist appointment";
        if (result.scenarioId !== content?.scenario.id || result.variant !== content?.variant.id) {
          const newContent = await fetchContent(result.scenarioId, result.variant);
          setContent(newContent);
          title = newContent.scenario.title;
        }
        await presenter.speakText(
          `Got it — ${title.toLowerCase()}. Let's get you ready.`,
        );
        setStatus("");
        setPhase("prep");
      } catch (err) {
        setStatus(`classify error: ${(err as Error).message}`);
      }
    },
    [presenter, content],
  );

  const speakIntakeAudio = useCallback(async () => {
    try {
      await presenter.speakText(
        "Hi! I'm Luna. What phone call would you like to practice today? For example, a dentist appointment.",
      );
    } catch (err) {
      setStatus(`audio error: ${(err as Error).message}`);
    }
  }, [presenter]);

  const captureIntake = useCallback(async () => {
    try {
      setStatus("listening…");
      await recStart();
      const { base64, mimeType } = await new Promise<{ base64: string; mimeType: string }>((resolve) => {
        const maxTimer = setTimeout(() => {
          stopRecordingRef.current = null;
          recStop().then(resolve);
        }, 6000);
        stopRecordingRef.current = () => {
          clearTimeout(maxTimer);
          stopRecordingRef.current = null;
          recStop().then(resolve);
        };
      });
      setStatus("transcribing…");
      const { text } = await transcribeAudio(base64, mimeType);
      await runIntake(text);
    } catch (err) {
      setStatus(`intake mic error: ${(err as Error).message}`);
      recCancel();
    }
  }, [recStart, recStop, recCancel, runIntake]);

  // ---- Prep ----
  const runPrep = useCallback(async () => {
    if (!content) return;
    setStatus("heading to Prep…");
    setPhase("prep");
    setStatus("Luna will walk you through the key sentences.");
    setSpeechBusy(true);
    try {
      if (phaseRef.current !== "prep") return;
      await presenter.speakText("Now let's practice some key vocabulary.");
      for (let i = 0; i < content.prep_lines.length; i++) {
        const line = content.prep_lines[i];
        // Abort silently if the learner left Prep mid-read (e.g. started the
        // call) — continuing would speak over Practice and clobber its status.
        if (phaseRef.current !== "prep") return;
        setPlayingIdx(i);
        // Luna reads the English explanation, then the Japanese plays twice as
        // plain audio — female voice first, then male (PREP_VOICES order).
        await presenter.speakText(line.en);
        for (let v = 0; v < PREP_VOICES.length; v++) {
          if (phaseRef.current !== "prep") return;
          const audio = await prerenderLine(line.ja, PREP_VOICES[v]);
          if (phaseRef.current !== "prep") return;
          await playWav(audio);
          if (phaseRef.current !== "prep") return;
          if (v < PREP_VOICES.length - 1) await sleep(REPEAT_PAUSE_MS);
        }
        if (i < content.prep_lines.length - 1) await sleep(SECTION_PAUSE_MS);
      }
      setStatus("Ready to practice? Tap a line to hear it again, or continue.");
    } catch (err) {
      if (phaseRef.current === "prep") setStatus(`prep audio error: ${(err as Error).message}`);
    } finally {
      setPlayingIdx(null);
      setSpeechBusy(false);
    }
  }, [content, presenter]);

  // PLAN flow (§5.2): on entering Prep, run the read-through automatically.
  useEffect(() => {
    if (phase === "prep" && content && !prepAutoPlayed.current) {
      prepAutoPlayed.current = true;
      void runPrep();
    }
  }, [phase, content, runPrep]);

  // On-demand replay: tapping an example plays it once (female voice).
  const playPrepLine = useCallback(
    async (index: number) => {
      const line = content?.prep_lines[index];
      if (!line) return;
      setSpeechBusy(true);
      setPlayingIdx(index);
      try {
        const audio = await prerenderLine(line.ja, PREP_VOICES[0]);
        await playWav(audio);
      } catch (err) {
        setStatus(`audio error: ${(err as Error).message}`);
      } finally {
        setPlayingIdx(null);
        setSpeechBusy(false);
      }
    },
    [content],
  );

  // Enter (or re-enter) practice: full-screen role avatar on a live Perxona
  // voice; the authored start node seeds the call (ADR-0008).
  const enterPractice = useCallback(async () => {
    if (!content) return;
    stopWav();
    setStatus("switching to the clinic…");
    setPhase("practice");
    onFullscreenStage(true);
    setCurrentNodeId(content.dialogue.start_node);
    setRecoveryStage(0);
    setHintShown(null);
    setTurns([]);
    setReview(null);
    setSpeechBusy(true);
    try {
      await presenter.initialize(token, {
        avatarId: config.practice.avatar_id,
        sceneId: config.practice.scene_id,
        voiceId: config.practice.voice_id || undefined,
      });
      const first = content.dialogue.nodes[content.dialogue.start_node];
      if (first) {
        setAvatarLine(first.line);
        await presenter.speakText(first.line.ja);
        setStatus("Your turn — speak in Japanese.");
      }
    } catch (err) {
      setStatus(`audio error: ${(err as Error).message}`);
    } finally {
      setSpeechBusy(false);
    }
  }, [content, presenter, token, config, onFullscreenStage]);

  // ---- Practice turn handling (P4: the router authors the avatar's lines) ----
  const handleUserTurn = useCallback(async () => {
    if (!content) return;
    const node: DialogueNode = content.dialogue.nodes[currentNodeId];
    setStatus("listening…");
    try {
      await recStart();
      const { base64, mimeType } = await new Promise<{ base64: string; mimeType: string }>((resolve) => {
        const maxTimer = setTimeout(() => {
          stopRecordingRef.current = null;
          recStop().then(resolve);
        }, 8000);
        stopRecordingRef.current = () => {
          clearTimeout(maxTimer);
          stopRecordingRef.current = null;
          recStop().then(resolve);
        };
      });
      setStatus("transcribing…");
      const { text } = await transcribeAudio(base64, mimeType);
      setStatus("routing…");
      const history = turns.map((t) => ({ avatar: t.lineJa, learner: t.transcript }));
      const result = await routeTurn(
        currentNodeId,
        text,
        recoveryStage,
        content.scenario.id,
        content.variant.id,
        history,
      );

      // Record the turn for the Review.
      setTurns((prev) => [
        ...prev,
        {
          nodeId: currentNodeId,
          lineJa: node.line.ja,
          transcript: text,
          correct: result.outcome === "advance",
          recoveryOutcome: result.outcome === "advance" ? undefined : result.outcome,
        },
      ]);
      setHintShown(result.showHint && result.hint ? result.hint : null);
      setRecoveryStage(result.recoveryStage || 0);

      setSpeechBusy(true);
      setStatus("avatar speaking…");
      for (const line of result.speak) {
        setAvatarLine(line);
        await presenter.speakText(line.ja);
      }
      setSpeechBusy(false);

      // Call ended (goal achieved or help branch reached the goal).
      if (result.callDone) {
        onFullscreenStage(false);
        setPhase("review");
        setStatus("ending the call…");
        const reviewData = await reviewCall([...turns, {
          nodeId: currentNodeId,
          lineJa: node.line.ja,
          transcript: text,
          correct: result.outcome === "advance",
          recoveryOutcome: result.outcome === "advance" ? undefined : result.outcome,
        }]);
        setReview(reviewData);
        setStatus("");
        return;
      }
      setStatus("Your turn — speak in Japanese.");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
      setSpeechBusy(false);
      recCancel();
    }
  }, [content, currentNodeId, recoveryStage, recStart, recStop, recCancel, turns, presenter, onFullscreenStage]);

  const endCallEarly = useCallback(() => {
    onFullscreenStage(false);
    setPhase("review");
    setStatus("call ended");
    reviewCall(turns).then(setReview).catch((err) => setStatus(`review error: ${(err as Error).message}`));
  }, [turns, onFullscreenStage]);

  const resetFlow = useCallback(() => {
    onFullscreenStage(false);
    prepAutoPlayed.current = false;
    setPhase("welcome");
    setTurns([]);
    setReview(null);
    setStatus("");
    setIntakeText("");
    setRecoveryStage(0);
    setHintShown(null);
    setAvatarLine(null);
  }, [onFullscreenStage]);

  if (!content) {
    return (
      <main className="text-foreground p-6 max-w-2xl mx-auto">
        <p>Loading lesson…</p>
        {status && <p className="text-muted-foreground text-sm">{status}</p>}
      </main>
    );
  }

  return (
    <main ref={mainRef} className="text-foreground p-4 sm:p-6 max-w-2xl mx-auto">
      {phase === "welcome" && (
        <section className="text-center space-y-4 py-8">
          <h1 className="text-3xl font-semibold">{content.scenario.title}</h1>
          <p className="text-muted-foreground">{content.scenario.tagline}</p>
          <BigButton onClick={begin} disabled={!presenter.mounted}>
            Start
          </BigButton>
          <p className="text-xs text-muted-foreground">Tap Start to unlock audio and meet Luna.</p>
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "intake" && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Intake</h2>
          <p className="text-sm text-muted-foreground">
            Luna: “What phone call would you like to practice today?” (speak in English, or type).
          </p>
          <div className="flex gap-2 items-center">
            <input
              value={intakeText}
              onChange={(e) => setIntakeText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && intakeText.trim() && runIntake(intakeText.trim())}
              placeholder="e.g. I'd like a dentist appointment"
              className="flex-1 px-3 py-2 rounded border border-border bg-card"
            />
            <BigButton onClick={() => intakeText.trim() && runIntake(intakeText.trim())} disabled={!intakeText.trim()}>
              Go
            </BigButton>
          </div>
          <div className="flex gap-2">
            <BigButton variant="ghost" onClick={speakIntakeAudio} disabled={recording}>
              Hear Luna
            </BigButton>
            {recording ? (
              <BigButton onClick={() => stopRecordingRef.current?.()}>
                ⏹ Stop
              </BigButton>
            ) : (
              <BigButton variant="ghost" onClick={captureIntake}>
                🎤 Talk inline
              </BigButton>
            )}
          </div>
          {micError && <p className="text-sm text-destructive">{micError}</p>}
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "prep" && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Prep — key sentences</h2>
          <div className="space-y-2">
            {content.prep_lines.map((line, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm w-5">#{i + 1}</span>
                <button
                  type="button"
                  className="flex-1 text-left disabled:cursor-default"
                  onClick={() => playPrepLine(i)}
                  disabled={speechBusy}
                  aria-label={`Play example ${i + 1}: ${line.en}`}
                >
                  <LineCard line={line} playing={playingIdx === i} />
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <BigButton onClick={runPrep} disabled={speechBusy}>
              Read lines again
            </BigButton>
            <BigButton onClick={enterPractice}>Ready — start the call</BigButton>
          </div>
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "practice" && (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Practice — the call</h2>
          {avatarLine && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Receptionist:</p>
              <LineCard line={avatarLine} accent />
            </div>
          )}
          {hintShown && (
            <div className="rounded-lg border border-accent bg-accent/15 p-3">
              <p className="text-xs font-medium">Expected phrase (hint):</p>
              <LineCard line={hintShown} />
            </div>
          )}
          <div className="flex gap-2">
            <BigButton onClick={handleUserTurn} disabled={recording || speechBusy}>
              {recording ? "Listening…" : "🎤 Speak"}
            </BigButton>
            {recording && (
              <BigButton onClick={() => stopRecordingRef.current?.()}>
                ⏹ Stop
              </BigButton>
            )}
            <BigButton variant="ghost" onClick={endCallEarly} disabled={recording}>
              End call
            </BigButton>
          </div>
          {micError && <p className="text-sm text-destructive">{micError}</p>}
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "review" && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Call Review</h2>
          {review && (
            <>
              <div className="rounded-lg bg-primary/10 p-4">
                <p className="text-sm leading-relaxed">{review.overall}</p>
              </div>
              <div className="space-y-3">
                {review.perTurn.map((t) => (
                  <div key={t.turn} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Turn {t.turn} · {t.node}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                        t.grade === "good" ? "bg-primary/15 text-primary" :
                        t.grade === "teineigo" ? "bg-yellow-500/15 text-yellow-700" :
                        t.grade === "english" ? "bg-destructive/15 text-destructive" :
                        "bg-muted text-muted-foreground"
                      }`}>
                        {t.grade === "good" ? "✓ good" :
                         t.grade === "teineigo" ? "⚠ polite form" :
                         t.grade === "english" ? "✗ English" :
                         "— silent"}
                      </span>
                    </div>
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">Expected:</p>
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
                  </div>
                ))}
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
    </main>
  );
}
