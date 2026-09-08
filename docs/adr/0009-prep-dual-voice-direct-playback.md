# ADR-0009: Prep examples play on two BYO-TTS voices, direct playback (not Luna)

Prep's Japanese examples are no longer spoken by Luna via `presentWithAudio()`. Luna opens
Prep and reads each line's **English explanation** in her own Perxona voice; the Japanese
example then plays twice as **plain BYO-TTS audio — female voice (`lauren_us`) then male
(`bert`) — directly**, not through the presenter, so Luna neither lip-syncs nor appears to
speak the examples. Because the audio bypasses the presenter, `/api/tts` returns the
TTS-native WAV and skips the 16 kHz mono ffmpeg re-encode (that contract is opt-in via
`normalize: true`). Rationale: two-voice exposure mirrors real phone calls (male/female
callers), and keeping the examples off Luna's voice separates coaching (Luna, English) from
example content (homelab TTS, Japanese). This supersedes ADR-0004's `presentWithAudio()`
lip-sync path for Prep (pruned from the client on 2026-08-30); prerender-first still stands,
now cached per voice × line. Pacing:
0.25 s between the two readings, 0.9 s between lines (tightened 2026-09-05; originally 0.5 s /
2 s, felt sluggish in practice). Replay is learner-driven by tapping the
example card itself (plays once, female voice; card underglow while playing). Voices were
chosen by live probe of the homelab TTS `/voices` catalog (2026-08-30).

**Update (2026-09-08):** the dual-voice auto-narration described above was documented here but
not actually wired up — `speakPrepLine` only ever played `PREP_VOICES[0]` (`lauren_us`); `bert`
was declared and unused. Fixed: `speakPrepLine` now takes a voices list and loops with a 0.25s
gap between readings; `runPrepAuto` passes both voices, `playPrepLine` (tap-to-replay) still
passes just the female voice, per this ADR. At the same time, all 600 clips (300 prep lines ×
2 voices) were pre-rendered offline (`server/scripts/render-prep-audio.mjs`) to static MP3s
under `app/public/prep-audio/`, so Prep no longer calls `/api/tts` live at all in the normal
case — `app/src/lib/prep-audio.ts` plays the baked file directly and falls back to the
pre-existing live-TTS path (`prerenderLine` + `playWav`) only for a line the render pass
hasn't covered yet.
