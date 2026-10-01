# Research: inference cost, CLM, and free public hosting (2026-10-01)

**Status: planning only. Nothing here is decided or implemented.** The goal of the session was
to understand the *size* of the problem. No code was changed.

## Questions asked (user, this session)

1. How might the CLM classifier (`Contrastive-LM/CLM-v0.1-8B`) reduce running cost, given Gemma 4
   currently handles unpredictable input?
2. Find a **free** way to host the POC publicly.
3. The product may later run **without the homelab**; inference must be as cheap as possible.
   Re-think the CLM conclusion with that in mind.
4. Public hosting via Tailscale Funnel (option A) or Cloudflare tunnel (B) is unacceptable: the POC
   was not built with security as a requirement and it risks the internal network.
5. Perxona is free for a year (lowest tier, hackathon award) — **until July 2027**.

## Source legend (per AGENTS.md sourcing discipline)

- **[user]** stated by the user this session
- **[code]** read directly from this repo (path:line)
- **[kit]** read directly from `/Users/jon/Documents/repo/Perxona/perxona-connect-kit`
- **[web]** web search result (secondary, unverified against the vendor; prices/limits drift)
- **[card]** CLM model card, fetched via a summarizing tool (not read raw — verify before relying)
- **[est]** my estimate/assumption — not measured

## 1. Where LLM calls happen today [code]

