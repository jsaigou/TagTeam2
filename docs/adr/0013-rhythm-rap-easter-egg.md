# ADR-0013: Rhythm-rap easter egg — a Parappa-style beat-driven camera/frame routine

Proposed 2026-10-02. Fourth Prep-page easter egg (registry from ADR-0012). **Status: design
only — nothing is built.** Facts below are tagged: **[live]** = measured this session on the
deployed container (2026-10-01/02), **[docs]** = `@perxona/presenter-types@0.4.0`,
**[user]** = user direction this session, **[web]** = web lookup, **[unverified]** = MEASURE
before relying on it.

## Concept

Luna "raps" a Prep key sentence over a beat, call-and-response style, in the spirit of
Parappa the Rapper: rapid, beat-locked camera pushes, tilts, flips and frame jumps rather than
big body animation. The user asked for **complex combined motion — zoom + rotation, sudden
inversions, repositioning — to feel dynamic [user]**. Scoring is cosmetic (scripted Cool/Good
outcomes); no rhythm-input system (MVP scope discipline, `AGENTS.md`).

## What Luna can and cannot do

- **Body motions: only 8 [live]** — Idle 01/02, Talk 01/02, Listen, Laugh, Cry, Greeting Wave.
  No dance. Facial expression comes from `present(..., {emotion, intensity})` [docs]. So the
  egg's energy comes from *camera and frame*, not the rig.
- **`playMotion(id)`**: first call 146–618 ms (resolve + preload), repeats 1–2 ms [live].
  Dispatch only — playback not visually verified [unverified]. → pre-warm every motion once at
  egg start.
- **Camera (`updateCameraFOV`, −10…+10 offsets) [docs], confirmed [live]:** `distance` dollies
  (−10 extreme face close-up, +10 pulled far back, **nonlinear** — −4…−5 look near-identical);
  `horizontal`/`vertical` track. `updateCameraAngle` (fullbody/halfbody) is a hard cut and
  resets offsets [docs, live]. Per-frame updates ≈0.13–0.25 ms, steady 8.3 ms frame cadence
  [live]. This corrects the earlier note in `use-presenter.ts` that `distance` is a no-op.
- **No camera roll in the SDK** [docs]. Rotation is CSS (below).

## Decision: three layers, and the presenter element is never transformed

| Layer | Controls | Status |
|---|---|---|
| SDK camera | zoom (`distance`), pan (`horizontal`/`vertical`), fullbody↔halfbody cut | validated [live] |
| Porthole **wrapper** div (ours, `fixed z-20 overflow-hidden`) | `transform`: rotate (incl. instant 180° inversion), mirror (`scale(-x, y)`), squash/stretch (non-uniform scale), translate; `border-radius`/`clip-path` shape changes | validated [live]: rotate −12°, rotate 180°, translate+rotate(−25°)+scale(1.5)+camera −8, mirror+squash, circle, parallelogram clip |
| `<sv-presenter>` element itself | — | **untouched** |

Rationale: ADR-0012's standing rule — resizing/repositioning the live element once broke the
widget permanently (solid black). Wrapper transforms plus the SDK camera achieve every effect
asked for without touching it. A rotate on the *element* (a camera-style tilt inside a
straight frame) was **not tested** — the live test was blocked by the permission classifier
and not worked around; if wanted, test only on a throwaway tab where a reload recovers
[unverified]. The wrapper's own `left/top/width/height` already animate in the app (spring
easing), so the egg must move it with **`transform` only** to avoid fighting those transitions.
It overlays page content (z-20, pointer-events-none), so the egg needs a backdrop/overlay.

Stress run [live]: 11 beat-keyed keyframes at 120 bpm (360°/180° spins, mirror, scale 0.8–1.6,
distance −10…+8, translate ±~500px) — all fired, avg apply 0.25 ms, frame p50 8.3 ms / p95
9.2 ms, **but one 125 ms hitch in 616 frames** (cause not isolated), and Luna rendered
normally afterwards. Mid-sequence frames were not inspected [unverified].

## Timing: audio is the clock

