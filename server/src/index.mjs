/**
 * TagTeam2 thin Express server.
 * - /api/connect/config  → mints a Perxona connect_token + fixed-target asset IDs
 * - /api/stt            → proxy STT (homelab hosted, OpenAI-compatible)
 * - /api/tts            → proxy BYO-TTS (homelab) → 16 kHz mono WAV for presenter
 */
import express from "express";
import { createConnectClient } from "./connect-client.mjs";
import { transcribeAudio, synthesizeSpeechWav } from "./providers.mjs";
import { loadBundle } from "./content.mjs";
import { routeTurnP4, reviewCall } from "./rules.mjs";
import { chatJSON } from "./llm.mjs";

const MVP = { scenario: "dentist", variant: "a" };

const SCENARIOS = [
  { id: "dentist", title: "Dentist appointment" },
  { id: "doctor", title: "Doctor appointment" },
  { id: "restaurant", title: "Restaurant reservation" },
  { id: "lost-card", title: "Lost credit card" },
  { id: "redelivery", title: "Package redelivery" },
];

const app = express();
const PORT = Number(process.env.PORT || 8787);
const connect = createConnectClient({
  baseUrl: process.env.PERXONA_API_BASE_URL || "https://console.perxona.ai/asia",
  email: process.env.PERXONA_CONNECT_EMAIL,
  password: process.env.PERXONA_CONNECT_PASSWORD,
});

app.use(express.json({ limit: "25mb" }));

// Security headers (lightweight — no Helmet dependency needed).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Trust the Tailscale reverse proxy for correct req.ip.
app.set("trust proxy", true);

// Simple in-memory rate limiter for expensive proxy endpoints.
const rateBuckets = new Map();
function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = rateBuckets.get(key);
    if (!entry || now > entry.resetAt) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Mint a connect_token + expose the fixed-target config the client presenter needs.
