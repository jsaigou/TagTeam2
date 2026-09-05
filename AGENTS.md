# TagTeam2 — Agent Operating Rules

TagTeam is a Japanese phone-call practice app for English speakers, built on the Perxona
avatar system. This repo (`TagTeam2`) is a **greenfield redesign** after a failed prior
attempt. These rules exist to keep this attempt on the rails.

## Critical: sourcing discipline (do not contaminate the design)

- The OLD `/Users/jon/Documents/repo/TagTeam` repo is the failed prior attempt. The user has
  granted a **narrowed exemption**: we MAY read it for **concrete reference facts** — color
  scheme, API keys, server addresses. We must NOT copy/be influenced by its **layout or page
  design** (that is what sank the prior attempt).
- **You MAY read the Perxona repo** (`/Users/jon/Documents/repo/Perxona/perxona-connect-kit`)
  — that is the SDK reference and is legitimate.
- **Source every claim in project docs** to one of: (a) user statements in this session,
  (b) the Perxona connect-kit read directly, (c) a live probe, or (d) an old-repo reference
  fact (color/API-key/server-address only). If a "fact" only comes from session-recall about
  the old repo, treat it as **unverified — MEASURE IN S0**, never as established fact.
- The old repo's layout/design used to contaminate agents; treat any design claim about the old
  repo as **off-limits**, not a source.

## Project state (facts established in this session)

- **Framework:** React 19 + TS + Vite + Tailwind + shadcn (frontend), thin Express (Node ≥22)
  backend — mirrors Perxona's own `tools/motion-browser` reference app.
- **Perxona integration:** `<sv-presenter>` web component from CDN; fixed-target config
  (26-char ULID asset IDs); server mints `connect_token`; `resumeAudioPlayback()` must run
  from a direct user gesture. See `PLAN.md` §4.
- **Audio:** BYO-TTS **prerender-first** (ADR-0004), cached per line × voice; Prep examples
  play directly, not through the presenter (ADR-0009 — the old `presentWithAudio()` lip-sync
  path is pruned). P4 (ADR-0008) scopes prerender to **Prep only**; practice uses the
  live Perxona voice for LLM-authored lines.
- **Flow:** Intake (conversational, LLM classifies scenario+slots) → Prep (Luna reads the
  English; Japanese plays on two BYO-TTS voices, direct playback, tap card to replay —
  ADR-0009) → Practice (blocking LLM Turn Router with
  authored-graph fallback + end-of-call Judge, ADR-0008) → Call Review (post-call
  corrections; never replay learner's voice).
- **Two distinct functions, do not conflate:** Turn Router (blocking; decides the outcome
  and authors the avatar's next line — LLM-driven with authored-graph fallback per
  ADR-0008) vs Judge (end-of-call performance review). See ADR-0006/0008.
- **Hero S0 spike is approved** (see PLAN §11): scaffold + present + STT + BYO-TTS verify.
  Content authoring waits until the design is firm.

## Plans & docs

- `PLAN.md` — durable v1 plan (living).
- `CONTEXT.md` — domain glossary (Luna, Meeks, Scenario, Variant, Prep Line, Slot, Intake,
  Turn, Clause, Filler, Judge, Turn Router, Call Review, Prep, Practice).
- `docs/adr/` — decision records (0001–0008).

## Delivery workflow (user direction, 2026-09-05)

- A **phase** is a coherent set of sprints achieving one goal. **Mid-phase** sprint work is
  left uncommitted for the user's review. **Phase end** ⇒ commit (house style, no AI
  attribution), push to `origin/main`, deploy to Core per `DEPLOY.md`, and verify health
  both in-container and through `https://tagteam2.mango-rockhopper.ts.net` before declaring
  the phase done.
- Do not conflate with the app's screen phases (Welcome / Intake / Prep / Practice /
  Review) — that term in `CONTEXT.md` and the UI is product-domain, not delivery.

## MVP scope discipline

Thin vertical slice: 1 scenario × 1 variant first. **Do not add** user auth, databases,
WebSocket hubs, phone pairing, document upload/scanner, vocab/help systems, or per-call
customization to the MVP. Those are (or resemble) what sank the prior attempt.
