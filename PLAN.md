# TagTeam — Durable Plan (v1)

> **Status:** Living document. Code review (2026-08-29) identified 43 findings
> (5 critical, 15 significant, 23 minor) between the ADR-locked design and the P1
> implementation. S0 spike and P1 vertical slice remain as historical milestones.
> **Sprints 1–5 COMPLETE** — all 43 findings addressed.
> **P2 COMPLETE** — 5 scenarios × 3 variants = 15 content bundles authored, server
> supports multi-scenario selection via LLM intake classifier.
> **P3 COMPLETE** — manual stop button, responsive layout, Call Review grade badges,
> deployed to homelab (tagteam2 on Core). TTS/STT/content APIs verified live.
> (2026-08-29: Connect 401 note resolved — credentials refreshed and verified live.)
> Verification: TypeScript strict clean, oxlint 0/0, 82 server tests pass, build succeeds.
> **P4 COMPLETE (2026-08-30)** — LLM-driven practice dialogue (ADR-0008): blocking LLM Turn
> Router authors the avatar's Japanese lines (persona directive + brief + history) with the
> authored graph as silent fallback; practice avatar speaks on a live Perxona ja voice
> (`PRACTICE_VOICE_ID`); "Practice again" re-enters the call directly ("Start over" does the
> full reset); content band below the stage is independently scrollable so controls are
> always reachable. Deployed to homelab; live router verified on off-script utterances
> (source: llm, ~1–2s), fallback drills covered by tests.
> **Presenter contract pass (2026-09-05)** — `@perxona/presenter-types@0.3.0` adopted
> (hand-rolled presenter subset replaced, §4); `setListening` wired across the learner's
> record → transcribe → route window in practice + intake (both avatars probed: listening
> assets present — the practice avatar's is a chin-thinking pose — no thinking assets, so
> `setThinking` stays unwired); LLM router lines carry an optional catalog-validated
> `emotion` → `present()` facial expressions (fallback lines carry none); `speakText`
> fails fast on unsuccessful `PresentationResult`. Live smoke: real-homelab router returned
> caring / confusion / gratitude on the on-script / English-rejection / closing cases
> (~1.5s each). Verification: 86 server tests, tsc strict + oxlint 0/0 + build clean.
> **Content realism pass (2026-09-05)** — dentist reworked against a user-verified reality
> check (reason → first-visit → patient ID for returning patients → name → specific
> date+time confirmation → first-visit instructions); variants repurposed to toothache /
> cleaning / fallen filling; Prep lines now scenario-specific only (generic greetings and
> time-slot lines dropped — the call teaches those); authoring rubric + `reality_check`
> gate added (PLAN §6; the other four scenarios carry draft reality checks for phase 2);
> practice voice fixed — female `01KZFHK5FW671H7CX0Z6CMCV1R` → male
> `01KZFHK5FX4D4CFVKN9TXAJSBW` ("Male – calm and approachable") matching the male role
> avatar; router prompt injects today's date (Asia/Tokyo) for real-date confirmations.
> **Content realism phase 2 (2026-09-05)** — rubric applied to the remaining four
> scenarios, all reality checks now user-verified: doctor (symptom+since-when → first
> visit → name → date+time confirm; insurance card is counter-only guidance per user
> correction, never a phone question), restaurant (party size → date/time → name → phone →
> seat/course+allergy check, 15-min hold; variants table/anniversary+cake/宴会+budget),
> lost-card (situation → name+DOB+last-4 verification → irreversible cancellation →
> ~1-week reissue; stolen variant adds a 遺失届 police-report branch), redelivery (tracking
> number → name+address → time-window menu → date+window confirm; variants 不在票/address
> change/never arrived). Live smoke: scripted calls across all four — every required
> question asked, confirmations on correct real dates, 15/15 bundles edge-valid.
> **Call ritual + review host (2026-09-05)** — practice now opens on a Dial button: a
> synthesized Japanese ringback tone (WebAudio, no asset) masks the presenter re-init, the
> far side "answers" with the authored start line, and the conversation runs hands-free on
> a zero-dependency browser VAD (energy-based, rolling MediaRecorder, half-duplex — paused
> while the avatar speaks; Intake keeps push-to-talk). On call end the presenter swaps
> back to Luna, who speaks the review in English (lead-in + Judge overall; the Judge runs
> in parallel and the written cards always render).
>
> Companion docs: `CONTEXT.md` (domain glossary), `docs/adr/` (decisions),
> `DEPLOY.md` (per-version deploy runbook). The scenario content schema is defined
> by the JSON bundles in `content/` and the TypeScript types in
> `app/src/lib/api.ts`. See §6.

## 1. What we're building

TagTeam helps **English speakers in Japan** practice making **phone calls in Japanese**,
using the **Perxona** avatar system. A guide avatar (“**Luna**”, the `meeks` avatar, shown
as a small window while coaching) walks the learner through an intake conversation, then
teaches them 3–5 key sentences for a specific call, then role-plays the call against a
full-screen avatar playing the person on the other end.

This is a **greenfield redesign** after a failed prior attempt. The MVP is deliberately a
**thin vertical slice** to avoid the feature sprawl that sank the old version.

## 2. Locked decisions (see ADRs)

| # | Decision | ADR |
|---|----------|-----|
| D1 | React 19 + TS + Vite + Tailwind + shadcn (frontend), thin Express ≥22 backend | `adr/0001` |
| D2 | Content is pre-generated/durable; never generated live | `adr/0002` |
| D3 | Vertical slice first (1 scenario × 1 variant) | `adr/0003` |
| D4 | Audio: BYO-TTS **prerender-first** for known outcomes, live Perxona voice as fallback / for ad-hoc lines | `adr/0004` |
| D5 | Homelab STT (`stt.mango-rockhopper.ts.net`) for both English intake and Japanese practice | — (provider abstraction) |
| D6 | Intake selection is conversational: Luna elicits goal → LLM classifies to scenario + slots | `adr/0005` |
| D7 | Practice: blocking Turn Router + end-of-call Judge; router is LLM-driven with authored-graph fallback (P4 supersedes the state-machine source) | `adr/0006`, `adr/0008` |
| D8 | “Luna” is an app-level display name for the `meeks` avatar resolved via fixed-target config (not a Perxona concept) | — (naming) |
| D9 | At most one live `<sv-presenter>` at a time | — (cost/constraint) |