All go through `server/src/llm.mjs` `chatCompletion`/`chatJSON`: an **OpenAI-compatible**
`/chat/completions` client driven by `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
(default model string `granite3.3-8b`; PLAN §9 says `gemma4-26b-a4b-nothink` is in use,
~0.4–0.9 s per strict-JSON call, measured 2026-08-29).

| Call | Site | Frequency | Timeout | Needs generation? |
|---|---|---|---|---|
| P4 Turn Router (blocking) | `rules.mjs` `routeTurnP4LLM` | every turn (5–8 per call [est]) | 12 s | Yes — authors next ja line, romaji, en, hint, emotion, `justCollected` |
| Judge | `rules.mjs` `reviewCallLLM` | once per call | 30 s | Yes — English notes + corrections |
| Intake classifier | `index.mjs` `/api/classify` | once per session | 5 s | No (label), but currently a stub (single scenario) |
| Legacy graph router | `rules.mjs` `routeTurnLLM` | fallback path | 3 s | No (classification) |

Already-free deterministic guards (no LLM): `isForeignScript`, `looksLikeEnglish`,
single-word-English STT-noise rule, authored-graph fallback (`routeTurnDeterministic`).

The P4 system prompt is large and mostly static (persona, brief, rules, rubric); the dynamic parts
(history slice of 10, collected summary, date reference, transcript) are in the user message. The
prompt contains many rules patching past failures (STT noise, re-asking collected slots, date
handling). The model returns romaji and English for each line in addition to Japanese.

## 2. CLM [card]

- Two small projection heads (state head + action head) on a **frozen Qwen3-8B** encoder, trained
  with bidirectional InfoNCE.
- **Scores candidates you supply** (typed questions with predefined answers, or free-form
  candidate lists); **no text generation**.
- Targets computer-use / gaming / tool-calling / agentic verification; card claims large latency
  wins vs. competitors, and says specialized tasks need fine-tuning.
- Apache 2.0; encoder-locked to Qwen3-8B; serving needs vLLM.
- **Not found on the card:** any evidence on Japanese or noisy STT transcripts.

### Conclusion (re-checked after the no-homelab requirement)

CLM **does not pay off** for this workload at plausible scale:

- It can only replace the *classification* slices (outcome label, slot extraction, intake). The
  expensive part — authoring Japanese lines and the Judge review — still needs a generator.
- Gemma 4 26B-A4B has ~4B active parameters [est from model name], so CLM's dense-8B forward pass
  is not cheaper per token; the only saving is skipping decode.
- Hosted per-token inference is already ~0.3¢ per practice call (§4). An always-on 8B GPU is a
  fixed cost of hundreds of dollars/month [est], i.e. break-even only around 100k+ calls/month, and
  CLM displaces just part of the spend. Serverless GPU adds cold-start latency on a blocking path.
- Revisit only at hundreds of thousands of calls/month. A ~100–300M multilingual encoder, or
  single-token outcome labels from the existing LLM (logprobs/constrained decoding), would capture
  most of the benefit with less infrastructure.

## 3. Cheaper-than-CLM levers (ranked, none implemented)

1. **Prompt/prefix caching** — the static system block repeats every turn.
2. **Romaji via a library** (e.g. kuromoji/wanakana) instead of model output — cuts an estimated
   quarter of output tokens [est]. (Not checked how much of the UI depends on model-written romaji.)
3. **Trim the router prompt** — move failure-patch rules into code, as `isForeignScript` already is.
4. **Single-token outcome classification** with the existing LLM.
5. **Skip the generator on noise/unclear turns** — replay `lastAvatarLine` / authored
   `unclear_reask`. Do **not** use authored hint/help here: a stale authored node is a known bug
   under ADR-0008.
6. **Judge** — shorten/skip for clean calls (small win; once per call).

## 4. Pricing gathered [web] and the cost model [est]

Prices (search results, Oct 2026; verify before budgeting):

- **Gemma 4 26B A4B** hosted, per 1M tokens in/out: Cloudflare $0.10 / $0.30; DeepInfra
  $0.07 / $0.34; Parasail $0.13 / $0.40. Blended range across 7 providers $0.10–$0.70. Providers
  listed: Cloudflare, DeepInfra, Google AI Studio, Parasail, Novita, GMI, Clarifai.
- **Groq Whisper large-v3-turbo**: $0.04 per audio hour, 10-second minimum billing per request;
  free plan reported at 2,000 transcription requests/day; same price for Japanese.
- **Gemini Flash-Lite** paid input $0.10/M; free tier reported variously as 15 RPM / 1,000 RPD or
  30 RPM / 1,500 RPD (sources disagree — quotas changed during 2026). Pro models off the free tier
  since 2026-04-01. *Caveat (general knowledge, not in these sources):* Google's free tier may use
  prompts for training.

Cost model per practice call — **assumptions, not measurements**: 7 turns; avg router prompt
2.5k tokens (~17k in, ~1.7k out total); Judge+Intake ~2k in / ~0.8k out combined; STT 7 × 10 s
billing minimum.

| Piece | ≈ cost |
|---|---|
| Router (Cloudflare rates) | $0.002 |
| Judge + Intake | $0.0005 |
| STT (Groq) | $0.0008 |
| **Total** | **≈ $0.003–0.004 / call** (~$35/month at 10,000 calls) |

**Replace these estimates with real numbers** (§9, spike 2).

## 5. Free public hosting options [web, code, user]

Constraint [code]: the backend calls `stt.` / `tts.` / LLM hosts on the **tailnet**
(`providers.mjs` defaults `*.mango-rockhopper.ts.net`), so any off-homelab host needs those
swapped to hosted providers.

| Option | Cost | Status |
|---|---|---|
| A. Tailscale Funnel sidecar (used 2026-09-12 demo) | Free | **Rejected [user]** — public app on the homelab |
| B. Cloudflare Tunnel from Core | Free (stable URL needs a domain) | **Rejected [user]** — same exposure |
| C. Render free web service + hosted APIs | Free [web: 512 MB, 750 h/mo, cold starts] | **Preferred** — nothing public touches the homelab |
| D. Oracle Cloud Always Free VM | Free [web: up to 4 OCPU / 24 GB; card needed; capacity scarce] | Alternative |
| Koyeb | [web] free instance requires a card since Feb 2026 | Not evaluated further |
| Fly.io | [web] 2-hour/7-day trial only for new customers | Ruled out |

Free-tier terms were not read from the vendors' own pages. For the earlier Funnel work, see
memory `project_docktail_funnel_pattern` (isolated `tag:funnel` sidecar; `tag:funnel` ACL left in
place).

## 6. Security exposure of a public deployment

**Why A/B were dropped [user + code]:** the container holds the Perxona credentials and a route to
tailnet services; any bug in a public Node app is a path toward them.

Findings from `server/src/index.mjs` and `connect-client.mjs`:

- **Perxona token leak [code + kit]:** `mintBrowserToken()` returns the cached account login token
  unchanged (`connect-client.mjs:93`); `/api/connect/config` (`index.mjs:66`) serves it to any
  caller. The connect-kit docs state the token is "a real bearer credential for the shared
  identity" once in the browser and that the sample is "not multi-tenant"
  (`AGENTS.md:51`, `samples/express/README.md:99–102,371`). **Every public visitor would hold a
  bearer token for the whole Perxona account.** Scope of what that token can reach was **not
  determined**; no scoped/publishable token was found in the kit docs.
- **No auth** on any route.
- **Rate limits only on `/api/stt` (20/min) and `/api/tts` (30/min)**; `/api/classify`,
  `/api/route-turn`, `/api/review` (LLM) are unmetered. (In-memory limiter, `index.mjs:44–61`.)
- `express.json({ limit: "25mb" })` globally (`index.mjs:32`).
- Env secrets present (names only): Perxona base URL + email + password, LLM/STT/TTS endpoints,
  avatar/scene/voice IDs.

## 7. Perxona [user, kit]

- Free until **July 2027**, lowest tier [user]. Removes the avatar from POC cost; **post-July cost
  is unknown** and may exceed all inference combined [est].
- Lowest-tier **quota is unknown**; no second free account to isolate a public POC [user implied].
- PLAN §4 already notes upstream `initialize(connectToken, …)` is deprecated and keys are
  expected; adopting keys would retire the refresh cycle and might fix the token-scope problem.

## 8. Sizing (planning, [est])

Safe public POC ≈ **3–5 days** if the model stays Gemma 4; risk sits in three external unknowns.

| Workstream | Size |
|---|---|
| App hardening (passcode gate, limits on all routes, body limit, kill switch, per-token session cap) | S, ~1 day |
| LLM off homelab | S (same hosted Gemma) / M (different model: re-tune prompts, re-check ja quality) |
| STT off homelab | M — Whisper on beginner Japanese; short-utterance hallucinations |
| Live TTS | S + decision — only unbaked-line fallback and Review dynamic drill need it |
| Hosting + deploy | S — Dockerfile exists; `DEPLOY.md` is Core-specific |
| Perxona token exposure | Unknown |

Recurring: POC $0 on free tiers (with quota limits); product ≈ $0.003–0.004/call for LLM+STT
[est]; Perxona after July unknown.

## 9. Open unknowns and cheapest next spikes (hours, not days)

1. **Ask Perxona:** scoped/publishable token for the presenter? lowest-tier quota?
2. **Measure real tokens/call** and the `[router] P4 LLM:` outcome mix from the Core container
   logs (replaces §4 assumptions; shows how many turns are noise/repeat).
3. **Replay logged turns** through hosted Gemma and Groq STT to compare Japanese/STT quality.
4. Read vendors' own current free-tier terms (Render, Groq, Cloudflare, Google) — §4/§5 come from
   third-party summaries.
5. Confirm CLM card details directly if CLM is ever reconsidered.

## Sources [web]

- Gemma 4 26B A4B pricing — https://pricepertoken.com/pricing-page/model/google-gemma-4-26b-a4b-it
  (also surfaced: deepinfra.com/blog/gemma-4-pricing-benchmarks-cost-scenarios,
  openrouter.ai/google/gemma-4-26b-a4b-it, computeprices.com/models/gemma-4-26b-a4b-it)
- Gemini API free tier limits — https://www.scriptbyai.com/gemini-api-free-tier-limits/
  (also: pricepertoken.com/endpoints/google-ai-studio/free)
- Free Docker hosting 2026 — https://flywp.com/blog/9769/best-free-docker-hosting-platforms/
  (also: snapdeploy.dev/blog/free-docker-hosting-2026-platforms-compared,
  render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- Groq speech-to-text — https://console.groq.com/docs/speech-to-text
  (price figures via cloudzero.com/blog/groq-pricing and apio.sh/apis/groq-speech-to-text)
- CLM model card — https://huggingface.co/Contrastive-LM/CLM-v0.1-8B (via summarizer)
