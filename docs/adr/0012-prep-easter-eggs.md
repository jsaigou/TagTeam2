# ADR-0012: Prep-page Easter Eggs — a registry framework, first entry an MGS-style codec briefing

Added 2026-09-06, refined through 2026-09-07. A small morale/flavor feature, not part of the
original MVP scope: while on Prep, there's a 1-in-10 chance (`rollEasterEgg()`,
`app/src/lib/easter-eggs.ts`) a gag sequence plays instead of (well, before) the normal
key-sentence read-through. Built as a **registry** (`EASTER_EGG_IDS`, currently one entry)
rather than special-casing "the only egg" — `pickRandomEasterEgg()` already supports more.
A Settings menu toggle ("Easter eggs — Always show on Prep", `localStorage["tagteam.easterEggsAlways"]`)
forces the roll to 100% for demoing; the Konami code (↑↑↓↓←→←→ba) force-triggers one on Prep
immediately, bypassing the roll entirely.

**First egg: the codec briefing.** A green-phosphor CRT takeover riffing on Metal Gear Solid's
radio-call cutscenes — scanlines/vignette/bloom/flicker/refresh-line, a typewriter mission
briefing built from the real scenario's `place`/`goal` (not invented flavor text), then Luna
reveals in close-up and "the Colonel" delivers a line before she screams and catches herself
back into her own voice. `CodecOverlay` (`Flow.tsx`) is a decorative layer only, portaled to
`document.body` so it isn't clipped by any ancestor stacking context — it deliberately never
touches Luna's actual `<sv-presenter>` element. `runCodecBriefing`'s close-up crop uses
`setZoom`'s CSS transform (scales the existing element in place) rather than resizing or
repositioning her porthole; an earlier iteration tried filling the screen by resizing the live
avatar element directly and broke the presenter widget's internal rendering **permanently**
(solid black, unrecoverable short of a fresh mount) — that failure mode is now a standing rule
(project memory, and the comment above `CodecOverlay`), not just a one-off fix.

**Audio: pre-rendered, not live TTS.** The Colonel's line and the scream are baked WAVs
(`app/public/easter-eggs/`), synthesized via the homelab BYO-TTS qwen-tts voice-design voice
`bert` — the same pipeline Prep's own dual-voice Japanese examples use (ADR-0009) — so the gag
fires instantly and never depends on the TTS server being warm. They're played through
`presenter.speakAudio`, the same pregenerated-clip path Review's "repeat after me" drill uses.
SFX beds (morse/transceiver/ambient) are free clips trimmed with ffmpeg.

**The presenter's "finished" signal fires early — twice bitten.** `presenter.speakAudio`'s
completion detection (`ALL_PERFORMANCE_FINISHED`/`PERFORMANCE_STATE` off the `<sv-presenter>`
widget) can resolve well before the clip actually finishes playing — confirmed live: a 3.28s
line once resolved in 235ms, cutting the Colonel off mid-sentence. `speakAtLeast` (`Flow.tsx`)
races the call against the clip's known minimum duration (hardcoded, since these are fixed
baked assets) so a line can never be cut short. The same bug turned out to affect *live*
`speakText` too, not just pregenerated clips: Prep's own English-then-Japanese line narration
(`speakPrepLine`) awaited `presenter.speakText(line.en)` before playing the Japanese example,
and on an early resolution the Japanese started talking over the English's tail — reported
live 2026-09-07. Fixed the same way, via `speakTextAtLeast`, but since there's no pregenerated
clip to measure a duration from, the minimum is estimated from the text length (~13 chars/sec,
a conservative floor for Luna's speaking rate) instead of a hardcoded clip length.

**Text layout clears Luna's window.** `CodecOverlay`'s intro/caption text originally centered
across the full viewport; on narrower screens it landed directly under Luna's porthole, which
sits top-left (per the no-resize/reposition rule above, her position never moves for the egg).
Fixed by reserving the same porthole-width spacer Prep's own title row already uses (`Flow.tsx`,
the `flex items-start gap-4` + fixed-width spacer pattern used for the intake/prep slot), so the
text column starts clear of her regardless of viewport width instead of trusting horizontal
centering to miss her.

**The scream, iterated three times.** v1 shipped English "SNAKE!" (single burst). A pass tried
katakana ("スネーク！スネーク！") for a more "Japanese" feel, but the take read as normal
speech, not a shout, so it reverted to English. The reverted take was a single burst again
(user-reported: "the audio is supposed to shout snake twice, but it says snake once") — fixed
by resynthesizing "SNAKE! SNAAAAAKE!" (a short burst then a drawn-out second one). Every take
was picked from several synthesized candidates by inspecting the volume envelope (`ffmpeg
-af silencedetect`/`astats`) for a clean two-burst shape with the second burst longer than the
first — the agent generating these clips has no ears, so envelope shape is the substitute for
"does this sound right."

**Verification.** Per house rule, verified against the deployed homelab container
(`https://tagteam2.mango-rockhopper.ts.net`) via Chrome browser automation each time, never a
local dev server — including one live capture of the CRT overlay mid-sequence to confirm the
text/porthole layout. Audio content itself (does the scream *sound* right) is verified
indirectly via the envelope-shape heuristic above, not by ear.
