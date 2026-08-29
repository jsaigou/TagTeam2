import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, loadVariant, loadCommon } from "./content.mjs";

// ---- loadCommon ----

test("loadCommon: returns fillers + no_english_rejection", () => {
  const c = loadCommon();
  assert.ok(c.fillers);
  assert.ok(c.no_english_rejection);
  assert.ok(c.no_english_rejection.ja);
  assert.ok(c.no_english_rejection.romaji);
  assert.ok(c.no_english_rejection.en);
  // Fillers should have at least the 4 authored entries
  assert.ok(Object.keys(c.fillers).length >= 4);
});

// ---- loadVariant ----

test("loadVariant: returns expected shape", () => {
  const v = loadVariant("dentist", "a");
  assert.equal(v.scenario.id, "dentist");
  assert.equal(v.scenario.title, "Dentist appointment");
  assert.ok(v.role);
  assert.ok(v.prep_lines);
  assert.equal(v.prep_lines.length, 5);
  assert.ok(v.intro);
  assert.ok(v.dialogue);
  assert.ok(v.summary);
});

test("loadVariant: stamps dialogue nodes with their id", () => {
  const v = loadVariant("dentist", "a");
  const nodes = Object.values(v.dialogue.nodes);
  assert.ok(nodes.every((n) => typeof n.id === "string" && n.id.length > 0));
});

test("loadVariant: dialogue has start_node and goal_node", () => {
  const v = loadVariant("dentist", "a");
  assert.ok(v.dialogue.start_node);
  assert.ok(v.dialogue.goal_node);
  assert.ok(v.dialogue.nodes[v.dialogue.start_node], "start_node exists in nodes");
  assert.ok(v.dialogue.nodes[v.dialogue.goal_node], "goal_node exists in nodes");
});

test("loadVariant: each node has expected + recoveries", () => {
  const v = loadVariant("dentist", "a");
  for (const node of Object.values(v.dialogue.nodes)) {
    assert.ok(Array.isArray(node.expected), `${node.id} has expected array`);
    assert.ok(node.recoveries, `${node.id} has recoveries`);
    assert.ok(typeof node.recoveries.help === "string", `${node.id} has help edge`);
  }
});

test("loadVariant: prep_lines all have ja/romaji/en", () => {
  const v = loadVariant("dentist", "a");
  for (const line of v.prep_lines) {
    assert.ok(line.ja, "prep line has ja");
    assert.ok(line.romaji, "prep line has romaji");
    assert.ok(line.en, "prep line has en");
  }
});

// ---- loadBundle ----

test("loadBundle: includes common content", () => {
  const b = loadBundle("dentist", "a");
  assert.ok(b.common);
  assert.ok(b.common.fillers);
  assert.ok(b.common.no_english_rejection);
});

test("loadBundle: merges variant + common", () => {
  const b = loadBundle("dentist", "a");
  assert.equal(b.scenario.id, "dentist");
  assert.ok(b.prep_lines);
  assert.ok(b.dialogue);
  assert.ok(b.common.fillers);
});

test("loadBundle: defaults to dentist/a", () => {
  const b = loadBundle();
  assert.equal(b.scenario.id, "dentist");
});
