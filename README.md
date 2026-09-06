# TagTeam

**Sound confident before you dial.**

TagTeam is a Japanese phone-call practice app for English speakers. Tell **Luna** — a live
avatar coach — what call you need to make; she preps you on the key sentences, read aloud in
two voices, then you place the call and she plays the person on the other end. When it's over
you get a per-turn review of your polite form (です /ます), in English.

Built on the Perxona avatar system, with a thin Express backend and a React frontend.

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

- `PLAN.md` — the durable v1 plan and sprint log
- `CONTEXT.md` — domain glossary (Luna, Meeks, Scenario, Variant, Turn Router, Judge, …)
- `docs/adr/` — decision records
- `DEPLOY.md` — how this reaches the homelab (`https://tagteam2.mango-rockhopper.ts.net`)
- `AGENTS.md` — operating rules for agents working in this repo
