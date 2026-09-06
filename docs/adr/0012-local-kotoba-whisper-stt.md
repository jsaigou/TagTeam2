# ADR-0012: Japanese STT moved local (Kotoba-Whisper via whisper.cpp), hosted STT kept for English

All Japanese transcription (practice-call turns, "repeat after me" drills) now runs against a
`whisper.cpp` `whisper-server` baked into the app's own container, serving the
[Kotoba-Whisper v2.2](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.2) GGML model
(q8_0 quantization, ~780MB) — a distilled Whisper large-v3 trained on ReazonSpeech (real
Japanese TV/conversational speech, not read-aloud corpus data). Intake's English speech still
goes to the existing hosted `nvidia/nemotron-asr` endpoint (`STT_BASE_URL`); routing is by the
`language` the client already sends (`transcribeAudio` in `server/src/providers.mjs`).

**Why**: the hosted STT does its own per-utterance language-ID regardless of the `language`
parameter passed to it, and leaks the guess into the transcript (`"分かりました。 <ja-JP>"`,
`"Yeah. <en-US>"` — see `stripSttArtifacts`, ADR-0006). Short Japanese utterances (はい/いいえ)
routinely got misidentified as English or came back empty; a prior investigation confirmed the
hosted wrapper doesn't honor an explicit `language_code=ja-JP` either, so this couldn't be fixed
from the client or server against that provider. Kotoba-Whisper is Japanese-only by training —
it has no other language to mistakenly guess, so this whole failure class is structurally
impossible rather than mitigated after the fact (the 2+-Latin-word guard in `looksLikeEnglish`
stays, as a safety net and for any transcript that does reach the hosted path).

**Why local instead of another hosted provider**: this app's practice turns are single short
utterances processed one at a time (not streaming, not high-concurrency) — a good fit for
CPU inference, and it removes a network round-trip + an external dependency from the hot path.
whisper.cpp needs no GPU/BLAS for this; Kotoba-Whisper's distilled 2-layer decoder (vs.
large-v3's 32) is what makes it ~6x faster than full large-v3 on CPU. Verified against Core's
actual hardware (AMD Ryzen 7 8845HS, 16 threads, ~7% baseline load) before committing to this:
published whisper.cpp CPU benchmarks show full large-v3 already reaches real-time (RTF <1) with
int8/int4 quantization at 8+ threads, so Kotoba-Whisper's much lighter decoder comfortably beats
real-time for the few-second clips this app transcribes.

**Build**: a `whisper-build` Docker stage (`debian:bookworm-slim`) compiles `whisper.cpp`
(pinned tag, CMake `whisper-server` target only — no SDL2/BLAS) and downloads the model at
build time, baked into the final image (reproducible, no runtime network dependency). `start.sh`
launches `whisper-server` bound to `127.0.0.1` only (never reachable outside the container) in
the background, then `exec`s the Node server as PID 1. `STT_LOCAL_ENABLED=false` reverts all
Japanese transcription to the hosted path if the local server ever needs to be bypassed.
