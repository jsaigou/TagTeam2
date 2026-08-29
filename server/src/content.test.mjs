import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadBundle, loadVariant, loadCommon } from "./content.mjs";

// Discover all scenarios + variants from the filesystem.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../../content/scenarios");
const scenarios = readdirSync(CONTENT_DIR).filter((d) =>
  existsSync(path.join(CONTENT_DIR, d, "metafile.json")),
);
const variantsPerScenario = Object.fromEntries(
  scenarios.map((s) => {
    const meta = JSON.parse(readFileSync(path.join(CONTENT_DIR, s, "metafile.json"), "utf8"));
    return [s, meta.variants || ["a"]];
  }),
);

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

// ---- Parameterized tests across ALL discovered scenarios + variants ----

for (const scenarioId of scenarios) {
  for (const variantId of variantsPerScenario[scenarioId]) {
    test(`loadBundle: ${scenarioId}/${variantId} loads with correct shape`, () => {
      const b = loadBundle(scenarioId, variantId);
      assert.ok(b.scenario.id, `${scenarioId}/${variantId}: scenario.id`);
      assert.ok(b.scenario.title, `${scenarioId}/${variantId}: scenario.title`);
      assert.ok(b.prep_lines, `${scenarioId}/${variantId}: prep_lines`);
      assert.equal(b.prep_lines.length, 5, `${scenarioId}/${variantId}: 5 prep lines`);
      assert.ok(b.dialogue, `${scenarioId}/${variantId}: dialogue`);
      assert.ok(b.dialogue.start_node, `${scenarioId}/${variantId}: start_node`);
      assert.ok(b.dialogue.goal_node, `${scenarioId}/${variantId}: goal_node`);
      assert.ok(b.dialogue.nodes, `${scenarioId}/${variantId}: nodes`);
      assert.ok(b.common, `${scenarioId}/${variantId}: common`);
      assert.ok(b.common.fillers, `${scenarioId}/${variantId}: fillers`);
    });

    test(`loadVariant: ${scenarioId}/${variantId} prep lines have ja/romaji/en`, () => {
      const v = loadVariant(scenarioId, variantId);
      for (const line of v.prep_lines) {
        assert.ok(line.ja, `${scenarioId}/${variantId}: prep line has ja`);
        assert.ok(line.romaji, `${scenarioId}/${variantId}: prep line has romaji`);
        assert.ok(line.en, `${scenarioId}/${variantId}: prep line has en`);
      }
    });

    test(`loadVariant: ${scenarioId}/${variantId} nodes stamped with id`, () => {
      const v = loadVariant(scenarioId, variantId);
      const nodes = Object.values(v.dialogue.nodes);
      assert.ok(nodes.every((n) => typeof n.id === "string" && n.id.length > 0));
      assert.ok(nodes.every((n) => Array.isArray(n.expected)));
      assert.ok(nodes.every((n) => n.recoveries));
    });
  }
}
