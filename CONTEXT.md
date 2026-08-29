# TagTeam

Letter-ready app context for TagTeam: an app that helps English speakers in Japan practice
making phone calls in Japanese using the Perxona avatar system.

## Language

**Luna**:
The learner-facing guide avatar. App-level name; not a Perxona concept.
_Avoid_: guide, coach, AI assistant

**Meeks**:
The specific Perxona avatar asset used to render Luna. Resolved via fixed-target config.
_Avoid_: Luna (they are not interchangeable — Meeks is the asset, Luna is the persona)

**Roleplay Avatar**:
The Perxona avatar that plays the person on the other end of the call (receptionist, clerk).
_Avoid_: NPC, role-playing character

**Scenario**:
A pre-authored phone-call situation the learner can practice, with a defined goal, slots,
roleplay avatar, and scene. Example: dentist appointment.
_Avoid_: use case, template, exercise

**Variant**:
One of (by default) three lexical alternatives of a Scenario — same goal/outcome, different
appropriate vocabulary.
_Avoid_: version, flavor

**Prep Line**:
A single key Japanese sentence the learner needs for the call, shown with romaji + English
translation. Luna reads the **English** aloud; the Japanese plays twice as plain BYO-TTS
audio — female voice (`lauren_us`) then male (`bert`) — not spoken by Luna (ADR-0009). Each
scenario has **5** Prep Lines; afterwards the learner **taps a line's card** to replay it
on demand.
_Avoid_: bullet, keyphrase, sentence (keep the surface label distinct)

**Slot**:
A concrete piece of information the learner would supply for their specific call (name,
dentist name, desired time). Collected during intake to make the call feel real. **For MVP,
slots are generic and not filled into the dialogue** (no per-learner customization) — that is
a post-MVP extension.
_Avoid_: field, parameter, placeholder

**Intake**:
The opening conversation where Luna determines the learner's goal and confirms the scenario.
For MVP this is a **confirmation stub** (single scenario); if unsure, Luna picks the closest
scenario and says so explicitly. A future semantic layer generates new scenarios on-the-fly.
_Avoid_: setup, onboarding, welcome flow

**Turn**:
One exchange in the practice dialogue: the roleplay avatar's line, the learner's response,
and the judge's verdict.
_Avoid_: message, round

**Clause**:
The smallest unit of prerendered speech audio: one prerendered WAV per line × voice, cached
for replay (`app/src/lib/prerender.ts`). Originally clause-aligned so presenter lip-sync
followed the audio; since Prep examples play directly (ADR-0009) the unit now serves as the
TTS cache key.
_Avoid_: segment, chunk, phoneme

**Filler**:
A short standalone utterance (うん, あっ, かしこまりました) authored as its own Clause
(`content/shared/common.json`), designed to assure the listener the call is still live.
Not used as a turn-to-turn accent; the avatar is silent while the learner speaks.
_Avoid_: acknowledgement, interjection

**Recovery Edge**:
One of up to three authored fallback edges from a dialogue node when the learner's transcript
doesn't match any expected response: ① repeat the prompt, ② show a hint (romaji + English),
③ a help branch that moves the call forward.
_Avoid_: fallback, retry path

**Hint**:
The on-screen reveal of the expected phrasing for a dialogue node (romaji + English) shown as
recovery stage ②, without advancing the call. Authored per node; not coupled to the Prep Lines.
_Avoid_: answer, spoiler

**Judge**:
The LLM function that evaluates a learner's performance at the end of the call (fed by the
maintained transcript) and produces the corrections for Call Review. Runs after the call ends,
non-blocking. Emits per-turn corrections plus an overall assessment; all explanations are in
English. Uses the recorded no-match recovery events as the miss signal; it does not gate the
live call. **Not** responsible for selecting the next response line — that is the Turn Router.
_Avoid_: scorer (when meaning the live next-line decision)

**Teineigo**:
The polite です/ます speech level — the expected register for the learner's practice. Failing
to use teineigo is treated as a failure and gets strong feedback in Call Review.
_Avoid_: keigo, formality

**Keigo**:
Honorific/humble (尊敬語・謙譲語) speech. Never treated as a failure; offered only as optional
tips on the Call Review page.
_Avoid_: teineigo (they are not the same bar)

**Turn Router**:
Decides the outcome of the learner's turn (advance / repeat / hint / help / reject English /
call done) and authors the next Japanese line the Roleplay Avatar speaks. Driven by the
homelab LLM against the Persona Directive and Scenario Brief, fed the raw (uncorrected) STT
transcript and turn history; the authored turn graph is the deterministic fallback
(ADR-0008). **Blocks** — the avatar must not speak again until this is decided, or the call
descends into chaos.
_Avoid_: reusing Judge for this

**Persona Directive**:
The Japanese directive defining who the Roleplay Avatar is on the call (role, register,
stock openings) and how they behave. Frames the LLM-driven practice dialogue (ADR-0008).
_Avoid_: prompt, character sheet

**Scenario Brief**:
The structured summary of a Scenario given to the practice LLM: call stages, goal, key
information, and what counts as the learner advancing. The authored turn graph and the Prep
Lines anchor to the same frame; the brief remains the LLM's frame in fallback mode.
_Avoid_: script, outline

**Call Review**:
The post-call screen where the learner sees each of their attempts (as text) with the
expected phrasing and corrections. The learner's own voice is never replayed.
_Avoid_: summary, report, debrief

**Prep**:
The screen/phase where Luna teaches the 5 Prep Lines to the learner, reads them aloud, and
offers on-demand repetition of any line.
_Avoid_: flashcards, lesson

**Practice**:
The screen/phase where the learner role-plays the call against the Roleplay Avatar.
_Avoid_: call screen, simulation, exercise screen