app.get("/api/connect/config", async (_req, res) => {
  try {
    const token = await connect.mintBrowserToken();
    res.json({
      connect_token: token,
      presenterUrl: process.env.VITE_PRESENTER_URL || "",
      coach: {
        avatar_id: process.env.COACH_AVATAR_ID || "01KD2H4NWSZP4Y3CK8P3PSHTYP",
        scene_id: process.env.COACH_SCENE_ID || "01K4NYB6627539QRJR2HXESJJK",
        voice_id: process.env.COACH_VOICE_ID || "01KTBJGRFKWS029KQKQBC3318V",
      },
      practice: {
        avatar_id: process.env.PRACTICE_AVATAR_ID || "01KH0D8ZAZHZ762FV5SK3503ZR",
        scene_id: process.env.PRACTICE_SCENE_ID || "01K4NYBH42K727CZYGH6DC7Z2C",
        // P4 (ADR-0008): live Perxona ja voice for LLM-authored lines.
        voice_id: process.env.PRACTICE_VOICE_ID || "01KZFHK5FW671H7CX0Z6CMCV1R",
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// STT proxy: { audio_base64, mime_type } → { text }
app.post("/api/stt", rateLimit(20), async (req, res) => {
  try {
    const { audio_base64, mime_type, language } = req.body ?? {};
    if (typeof audio_base64 !== "string" || !audio_base64) {
      return res.status(400).json({ error: "audio_base64 is required" });
    }
    if (audio_base64.length > 15_000_000) {
      return res.status(413).json({ error: "audio too large" });
    }
    const buffer = Buffer.from(audio_base64, "base64");
    const result = await transcribeAudio(buffer, { mimeType: mime_type, language });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// BYO-TTS proxy: { text, voice?, language? } → 16 kHz mono WAV audio
app.post("/api/tts", rateLimit(30), async (req, res) => {
  try {
    const { text, voice, language } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    if (text.length > 2000) {
      return res.status(413).json({ error: "text too long (max 2000 chars)" });
    }
    const wav = await synthesizeSpeechWav(text.trim(), { voice, language });
    res.type("audio/wav").send(Buffer.from(wav));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Content: pre-authored scenario bundle (ADR-0002). Supports multi-scenario.
app.get("/api/content", (req, res) => {
  const scenario = typeof req.query.scenario === "string" ? req.query.scenario : MVP.scenario;
  const variant = typeof req.query.variant === "string" ? req.query.variant : MVP.variant;
  try {
    res.json(loadBundle(scenario, variant));
  } catch {
    res.status(404).json({ error: `scenario not found: ${scenario}/${variant}` });
  }
});

// Intake classifier (ADR-0005) — LLM-based with hardcoded stub fallback.
// For MVP, always returns dentist/a (single scenario), but the LLM path
// is wired for future multi-scenario support. POST { transcript }.
app.post("/api/classify", async (req, res) => {
  try {
    const { transcript } = req.body ?? {};
    const text = typeof transcript === "string" ? transcript : "";
    let llmResult = null;

    if (process.env.LLM_BASE_URL) {
      try {
        const scenarioList = SCENARIOS.map((s) => `${s.id} (${s.title})`).join(", ");
        llmResult = await chatJSON([
          {
            role: "system",
            content: `You are a phone-call practice intake classifier. Classify the learner's English request into a scenario. Available scenarios: ${scenarioList}. Also pick a variant (a, b, or c) based on the learner's described situation. Respond as JSON: {"scenarioId": "...", "variant": "a|b|c", "confidence": 0.0-1.0, "slots": {}}`,
          },
          { role: "user", content: `Learner said: "${text}"` },
        ], { timeoutMs: 5000, temperature: 0 });
      } catch (err) {
        console.log(`[classify] LLM failed: ${err.message}, using stub`);
      }
    }

    const scenarioId = llmResult?.scenarioId && SCENARIOS.some((s) => s.id === llmResult.scenarioId)
      ? llmResult.scenarioId : MVP.scenario;
    const variant = llmResult?.variant && ["a", "b", "c"].includes(llmResult.variant)
      ? llmResult.variant : MVP.variant;

    res.json({
      scenarioId,
      variant,
      confidence: llmResult?.confidence ?? 1.0,
      confirmed: true,
      note: "We'll practice making a dentist appointment.",
      slots: llmResult?.slots || { desired_time: null, today_or_not: null },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Turn Router (ADR-0006/0008) — blocking outcome + next-line decision.
// POST { nodeId, transcript, recoveryStage, scenario, variant, history }.
app.post("/api/route-turn", async (req, res) => {
  try {
    const { nodeId, transcript, recoveryStage = 0, scenario = MVP.scenario, variant = MVP.variant, history = [] } = req.body ?? {};
    if (typeof nodeId !== "string" || !nodeId) {
      return res.status(400).json({ error: "nodeId is required" });
    }
    const text = typeof transcript === "string" ? transcript.slice(0, 500) : "";
    const stage = typeof recoveryStage === "number" ? recoveryStage : Number(recoveryStage) || 0;
    const hist = Array.isArray(history) ? history.slice(-8) : [];
    const bundle = loadBundle(scenario, variant);
    const node = bundle.dialogue.nodes[nodeId];
    if (!node) return res.status(404).json({ error: "unknown node" });
    const result = await routeTurnP4({ bundle, node, transcript: text, recoveryStage: stage, history: hist });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// End-of-call Judge (ADR-0006) — non-blocking review. POST { turns: [...] }.
app.post("/api/review", async (req, res) => {
  try {
    const { turns = [] } = req.body ?? {};
    if (!Array.isArray(turns)) {
      return res.status(400).json({ error: "turns must be an array" });
    }
    res.json(await reviewCall(turns.slice(0, 100)));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Serve the built frontend (single container) if present, with SPA fallback.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../../app/dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

// Global error handler — ensures JSON (not HTML) on unhandled throws.
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[tagteam2] server on :${PORT}`);
});