### 2.1 Reference facts — pulled from the OLD repo (user-approved, do not treat as design)

The user granted a **narrowed exemption** to read the old `TagTeam` repo for concrete
reference facts only. These are **source (d): old-repo reference facts**. They inform the
S0 spike but are independent of the old repo's layout/design (which is off-limits).

- **Perxona Connect API base (Asia):** `https://console.perxona.ai/asia`
- **Homelab LLM (server-side, proxied):** `https://a0.mango-rockhopper.ts.net/v1`
- **Homelab TTS (BYO-TTS / Qwen instance):** `https://tts.mango-rockhopper.ts.net/v1`
  (API key optional on the tailnet). Source: old `.env.example`.
- **Homelab STT:** `https://stt.mango-rockhopper.ts.net` — **RESOLVED in S0 (live probe).** It is a
  **hosted OpenAI-compatible** service (NOT whisper-cpp — the old whisper default never ran in
  prod). Confirmed route: `POST https://stt.mango-rockhopper.ts.net/v1/audio/transcriptions`
  (multipart `file` + `model` + `language=ja` + `response_format=json`) → `{ text }`. Old prod
  set `STT_PROVIDER=hosted → stt.mango-rockhopper.ts.net` (AGENTS.md:240), and a live POST of a
  synthesized clip returned `{"text":"始めまして大和"}` HTTP 200.
  **Model: `nvidia/nemotron-asr` (Nemotron ASR)** — user-confirmed 2026-08-30; replaces the
  S0-era `whisper-1` placeholder. Live probe shows the service ignores the `model` field
  (single-model backend; a bogus name still transcribes), so the value only matters for logs.
- **Color scheme (shadcn CSS vars, sage/forest + cream):** light — background `#f2e8cf`,
  foreground `#1f2a1f`, primary `#386641`, accent `#a7c957`, muted `#e7e3d0`/`#6b7a63`,
  destructive `#bc4749`, ring `#6a994e`; dark — background `#1a241a`, card `#22301f`,
  primary `#a7c957`, accent `#6a994e`, border `#3a4a36`. This is a reference the user may
  adopt/adapt, not a design mandate.
- **Perxona Connect credentials (email/password)** and **fixed-target asset IDs** live in the
  old repo `.env` + presets; the MVP server reuses the SAME Connect identity (migrate the
  email/password into our gitignored `.env`, never commit). Token mint: `POST
  /api/v1/connect/auth/login` → `access_token`, cached + auto-refresh on 401/403 (pattern in
  old `server/connect-client.mjs`).
- **Asset IDs (old presets.ts, verified against live catalog):** Luna/guide avatar (cc051_meeks)
  `01KD2H4NWSZP4Y3CK8P3PSHTYP`; practice waiter role (cc066_male_waiter)
  `01KH0D8ZAZHZ762FV5SK3503ZR`; coach scene (sova_anime_1) `01K4NYB6627539QRJR2HXESJJK`;
  practice scene (sova_anime_2) `01K4NYBH42K727CZYGH6DC7Z2C`; guide voice (Female-cute-fast,
  English-capable) `01KTBJGRFKWS029KQKQBC3318V`. Old role-packs are municipal-office
  (reception/claims/accounts) — NOT our dentist MVP; we may need a dentist-appropriate role
  avatar/scene or reuse the defaults.
- **BYO-TTS:** Qwen/kokoro instance `tts.mango-rockhopper.ts.net/v1`, model `kokoro-82m`,
  voice `ruu` (demo); BYO audio must be **16 kHz mono WAV** (the presenter codec contract);
  old config normalizes via ffmpeg.
- **Ja voices + persona directives (old `src/shared/coaching.json`, ids verified against the
  live catalog at the time):** reception pack voice `01KZFHK5FW671H7CX0Z6CMCV1R` (claims
  `01KZFHK5FV530D234HJ3PSWY3V`, accounts `01KZFHK5FX4D4CFVKN9TXAJSBW`) and per-role Japanese
  **persona directives** (role, register, stock openings) — the reference pattern for P4's
  practice voice (`PRACTICE_VOICE_ID`, re-verify live) and LLM persona prompts.
  **PRACTICE_VOICE_ID (2026-09-05):** `01KZFHK5FX4D4CFVKN9TXAJSBW` — "Male – calm and
  approachable" (azure, ja), matching the male role avatar; the previous
  `01KZFHK5FW671H7CX0Z6CMCV1R` was **female** ("steady and approachable"), an audible
  mismatch on the male waiter avatar (all five scenarios share it, so one voice fixes all).
- **TTS voice catalog (live probe 2026-08-29):** `GET {TTS_BASE_URL}/voices` — 67 voices.
  ja kokoro: `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`, `jm_kumo` (fast),
  `ruu` (premium). qwen-tts premium voices (`susan`, `bert`, `lauren_us`, `nathan_us`,
  `onlyfans`) synthesize Japanese **only when the `language` param is omitted** (500 with
  it). User-chosen demo BYO voice: `susan`.
- **Homelab LLM models (live probe 2026-08-29):** `granite3.3-8b` does NOT exist on the
  host; available include `gemma4-26b-a4b-nothink` (in use; ~0.4–0.9s per strict-JSON call),
  `qwen3.6-flash`, `carbon-8b`, `qwen3-swallow-8b`, `swallow-32b`.
- **Explicitly OUT of scope (do not add to MVP):** SEARXNG, Firecrawl, document scan/upload,
  OpenCV, VAD silero are all artifacts of the old version's sprawl. Ignore.

## 3. Architecture

