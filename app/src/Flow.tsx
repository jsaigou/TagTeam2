import { useCallback, useEffect, useRef, useState } from "react";
import {
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
import type { UsePresenter } from "./hooks/use-presenter";

type Phase = "welcome" | "intake" | "prep" | "practice" | "review";

interface FlowProps {
  presenter: UsePresenter;
  token: string;
}

// Reusable line card component showing kanji + romaji + english.
function LineCard({ line, accent = false }: { line: JaLine; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-primary bg-accent/20" : "border-border bg-card"}`}>
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

export default function Flow({ presenter, token }: FlowProps) {
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

  const speechBusyRef = useRef(false);

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

  const setSpeechBusy = useCallback((b: boolean) => {
    speechBusyRef.current = b;
  }, []);

  // ---- Welcome ----
  const begin = useCallback(async () => {
    setStatus("warming up Luna…");
    try {
      await presenter.resumeAudio();
      await presenter.initialize(token, {
        avatarId: "01KD2H4NWSZP4Y3CK8P3PSHTYP",
        sceneId: "01K4NYB6627539QRJR2HXESJJK",
        voiceId: "01KTBJGRFKWS029KQKQBC3318V",
      });
      setPhase("intake");
      setStatus("");
    } catch (err) {
      setStatus(`init error: ${(err as Error).message}`);
    }
  }, [presenter, token]);

  // ---- Intake (confirmation stub) ----
  const runIntake = useCallback(
    async (transcript: string) => {
      setStatus("Luna is confirming…");
      try {
        await classifyIntake(transcript);
        setIntakeText(transcript);
        await presenter.speakText(
          `Got it — a ${content?.scenario.title ?? "dentist"} appointment. Let's get you ready.`,
        ).catch(() => {});
        setStatus("");
        setPhase("prep");
      } catch (err) {
        setStatus(`classify error: ${(err as Error).message}`);
      }
    },
    [presenter, content],
  );

  const speakIntakeAudio = useCallback(async () => {
    await presenter.speakText(
      "Hi! I'm Luna. What phone call would you like to practice today? For example, a dentist appointment.",
    ).catch(() => {});
  }, [presenter]);

  const captureIntake = useCallback(async () => {
    try {
      setStatus("listening…");
      await recStart();
      await new Promise((r) => setTimeout(r, 3500));
      const { base64, mimeType } = await recStop();
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
    setStatus("Luna will read each line for you.");
    setSpeechBusy(true);
    try {
      for (const line of content.prep_lines) {
        await presenter.speakText(line.ja).catch(() => {});
        await presenter.speakText(line.ja).catch(() => {});
        await new Promise((r) => setTimeout(r, 3000));
      }
    } finally {
      setSpeechBusy(false);
      setStatus("Ready to practice? Repeat a line, or continue.");
    }
  }, [content, presenter, setSpeechBusy]);

  const repeatPrepLine = useCallback(
    async (line: JaLine) => {
      setSpeechBusy(true);
      try {
        await presenter.speakText(line.ja).catch(() => {});
      } finally {
        setSpeechBusy(false);
      }
    },
    [presenter, setSpeechBusy],
  );

  // Enter practice: switch to full-screen role avatar.
  const startPractice = useCallback(async () => {
    if (!content) return;
    setStatus("switching to the clinic…");
    setPhase("practice");
    const startNode = content.dialogue.start_node;
    setCurrentNodeId(startNode);
    setRecoveryStage(0);
    setHintShown(null);
    setTurns([]);
    setReview(null);
    setSpeechBusy(true);
    try {
      await presenter.speakText("Okay, here you go. I'll be listening.").catch(() => {});
      const first = content.dialogue.nodes[startNode];
      if (first) {
        setAvatarLine(first.line);
        await presenter.speakText(first.line.ja).catch(() => {});
        setStatus("Your turn — speak in Japanese.");
      }
    } finally {
      setSpeechBusy(false);
    }
  }, [content, presenter, setSpeechBusy]);

  // ---- Practice turn handling ----
  const handleUserTurn = useCallback(async () => {
    if (!content) return;
    const node: DialogueNode = content.dialogue.nodes[currentNodeId];
    setStatus("listening…");
    try {
      await recStart();
      await new Promise((r) => setTimeout(r, 4000));
      const { base64, mimeType } = await recStop();
      setStatus("transcribing…");
      const { text } = await transcribeAudio(base64, mimeType);
      setStatus("routing…");
      const result = await routeTurn(currentNodeId, text, recoveryStage);
      const { outcome, nextNodeId, hint, showHint } = result.decision;

      // Record the turn for the Review.
      setTurns((prev) => [
        ...prev,
        {
          nodeId: currentNodeId,
          lineJa: node.line.ja,
          transcript: text,
          correct: outcome === "advance",
          recoveryOutcome: outcome === "advance" ? undefined : outcome,
        },
      ]);

      if (showHint && hint) setHintShown(hint);
      else if (!showHint) setHintShown(null);

      setRecoveryStage(result.decision.recoveryStage || 0);

      // English rejection: speak the rejection line, then repeat the prompt.
      if (outcome === "reject_english") {
        const rejection = content.common.no_english_rejection;
        setAvatarLine(rejection);
        setSpeechBusy(true);
        setStatus("avatar speaking…");
        await presenter.speakText(rejection.ja).catch(() => {});
        const repeatText = node.recoveries.repeat || node.line.ja;
        await presenter.speakText(repeatText).catch(() => {});
        setSpeechBusy(false);
        setStatus("Your turn — speak in Japanese.");
        return;
      }

      // Determine the avatar's next line.
      const goalNode = content.dialogue.goal_node;
      const isAdvancing = outcome === "advance" || outcome === "help";
      let nextLine: JaLine | null = null;
      if (isAdvancing) {
        const nn = content.dialogue.nodes[nextNodeId];
        if (nn) {
          setCurrentNodeId(nextNodeId);
          nextLine = nn.line;
        }
      } else {
        // Recovery (repeat/hint): avatar re-asks the current prompt.
        nextLine = node.line;
      }

      // Call ended naturally (reached the goal node).
      if (nextNodeId === goalNode && isAdvancing) {
        setPhase("review");
        setStatus("ending the call…");
        if (nextLine) {
          setAvatarLine(nextLine);
          setSpeechBusy(true);
          await presenter.speakText(nextLine.ja).catch(() => {});
          setSpeechBusy(false);
        }
        const reviewData = await reviewCall([...turns, {
          nodeId: currentNodeId,
          lineJa: node.line.ja,
          transcript: text,
          correct: outcome === "advance",
          recoveryOutcome: outcome === "advance" ? undefined : outcome,
        }]);
        setReview(reviewData);
        setStatus("");
        return;
      }

      if (nextLine) {
        setAvatarLine(nextLine);
        setSpeechBusy(true);
        setStatus("avatar speaking…");
        const textToSpeak = isAdvancing
          ? nextLine.ja
          : node.recoveries.repeat || nextLine.ja;
        await presenter.speakText(textToSpeak).catch(() => {});
        setSpeechBusy(false);
        setStatus("Your turn — speak in Japanese.");
      } else {
        setStatus("Your turn — speak in Japanese.");
      }
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
      recCancel();
    }
  }, [content, currentNodeId, recoveryStage, presenter, recStart, recStop, recCancel, turns, setSpeechBusy]);

  const endCallEarly = useCallback(() => {
    setPhase("review");
    setStatus("call ended");
    reviewCall(turns).then(setReview).catch(() => {});
  }, [turns]);

  if (!content) {
    return (
      <main className="min-h-svh bg-background text-foreground p-6">
        <p>Loading lesson…</p>
        {status && <p className="text-muted-foreground text-sm">{status}</p>}
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-background text-foreground p-6 max-w-2xl mx-auto">
      {phase === "welcome" && (
        <section className="text-center space-y-4 py-16">
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
            <BigButton variant="ghost" onClick={speakIntakeAudio}>
              Hear Luna
            </BigButton>
            <BigButton variant="ghost" onClick={captureIntake}>
              🎤 Talk inline
            </BigButton>
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
                <div className="flex-1">
                  <LineCard line={line} accent={i === 0} />
                </div>
                <BigButton variant="ghost" onClick={() => repeatPrepLine(line)} disabled={speechBusyRef.current}>
                  Repeat
                </BigButton>
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <BigButton onClick={runPrep} disabled={speechBusyRef.current}>
              Read lines again
            </BigButton>
            <BigButton onClick={startPractice}>Ready — start the call</BigButton>
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
            <BigButton onClick={handleUserTurn} disabled={recording || speechBusyRef.current}>
              {recording ? "Listening…" : "🎤 Speak"}
            </BigButton>
            <BigButton variant="ghost" onClick={endCallEarly}>
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
                      <span className={`text-xs font-medium ${t.correct ? "text-primary" : "text-destructive"}`}>
                        {t.correct ? "on target" : "needs work"}
                      </span>
                    </div>
                    <p className="text-sm mt-1">{t.expected}</p>
                    <p className="text-sm text-muted-foreground italic">You said: “{t.said}”</p>
                    {t.notes.map((n, i) => (
                      <p key={i} className="text-xs text-muted-foreground mt-1">• {n}</p>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
          {!review && <p className="text-sm">Preparing your review…</p>}
          {status && <p className="text-sm">{status}</p>}
          <button
            className="px-5 py-2 rounded-lg border border-border bg-card"
            onClick={() => window.location.reload()}
          >
            Practice again
          </button>
        </section>
      )}
    </main>
  );
}
