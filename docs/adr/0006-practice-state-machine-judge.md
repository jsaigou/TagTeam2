# ADR-0006: Practice routing is a blocking state machine; performance judging is end-of-call

Two distinct functions live in the practice call and must not be conflated:

- **Turn Router (blocking)** — decides which response line the roleplay avatar speaks next
  from the learner's uncorrected STT transcript + current node. It must finish before the
  avatar speaks again, or the call falls into chaos.
- **Judge / Performance Review (end-of-call)** — evaluates the learner's overall performance
  from the maintained transcript and produces Call Review corrections. Non-blocking; runs
  after the call ends.

The dialogue itself is a pre-authored turn-graph of the roleplay avatar's lines (deterministic,
demo-safe). If the learner's speech is too unclear for STT, that itself is a data point shown
at Review.

**STT reliability on short utterances (found live 2026-09-06):** the hosted `nvidia/nemotron-asr`
is NVIDIA's Nemotron 3.5 ASR (released June 2026), a 40-locale model that auto-detects the
spoken language per utterance via language-ID prompt conditioning, and leaks that detection as a
literal `<ja-JP>`/`<en-US>` token appended to the transcript. On short utterances the language-ID
step is unreliable — confirmed live: 「いいえ」 (2 mora) transcribed as `"Yeah. <en-US>"`, 「はい」
came back empty. Passing a pinned `language_code` (vs. `auto`) is documented upstream to
constrain decoding, but probing our hosted endpoint with `ja` vs. `ja-JP` produced byte-identical
(still wrong) output — the wrapper in front of the NIM does not appear to forward it, so this
can't be fixed from the app; it needs a homelab/wrapper-side change (or a single-language
deployment profile) to fix at the source. App-side mitigation (2026-09-06):
`stripSttArtifacts` (`providers.mjs`) removes the leaked tag before the transcript enters the
pipeline anywhere; `looksLikeEnglish` requires **2+ separate Latin words**, not one, before
calling something an English lapse — a lone hallucinated word (the exact "Yeah." failure mode)
no longer triggers `reject_english` in the router or an "English" verdict in the Judge. A
transcript that's neither Japanese nor confirmed-English multi-word grades `"unclear"` in Review
(never "good"/"english"/silently defaulted), with its own honest note, and the Judge LLM is
handed a `"[unclear -- speech-to-text failed to capture this turn]"` placeholder instead of the
garbled text so it can't build a note or an "overall" claim around content that was never said.

**Resolution (2026-09-06):** the hosted STT backend was swapped from `nvidia/nemotron-asr` to
Qwen3-ASR-0.6B to address the above, but live testing showed the same failure class persisted in
new forms (「いいえ」 variously came back as `"Yeah."`, `"ええ。"`, Korean `"이에"`, and Chinese
`"耶。"` across repeated identical calls) — the model swap alone didn't fix it. Root cause
(diagnosed by the team operating the hosted endpoint): its server software (`qwen3-asr.cpp`)
parsed the `language` form field but discarded it (`(void)language;`) before generation, so the
model always freely guessed language from audio alone with zero steering, regardless of what the
client sent. Fixed upstream by pre-filling the model's response with `"language {Name}<asr_text>"`
before generation so it skips the free-guess step — verified independently against the live
endpoint: 「いいえ」/「はい」 both correct across repeated calls, English intake path and
longer-sentence transcription unaffected, latency unchanged (~0.3s). No app-side change was
needed — `providers.mjs` already sent `language=ja`/`en` per request throughout.

**Accepted residual gap:** forcing the language stops it from guessing the *wrong language*, but
a smaller, separate failure mode remains — occasionally the *wrong word within the correct
language* on very short/ambiguous audio, an accuracy ceiling of the 0.6B model rather than a
language-ID bug. The team operating the endpoint assessed the likely fix as a larger GPU-based
model; after discussion, decided (2026-09-06) to accept this gap rather than pursue that. The
app-side mitigation above (`stripSttArtifacts`, `looksLikeEnglish`'s 2+-word guard, `"unclear"`
grading) already covers this residual case gracefully — an occasional wrong-word transcript grades
`"unclear"` with an honest note rather than corrupting the Judge or blaming the learner, so no
further app-side work follows from this decision.

Judge output is addressed to the learner directly, second person ("you") — never narrated in
the third person ("the learner..."); both the deterministic fallback and the LLM prompt enforce
this (2026-09-05). The LLM's `perTurn` rows are matched back to turns by the `turn` number it
returns, never by array position — a missing/reordered/extra row would otherwise silently shift
every note onto the wrong turn, which reads to the learner as a fabricated mistake. Any row-count
mismatch falls back to the deterministic Judge rather than serving misaligned notes (2026-09-05).
