/**
 * Practice rules (ADR-0006): Turn Router (blocking) + end-of-call Judge.
 * Deterministic implementations over the pre-authored content — zero LLM latency,
 * which is required because the Turn Router BLOCKS before the avatar speaks.
 */

// Stage 0: normal. 1: repeat shown. 2: hint shown. 3+: must advance (help).
const STAGE_HELP = 3;

function normalize(s) {
  return String(s || "")
    .replace(/[\s\u3000]+/g, "")
    .normalize("NFKC")
    .toLowerCase();
}

/** True if any keyword appears in the transcript. Fuzzy-contains on normalized text. */
function matchesExpected(transcript, matchList) {
  const t = normalize(transcript);
  if (!t) return false;
  return matchList.some((kw) => {
    const k = normalize(kw);
    return k.length > 1 ? t.includes(k) : t.includes(k);
  });
}

/** Look for plain-English-only attempts (distinct from katakana/和製英語). */
export function looksLikeEnglish(transcript) {
  const t = (transcript || "").trim();
  if (!t) return false;
  // Katakana/Japanese characters anywhere → treat as a Japanese(ish) attempt.
  if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(t)) return false;
  // Otherwise: if it contains latin letters/words, it reads as English-only.
  return /[A-Za-z]{2,}/.test(t);
}

/**
 * Turn Router — decides which node the roleplay avatar advances to.
 * @param node     the current dialogue node ({ id, line, expected, recoveries })
 * @param transcript  raw STT transcript (as-is, ADR-0006)
 * @param recoveryStage  0..3+
 * @returns { outcome, nextNodeId, hint?, showHint }
 */
export function routeTurn(node, transcript, recoveryStage = 0) {
  const stage = Number(recoveryStage) || 0;
  const rec = node.recoveries || { repeat: "", hint: null, help: "" };
  const expected = node.expected || [];

  // English-only attempts always get the in-universe rejection + repeat (PLAN §5.3).
  if (looksLikeEnglish(transcript)) {
    return { outcome: "reject_english", showHint: false, hint: null, nextNodeId: node.id, recoveryStage: Math.max(1, stage) };
  }

  const matched = matchesExpected(transcript, expected.flatMap((e) => e.match ?? []));

  if (matched && stage < STAGE_HELP) {
    // Correct (or acceptable) response → advance to the matched next node.
    const nextNodeId = expected.find((e) => matchesExpected(transcript, e.match ?? []))?.next ?? node.id;
    return { outcome: "advance", showHint: false, hint: null, nextNodeId, recoveryStage: 0 };
  }

  // No match → escalate recovery: repeat prompt → hint → help branch.
  if (stage >= STAGE_HELP) {
    const helpId = rec.help || node.id;
    return { outcome: "help", showHint: true, hint: rec.hint, nextNodeId: helpId, recoveryStage: STAGE_HELP };
  }
  if (stage === 2) {
    // Hint already shown; next repeat advances through help next time.
    return { outcome: "repeat", showHint: true, hint: rec.hint, nextNodeId: node.id, recoveryStage: STAGE_HELP };
  }
  if (stage === 1) {
    const showHint = Boolean(rec.hint);
    return { outcome: showHint ? "hint" : "repeat", showHint, hint: rec.hint, nextNodeId: node.id, recoveryStage: 2 };
  }
  // stage 0 → first miss: repeat the prompt.
  return { outcome: "repeat", showHint: false, hint: null, nextNodeId: node.id, recoveryStage: 1 };
}

const TEINEIGO_RX = /です|ます|でした|ました|ましょう|ください|ましょうか|ですね/;

/**
 * Judge — end-of-call evaluation (non-blocking). Deterministic over the recorded turns.
 * @param turns [{ nodeId, lineJa, transcript, correct, recoveryOutcome }]
 * @returns { perTurn: [], overall, stats }
 */
export function reviewCall(turns = []) {
  const perTurn = turns.map((t, i) => {
    const note = [];
    let grade = "good";
    const hasJapanese = /[\u3040-\u30ff\u4e00-\u9fff]/.test(t.transcript || "");
    const hasTeineigo = TEINEIGO_RX.test(t.transcript || "");

    if (looksLikeEnglish(t.transcript)) {
      grade = "english";
      note.push("You switched to English — try to stay in Japanese.");
    } else if (hasJapanese && !hasTeineigo) {
      grade = "teineigo";
      note.push("Use the polite です/ます form here (teineigo) for a clinic call.");
    } else if (hasJapanese && hasTeineigo) {
      note.push("Clear polite phrasing. Nice.");
    } else if (!t.transcript) {
      grade = "silent";
      note.push("No response was captured that turn.");
    }

    if (t.recoveryOutcome === "repeat" || t.recoveryOutcome === "hint" || t.recoveryOutcome === "help") {
      note.push("This turn needed a nudge — the call recovered but try it smoothly next time.");
    }

    return {
      turn: i + 1,
      node: t.nodeId,
      expected: t.lineJa || "",
      said: t.transcript || "",
      correct: !!t.correct,
      grade,
      notes: note,
    };
  });

  const recovered = turns.filter((t) => t.recoveryOutcome && t.recoveryOutcome !== "advance").length;
  const englishCount = turns.filter((t) => looksLikeEnglish(t.transcript)).length;
  const smoothTurns = turns.filter((t) => t.correct && !t.recoveryOutcome).length;

  const overall = [
    `You completed ${turns.length} turns.`,
    smoothTurns > 0 ? `${smoothTurns} were smooth and on-target.` : "Most turns needed some recovery.",
    recovered > 0 ? `You used ${recovered} recovery nudge(s) — that's normal, it means the call kept moving.` : "No recovery nudges were needed.",
    englishCount > 0 ? `You fell back to English ${englishCount} time(s). Keep the whole call in Japanese.` : "You stayed in Japanese the whole call.",
    "Remember: です/ます (teineigo) is the bar here — keigo is only a bonus.",
  ].join(" ");

  return { perTurn, overall, stats: { turns: turns.length, recovered, englishCount, smoothTurns } };
}
