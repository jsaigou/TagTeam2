import { test } from "node:test";
import assert from "node:assert/strict";
import { stripSttArtifacts } from "./providers.mjs";

// nvidia/nemotron-asr leaks its own per-utterance language-ID token into the
// transcript (observed live 2026-09-06: "分かりました。 <ja-JP>", "Yeah. <en-US>").

test("stripSttArtifacts: strips a trailing language-ID tag", () => {
  assert.equal(stripSttArtifacts("分かりました。 <ja-JP>"), "分かりました。");
  assert.equal(stripSttArtifacts("Yeah. <en-US>"), "Yeah.");
});

test("stripSttArtifacts: leaves clean text untouched", () => {
  assert.equal(stripSttArtifacts("予約をお願いします"), "予約をお願いします");
});

test("stripSttArtifacts: handles empty/undefined input", () => {
  assert.equal(stripSttArtifacts(""), "");
  assert.equal(stripSttArtifacts(undefined), "");
});
