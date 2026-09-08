# ADR-0004: BYO-TTS prerender-first, live Perxona voice as fallback

Most practice/prep outcomes are known in advance (pre-authored content), so we prerender the
audio with our own text-to-speech and hand it to Perxona via `presentWithAudio()` for
lip-sync and avatar playback, rather than calling `present()` (Perxona synthesis) for every
line. The live Perxona Japanese voice remains as fallback and for genuinely ad-hoc lines.
English coaching is delivered as on-screen subtitles (optional browser speechSynthesis), not
a second Perxona voice, to avoid a mid-session presenter re-initialization.

**Status:** partially superseded. ADR-0008 moved practice off prerender entirely, and
ADR-0009 moved Prep off `presentWithAudio()` (direct playback, two BYO-TTS voices); the
`presentWithAudio()`/`speakWithAudio()` client path was pruned on 2026-08-30. Prerender-first
itself stands (per line × voice cache in `app/src/lib/prerender.ts`) as the fallback path.
For Prep specifically, "prerender" moved a step further (2026-09-08): all 600 example clips
are rendered **offline, ahead of time** (`server/scripts/render-prep-audio.mjs`) to static
MP3s under `app/public/prep-audio/`, rather than synthesized on first play and cached for the
session — `prerender.ts`'s runtime cache now only covers a Prep line the render pass hasn't
covered yet, plus Review's inherently-dynamic drill lines.