```
app/      # React 19 + TS + Vite + Tailwind frontend (desktop + mobile responsive)
server/   # Express (Node ≥22, ESM) — thin backend
content/  # Pre-authored scenario content bundles (JSON)
docs/     # Plan, ADRs, CONTEXT.md, content model
```

**Server responsibilities (kept thin):**
- `GET /api/config` → `{ presenterUrl, sttUrl, voiceMode, defaults, fixedTarget, flags }`
- `GET /api/connect-token` → mints/refreshes the Connect JWT (shared service account; auto re-login on 401/403)
- `GET /api/avatars` · `/api/scenes` · `/api/voices` · `/api/avatars/:id/motions` → catalog reads (setup/verify only)
- `POST /api/transcribe` → forward audio to homelab STT; return transcript + language
- `POST /api/classify` → intake LLM classifier
- `POST /api/route-turn` → Turn Router (blocking next-line decision)
- `POST /api/review` → end-of-call Performance Review (Judge) for Call Review
- Static serving of built `app/`; `GET /api/health`

**Deliberately excluded from the MVP:** user accounts/auth, database, WebSocket hubs,
phone pairing, document upload/scanner, vocab/help systems. Sessions are transient
in-memory on the client.

## 4. Perxona integration facts (the load-bearing constraints)

- `<sv-presenter>` is a whole-scene web component loaded from the CDN
  (`PRESENTER_URL`, e.g. `https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js`).
  It renders the avatar **and** the scene; sized by CSS (windowed vs full-screen).
- Avatars/scenes/voices/motions are catalog assets keyed by **26-char ULIDs**. Production
  pattern is **fixed target** (`DEMO_FIXED_AVATAR_ID` / `SCENE_ID` / `VOICE_ID`), no pickers.
