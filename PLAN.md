# TagTeam — Durable Plan (v1)

> **Status:** Living document. v1 establishes direction; it will be sharpened by the
> grill-with-docs sessions and updated as the S0 spike confirms facts.
>
> Companion docs: `CONTEXT.md` (domain glossary), `docs/adr/` (decisions). See
> `docs/CONTENT.md` for the scenario content model (to be written after S0).

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
| D7 | Practice is a state machine + LLM judge (not free-form API LLM) | `adr/0006` |
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
- The presenter JS API (typed in `@perxona/presenter-types`):
  - `initialize(connectToken, { avatarId, sceneId, voiceId? })`
  - `resumeAudioPlayback()` — **must run from a direct user gesture** (autoplay policy)
  - `present(content)` — synthesize+speak (needs a voice, or it's BYO-TTS)
  - `presentWithAudio(audioBuffer, transcript)` — **BYO-TTS**: play our own audio, lip-sync from transcript
  - `playMotion(motionId)` — whole-body pre-recorded clip, independent of speech
  - `interruptPresentation()` · `updateCameraAngle('halfbody'|'fullbody')` · `updateCameraFOV()`
  - `refreshConnectToken(token)` · `setListening()` / `setThinking()` / `muteAudio()`
  - Events: `PRESENTER_STATUS`→`Ready`, `PERFORMANCE_END`, `ALL_PERFORMANCE_FINISHED`,
    `PLAYING_SPEECH_TEXT`, `CONNECT_TOKEN_EXPIRED`
- `present()` **queues** and never rejects (resolves `PresentationResult.success`).
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

### 5.2 Prep — staggered key sentences
- Luna starts **top-left** (windowed presenter). Bulleted list area on the page.
- Choreography loop (client state machine driven by presenter events):
  1. Reveal bullet *N* (one at a time).
  2. Luna window **moves down next to that line** (CSS transform).
  3. Luna **reads the line aloud twice**: `present(line)` → await `ALL_PERFORMANCE_FINISHED`
     → `present(line)` → await finish.
  4. **3-second pause.**
  5. Next bullet → repeat (**5 bullets** per scenario).
- After the last: Luna asks **“Ready to practice? Or would you like me to repeat any of the
  lines?”** → Ready advances. If the learner wants a repeat, they select a specific line and
  Luna re-reads it (learner-driven, on-demand repetition; not a bulk “more practice” loop).
- Each line shown as **kanji + furigana/romaji + English** (audience can’t reliably read Japanese).

### 5.3 Practice — roleplay call (state machine; routing is NOT the same as judging)
- Switch to **full-screen presenter** with the location’s avatar + an appropriate scene.
- **Two distinct functions, deliberately separated:**
  1. **Turn Router** — decides which response line the roleplay avatar speaks next from the
     learner's **uncorrected** STT transcript + current node. **This BLOCKS**: the avatar must
     not speak again until it's decided, or the call descends into chaos. It runs once the STT
     transcript is available, before the avatar's next line.
  2. **Performance Review (Judge)** — end-of-call evaluation for Call Review. Non-blocking; we
     maintain the full transcript during the call and evaluate after it ends.
- Alternating dialogue:
  1. Role avatar speaks a **pre-written Japanese line** (pre-rendered Clauses).
  2. User responds in **Japanese** via STT.
  3. **Turn Router** (blocking) picks the avatar's next node → back to step 1.
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
- **No-match escalation (3-stage, per node):** when the Router finds no match for the
  learner's transcript, it progresses ① **repeat the prompt** — the avatar politely re-asks
  its current line → ② **show the expected phrase as a hint** on screen (romaji + English),
  and the avatar repeats the line → ③ **help branch** — a dedicated gentle forward path that
  moves the call along. Every dialogue node therefore authors up to 3 recovery edges
  (re-ask, hint, help). The on-screen hint text is authored per node; it is NOT coupled to the
  Prep Lines.
- **Pacing:** the avatar is **silent while the learner speaks** (`setListening` visual only —
  no audio plays during the learner's turn). Filler Clauses (あっ, そうですか) are used only
  when the avatar has a **long** line, to assure the learner the call is still live; they are
  not inserted as turn-to-turn accents.
- On goal achieved (appointment made, card reported lost, redelivery scheduled), the avatar
  ends the call politely and we transition to the **Call Review** screen (§5.4).
- **Learner feedback is NOT shown during the call, and the learner's own voice is never
  replayed.** All feedback and corrections appear on the post-call Review page.

### 5.4 Call Review (post-call)
- A dedicated page after the practice call ends.
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

Full model in `docs/CONTENT.md` (written after S0). In short:

```
content/scenarios/{scenario-id}/
  metafile.json      # title, scene id, role avatar id, goal, slot schema
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

## 7. Audio strategy (BYO-TTS prerender-first)

Luna must (a) read the Japanese key lines aloud, and (b) coach in English. Practice is
all-Japanese roleplay. Decision: **prerender the known-outcome audio with a BYO-TTS of our
own** and hand it to Perxona via `presentWithAudio()` for lip-sync/avatar playback; use the
**live Perxona Japanese voice** as fallback and for truly ad-hoc lines. English coaching
is delivered as **on-screen subtitles** (+ optional browser speechSynthesis) rather than a
second Perxona voice, to avoid mid-session presenter re-init.

See ADR `0004`. Details (TTS provider choice, storage of prerendered assets) land in S0.

**Prerender unit — per Clause (resolved).** The smallest prerendered audio unit is a Clause
(see `CONTEXT.md`). A spoken line is composed of one or more Clauses; each line's audio is
split so lip-sync follows the audio (each `presentWithAudio(audio, transcript)` call passes a
transcript clause-aligned with that audio). Fillers (うん, ううん, あっ, かしこまりました) are
prerendered as their own reusable Clauses for natural pacing/acknowledgement. Prep reads a
line twice by replaying its Clauses; the practice avatar composes a line + optional filler
Clause per turn.

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
- **Turn Router** `routeTurn(dialogueNode, userTranscript) → { nextNodeId }` — blocking,
  must complete before the avatar's next line (feed it the raw STT transcript). **Lean:** a
  fast classifier over the finite candidate next-nodes (IBM Granite family is the named
  candidate), tolerant of paraphrase/ASR noise; deterministic matcher kept as a fallback if
  latency proves too high.
- **Performance Review (Judge)** `reviewCall(transcript) → { per-turn corrections }` —
  end-of-call, non-blocking.
- **Latency caveat (unverified — MEASURE IN S0):** a prior homelab LLM was reported slow
  (tens of seconds) for a large/planning workload; the user notes that a simple
  next-sentence choice may be far faster, and that a classifier (e.g. IBM Granite family) may
  suit it. The **Review** tolerates latency (runs after the call ends). The **Turn Router**
  does NOT — the live next-line decision must complete before the avatar speaks again, so S0
  must measure the actual router latency before committing to an implementation.
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

## 11. Delivery sequence

**S0 — Spike (COMPLETE — exit criteria PASSED):**
- Scaffolded `app/` (Vite 8 + React 19 + TS + Tailwind v4) and `server/` (Express ≥22 ESM); git
  repo linked to `github.com/jsaigou/TagTeam2`.
- Adapted `usePresenter` from the connect-kit; windowed `<sv-presenter>` verified in headless
  Chrome: `PRESENTER_STATUS → Ready`, Cocos `LoadScene main.scene` (avatar renders), camera
  framing set.
- **Homelab STT confirmed** (`POST /v1/audio/transcriptions`, OpenAI-compatible) → returns
  Japanese `{ text }`. Not whisper-cpp (hosted service; prod used `STT_PROVIDER=hosted`).
- **BYO-TTS confirmed** (`/v1/audio/speech`, kokoro-82m/ruu) → `presentWithAudio(16kHz mono WAV,
  transcript)` plays and aligns: observed `PLAYING_SPEECH_TEXT` with the exact line, then
  `PERFORMANCE_END` → `ALL_PERFORMANCE_FINISHED`.
- Migrated Connect credentials + fixed-target asset IDs (Meeks/Luna, coach scenes, voice) — see §2.1.
- **Exit criteria met:** Luna renders + speaks a hard-coded line; STT returns Japanese; BYO-TTS
  audio plays through the presenter. Demo app at `app/` exposes Start/Native/BYO/STT-self-check.

**P1 — Vertical slice (1 scenario × 1 variant):** dentist / variant A end-to-end:
Intake → Prep → Practice → Call Review, with the Start-gesture audio unlock.
**P2 — Content scale-out:** remaining dentist variants, then doctor, restaurant, credit
card, redelivery.
**P3 — Polish & deploy:** docker-compose on the homelab host (reaching tailnet STT + public
Perxona), responsive/mobile pass, visual/motion polish, Call Review improvements.

## 12. Open questions to resolve via grilling / S0

1. Exact homelab STT route + request/response format. → **Resolved in S0:** hosted,
   OpenAI-compatible; `POST https://stt.mango-rockhopper.ts.net/v1/audio/transcriptions` with
   multipart `file`+`model`+`language=ja`+`response_format=json` → `{ text }` (§2.1).
2. BYO-TTS provider + prerender pipeline; where prerendered audio lives (BLOB? artifact dir?).
3. How the “more practice” path behaves; how many bullets per scenario. → **Resolved:** 5 bullets;
   after Luna's read, she asks whether to repeat ANY line — learner selects one and Luna re-reads
   it (on-demand), not a bulk loop (§5.2).
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
