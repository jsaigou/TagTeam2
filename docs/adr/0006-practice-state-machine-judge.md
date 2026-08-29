# ADR-0006: Practice routing is a blocking state machine; performance judging is end-of-call

Two distinct functions live in the practice call and must not be conflated:

- **Turn Router (blocking)** — decides which response line the roleplay avatar speaks next
  from the learner's uncorrected STT transcript + current node. It must finish before the
  avatar speaks again, or the call falls into chaos.
- **Judge / Performance Review (end-of-call)** — evaluates the learner's overall performance
  from the maintained transcript and produces Call Review corrections. Non-blocking; runs
  after the call ends.

The dialogue itself is a pre-authored turn-graph of the roleplay avatar's lines (deterministic,
demo-safe). Stt is processed as-is (no cleanup) — if the learner's speech is too unclear for
STT, that itself is a data point shown at Review.
