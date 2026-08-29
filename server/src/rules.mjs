/**
 * Practice rules (ADR-0006): Turn Router (blocking) + end-of-call Judge.
 * LLM-based with deterministic fallback (PLAN §9). The Turn Router tries the
 * LLM with a 3s timeout (it BLOCKS before the avatar speaks); the Judge uses a
 * 30s timeout (non-blocking, runs after the call ends). Both fall back to the
 * deterministic keyword/regex matcher on timeout or error.
 */
import { chatJSON } from "./llm.mjs";

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
  return matchList.some((kw) => t.includes(normalize(kw)));
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
 * Deterministic Turn Router — keyword matcher over the pre-authored content.
 * Used as fallback when the LLM is unavailable or too slow.
 */
function routeTurnDeterministic(node, transcript, recoveryStage = 0) {
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

/**
 * LLM-based Turn Router — asks the LLM to classify the learner's transcript
 * against the expected responses. Tolerant of paraphrase and ASR noise.
 * Returns null on timeout/error (caller falls back to deterministic).
 */
async function routeTurnLLM(node, transcript, recoveryStage) {
  const expected = node.expected || [];
  if (expected.length === 0) return null;

  const expectedList = expected.map((e, i) =>
    `${i + 1}. Keywords: ${e.match?.join(", ") || "(none)"} → next: ${e.next}`
  ).join("\n");

  const messages = [
    {
      role: "system",
      content: "You are a Japanese phone-call practice router. Classify the learner's speech-to-text transcript against expected responses. 和製英語 (katakana English) is acceptable Japanese. Be tolerant of ASR noise and minor grammar errors. Respond as JSON only.",
    },
    {
      role: "user",
      content: `Avatar said (Japanese): "${node.line.ja}"\nEnglish meaning: "${node.line.en}"\n\nExpected responses:\n${expectedList}\n\nLearner's transcript: "${transcript}"\n\nClassify:\n- If it matches expected response N, return {"match": N, "is_english": false}\n- If it's plain English (no Japanese characters), return {"match": 0, "is_english": true}\n- If no match, return {"match": 0, "is_english": false}`,
    },
  ];

  const result = await chatJSON(messages, { timeoutMs: 3000, temperature: 0 });
  if (!result || typeof result.match !== "number") return null;

  const rec = node.recoveries || { repeat: "", hint: null, help: "" };
  const stage = Number(recoveryStage) || 0;

  if (result.is_english) {
    return { outcome: "reject_english", showHint: false, hint: null, nextNodeId: node.id, recoveryStage: Math.max(1, stage) };
  }

  if (result.match > 0 && result.match <= expected.length && stage < STAGE_HELP) {
    const nextNodeId = expected[result.match - 1].next;
    return { outcome: "advance", showHint: false, hint: null, nextNodeId, recoveryStage: 0 };
  }

  return null;
}

/**
 * Turn Router (exported) — tries LLM first (3s timeout), falls back to
 * deterministic keyword matcher. The Turn Router BLOCKS before the avatar
 * speaks, so latency is critical.
 */
export async function routeTurn(node, transcript, recoveryStage = 0) {
  try {
    const llmResult = await routeTurnLLM(node, transcript, recoveryStage);
    if (llmResult) {
      console.log(`[router] LLM: ${llmResult.outcome} → ${llmResult.nextNodeId}`);
      return llmResult;
    }
  } catch (err) {
    console.log(`[router] LLM failed: ${err.message}, falling back to deterministic`);
  }
  return routeTurnDeterministic(node, transcript, recoveryStage);
}

/**
 * P4 (ADR-0008): LLM-driven practice router. The LLM authors the avatar's next
 * Japanese line from the scenario persona directive + brief + turn history.
 * Falls back to the deterministic graph matcher (ADR-0006) on timeout,
 * malformed output, or no-LLM. Returns the unified contract:
 * { outcome, speak: JaLine[], showHint, hint, recoveryStage, callDone, source }.
 */
const P4_OUTCOMES = new Set(["advance", "repeat", "hint", "help", "reject_english"]);

// The model occasionally answers with synonyms; map them onto the canonical set.
const P4_OUTCOME_SYNONYMS = {
  advance: "advance", success: "advance", ok: "advance", proceed: "advance", next: "advance",
  repeat: "repeat", reask: "repeat", "re-ask": "repeat", clarify: "repeat",
  hint: "hint",
  help: "help", forward: "help",
  reject_english: "reject_english", english: "reject_english", reject: "reject_english",
  // Closing outcomes: the call is over — advance into the automatic review.
  done: "advance", close: "advance", end: "advance", goodbye: "advance", finished: "advance",
};

// The model varies the call-done flag's key; accept the common variants so the
// call always ends into the review automatically.
function p4CallDone(r) {
  return Boolean(r.callDone ?? r.call_done ?? r.done ?? r.is_done ?? r.finished ?? r.end_call);
}

async function routeTurnP4LLM({ bundle, node, transcript, recoveryStage, history }) {
  const { persona, brief } = bundle.scenario;
  if (!persona) return null;
  const hist = (history || [])
    .slice(-6)
    .map((h) => `Avatar: "${h.avatar}"\nLearner: "${h.learner}"`)
    .join("\n");
  const messages = [
    {
      role: "system",
      content:
        "You are the roleplay avatar in a Japanese phone-call practice call. " +
        `Persona directive (Japanese): ${persona} ` +
        `Scenario brief — goal: ${bundle.scenario.goal}; stages: ${(brief.stages || []).join(" → ")}; ` +
        `key info to collect: ${(brief.key_info || []).join(", ")}. ` +
        "Rules: the learner is a beginner — keep your lines short, natural, polite です/ます, one question at a time. " +
        "和製英語 (katakana English) counts as Japanese. Plain English → outcome reject_english: refuse in-universe in Japanese and re-ask. " +
        "Unclear or off-topic → repeat (1st miss) / hint (2nd miss) / help (3rd+, gently move the call forward). " +
        "Learner moved the call forward → advance. Goal achieved → set callDone to true and speak a polite closing line (the app then shows the feedback page automatically). " +
        'Respond as JSON only: {"outcome","nextLineJa","nextLineRomaji","nextLineEn","callDone"}',
    },
    {
      role: "user",
      content:
        `Call so far:\n${hist || "(call just started)"}\n` +
        `Your current prompt (Japanese): "${node.line.ja}" (${node.line.en})\n` +
        `Recovery stage so far: ${Number(recoveryStage) || 0}\n` +
        `Turn number: ${(history?.length || 0) + 1} (a call like this wraps up in about 5-8 turns — once the goal is achieved, close it).\n` +
        `Learner's latest transcript: "${transcript}"`,
    },
  ];
  const r = await chatJSON(messages, { timeoutMs: 8000, temperature: 0.2 });
  const outcome = P4_OUTCOME_SYNONYMS[String(r?.outcome ?? "").toLowerCase()];
  if (!r || !outcome || !P4_OUTCOMES.has(outcome)) return null;
  if (typeof r.nextLineJa !== "string" || !r.nextLineJa.trim()) return null;
  const recoveryStageNext =
    outcome === "advance" ? 0 :
    outcome === "hint" ? 2 :
    outcome === "help" ? 3 :
    Math.min(3, (Number(recoveryStage) || 0) + 1);
  const showHint = outcome === "hint" || outcome === "help";
  return {
    outcome,
    speak: [{
      ja: r.nextLineJa.trim(),
      romaji: typeof r.nextLineRomaji === "string" ? r.nextLineRomaji : "",
      en: typeof r.nextLineEn === "string" ? r.nextLineEn : "",
    }],
    showHint,
    hint: showHint ? node.recoveries?.hint || null : null,
    recoveryStage: recoveryStageNext,
    callDone: p4CallDone(r),
    source: "llm",
  };
}

/** Authored lines for the fallback contract, derived from the graph decision. */
function fallbackSpeak(bundle, node, decision) {
  const nodes = bundle.dialogue.nodes;
  const line = (n) => n?.line || { ja: "", romaji: "", en: "" };
  switch (decision.outcome) {
    case "advance":
    case "help":
      return [line(nodes[decision.nextNodeId])];
    case "reject_english":
      return [bundle.common?.no_english_rejection || line(node), line(node)];
    default: {
      const repeatJa = node.recoveries?.repeat || node.line.ja;
      return [{ ja: repeatJa, romaji: "", en: "" }];
    }
  }
}

/** P4 Turn Router (exported): LLM first, deterministic graph fallback. */
export async function routeTurnP4({ bundle, node, transcript, recoveryStage = 0, history = [] }) {
  try {
    const llm = await routeTurnP4LLM({ bundle, node, transcript, recoveryStage, history });
    if (llm) {
      console.log(`[router] P4 LLM: ${llm.outcome}${llm.callDone ? " (call done)" : ""}`);
      return llm;
    }
  } catch (err) {
    console.log(`[router] P4 LLM failed: ${err.message}, falling back to graph`);
  }
  const decision = routeTurnDeterministic(node, transcript, recoveryStage);
  const goal = bundle.dialogue.goal_node;
  return {
    outcome: decision.outcome,
    speak: fallbackSpeak(bundle, node, decision),
    showHint: decision.showHint,
    hint: decision.hint,
    recoveryStage: decision.recoveryStage,
    callDone: decision.nextNodeId === goal && (decision.outcome === "advance" || decision.outcome === "help"),
    source: "fallback",
  };
}

const TEINEIGO_RX = /です|ます|でした|ました|ましょう|ください|ましょうか|ですね/;

/**
 * Deterministic Judge — regex/keyword-based evaluation. Used as fallback.
 * @param turns [{ nodeId, lineJa, transcript, correct, recoveryOutcome }]
 * @returns { perTurn: [], overall, stats }
 */
function reviewCallDeterministic(turns = []) {
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

/**
 * LLM-based Judge — asks the LLM to evaluate each turn and produce corrections.
 * Returns null on timeout/error (caller falls back to deterministic).
 */
async function reviewCallLLM(turns) {
  if (!turns.length) return null;

  const turnList = turns.map((t, i) =>
    `Turn ${i + 1}:\n  Expected: "${t.lineJa || ""}"\n  Learner said: "${t.transcript || ""}"\n  Correct: ${t.correct}\n  Recovery: ${t.recoveryOutcome || "none"}`
  ).join("\n\n");

  const messages = [
    {
      role: "system",
      content: "You are a Japanese phone-call practice judge. Evaluate the learner's performance. The grading bar is teineigo (です/ます polite form) — failing to use it is a weakness, but keigo (honorifics) is only an optional tip, never a failure. All explanations must be in English (the learner is an English speaker). Respond as JSON only.",
    },
    {
      role: "user",
      content: `Evaluate these turns from a dentist appointment phone call:\n\n${turnList}\n\nFor each turn, provide:\n- "correction": what the learner should have said (Japanese)\n- "polite": whether they used teineigo (boolean)\n- "note": a short English explanation (1-2 sentences)\n\nThen provide an "overall" assessment (2-3 sentences in English).\n\nRespond as JSON:\n{"perTurn": [{"turn": 1, "correction": "...", "polite": true, "note": "..."}], "overall": "..."}`,
    },
  ];

  const result = await chatJSON(messages, { timeoutMs: 30_000, temperature: 0.3 });
  if (!result || !Array.isArray(result.perTurn)) return null;

  // Enrich LLM output with the original transcript data the client expects.
  const perTurn = turns.map((t, i) => {
    const llmTurn = result.perTurn[i] || {};
    return {
      turn: i + 1,
      node: t.nodeId,
      expected: t.lineJa || "",
      said: t.transcript || "",
      correct: !!t.correct,
      grade: llmTurn.polite ? "good" : (looksLikeEnglish(t.transcript) ? "english" : "teineigo"),
      notes: [llmTurn.note || "", llmTurn.correction ? `Try: ${llmTurn.correction}` : ""].filter(Boolean),
    };
  });

  return {
    perTurn,
    overall: result.overall || "",
    stats: {
      turns: turns.length,
      recovered: turns.filter((t) => t.recoveryOutcome && t.recoveryOutcome !== "advance").length,
      englishCount: turns.filter((t) => looksLikeEnglish(t.transcript)).length,
      smoothTurns: turns.filter((t) => t.correct && !t.recoveryOutcome).length,
    },
  };
}

/**
 * Judge (exported) — tries LLM first (30s timeout, non-blocking), falls back to
 * deterministic regex/keyword evaluation. Runs after the call ends.
 */
export async function reviewCall(turns = []) {
  try {
    const llmResult = await reviewCallLLM(turns);
    if (llmResult) {
      console.log(`[judge] LLM: ${llmResult.perTurn.length} turns reviewed`);
      return llmResult;
    }
  } catch (err) {
    console.log(`[judge] LLM failed: ${err.message}, falling back to deterministic`);
  }
  return reviewCallDeterministic(turns);
}
