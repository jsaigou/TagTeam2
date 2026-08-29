/**
 * Content loader: reads pre-authored scenario bundles from content/ (ADR-0002).
 * Bundles are deterministic, reviewable JSON — never generated live.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "../../content");

const cache = new Map();

function loadJson(rel) {
  const abs = path.join(CONTENT_DIR, rel);
  if (!cache.has(abs)) {
    cache.set(abs, JSON.parse(readFileSync(abs, "utf8")));
  }
  return cache.get(abs);
}

/** Load the shared common content (fillers + no-English rejection). */
export function loadCommon() {
  return loadJson("shared/common.json");
}

/** Load one variant bundle: metafile + variant content (intro, prep, dialogue, summary). */
export function loadVariant(scenarioId, variantId) {
  const meta = loadJson(`scenarios/${scenarioId}/metafile.json`);
  const prep0 = loadJson(`scenarios/${scenarioId}/${variantId}/prep-lines.json`);
  const intro = loadJson(`scenarios/${scenarioId}/${variantId}/intro.json`);
  const dialogue = loadJson(`scenarios/${scenarioId}/${variantId}/dialogue.json`);
  // Stamp each dialogue node with its id (the JSON keys the node by id, not the node itself).
  for (const [id, n] of Object.entries(dialogue.nodes)) n.id = id;
  const summary = loadJson(`scenarios/${scenarioId}/${variantId}/summary.json`);
  return {
    scenario: {
      id: meta.id,
      title: meta.title,
      tagline: meta.tagline,
      goal: meta.goal,
      persona: meta.persona || "",
      brief: meta.brief || { stages: [], key_info: [] },
    },
    role: meta.role,
    variant: { id: prep0.id, label: prep0.label, lines: prep0.variant },
    prep_lines: prep0.prep_lines,
    intro,
    dialogue,
    summary,
  };
}

/** Load the complete client-facing bundle (everything the app needs to render the slice). */
export function loadBundle(scenarioId = "dentist", variantId = "a") {
  return {
    common: loadCommon(),
    ...loadVariant(scenarioId, variantId),
  };
}
