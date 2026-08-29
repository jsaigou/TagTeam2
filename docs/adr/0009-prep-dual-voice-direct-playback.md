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
lip-sync path for Prep; prerender-first still stands, now cached per voice × line. Pacing:
1 s between the two readings, 2 s between lines. Replay is learner-driven by tapping the
example card itself (plays once, female voice; card underglow while playing). Voices were
chosen by live probe of the homelab TTS `/voices` catalog (2026-08-30).
