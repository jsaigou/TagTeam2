# TagTeam

**Sound confident before you dial.**

TagTeam is a Japanese phone-call rehearsal app for English speakers. Tell **Luna** — a live
avatar coach — what call you need to make; she drills you on the key sentences, read aloud in
two voices, then you place the call and she plays the person on the other end. When it's over
you get a per-turn review of your polite です/ます register, in English.

Built on the Perxona avatar system, with a thin Express backend and a React 19 frontend.

## How a session runs

| Phase | What happens |
|---|---|
| **Welcome** | Tell Luna what call you need — type it, tap a common call, or talk. |
| **Intake** | An LLM classifier matches your goal to one of 5 Scenarios × 3 Variants each. |
| **Prep** | Luna teaches the variant's 20-line sentence library; every line plays in two pre-baked voices (female, then male), and any card replays on tap. |
| **Dial → Practice** | A synthesized ringback tone hands off to the Roleplay Avatar. A blocking LLM Turn Router authors its live lines against a Persona Directive + Scenario Brief, with an authored dialogue graph as the deterministic fallback. |
| **Review** | The Judge grades every turn's teineigo (です/ます) register after the call ends and hands back corrections in English — your own voice is never replayed. |

`CONTEXT.md` has the full glossary behind these terms.

## Content

- **5 scenarios** — dentist, doctor, restaurant, lost card, redelivery
- **3 variants each** (15 total) — same goal, different appropriate vocabulary
- **20 curated prep lines per variant**, pre-rendered in 2 voices — 600 static clips, so Prep
  never waits on a live TTS call in the normal path (`server/scripts/render-prep-audio.mjs`)
- Every scenario has been reality-checked against how the call actually goes in Japan
  (see `PLAN.md` §6)

## Stack

| | |
|---|---|
| Frontend | React 19 + TypeScript + Vite + Tailwind (`app/`) |
| Backend | Thin Express, Node ≥22 (`server/`) |
| Avatar | Perxona `<sv-presenter>` web component — renders both Luna and the Roleplay Avatar |
| Practice dialogue | Blocking LLM Turn Router (ADR-0008) authors live lines; an authored dialogue graph is the deterministic fallback |
| Grading | End-of-call Judge scores teineigo (です/ます); keigo tips are optional, never a failure |

## Running it

```sh
# Backend (Node ≥22) — needs server/.env for Perxona / STT / TTS / LLM creds
cd server && npm install && npm run dev        # :8787

# Frontend — proxies /api to :8787
cd app && npm install && npm run dev

# Tests
cd server && npm test
```

## The docs that matter

| Doc | What's in it |
|---|---|
| `PLAN.md` | The durable v1 plan and sprint log |
| `CONTEXT.md` | Domain glossary — Luna, Meeks, Scenario, Variant, Turn Router, Judge, … |
| `docs/adr/` | Decision records (ADR-0001 … ADR-0012) |
| `DEPLOY.md` | How this reaches the homelab (`tagteam2` on Core) |
| `AGENTS.md` | Operating rules for agents working in this repo |