- The presenter JS API — contract supplied by `@perxona/presenter-types` (exact-pinned
  devDependency `0.3.0`, type-only; adopted 2026-09-05 replacing the hand-rolled subset in
  `app/src/lib/presenter.ts`. The package tracks the CDN contract — re-pin deliberately,
  never `^`):
  - `initialize(connectToken, { avatarId, sceneId, voiceId? })` — **deprecated upstream** in
    0.3.0 in favor of `initializeWithConnectKey` (scoped, origin-restricted, revocable
    `X-Connect-Key`; no rotation cycle). Key provisioning is **not yet documented**
    (handbook + Connect OpenAPI still Bearer-JWT-only), so we keep `initialize` +
    `refreshConnectToken`. **Watch item:** adopt keys when Perxona ships management — that
    retires the `CONNECT_TOKEN_EXPIRED` → refresh cycle.
  - `resumeAudioPlayback()` — **must run from a direct user gesture** (autoplay policy)
  - `present(content, { emotion?, intensity? })` — synthesize+speak (needs a voice, or it's
    BYO-TTS). `emotion` (13-value `EmotionCategory`) / `intensity` drive backend
    **facial-expression** selection; omitted ⇒ body motions only.
  - `playMotion(motionId)` — whole-body pre-recorded clip, independent of speech
  - `interruptPresentation()` · `updateCameraAngle('halfbody'|'fullbody')` · `updateCameraFOV()`
  - `refreshConnectToken(token)` · `setListening()` / `setThinking()` / `muteAudio()` —
    Listening/Thinking render **only if the avatar has those motion assets** (else no-op).
    Live probe (2026-09-05): both our avatars have `category:listening` (the practice
    avatar's is a chin-thinking pose); **neither** has `category:thinking` ⇒ we wire
    `setListening` only.
  - Events: `PRESENTER_STATUS`→`Ready`, `PERFORMANCE_END`, `ALL_PERFORMANCE_FINISHED`,
    `PLAYING_SPEECH_TEXT`, `CONNECT_TOKEN_EXPIRED`
- `present()` **queues** and never rejects — it resolves a `PresentationResult`; `success ===
  false` (e.g. `VOICE_NOT_CONFIGURED`, `PRESENTER_NOT_READY`) means nothing will play, so
  `speakText` throws on it instead of waiting out the 60s finish timeout.
- `presentWithAudio(audioBuffer, transcript)` remains in the contract but is unused — BYO
  audio plays directly (ADR-0009); the client path was pruned 2026-08-30.
- Voices have `languages`. No `voice_id` ⇒ BYO-TTS mode (`speech_format: unknown`).

Reference implementation to adapt: Perxona’s own `tools/motion-browser` React app
(`src/lib/presenter.ts` loader + `src/hooks/use-presenter.ts`) — mirror it.

## 5. Screens & flow

### 5.1 Welcome / Intake
- Landing with a clearly-named **Start** button.
- Start click ⇒ `resumeAudioPlayback()` (the required gesture) ⇒ Luna (windowed,
  half-body) greets bilingual and asks an open question: *“What phone call would you like
  to practice today?”*
- User **speaks in English** (homelab STT) or types. Luna asks a couple of clarifying
  turns (name, time, details).
- **MVP scope:** selection is a **stub** — for now Luna mainly **confirms** the scenario
  (the vertical slice is a single dentist scenario), keeping the conversation conversational
  and warm. Full multi-scenario selection is post-MVP.
- **If the classifier is unsure**, pick the **closest** scenario and **tell the learner
  explicitly** that the closest match is being used (no surprise). A future semantic layer
  generates new scenarios on-the-fly to grow the library of responses + pregenerated audio.
- LLM classifier maps the conversation → scenario + slots; Luna confirms: *“Got it — let’s
  get you ready.”* → advance to Prep.

### 5.2 Prep — key sentences, two BYO-TTS voices
- Luna starts **top-left** (windowed presenter). All example cards listed on the page.
- Choreography loop (client state machine in `Flow.tsx`):
  1. Luna opens: **“Now let’s practice some key vocabulary.”** (her own Perxona voice).
  2. For each line, the active card gets an **underglow** while its section plays:
     - Luna **reads the English explanation** aloud (her own voice).
     - The **Japanese plays twice as plain audio** — homelab BYO-TTS, female voice
       (`lauren_us`) then male (`bert`), **not spoken by Luna** (no presenter/lip-sync).
     - **0.5-second pause** between the two readings; **2-second pause** before the next line.
  3. Next line → repeat (**5 lines** per scenario).
- After the last: **“Ready to practice? Tap a line to hear it again, or continue.”** Ready
  advances. For an on-demand repeat the learner **taps the example card itself** (plays once,
  female voice; card underglow while playing) — learner-driven, not a bulk “more practice” loop.
- Each line shown as **kanji + romaji + English** (audience can’t reliably read Japanese).

### 5.3 Practice — roleplay call (blocking LLM router per ADR-0008; routing is NOT the same as judging)
- Switch to **full-screen presenter** with the location’s avatar + an appropriate scene.
- **Call ritual (2026-09-05):** practice opens on a **Dial** button. Pressing it plays a
  synthesized Japanese ringback tone (NTT trill — 400 Hz AM'd at ~20 Hz, 1 s ring / 2 s
  pause, 2 cycles; WebAudio only, no asset) while the practice presenter re-initializes.
  When the ring finishes the far side "answers": the avatar speaks the authored start
  line, and the conversation runs **hands-free on browser VAD**.
- **VAD (zero-dependency):** energy-based voice activity detection on an AnalyserNode
  drives a rolling MediaRecorder (100 ms chunks, 400 ms preroll, ~700 ms trailing silence
  ends an utterance, 10 s cap, noise-floor calibration; the stream requests browser
  echoCancellation + noiseSuppression). **Half-duplex:** analysis is paused while
  transcribing/routing and while the avatar speaks; a wordless noise blip never spends a
  turn. Replaces the push-to-talk Speak/Stop buttons in practice (Intake keeps its
  push-to-talk capture).
- **Two distinct functions, deliberately separated:**
  1. **Turn Router** — decides the turn outcome and **authors the Japanese line** the roleplay
     avatar speaks next, from the learner's **uncorrected** STT transcript + scenario
     persona/brief + turn history (homelab LLM, ADR-0008; the authored turn graph is the
     deterministic fallback). **This BLOCKS**: the avatar must not speak again until it's
     decided, or the call descends into chaos. It runs once the STT transcript is available,
     before the avatar's next line.
  2. **Performance Review (Judge)** — end-of-call evaluation for Call Review. Non-blocking; we
     maintain the full transcript during the call and evaluate after it ends.
- Alternating dialogue:
  1. Role avatar speaks a **Japanese line** — LLM-authored, spoken on the live Perxona voice
     (P4); pre-rendered Clauses remain Prep-only.
  2. User responds in **Japanese** via STT.
  3. **Turn Router** (blocking) decides the outcome + authors the avatar's next line → back
     to step 1.
- **English handling during the Japanese call:**
  - **和製英語 / katakana-English** (アポイント, コンタクト, メール) is **allowed** — treated as
    an acceptable Japanese attempt (it IS Japanese usage).
  - **Standard English** is **not** an acceptable route: the avatar responds with a scripted
    in-universe rejection line — **ソーリー、ノー・イングリッシュ** (rendered in Japanese, spoken
    + shown on screen) — keeping the call in Japanese, then falls into the no-match recovery
    (§ below).
- **STT is processed as-is** — the transcript is used raw, with no cleanup/normalization. If
  the learner's speech is too unclear for STT to capture correctly, that itself is a data
  point for the learner (shown at Review).
- **No-match escalation (3-stage):** when the learner's transcript doesn't move the call
  forward, the Router progresses ① **repeat the prompt** — the avatar politely re-asks →
  ② **show the expected phrase as a hint** on screen (romaji + English), and the avatar
  repeats → ③ **help branch** — a gentle forward path that moves the call along. In LLM mode
  the same rubric drives the stages and the lines; in fallback mode the authored per-node
  recovery edges (re-ask, hint, help) apply. The on-screen hint text is authored per node;
  it is NOT coupled to the Prep Lines.
- **Pacing:** the avatar is **silent while the learner speaks** — `setListening(true)` stays
  up for the whole connected call (Talking overrides it while the avatar speaks and it
  resumes after; the practice avatar's listening asset is a chin-thinking pose — §4 probe).
  Filler Clauses (あっ, そうですか) are a BYO-prerender mechanism, **retired from practice
  in P4** (ADR-0008); Prep keeps its prerendered Clauses.
- On goal achieved (appointment made, card reported lost, redelivery scheduled), the avatar
  ends the call politely and we transition to the **Call Review** screen (§5.4).
- **Learner feedback is NOT shown during the call, and the learner's own voice is never
  replayed.** All feedback and corrections appear on the post-call Review page.

### 5.4 Call Review (post-call)
- A dedicated page after the practice call ends.
- **Luna hosts the review (2026-09-05):** on call end the presenter re-initializes to the
  **coach** (Luna — the role avatar no longer stays on screen) and Luna **speaks the
  feedback in English**: a short lead-in, then the Judge's overall assessment while the
  per-turn cards render. The Judge call fires in parallel with Luna's re-init/lead-in (its
  latency hides behind them); any speech or re-init failure never hides the written review.
- Shows each captured learner attempt (as **text transcript**, not audio replay) alongside
  the expected phrasing and the **Performance Review (Judge)** correction per turn, followed
  by an **overall assessment** of the call.
- **All Review explanations are written in English** (the learner is an English speaker).
- **Grading bar:** the learner is expected to speak in **teineigo** (polite です/ます forms);
  failing to do so triggers **strong feedback**. **Keigo** (honorific/humble forms) is offered
  only as optional **tips**, never treated as a failure.
- **Miss signal:** no-match recovery events (repeat/hint/help prompts) already tell the learner
  they were off-target in-call. The Judge works **afterwards** on the recorded turn data —
  it does not gate or interrupt the live call.
- Summarizes what went well and what to improve, keyed to the Prep Lines.
- **Do not replay the learner's recorded voice** (most people find that unsettling); audio is
  discarded or kept only transiently and never played back to the user.

## 6. Content model — summary

The content schema is defined by the JSON bundles in `content/` and the TypeScript types
in `app/src/lib/api.ts` (`ContentBundle`, `DialogueNode`). In short:

```
content/scenarios/{scenario-id}/
  metafile.json      # title, scene id, role avatar id, goal, slot schema,
                     # persona, brief, reality_check (authoring gate — rubric below)
  {variant-id}/
    intro.json       # role avatar greeting + first line
    prep-lines.json  # 5 key sentences (OrderedLine { ja, romaji, en })
    dialogue.json    # curated turn graph: nodes, edges, expected responses, feedback,
                     # + up to 3 recovery edges per node (repeat / hint / help)
    summary.json     # wrap-up lines + success criteria
```

Shared (non-scenario) content: **Fillers** and the **no-English rejection line**
「ソーリー、ノー・イングリッシュ」are reusable Clauses authored once, not per scenario. All
shared lines are rendered in Japanese (kana/kanji), never romaji on screen.

- **3 variants per scenario**, differing by vocabulary, same goal/outcome
  (e.g. dentist: 虫歯が痛い vs 歯が痛む).
- **MVP scenarios:** dentist · doctor · restaurant · lost credit card · package redelivery.
- Every string is `{ ja, romaji, en }`.
- **Principle:** author the full 5×3 set, but **wire up 1 scenario × 1 variant** first; the
  rest are validated content ready to flip on.

**Authoring rubric (2026-09-05, after the dentist realism pass).** Every scenario's
`metafile.json` carries a **`reality_check`** block — what the real institution *always*
asks (`required_questions`), the reasons callers actually have (`common_reasons`), and the
confirmation conventions — source-tagged `user-verified` or `draft`. The rules:

- **Prep teaches only scenario-specific production** (reason phrasing, giving your name,
  answering first-visit, patient ID, acknowledging specifics). Greetings/thanks/goodbyes
  and time-slot basics are excluded — the call itself teaches them.
- **Persona + brief must mandate every `required_question`**; the turn graph branches where
  answers diverge the path (first visit → name; returning → patient ID → name); the final
  confirmation repeats the **specific date and time** (the router prompt injects today's
  date, Asia/Tokyo, so dates are real).
- **Variants differ by reason/situation** (toothache vs cleaning vs fallen filling), not by
  politeness synonyms.
- **Gate:** `content.test.mjs` fails if a scenario lacks a `reality_check` (or has an empty
  persona/brief). All five scenarios are user-verified (2026-09-05) and reworked against
  their checks.

## 7. Audio strategy (BYO-TTS prerender-first)

Luna coaches in English on her own Perxona voice; the Japanese Prep examples are
**prerendered BYO-TTS audio played directly** — not through the presenter (ADR-0009, §5.2).
Practice is all-Japanese roleplay on the **live Perxona voice** (ADR-0008). Decision
history: prerender-first (ADR-0004) originally handed prerendered audio to Perxona via
`presentWithAudio()` for lip-sync/avatar playback; ADR-0009 superseded that for Prep, and
the `presentWithAudio()`/`speakWithAudio()` client path was **pruned on 2026-08-30**.

See ADRs `0004` / `0008` / `0009`.

**Prerender unit — per Clause.** The authored unit is the Clause (see `CONTEXT.md`): one
prerendered WAV per line × voice, lazily cached in `app/src/lib/prerender.ts`.
Clause-aligned splitting (one Clause per presenter call so lip-sync followed the audio)
belonged to the presenter path and is dormant. Fillers (うん, あっ, かしこまりました) remain
authored (`content/shared/common.json`) but their prerender/practice use was retired in P4.

**P4 scope change (ADR-0008):** prerender is **Prep-only**. The practice avatar speaks
LLM-authored lines on a live Perxona Japanese voice via `present()`.

## 8. STT (homelab)

- `https://stt.mango-rockhopper.ts.net` — homelab STT service (user: "extremely proficient in
  multiple languages"). On the tailnet; both dev and the deployed container must reach it.
  Root path returns 404; **verify the exact route** (e.g. `/v1/audio/transcriptions`) in S0.
- Browser records (MediaRecorder) → `POST { audio_base64, mime_type }` → server forwards →
  transcript. Behind a small provider abstraction (`STT_PROVIDER=homelab`).

## 9. LLM (classifier, turn router, end-of-call review)

- Provider behind one interface (`LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_MODEL`); default homelab
  LLM, fallback OpenAI/Anthropic.
- `classifyIntake(transcript) → { scenarioId, slots, confidence }` (strict JSON schema);
  for MVP this is a **confirmation stub** — surface the closest match to the learner (see §5.1).
- **Turn Router** `routeTurn(...) → { outcome, nextLineJa, hint?, callDone }` — blocking,
  must complete before the avatar's next line (feed it the raw STT transcript). **P4
  (ADR-0008):** the homelab LLM is the primary source — prompted with the scenario's persona
  directive + brief + rubric and the turn history, it returns the outcome and authors the
  avatar's next Japanese line; the deterministic matcher over the authored graph is the
  fallback on timeout/malformed/no-LLM. The LLM path also returns an optional `emotion`
  (validated against the 13-value `EmotionCategory` by `pickEmotion`; anything invented is
  dropped), carried on the spoken line and passed to `present()` options for facial
  expression — fallback/authored lines carry none (2026-09-05). The prompt is also fed
  today's date (Asia/Tokyo) so appointment confirmations name a real date and time.
- **Performance Review (Judge)** `reviewCall(transcript) → { per-turn corrections }` —
  end-of-call, non-blocking.
- **Latency (measured 2026-08-29):** `gemma4-26b-a4b-nothink` answers simple strict-JSON
  calls in ~0.4–0.9s on the homelab — comfortable for the blocking router with an ~8s
  timeout budget and the authored-graph fallback behind it. The **Review** tolerates latency
  anyway (runs after the call ends). Model is swappable via `LLM_MODEL` if ja dialogue
  quality demands it (candidates on the host: `qwen3.6-flash`, `carbon-8b`,
  `qwen3-swallow-8b`).
- STT is processed as-is (no cleanup) everywhere.

## 10. Risk register

| Risk | Mitigation |
|---|---|
| No/unknown Japanese BYO-TTS or Perxona Japanese voice for a given line | Prerender-first default; live voice fallback; verify in S0 |
| Homelab STT route unknown (404 at root) | Verify exact endpoint in S0; provider abstraction |
| Turn Router latency (blocking decision) | Measure real latency in S0; candidate: classifier (e.g. IBM Granite) or fast LLM; keeps the live line cheap |
| `meeks` (=Luna) / role avatar / scene IDs unknown | Resolve from sponsor account at setup via fixed-target config |
| Two live presenters (cost/complexity) | At most one live presenter; Luna during practice = text/static fallback in MVP |
| Browser autoplay blocks audio | Mandatory Start gesture → `resumeAudioPlayback()` |
| Prior app’s failure mode = feature sprawl | Thin vertical slice; explicit exclusion list (see §3) |
| BYO-TTS prerender pipeline built but never wired into the flow | Sprint 2 wires `presentWithAudio()` for all Japanese speech |
| Practice avatar never initialized — learner sees Luna, not the roleplay avatar | Sprint 3 re-initializes presenter with practice config on phase transition |
| Turn Router is keyword-only, can't handle paraphrase | Sprint 4 adds LLM router with deterministic fallback; latency measured |
| Judge is deterministic regex, can't assess correctness | Sprint 4 adds LLM judge for semantic per-turn corrections |
| No token expiry handling on the client | Sprint 3 wires `onConnectTokenExpired` → `refreshConnectToken` |
| Zero tests for P1 "complete" milestone | Sprint 5 adds unit tests for routeTurn, reviewCall, content loader |
| `strict: true` missing from tsconfig — weak type safety | Sprint 5 enables strict mode and fixes resulting errors |
| `forceRefresh` returns stale token during in-flight login | Sprint 1 fixes connect-client concurrent-refresh bug |

## 11. Delivery sequence

### Historical milestones

**S0 — Spike (COMPLETE):** Scaffolded app/server, verified presenter rendering, STT,
BYO-TTS in isolation. Exit criteria met.

**P1 — Vertical slice (COMPLETE with gaps):** Dentist/variant A end-to-end authored,
built, deployed live. Code review (2026-08-29) found the slice runs but diverges from
the ADRs in 5 critical areas: BYO-TTS bypassed, practice avatar not initialized, Turn
Router/Judge are stubs not LLM-based, `help` recovery ends calls prematurely, and the
English-rejection line is never spoken. The sprints below close these gaps.

### Sprint sequence (post-review remediation)

Each sprint is independently deliverable and verifiable. Mid-phase sprint work is left
uncommitted for the user's review; a **phase** (a coherent set of sprints achieving one
goal) ends with commit → push to `origin/main` → deploy to Core per `DEPLOY.md`
(user direction, 2026-09-05).

---

**Sprint 1 — Correctness fixes** (wrong behavior, no new features)

| # | Fix | Files |
|---|-----|-------|
| 1.1 | `/api/classify` returns `note` as a function → return a string | `server/src/index.mjs` |
| 1.2 | `practice.voice_id` uses `PRACTICE_AVATAR_ID` → use empty string (BYO-TTS mode) | `server/src/index.mjs`, `content/scenarios/dentist/metafile.json` |
| 1.3 | `help` outcome ends the call → advance to help node (end only if help→done) | `app/src/Flow.tsx` |
| 1.4 | `reject_english` not handled → speak `no_english_rejection` line, then repeat | `app/src/Flow.tsx` |
| 1.5 | `start_node`/`goal_node` hardcoded → read from `content.dialogue` | `app/src/Flow.tsx` |
| 1.6 | Sync route handlers have no try/catch → add try/catch + global Express error handler | `server/src/index.mjs` |
| 1.7 | `forceRefresh` returns stale token during in-flight login → clear `loginPromise` on force | `server/src/connect-client.mjs` |
| 1.8 | Prep pause 2500ms → 3000ms per PLAN §5.2 | `app/src/Flow.tsx` |
| 1.9 | `goal_node` in dialogue.json is `"end"` → fix to `"done"` | `content/scenarios/dentist/a/dialogue.json` |
| 1.10 | Avatar's final line skipped on call end → speak `done` node line before Review | `app/src/Flow.tsx` |
| 1.11 | Speak the `done` node farewell before transitioning to Review | `app/src/Flow.tsx` |
| 1.12 | `matchesExpected` dead ternary → simplify | `server/src/rules.mjs` |
| 1.13 | ffmpeg stderr discarded → capture and include in error message | `server/src/providers.mjs` |
| 1.14 | Dead `connect` block in `providers.mjs fromEnv()` → remove | `server/src/providers.mjs` |
| 1.15 | Dead env vars `LLM_*`/`STT_PROVIDER`/`TTS_PROVIDER` in `.env.example` → keep `LLM_*` (Sprint 4 uses them), remove `STT_PROVIDER`/`TTS_PROVIDER` | `server/.env.example` |

**Done when:** all 15 fixes applied, `tsc -b && vite build` passes, `oxlint` shows only
pre-existing warnings, the dentist slice runs end-to-end without crashes, `help` recovery
advances the learner forward, English input triggers the rejection line, and the avatar's
farewell line is spoken before Review.

---

**Sprint 2 — BYO-TTS prerender wiring** (ADR-0004 compliance)

| # | Task | Files |
|---|------|-------|
| 2.1 | Wire `prerenderLine()` + `speakWithAudio()` into `Flow.tsx` for all Japanese speech | `app/src/Flow.tsx` |
| 2.2 | Prerender prep lines (lazy on first use, cache in `prerender.ts` Map) | `app/src/lib/prerender.ts` |
| 2.3 | Prerender dialogue avatar lines | `app/src/Flow.tsx` |
| 2.4 | Prerender `no_english_rejection` and fillers from `common.json` | `app/src/lib/prerender.ts`, `app/src/Flow.tsx` |
| 2.5 | Use fillers before long avatar lines (PLAN §5.3 pacing) | `app/src/Flow.tsx` |
| 2.6 | Replace `speakText(line.ja)` with `speakWithAudio(prerendered, line.ja)` for all Japanese | `app/src/Flow.tsx` |
| 2.7 | Keep `speakText()` only for English coaching lines (non-Japanese) | `app/src/Flow.tsx` |
| 2.8 | Stop swallowing TTS errors silently (`.catch(() => {})`) → surface to status UI | `app/src/Flow.tsx` |
| 2.9 | Remove hardcoded `voice: "ruu"` from `synthesizeSpeech` → pass from server config | `app/src/lib/api.ts` |

**Done when:** all Japanese avatar speech uses `presentWithAudio()` with prerendered 16kHz
mono WAV; `present()` is used only for English; fillers play before long lines; TTS errors
are surfaced to the user, not swallowed; the app still builds and lints clean.

---

**Sprint 3 — Practice experience** (PLAN §5.3 compliance)

| # | Task | Files |
|---|------|-------|
| 3.1 | Call `presenter.initialize()` with practice avatar/scene on phase transition | `app/src/Flow.tsx` |
| 3.2 | Full-screen layout switch for practice (CSS class change on stage div) | `app/src/App.tsx`, `app/src/Flow.tsx` |
| 3.3 | Pass `onConnectTokenExpired` callback → `refreshConnectToken` | `app/src/Flow.tsx`, `app/src/hooks/use-presenter.ts` |
| 3.4 | Pass avatar/scene/voice IDs from server config instead of hardcoding | `app/src/App.tsx`, `app/src/Flow.tsx` |
| 3.5 | Fix `speechBusyRef` → `useState` (React anti-pattern, oxlint warnings) | `app/src/Flow.tsx` |
| 3.6 | Add React Error Boundary with fallback UI | `app/src/App.tsx` (or new component) |
| 3.7 | Add manual stop button for recording (alternative to VAD) | `app/src/Flow.tsx`, `app/src/hooks/use-recorder.ts` |
| 3.8 | Pass `presenterUrl` from App config to `loadPresenterEngine` (eliminate double fetch) | `app/src/lib/presenter.ts`, `app/src/App.tsx` |
| 3.9 | Add `--destructive` CSS variable to `index.css` (`#bc4749` per §2.1) | `app/src/index.css` |
| 3.10 | Remove redundant `intro` block from `prep-lines.json` (duplicate of `intro.json`) | `content/scenarios/dentist/a/prep-lines.json` |

**Done when:** practice phase shows the roleplay avatar (not Luna) in full-screen; token
expiry auto-refreshes; speech busy state correctly disables buttons via React state; an
unhandled render error shows a fallback UI instead of crashing; recording has a manual
stop button.

---

**Sprint 4 — LLM integration** (PLAN §9 compliance)

| # | Task | Files |
|---|------|-------|
| 4.1 | Create `server/src/llm.mjs` — LLM client (OpenAI-compatible, reads `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`) | `server/src/llm.mjs` (new) |
| 4.2 | Turn Router: LLM-based with deterministic fallback — prompt with candidate next-nodes + raw transcript, strict JSON output | `server/src/rules.mjs` |
| 4.3 | Measure Turn Router LLM latency; keep deterministic as fallback if >2s | `server/src/rules.mjs` |
| 4.4 | Judge: LLM-based review — prompt with per-turn transcript + expected line + context, strict JSON per-turn corrections | `server/src/rules.mjs` |
| 4.5 | Intake classifier: LLM call (beyond hardcoded stub) — classify transcript to scenario+slots | `server/src/index.mjs` |
| 4.6 | Add structured logging (latency, outcome) for LLM calls | `server/src/llm.mjs` |
| 4.7 | Wire `LLM_*` env vars into the server config flow | `server/src/index.mjs` |

**Done when:** Turn Router uses LLM with deterministic fallback; latency is measured and
logged; Judge produces semantically meaningful per-turn corrections (not just regex
checks); intake classifier calls the LLM (even if MVP still returns dentist/a, the LLM
path is wired and the deterministic path is the fallback).

---

**Sprint 5 — Quality & hardening**

| # | Task | Files |
|---|------|-------|
| 5.1 | Unit tests for `routeTurn` (all recovery stages, English rejection, help branch) | `server/src/rules.test.mjs` (new) |
| 5.2 | Unit tests for `reviewCall` (teineigo detection, English, silent, grades) | `server/src/rules.test.mjs` |
| 5.3 | Unit tests for content loader (bundle shape, node stamping, missing files) | `server/src/content.test.mjs` (new) |
| 5.4 | Unit tests for connect-client (token cache, concurrent mint, force-refresh) | `server/src/connect-client.test.mjs` (new) |
| 5.5 | Enable `strict: true` in `tsconfig.app.json`; fix resulting type errors | `app/tsconfig.app.json` |
| 5.6 | Install shadcn/ui or update ADR-0001 to drop it | `app/` or `docs/adr/0001` |
| 5.7 | Input validation on all API endpoints (zod or manual) | `server/src/index.mjs` |
| 5.8 | Add Helmet for security headers | `server/src/index.mjs` |
| 5.9 | Rate limiting on STT/TTS proxy endpoints | `server/src/index.mjs` |
| 5.10 | Remove dead `feedback` field from dialogue schema or populate it | `content/`, `app/src/lib/api.ts` |
| 5.11 | Remove unused `variant` array from `prep-lines.json` or wire it into the UI | `content/scenarios/dentist/a/prep-lines.json` |
| 5.12 | Fix `recoveries.repeat` type — make it a `{ja, romaji, en}` object for consistency | `content/scenarios/dentist/a/dialogue.json`, `app/src/lib/api.ts` |
| 5.13 | Add `AbortController` to client-side fetch calls with timeout | `app/src/lib/api.ts` |
| 5.14 | Replace `window.location.reload()` "Practice again" with in-app state reset | `app/src/Flow.tsx` |

**Done when:** test suite passes for all server modules; `strict: true` is on with zero
errors; shadcn decision is resolved; API endpoints validate input; security middleware is
in place; dead schema fields are cleaned up.

---

### Post-sprint: P2 content scale-out

After Sprint 5, the implementation matches the ADRs. P2 then proceeds:
remaining dentist variants (B, C), then doctor, restaurant, lost credit card, package
redelivery — 5 scenarios × 3 variants per the original PLAN §6 target.

### P4 — LLM-driven practice dialogue (ADR-0008)

P3 live testing (2026-08-29) showed the finite turn graph cannot absorb real-call
variation — off-script learners only ever hit the authored recovery edges. User direction:
practice must rely on the LLM; the practice avatar may use a Perxona voice. Also fixed:
"Practice again" must re-enter the call, not reset to Welcome.

1. **Content:** additive `persona` (ja directive) + `brief` (call stages, goal, key info)
   fields per scenario — pattern sourced from old-repo `coaching.json` personas (§2.1);
   the authored graph stays as fallback + hint/Prep source.
2. **Server:** blocking LLM router returning `{ outcome, nextLineJa, hint?, callDone }`
   (strict JSON, ~8s timeout) with the deterministic `routeTurn` graph matcher as fallback
   on timeout/malformed/no-LLM.
3. **Server:** `PRACTICE_VOICE_ID` fixed-target Perxona ja voice (reference: old reception
   pack `01KZFHK5FW671H7CX0Z6CMCV1R` — re-verify live, §12 Q13) served via
   `/api/connect/config`.
4. **Client:** practice loop speaks LLM lines via native `present()`; BYO prerender +
   fillers retired from practice (Prep keeps prerender).
5. **Client:** "Practice again" re-enters Practice with the same scenario/variant (reset
   turns/recovery, re-init avatar, LLM opening line); separate "Start over" for the full
   reset to Welcome.
6. **Judge:** consume the router's turn records (outcome + authored line); review schema
   unchanged.
7. **Tests:** fallback drills (LLM unconfigured / timeout / malformed), callDone
   transition, persona/brief content-schema tests.
8. **Layout:** the area below the stage is a fixed, independently scrollable content
   band (stage shows through behind it); phase changes reset its scroll to top. Fixes
   the P3-era flaw where action buttons sat below the page fold with no affordance
   ("the button is not visible", 2026-08-29).
9. **Deploy + live verify:** off-script call stays coherent; practice-again loops without
   a full reset; router p95 latency < ~5s; kill-LLM fallback drill.

Exit criteria: all of the above verified on the homelab; CONTEXT.md / AGENTS.md updated
alongside (done at planning time, 2026-08-29).

## 12. Open questions to resolve via grilling / S0

1. Exact homelab STT route + request/response format. → **Resolved in S0:** hosted,
   OpenAI-compatible; `POST https://stt.mango-rockhopper.ts.net/v1/audio/transcriptions` with
   multipart `file`+`model`+`language=ja`+`response_format=json` → `{ text }` (§2.1).
2. BYO-TTS provider + prerender pipeline; where prerendered audio lives (BLOB? artifact dir?).
3. How the “more practice” path behaves; how many bullets per scenario. → **Resolved:** 5 lines;
   after the read-through the learner taps an example card to replay it (on-demand, female voice,
   card underglow while playing) — not a bulk loop (§5.2, ADR-0009).
4. Segment granularity of prerendered audio for lip-sync quality. → **Resolved: per Clause** (see §7).
5. **Turn Router** implementation: measure real latency in S0; candidates include a
   lightweight classifier (e.g. IBM Granite family), a fast small LLM, and/or a deterministic
   matcher fallback — the live next-line decision must block, so its latency must be low.
6. English-fallback during Japanese practice. → **Resolved:** 和製英語/katakana-English allowed;
   standard English → scripted rejection ソーリー、ノー・イングリッシュ, then no-match recovery (§5.3).
7. Call Review “success” criteria the Judge emits. → **Resolved:** per-turn correction + overall
   call assessment, explanations in English; teineigo is the bar (strong feedback on failure);
   keigo is optional tips only; miss signal = recorded recovery events (§5.4).
8. Intake selection for MVP. → **Resolved:** selection is a stub — Luna confirms the (single)
   scenario; unsure → pick closest and tell the learner; real multi-scenario selection +
   on-the-fly scenario generation (semantic layer) is post-MVP (§5.1).

### Post-review open questions (from 2026-08-29 code review)

9. **`mintBrowserToken()` returns the server's own `access_token`** — is this correct
   per Perxona's token model, or should a separately-scoped browser token be minted?
   Depends on the connect-kit's auth design; verify before exposing to untrusted clients.
10. **shadcn/ui** — ADR-0001 specifies it but it's not installed. Sprint 5.6 resolves:
    install it or update the ADR to drop it.
11. **`recoveries.repeat` type** — currently a bare `string` while `hint` is a full
    `{ja, romaji, en}` object. Sprint 5.12 makes it consistent. Decision: should the
    repeat line be displayable bilingually (needs romaji/en) or is it audio-only?
12. **`summary.json` minimal** — only a `success_line`, no success criteria. Should it
    carry richer wrap-up content (PLAN §6 says "wrap-up lines + success criteria")?
    Defer to P2 content authoring.
13. **Practice voice ULID (P4):** verify `01KZFHK5FW671H7CX0Z6CMCV1R` (old reception pack,
    §2.1) is still live and ja-capable before locking `PRACTICE_VOICE_ID`; otherwise pick
    from the live Connect catalog.
14. **LLM model for ja dialogue (P4):** gemma4-26b-a4b-nothink is fast; judge ja line
    quality in P4 live tests and swap via `LLM_MODEL` if needed.
