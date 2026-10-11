# Techniques: making Luna personable, and hiding wait time

Written 2026-10-11 from a read of the repo (code, ADRs, PLAN, git history, project memory).
Nothing here was re-measured this session; numbers are quoted from the docs/commits that
measured them. Source tags follow `AGENTS.md`: **[code]** read in this repo, **[adr]** a
recorded decision/measurement, **[git]** commit message, **[user]** user direction recorded in
docs/memory, **[unverified]** claimed but not measured.

Two goals, one toolbox: most of what makes Luna feel alive is also what covers a wait. The
catalogue below is grouped by the *wait being hidden*, then by *personality* techniques, then
by the *traps* we hit while building them.

---

## 1. Known waits, and what hides each one

| Wait | Size | What covers it | Where |
|---|---|---|---|
| Start → presenter `Ready` (`initialize()`; scene load from `cdn.perxona.ai`) | 3.8 s warm [adr 0011]; 12–33 s ordinary, 25.5 s seen live [git 4601824] | Readiness-gated door cover | `Doors.tsx`, `lib/door-timeline.ts` |
| Practice presenter re-init + Silero/ONNX load + mic permission | not separately measured | Ringback tone while dialing | `dial()` / `playRingback` |
| Judge LLM review (up to 30 s timeout [research doc]) | not measured | Run in parallel with Luna's re-init and spoken lead-in | `goToReview` |
| TTS synthesis for Prep examples | live TTS per line | Baked offline to static MP3s | `render-prep-audio.mjs`, `lib/prep-audio.ts` |
| Transcribe → route (Turn Router) per turn | router ~0.4–0.9 s strict-JSON [adr 0008]; ~1.5 s in live smoke [PLAN] | Listening pose held through the window; mic re-opened early for barge-in | `processUtterance`, `routeAndSpeak` |
| Prep-page processing | not measured | Easter eggs (stated intent) | `easter-eggs.ts`, ADR-0012 |
| `playMotion` first call | 146–618 ms, repeats 1–2 ms [memory: camera findings] | Pre-warm each motion once (designed, not built) | ADR-0013 |

### 1.1 The door cover — gate on *readiness*, never on a timer (ADR-0011)

- `begin()` enters Intake **immediately**; the rest of the screen is live while Luna loads. An
  opaque brand-token door covers only her porthole ("what loads is Luna, so cover Luna").
- The swing-open is gated on `presenter.ready`. The prior app used a fixed 6350 ms sequence that
  never observed the load, so a slow init lifted the cover onto a blank stage. A slow init now
  *holds* the doors shut with a breathing seam and "waking Luna…".
- Escape hatches so it can never trap the learner: tap / Enter / Space skips (200 ms fade);
  `prefers-reduced-motion` collapses to a cross-fade; a hard cap gives up to the normal error UI.
- **The cap was wrong first.** It shipped at 9 s, but ordinary connects take 12–33 s, so the
  "Luna is away" state fired on healthy connects. Now `CAP_MS` = 40 s, `begin()`'s
  `waitReady` uses the same cap, and a Ready that arrives *after* the cap un-freezes the doors and
  swings open for real [git 4601824]. Lesson: derive the cap from measured real-world
  distributions, and make the late-success path recover rather than stay failed.
- **Personality on the failure path.** If Ready arrives late, after the "away" state, Luna says
  *"Sorry, I was at the store."* [git 84a19e3, `Flow.tsx:588`] — a long wait turns into an
  in-character apology instead of a silent pop-in.
