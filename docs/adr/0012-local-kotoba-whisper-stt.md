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
whisper.cpp needs no GPU/BLAS for this.

**Latency reality check (measured, not estimated)**: Kotoba-Whisper's distilled decoder (2
layers vs. large-v3's 32) is what makes it ~6x faster than full large-v3 for *long-form*
transcription, where the autoregressive decoder dominates. That speedup barely applies to our
actual workload — Whisper's encoder always attends over a fixed 30s window (`n_audio_ctx=1500`)
regardless of real clip length, and Kotoba-Whisper keeps the *full* large-v3 encoder unchanged.
For a short utterance that fixed encoder pass, not the decoder, is the bottleneck: a live test
on Core's Ryzen 7 8845HS (8 threads; 16 threads measured no faster — this workload doesn't
scale with thread count past ~8, likely memory-bandwidth bound) took ~5.5s for a one-word clip
at full context. Worse, the mostly-silence padding at full context measurably hurt accuracy —
a 6s test phrase came back as literal garbage (`",,"`) at `audio_ctx=1500` but transcribed
correctly at `audio_ctx=768` (~15.4s of context) in ~2.5s. `768` is now hardcoded in
`transcribeLocal` (`LOCAL_STT_AUDIO_CTX`): generous headroom over any real single conversational
turn, faster than full context, and empirically more accurate on short clips, not just faster.
Net latency (~2-3s) is noticeably slower than the hosted nemotron-asr call it replaces, traded
for transcripts that are actually correct — accuracy over speed, since a fast wrong answer was
the entire problem being solved here.

**Build**: a `whisper-build` Docker stage (`debian:bookworm-slim`) compiles `whisper.cpp`
(pinned tag, CMake `whisper-server` target only — no SDL2/BLAS) and downloads the model at
build time, baked into the final image (reproducible, no runtime network dependency). `start.sh`
launches `whisper-server` bound to `127.0.0.1` only (never reachable outside the container) in
the background, then `exec`s the Node server as PID 1. `STT_LOCAL_ENABLED=false` reverts all
Japanese transcription to the hosted path if the local server ever needs to be bypassed.
