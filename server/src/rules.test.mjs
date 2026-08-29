import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTurn, reviewCall, looksLikeEnglish } from "./rules.mjs";

// LLM_BASE_URL is unset in tests → all calls fall back to deterministic.

const sampleNode = {
  id: "greeting",
  line: { ja: "はい、歯科医院です。", romaji: "hai, shika iin desu.", en: "Hello, dental clinic." },
  expected: [
    { match: ["予約", "よやく", "お願い"], next: "purpose", feedback: "" },
    { match: ["相談"], next: "purpose", feedback: "" },
  ],
  recoveries: {
    repeat: "すみません、ご用件は何でしょうか？",
    hint: { ja: "予約をしたいんです。", romaji: "yoyaku o shitai n desu.", en: "I'd like an appointment." },
    help: "purpose",
  },
};

const terminalNode = {
  id: "done",
  line: { ja: "お大事に。", romaji: "o-daiji ni.", en: "Take care." },
  expected: [],
  recoveries: { repeat: "", hint: null, help: "done" },
};

// ---- Turn Router ----

test("routeTurn: correct match advances", async () => {
  const r = await routeTurn(sampleNode, "予約したいんです", 0);
  assert.equal(r.outcome, "advance");
  assert.equal(r.nextNodeId, "purpose");
  assert.equal(r.recoveryStage, 0);
});

test("routeTurn: first miss repeats (stage 0→1)", async () => {
  const r = await routeTurn(sampleNode, "うーん", 0);
  assert.equal(r.outcome, "repeat");
  assert.equal(r.nextNodeId, "greeting");
  assert.equal(r.recoveryStage, 1);
  assert.equal(r.showHint, false);
});

test("routeTurn: second miss shows hint (stage 1→2)", async () => {
  const r = await routeTurn(sampleNode, "えーと", 1);
  assert.equal(r.outcome, "hint");
  assert.equal(r.showHint, true);
  assert.ok(r.hint);
  assert.equal(r.recoveryStage, 2);
});

test("routeTurn: third miss with hint shown (stage 2→3)", async () => {
  const r = await routeTurn(sampleNode, "わからない", 2);
  assert.equal(r.outcome, "repeat");
  assert.equal(r.showHint, true);
  assert.equal(r.recoveryStage, 3);
});

test("routeTurn: stage 3+ triggers help branch", async () => {
  const r = await routeTurn(sampleNode, "わからない", 3);
  assert.equal(r.outcome, "help");
  assert.equal(r.nextNodeId, "purpose");
  assert.equal(r.showHint, true);
});

test("routeTurn: English input triggers reject_english", async () => {
  const r = await routeTurn(sampleNode, "I want an appointment", 0);
  assert.equal(r.outcome, "reject_english");
  assert.equal(r.nextNodeId, "greeting");
});

test("routeTurn: katakana English is NOT rejected", async () => {
  const r = await routeTurn(sampleNode, "アポイント取りたいです", 0);
  assert.notEqual(r.outcome, "reject_english");
});

test("routeTurn: empty transcript repeats", async () => {
  const r = await routeTurn(sampleNode, "", 0);
  assert.equal(r.outcome, "repeat");
  assert.equal(r.recoveryStage, 1);
});

test("routeTurn: correct match resets recoveryStage to 0", async () => {
  const r = await routeTurn(sampleNode, "予約したい", 2);
  assert.equal(r.outcome, "advance");
  assert.equal(r.recoveryStage, 0);
});

test("routeTurn: terminal node with no expected always recovers", async () => {
  const r = await routeTurn(terminalNode, "ありがとう", 0);
  assert.equal(r.outcome, "repeat");
  assert.equal(r.nextNodeId, "done");
});

// ---- looksLikeEnglish ----

test("looksLikeEnglish: pure English detected", () => {
  assert.equal(looksLikeEnglish("I want an appointment"), true);
});

test("looksLikeEnglish: Japanese not detected as English", () => {
  assert.equal(looksLikeEnglish("予約したいです"), false);
});

test("looksLikeEnglish: katakana not detected as English", () => {
  assert.equal(looksLikeEnglish("アポイント"), false);
});

test("looksLikeEnglish: empty string not English", () => {
  assert.equal(looksLikeEnglish(""), false);
});

// ---- Judge ----

const sampleTurns = [
  { nodeId: "greeting", lineJa: "はい、歯科医院です。", transcript: "予約したいんです", correct: true },
  { nodeId: "purpose", lineJa: "今日でよろしいですか？", transcript: "I want today", correct: false, recoveryOutcome: "repeat" },
  { nodeId: "time_ask", lineJa: "何時がよろしいですか？", transcript: "二時でお願いします", correct: true },
  { nodeId: "confirm", lineJa: "二時でよろしいですね？", transcript: "", correct: false, recoveryOutcome: "help" },
];

test("reviewCall: returns perTurn array with correct length", async () => {
  const r = await reviewCall(sampleTurns);
  assert.equal(r.perTurn.length, 4);
  assert.equal(r.stats.turns, 4);
});

test("reviewCall: English turn gets english grade", async () => {
  const r = await reviewCall(sampleTurns);
  assert.equal(r.perTurn[1].grade, "english");
});

test("reviewCall: silent turn gets silent grade", async () => {
  const r = await reviewCall(sampleTurns);
  assert.equal(r.perTurn[3].grade, "silent");
});

test("reviewCall: polite Japanese gets good grade", async () => {
  const r = await reviewCall(sampleTurns);
  assert.equal(r.perTurn[0].grade, "good");
});

test("reviewCall: stats computed correctly", async () => {
  const r = await reviewCall(sampleTurns);
  assert.equal(r.stats.smoothTurns, 2); // turn 0 and 2
  assert.equal(r.stats.recovered, 2);    // turn 1 and 3
  assert.equal(r.stats.englishCount, 1); // turn 1
});

test("reviewCall: overall is non-empty string", async () => {
  const r = await reviewCall(sampleTurns);
  assert.ok(typeof r.overall === "string" && r.overall.length > 0);
});

test("reviewCall: empty turns returns empty results", async () => {
  const r = await reviewCall([]);
  assert.equal(r.perTurn.length, 0);
  assert.equal(r.stats.turns, 0);
});