- Implementation notes: portal to `document.body` (the band/stage are stacking contexts that
  paint *below* the presenter's opaque canvas); position imperatively each frame from a
  `measure()` callback; pure `computeDoorFrame(t, openAt, swing)` for deterministic timing;
  inline max z-index and a 100 ms interval re-assert so a backgrounded tab can't leak the avatar.

### 1.2 The call ritual — a ringback that does real work (`dial()`)

Practice opens on a **Dial** button, then a synthesized Japanese ringback (WebAudio, 400 Hz
carrier AM'd at ~20 Hz, 1 s ring + 2 s pause, no audio asset [`lib/audio.ts`]). The ring is
not decoration: `Promise.all([presenter re-init + waitReady, vadStart, ring.promise])` — all the
slow things run concurrently *behind* the ring, and the far side "answers" when the ring
finishes. Details worth keeping:

- The VAD is paused the instant the mic opens so the ring can't be heard as an utterance, and
  stays paused through the greeting.
- A dial token (`dialTokenRef`) makes cancel-while-ringing safe; a failed dial returns to the
  Dial button instead of sticking on "Ringing…".
- It also *is* the product: a real phone call has a ring. The wait is diegetic.
- Cycles are fixed (2). If init takes longer than the ring, the call connects only when
  everything is ready — the ring ends, the answer waits. [code]

### 1.3 Run the slow, independent work in parallel with something Luna does anyway

- **Judge ∥ Luna's review lead-in** (`goToReview`): the Judge request starts, Luna re-inits and
  speaks "Good work! Let's look at how the call went.", and only then is the Judge awaited. The
  written cards always render even if speech fails.
- **Intake**: `classifyIntake`'s LLM round-trip happens while Luna is "confirming…" — noted in
  `runIntake` as incidental settling time, **not a guarantee**; `quickPick` (no LLM) therefore
  `waitReady()`s explicitly.
- **Prep line narration**: Luna speaks the English while the baked Japanese MP3 is already
  static and instant — no synthesis wait in the normal case.

### 1.4 Bake whatever is predictable (ADR-0004 → P4 → 2026-09-08)

- Prep: all 600 clips (20 lines × 2 voices × 15 variants) rendered offline to
  `app/public/prep-audio/`. No `/api/tts` call in the normal case; the runtime cache is only the
  fallback for an unbaked line and for Review's dynamic drill.
- Easter-egg dialogue (Colonel line, scream, AYB lines, laugh sting) is baked WAV so "the gag
  fires instantly and never depends on the TTS server being warm" [adr 0012].
- **Where it deliberately stops:** practice dialogue is LLM-authored per turn, so it is *not*
  prerendered (ADR-0008); the filler-Clause mechanism was **retired from practice**. The
  authored fillers (うん, あっ, そうですか, かしこまりました in `content/shared/common.json`)
  remain in content but CONTEXT.md says the avatar is "silent while the learner speaks" and
  fillers are no longer used as turn-to-turn accents. **Do not assume spoken backchannel exists
  in practice today** — it doesn't. See §4 for the opening this leaves.

### 1.5 Mic-side latency choices (`use-vad.ts`)

These shape *perceived* responsiveness rather than hide a wait, but they set the clock the turn
latency is measured against:

- Silero V5 VAD in-browser (picked over energy detection as most reliable).
- `minSpeechMs: 250` (default 400 dropped はい/いいえ); `redemptionMs: 1900` (default 1400 split
  one sentence into two turns across a thinking pause); `preSpeechPadMs: 800`.
- `noiseSuppression: false` (it ate quiet onsets and hurt STT); `echoCancellation: true` so the
  mic can stay live while Luna talks.
- Tradeoff to remember: a longer silence grace (1.9 s) adds up to ~1.9 s of dead air before the
  turn even starts routing. That is a deliberate accuracy-over-snappiness choice; it is the
  largest single per-turn delay in the code, bigger than the router. [code; magnitude inferred]

---

## 2. Making Luna personable

### 2.1 Keep her *visibly* attentive: `setListening`

`presenter.setListening(true)` is held across the whole record → transcribe → route window in
Practice and Intake (and Review's repeat-after-me turn), and across the entire practice
conversation (Talking overrides it while the avatar speaks, then it resumes) [`dial()`,
PLAN presenter-contract pass]. The practice avatar's listening asset is a **chin-thinking pose**,
so a router wait reads as "she's considering what I said", not a freeze. Both avatars were
probed: listening assets exist, **thinking assets do not**, so `setThinking` stays unwired
[PLAN]. If Perxona adds a thinking state, wire it for the router window.

### 2.2 Emotion on every LLM line

The Turn Router may return `emotion` (catalog: joy, excitement, admiration, caring, gratitude,
sadness, disappointment, annoyance, embarrassment, curiosity, surprise, realization, …),
validated against the Connect catalog by `pickEmotion`, then passed as
`present(text, { emotion })` [`rules.mjs:298`, `Flow.tsx:2042`]. Live smoke returned caring /
confusion / gratitude on on-script / English-rejection / closing turns. Authored-graph fallback
lines carry none, so the fallback is flatter — acceptable, but noticeable.

### 2.3 Persona and brief make the *voice* human

- Persona Directive (Japanese) defines who the other end is — role, register, stock openings;
  the Scenario Brief gives stages, goal, key info [CONTEXT]. The prompt asks for "short,
  natural, polite です/ます, one question at a time" and tells the router to treat the learner
  as a beginner while letting a real caller volunteer several items at once.
- Realism passes: every scenario's question order was checked against a user-verified reality
  check (e.g. dentist: reason → first-visit → patient ID → name → date/time confirm →
  first-visit instructions) [PLAN]. Router prompt injects today's date (Asia/Tokyo) so
  confirmations use real dates. Practice voice was switched to a male voice to match the male
  role avatar. These are the "she feels like a real receptionist" details.
- Guards so she never sounds broken: foreign-script STT (Arabic seen live) re-asks
  deterministically via an authored `unclear_reask` ("すみません、もう一度お願いします。")
  instead of reaching the LLM; single-word English STT noise is not treated as an English
  attempt.

### 2.4 Barge-in

The mic stays live while she speaks; sustained speech calls `interruptPresentation()` and queues
the learner's utterance as the next turn (`bargeRef` breaks the remaining lines; `pendingRef`
holds one queued utterance, drained in `routeAndSpeak`'s `finally`). Interrupting rather than
talking over each other is one of the biggest "feels like a person" levers, and the
`interruptPresentation` + waiter-release design is what keeps an interrupted line from freezing
the call [`use-presenter.ts`].

### 2.5 Voice-per-role separation

Luna coaches in English on her own Perxona voice; Japanese examples play as plain two-voice
BYO-TTS (female `lauren_us`, then male `bert`, 0.25 s gap) *not* through her mouth
[adr 0009]. Rationale there: it mirrors real male/female callers and keeps coaching separate
from example content. Side effect for personality: Luna never lip-syncs a voice that isn't hers.
The "Now it's your turn." line in Review's drill is intentionally her **native** voice, because
the voice change itself signals the handoff.

### 2.6 Staged framing

Luna's size/position changes use **staged** moves — shrink at the title slot, *then* move — so
she never crosses the cards while they slide (`Flow.tsx` prep/review layout effects, with
`setZoom` for the reading crop). Camera: `halfbody` for the small porthole and the full-bleed
call; `distance: 1, vertical: 0, horizontal: 0` baseline on Ready.

### 2.7 Easter eggs — personality as a payload

Four eggs are designed, three built (codec briefing, All Your Base, DOOM invasion; rhythm-rap
is ADR-0013, design only). Every one reuses real scenario content (`place`/`goal`, an
`aybTargetWord` per scenario) rather than invented flavor. Fixed lines are baked WAVs and route
through `presenter.speakAudio` so Luna *performs* them. They are on by default (the "Always show"
toggle was removed and the roll is internally always-on, with per-egg opt-outs in Settings) [git
a7b10d1]. **Stated purpose: "to hide processing time and add some fun"** [user, earlier
session]. **[unverified]:** which specific wait on Prep an egg covers and by how much has not
been measured — see §4.

---

## 3. Traps we already paid for (do not repeat)

1. **Never resize, reposition or CSS-filter the live `<sv-presenter>`.** Doing so once turned
   her permanently solid black until a fresh mount [adr 0012, memory]. Crop-in = `setZoom`
   (CSS `transform` on the existing element). For bigger effects wrap it in our own
   `overflow:hidden` div and transform the *wrapper*; `updateCameraFOV` handles dolly/pan
   [adr 0013, live-validated rotate/mirror/clip on the wrapper].
2. **The presenter's "finished" signal fires early.** `ALL_PERFORMANCE_FINISHED` /
   `PERFORMANCE_STATE` can resolve long before audio ends (a 3.28 s line resolved in 235 ms).
   Chain with `speakAtLeast(clip, minMs)` for baked clips and `speakTextAtLeast` (~13 chars/s
   floor) for live text. Without it, Prep's Japanese talked over Luna's English tail, and the
   "Got it — …" line before Prep went out mostly silent when the next phase grabbed the audio
   channel. Slightly over-waiting beats any overlap.
3. **`waitReady()` falls through on timeout instead of throwing.** Always re-check
   `presenter.ready` before speaking; `present()` before Ready fails with
   `PRESENTER_NOT_READY` and the review plays silent. Also `await customElements.whenDefined`.
4. **Fixed timers lie.** Gate on the observed event (ready), with a measured cap and a
   late-recovery path (§1.1).
5. **Single audio channel.** Eggs, Prep autoplay, drills and review all share it. Eggs call
   `interruptPresentation()` and also stop in-flight prep-line audio [git 0f35981]; Prep
   autoplay is held while an egg is active and resumes after a 1 s gap so the handoff isn't
   jarring.
6. **A background/hidden tab freezes the avatar** (`visibilityState: hidden`, rAF stops). Any
   live verification must run a control change first. It is also why timing/visual checks of the
   door cover were unreliable in a non-painting harness (ADR-0011 notes).
7. **`playMotion` is slow the first time** (146–618 ms). Pre-warm.
8. **Decorative layers must portal to `document.body`** and clear `HEADER_H`; text layers must
   reserve Luna's porthole width so they don't land under her.
9. **Per-render identity churn.** `presenter` is a fresh object every render; effects that
   close over it and put it in deps got torn down before their timers fired (Prep autoplay
   silently never started). Read via a ref.

---

## 4. Gaps and recommended next steps

Ordered by value for effort. None are implemented.

1. **Measure before adding more masks.** The doc's biggest honest gap: per-turn
   transcribe+route latency in the browser, and per-turn "dead air" including the 1.9 s VAD
   grace, have not been logged as a distribution. Add `performance.now()` marks around
   VAD-end → STT done → router done → first audio and look at p50/p95 from real calls. Every
   suggestion below should be justified or dropped by that data.
2. **Spoken backchannel during the router window.** The retired filler mechanism is the obvious
   fit: play a short *prerendered* ack (うん / あっ / そうですか, already authored in
   `common.json`) only when the route is still pending after ~600–800 ms, and cancel it on
   barge-in. Constraint: ADR-0008 says practice voice is the live Perxona voice, and baked clips
   are the BYO-TTS voice — a voice mismatch mid-call is the risk, so prefer synthesizing the
   fillers once with the *same* voice or using non-speech cues. Tradeoff: a filler that arrives
   after the answer is worse than silence.
3. **Non-speech presence cues for the router window.** Cheap and voice-neutral: a motion from
   Luna's catalog (Idle/Listen), a subtle "…" caption, or a soft tick. The 8-motion catalog has
   no dedicated "thinking", so the Listen pose is what exists.
4. **Pre-warm.** Motions (per the measurement), the VAD/ONNX module and mic permission earlier
   than Dial (e.g. at Prep), and the router's static prompt prefix (LLM prefix caching also
   cuts cost — see the research doc). Dial already hides VAD load; moving it earlier shortens
   the ring-dependent critical path.
5. **Streaming/partial response.** Speak the avatar's first clause as soon as the router
   produces it rather than after the full JSON. Needs a streaming router format; larger change,
   likely the biggest real win if (1) shows router dominates.
6. **Shorten the VAD redemption conditionally.** 1900 ms is a blunt trade-off. A heuristic
   (shorter grace after sentence-final particles, longer after fillers/trailing ー) could keep
   accuracy and recover ~0.5–1 s. Needs live testing with real learners.
7. **Say what the eggs actually hide.** Decide whether eggs are meant to mask a specific wait
   (then trigger them on that wait) or are pure flavor (then drop "hides processing time" from
   copy). Currently they fire on Prep entry regardless of load.
8. **Rhythm-rap egg (ADR-0013)** adds the two techniques this project hasn't used yet — an
   audio-clock beat table and camera-driven "motion" for an avatar with only 8 body motions.
   Pre-warming motions at egg start is already in its design.

---

## 5. Quick reference — where things live

| Concern | File / symbol |
|---|---|
| Door cover | `app/src/Doors.tsx`, `app/src/lib/door-timeline.ts` (`CAP_MS`), ADR-0011 |
| Ringback + parallel warm-up | `Flow.tsx` `dial()`, `lib/audio.ts` `playRingback` |
| Early-finish workaround | `Flow.tsx` `speakAtLeast`, `speakTextAtLeast`; `use-presenter.ts` `waitForFinished` |
| Barge-in | `Flow.tsx` `bargeRef`, `pendingRef`; `use-presenter.ts` `interruptPresentation` |
| Listening pose | `presenter.setListening` in `Flow.tsx` (intake, practice, drill) |
| Emotion | `server/src/rules.mjs` `pickEmotion` / router prompt; `Flow.tsx` speak loop |
| Baked prep audio | `server/scripts/render-prep-audio.mjs`, `app/src/lib/prep-audio.ts` |
| VAD tuning | `app/src/hooks/use-vad.ts` |
| Easter eggs | `app/src/lib/easter-eggs.ts`, ADR-0012, ADR-0013 |
| Zoom / camera | `use-presenter.ts` `setZoom`, `setCameraAngle`, `updateCameraFOV` |
| Parallel Judge | `Flow.tsx` `goToReview` |
