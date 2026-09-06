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

Judge output is addressed to the learner directly, second person ("you") — never narrated in
the third person ("the learner..."); both the deterministic fallback and the LLM prompt enforce
this (2026-09-05). The LLM's `perTurn` rows are matched back to turns by the `turn` number it
returns, never by array position — a missing/reordered/extra row would otherwise silently shift
every note onto the wrong turn, which reads to the learner as a fabricated mistake. Any row-count
mismatch falls back to the deterministic Judge rather than serving misaligned notes (2026-09-05).
