#!/usr/bin/env node
/**
 * Pre-renders every Prep example sentence (each content/scenarios domain/variant's
 * prep-lines.json → prep_lines[]) as a static MP3 under app/public/prep-audio/, one clip per
 * (scenario, variant, index, voice). Run this after editing any prep-lines.json,
 * before committing/deploying:
 *
 *   cd server && node --env-file=.env scripts/render-prep-audio.mjs
 *
 * Idempotent: app/public/prep-audio/manifest.json records the sha256 of each
 * line's source text, so a rerun only pays for TTS + ffmpeg on lines that are
 * new or whose text changed since the last render — everything else is
 * skipped. Also prunes manifest entries/files for (scenario, variant, index,
 * voice) combos no longer present in current content (a line removed, or a
 * variant that shrank), so the asset folder doesn't accumulate orphans.
 *
 * Voices must match PREP_VOICES in app/src/lib/audio.ts — that's the runtime
 * source of truth for which voices actually get played; this list mirrors it.
 */
import { readdir, readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { synthesizeSpeechWav } from "../src/providers.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCENARIOS_DIR = path.join(REPO_ROOT, "content/scenarios");
const OUT_DIR = path.join(REPO_ROOT, "app/public/prep-audio");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const VOICES = ["lauren_us", "bert"];

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

function keyFor(domain, variant, index, voice) {
  return `${domain}-${variant}-${index}-${voice}`;
}

function wavToMp3(wavBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stderr = [];
    const child = spawn("ffmpeg", ["-y", "-i", "pipe:0", "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1"]);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(stderr).toString().slice(-500)}`));
    });
    child.stdin.end(Buffer.from(wavBytes));
  });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function fileExists(p) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function collectVariants() {
  const out = [];
  for (const domain of await readdir(SCENARIOS_DIR)) {
    const domainDir = path.join(SCENARIOS_DIR, domain);
    if (!(await stat(domainDir)).isDirectory()) continue;
    for (const variant of await readdir(domainDir)) {
      const file = path.join(domainDir, variant, "prep-lines.json");
      const data = await readJson(file);
      if (!data?.prep_lines) continue;
      out.push({ domain, variant, lines: data.prep_lines });
    }
  }
  return out;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = (await readJson(MANIFEST_PATH)) ?? {};
  const variants = await collectVariants();

  const liveKeys = new Set();
  let rendered = 0;
  let skipped = 0;
  let failed = 0;

  for (const { domain, variant, lines } of variants) {
    const seen = new Set();
    lines.forEach((line, index) => {
      if (seen.has(line.ja)) {
        console.warn(
          `WARNING: duplicate ja text in ${domain}/${variant} at index ${index} — index-based ` +
            `Prep audio lookup will pick whichever slot rendered last for this text.`,
        );
      }
      seen.add(line.ja);
    });

    for (let index = 0; index < lines.length; index++) {
      const ja = lines[index].ja;
      const hash = sha256(ja);
      for (const voice of VOICES) {
        const key = keyFor(domain, variant, index, voice);
        liveKeys.add(key);
        const outFile = path.join(OUT_DIR, `${key}.mp3`);
        const cached = manifest[key];
        if (cached?.hash === hash && (await fileExists(outFile))) {
          skipped++;
          continue;
        }
        try {
          const wav = await synthesizeSpeechWav(ja, { voice });
          const mp3 = await wavToMp3(wav);
          await writeFile(outFile, mp3);
          manifest[key] = { hash, text: ja, voice };
          rendered++;
          console.log(`rendered ${key} (${mp3.length}B)`);
        } catch (err) {
          failed++;
          console.error(`FAILED ${key}: ${err.message}`);
        }
      }
    }
  }

  // Prune anything no longer referenced by current content.
  let pruned = 0;
  for (const key of Object.keys(manifest)) {
    if (liveKeys.has(key)) continue;
    delete manifest[key];
    const orphan = path.join(OUT_DIR, `${key}.mp3`);
    if (await fileExists(orphan)) await rm(orphan);
    pruned++;
  }

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`done: ${rendered} rendered, ${skipped} skipped, ${pruned} pruned, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