All audio is baked (as ADR-0012's eggs). A beat clock derived from the audio clock
(`AudioContext.currentTime`, not `setTimeout`) drives a **choreography table**: bar/beat →
{wrapper transform, easing, camera offsets, shape, `playMotion` id}. Sudden moves use no
transition; swoops use easing. Motions are pre-warmed. At egg end restore the app baseline:
wrapper `transform: ""`, `updateCameraFOV({distance:1, vertical:0, horizontal:0})` (the values
`use-presenter.ts` sets on Ready), camera angle as found.

Luna's mapping: Talk 01/02 alternate per bar while rapping; Listen on the "your turn" bars
(`setListening`); Laugh / `joy` on Cool; Cry / `disappointment` on Awful; Wave as intro.
Her vocal plays through `presenter.speakAudio` so her lips move (the ADR-0012 pattern),
guarded by `speakAtLeast` for the early-"finished" signal; the beat plays separately.

## Content and audio

- **Lyrics: ours.** The rap is built from the real scenario's Prep key sentence (as the
  codec egg builds from `place`/`goal`) — silly framing, real Japanese.
- **Vocal: baked TTS**, same BYO-TTS pipeline as Prep/other eggs. So the beat must be an
  **instrumental**: a vocal track would fight Luna's lip-sync.
- **MC Hawking (the user's suggestion) — not usable as far as we can establish [web]:** a
  Ken Lawrence project; the 2004 album was a Brash Music commercial release, and no Creative
  Commons / free-reuse terms appeared in sources; official site fetch was rate-limited (429).
  Treat as all-rights-reserved unless the author grants permission.
- **Candidate free sources [web]** (licenses to be confirmed per track before download —
  nothing has been downloaded):
  - Pixabay "nerdcore" results: *Da Big Green Lootin' Machine* (Marusame00, 3:03, comedy
    rap), *Da Red Wunz Go Fasta* (2:02), *E Equals MC Squared An Einstein Rap*
    (Song_Writing_by_Brad, 1:50, tagged "Ai"). Pixabay Content License: commercial use OK, no
    attribution required, embedding in apps OK, no standalone redistribution. **These carry
    vocals** — usable only as a lip-flap-free "she's rapping over it" gag or as style
    reference, not as the backing track.
  - **Instrumental shortlist (license read from each track page 2026-10-02 [web]; nothing
    downloaded, BPM/feel unheard):**
    1. *Square and Back Again* — Geb, FMA, 2:00, **CC BY 4.0**, instrumental, tags Nerdcore /
       Minimal Electronic / Chiptune (square + sine generators). Best thematic fit; may be too
       minimal to read as a "beat". **Needs on-screen attribution** (no credits UI exists yet).
       https://freemusicarchive.org/music/geb/square-and-back-again/square-and-back-again/
    2. *Funny Hip-Hop Beat* — BerryDeep, Pixabay, 1:58, instrumental, Pixabay Content License
       (no attribution; not flagged AI). Best "real beat" fit.
       https://pixabay.com/music/alternative-hip-hop-funny-hip-hop-beat-605223/
    3. *Vivaldi Joke* — Grand_Project, Pixabay, 2:58, instrumental comedic neoclassical
       hip-hop, Pixabay Content License. **Registered for Content ID** — risk of claims if the
       planned demo video is uploaded to a platform.
       https://pixabay.com/music/beats-vivaldi-joke-534479/
  - **Ruled out:** *Technology* (Makaih Beats) — CC BY-NC-ND, no commercial use, no
    derivatives; *Under the Mountain Dark and Tall* (Geb) — CC BY-SA (share-alike muddies
    bundling it in the app).
  - Record the chosen track's title/author/license here when picked, plus BPM measured from
    the file (`ffmpeg`/onset analysis — no ears available).

## Integration (as ADR-0012)

Add `"rhythm-rap"` to `EASTER_EGG_IDS` / `EASTER_EGG_LABELS` in `app/src/lib/easter-eggs.ts`;
it joins the Settings enabled-eggs toggles and the random pick; Konami and the 1-in-10 roll
are unchanged. Effects live in a decorative overlay + a small choreography module; no new
server routes, no state beyond the existing egg settings.

## Verification plan (house rule: live container, not local dev)

1. Chrome tab **must be visible** — a hidden tab (`visibilityState: hidden`, rAF 0) freezes
   the avatar and silently invalidates every render test; always run a control change first.
2. Per-keyframe timing run to isolate the 125 ms hitch.
3. Capture mid-sequence frames for each effect; confirm Luna renders normally after the egg
   and after a second consecutive run (no black).
4. Verify motions visibly play and that pre-warming removes first-call latency.
5. Audio: envelope-shape checks as in ADR-0012 (no ears available).

## Open questions

- Instrumental beat: which track/license (above)? Original lyrics tone: silly vs nerdcore.
- Whether to test element-level rotate (throwaway tab) or stay wrapper-only.
- Easing curve for nonlinear `distance`; whether camera moves should lead or follow the beat.
