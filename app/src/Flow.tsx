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
import { useVad, type VadUtterance } from "./hooks/use-vad";
import { prerenderLine } from "./lib/prerender";
import { PREP_VOICES, playRingback, playWav, stopWav } from "./lib/audio";
import type { UsePresenter } from "./hooks/use-presenter";

type Phase = "welcome" | "intake" | "prep" | "practice" | "review";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Pacing between the two voice readings of a line, and between lines.
const REPEAT_PAUSE_MS = 500;
const SECTION_PAUSE_MS = 2000;

// Porthole geometry: 200×200 at rest, 128×128 while reading prep lines.
export const PORTHOLE_SIZE = 200;
const READ_SIZE = 128;
// Left gutter reserved for reading Luna (READ_SIZE + gap).
const READ_GUTTER = READ_SIZE + 24;
// How long Luna shrinks/regrows at the title slot before moving, so she
// never sweeps across the line cards while they slide.
const STAGE_MS = 380;

export interface StageLayout {
  fullscreen: boolean;
  visible: boolean;
  left: number;
  top: number;
  size: number;
  animate: boolean;
  /** Content band offset class for the phase (leaves room for the porthole). */
  bandTop: string;
}

interface FlowProps {
  presenter: UsePresenter;
  token: string;
  config: ConnectConfig;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onStageLayout: (layout: StageLayout) => void;
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

export default function Flow({ presenter, token, config, scrollRef, onStageLayout }: FlowProps) {
  const [phase, setPhase] = useState<Phase>("welcome");
  const [content, setContent] = useState<ContentBundle | null>(null);
  const [status, setStatus] = useState("");

  const { recording, error: micError, start: recStart, stop: recStop, cancel: recCancel } = useRecorder();

  // Call ritual: idle (Dial button) → dialing (ringback) → connected (VAD talk).
  const [callState, setCallState] = useState<"idle" | "dialing" | "connected">("idle");
  const processingRef = useRef(false);
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
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [intakeText, setIntakeText] = useState("");

  const [speechBusy, setSpeechBusy] = useState(false);
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const stopRecordingRef = useRef<(() => void) | null>(null);
  const prepAutoPlayed = useRef(false);
  const phaseRef = useRef(phase);
  const intakeRef = useRef<HTMLElement | null>(null);
  const prepRef = useRef<HTMLElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // The content band scrolls; reset to top on phase changes so controls are in view.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [phase, scrollRef]);

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
        top: 16,
        size: PORTHOLE_SIZE,
        animate,
        bandTop: "top-[15rem]",
      });
      if (phase === "practice") {
        return { fullscreen: true, visible: true, left: 0, top: 0, size: 0, animate, bandTop: "top-[19rem]" };
      }
      if (phase === "intake") {
        const r = intakeRef.current?.getBoundingClientRect();
        if (!r) return { ...centered(true), bandTop: "top-4" };
        return {
          fullscreen: false,
          visible: true,
          left: r.left,
          top: r.top,
          size: PORTHOLE_SIZE,
          animate,
          bandTop: "top-4",
        };
      }
      if (phase === "prep") {
        const s = prepRef.current?.getBoundingClientRect();
        if (!s) return { ...centered(true), bandTop: "top-4" };
        const slot = prepSlotRef.current;
        let top = s.top;
        if (slot.loc === "line" && playingIdx !== null) {
          const row = lineRefs.current[playingIdx]?.getBoundingClientRect();
          if (row) top = row.top + (row.height - READ_SIZE) / 2;
        }
        return {
          fullscreen: false,
          visible: true,
          left: s.left,
          top,
          size: slot.size,
          animate,
          bandTop: "top-4",
        };
      }
      if (phase === "review") return centered(true);
      // welcome: porthole hidden, so the content can sit higher
      return { ...centered(false), bandTop: "top-10" };
    },
    [phase, playingIdx],
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
        wasReadingRef.current = reading;
        if (staged) {
          prepSlotRef.current = { loc: "title", size: READ_SIZE };
          onStageLayout(computeLayout(true));
          timer = window.setTimeout(() => {
            prepSlotRef.current = reading
              ? { loc: "line", size: READ_SIZE }
              : { loc: "title", size: PORTHOLE_SIZE };
            onStageLayout(computeLayout(true));
          }, STAGE_MS);
        } else {
          if (reading) prepSlotRef.current = { loc: "line", size: READ_SIZE };
          else if (phase === "prep") prepSlotRef.current = { loc: "title", size: PORTHOLE_SIZE };
          onStageLayout(computeLayout(true));
        }
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(timer);
    };
  }, [computeLayout, onStageLayout, content, phase, playingIdx]);

  // Scroll/resize move the measured targets; re-pose without animation.
  useEffect(() => {
    const scroller = scrollRef.current;
    const report = () => onStageLayout(computeLayout(false));
    scroller?.addEventListener("scroll", report);
    window.addEventListener("resize", report);
    return () => {
      scroller?.removeEventListener("scroll", report);
      window.removeEventListener("resize", report);
    };
  }, [computeLayout, onStageLayout, scrollRef]);

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
      await presenter.waitReady();
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
        let title = content?.scenario.title ?? "your call";
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
        "Hi! I'm Luna. What phone call would you like to practice today? For example, calling a clinic or booking a restaurant.",
      );
    } catch (err) {
      setStatus(`audio error: ${(err as Error).message}`);
    }
  }, [presenter]);

  const captureIntake = useCallback(async () => {
    try {
      setStatus("listening…");
      presenter.setListening(true);
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
      presenter.setListening(false);
      setStatus("transcribing…");
      // Intake is spoken in English — tag the STT accordingly (practice is ja).
      const { text } = await transcribeAudio(base64, mimeType, "en");
      await runIntake(text);
    } catch (err) {
      presenter.setListening(false);
      setStatus(`intake mic error: ${(err as Error).message}`);
      recCancel();
    }
  }, [recStart, recStop, recCancel, runIntake, presenter]);

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

  // Enter (or re-enter) practice at the Dial button — the call ritual
  // (dial → ringback → answer → VAD conversation) starts from `dial()`.
  const enterPractice = useCallback(() => {
    if (!content) return;
    stopWav();
    vadStop();
    presenter.setListening(false);
    processingRef.current = false;
    pendingRef.current = null;
    bargeRef.current = false;
    lastSpokenRef.current = "";
    setPhase("practice");
    setCallState("idle");
    setCurrentNodeId(content.dialogue.start_node);
    setRecoveryStage(0);
    setHintShown(null);
    setTurns([]);
    setReview(null);
    setAvatarLine(null);
    setStatus(`Press Dial to call ${content.scenario.place}.`);
  }, [content, presenter, vadStop]);

  // Dial → ringback (which also masks the presenter re-init) → the
  // far side answers with the authored start line → open the VAD mic.
  const dial = useCallback(async () => {
    if (!content) return;
    setCallState("dialing");
    setStatus("ringing…");
    setSpeechBusy(true);
    const ring = playRingback(2);
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
      setCallState("connected");
      const first = content.dialogue.nodes[content.dialogue.start_node];
      if (first) {
        setAvatarLine(first.line);
        lastSpokenRef.current = first.line.ja;
        await presenter.speakText(first.line.ja);
      }
      vadPause(false);
      // Listening pose stays up for the whole conversation (Talking overrides
      // it while the avatar speaks and it resumes after).
      presenter.setListening(true);
      setStatus("Your turn — speak in Japanese.");
    } catch (err) {
      ring.stop();
      // Return to the Dial button — otherwise the UI sits on "Ringing…" forever.
      setCallState("idle");
      setStatus(`call error: ${(err as Error).message}`);
    } finally {
      setSpeechBusy(false);
    }
  }, [content, presenter, token, config, vadStart, vadPause]);

  // ---- End of call: swap back to Luna and let her speak the feedback. The
  // Judge runs in parallel — its latency hides behind Luna's re-init and
  // lead-in; speech trouble must never hide the written review.
  const goToReview = useCallback(
    async (finalTurns: TurnRecord[]) => {
      vadStop();
      presenter.setListening(false);
      stopWav();
      setCallState("idle");
      setPhase("review");
      setStatus("ending the call…");
      const judge = reviewCall(finalTurns).catch((err) => {
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
    [presenter, token, config, vadStop],
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
      // Gated during transcribe + route only; the mic goes live again while
      // the avatar speaks so the learner can barge in.
      vadPause(true);
      const node: DialogueNode | undefined = content.dialogue.nodes[currentNodeId];
      try {
        setStatus("transcribing…");
        const { text } = await transcribeAudio(base64, mimeType);
        if (!text.trim()) {
          // Noise blip without words — re-open the mic without spending a turn.
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
        );

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
        vadPause(false);
        const pending = pendingRef.current;
        if (pending && phaseRef.current === "practice") {
          pendingRef.current = null;
          void processRef.current(pending);
        }
      }
    },
    [content, currentNodeId, recoveryStage, turns, presenter, vadPause, goToReview],
  );

  useEffect(() => {
    processRef.current = processUtterance;
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
    void goToReview(turns);
  }, [turns, goToReview]);

  const resetFlow = useCallback(() => {
    prepAutoPlayed.current = false;
    setPhase("welcome");
    setTurns([]);
    setReview(null);
    setStatus("");
    setIntakeText("");
    setRecoveryStage(0);
    setHintShown(null);
    setAvatarLine(null);
    setCallState("idle");
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

  return (
    <main className="text-foreground p-4 sm:p-6 max-w-2xl mx-auto">
      {phase === "welcome" && (
        <section className="text-center space-y-4 py-8">
          <h1 className="text-3xl font-semibold">Japanese phone-call practice</h1>
          <p className="text-muted-foreground">
            Tell Luna what call you need to make — she'll prep you, then you'll place it.
          </p>
          <BigButton onClick={begin} disabled={!presenter.mounted}>
            Start
          </BigButton>
          <p className="text-xs text-muted-foreground">Tap Start to unlock audio and meet Luna.</p>
          {status && <p className="text-sm">{status}</p>}
        </section>
      )}

      {phase === "intake" && (
        <section ref={intakeRef} className="space-y-4">
          {/* Spacer reserves the porthole slot; the title sits to Luna's right
              and the chat box below her. */}
          <div className="flex items-start gap-4">
            <div style={{ width: PORTHOLE_SIZE, height: PORTHOLE_SIZE }} className="shrink-0" aria-hidden />
            <h2 className="text-xl font-semibold">Intake</h2>
          </div>
          <div className="flex gap-2 items-center">
            <input
              value={intakeText}
              onChange={(e) => setIntakeText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && intakeText.trim() && runIntake(intakeText.trim())}
              placeholder="e.g. I need to book a restaurant"
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
        <section ref={prepRef} className="space-y-3">
          {/* Spacer reserves the porthole slot beside the title so the lines
              below start under Luna instead of behind her. */}
          <div className="flex items-start gap-4">
            <div style={{ width: PORTHOLE_SIZE, height: PORTHOLE_SIZE }} className="shrink-0" aria-hidden />
            <h2 className="text-xl font-semibold">Prep — key sentences</h2>
          </div>
          {/* While a line is read, the gutter slides the lines right and narrows
              them as Luna shrinks down beside the active line. The close is
              delayed so the cards never slide under her on the way back up. */}
          <div
            className="space-y-2 transition-[padding-left] duration-[600ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              paddingLeft: playingIdx !== null ? READ_GUTTER : 0,
              transitionDelay: playingIdx !== null ? "0ms" : `${STAGE_MS + 100}ms`,
            }}
          >
            {content.prep_lines.map((line, i) => (
              <div
                key={i}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                className="flex items-center gap-2"
              >
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
          {callState === "idle" && (
            <div className="text-center space-y-3 py-6">
              <BigButton onClick={dial} disabled={speechBusy}>
                📞 Call {content.scenario.place}
              </BigButton>
              <p className="text-xs text-muted-foreground">
                You'll hear it ring — the {content.scenario.speaker} answers shortly.
              </p>
            </div>
          )}
          {callState === "dialing" && (
            <div className="text-center py-6 space-y-2">
              <p className="text-3xl animate-pulse">📞</p>
              <p className="text-sm text-muted-foreground">Ringing…</p>
            </div>
          )}
          {callState === "connected" && (
            <>
              {avatarLine && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">
                    {content.scenario.speaker.charAt(0).toUpperCase() + content.scenario.speaker.slice(1)}:
                  </p>
                  <LineCard line={avatarLine} accent />
                </div>
              )}
              {hintShown && (
                <div className="rounded-lg border border-accent bg-accent/15 p-3">
                  <p className="text-xs font-medium">Expected phrase (hint):</p>
                  <LineCard line={hintShown} />
                </div>
              )}
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
                    vadSpeech ? "border-primary text-primary" : "border-border text-muted-foreground"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      vadSpeech ? "bg-primary animate-pulse" : vadListening ? "bg-primary/50" : "bg-muted-foreground/40"
                    }`}
                  />
                  {vadSpeech ? "Hearing you…" : vadListening ? "Listening — just speak" : "Mic off"}
                </span>
                <div className="ml-auto">
                  <BigButton variant="ghost" onClick={endCallEarly} disabled={speechBusy}>
                    End call
                  </BigButton>
                </div>
              </div>
            </>
          )}
          {vadError && <p className="text-sm text-destructive">{vadError}</p>}
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
