# ADR-0008: Practice dialogue is LLM-driven with the authored graph as fallback; practice avatar uses a live Perxona voice

P3 live testing showed the finite turn graph (ADR-0006) cannot absorb real-call variation:
an off-script learner only ever hits the authored recovery edges, so the call feels like a
menu, not a conversation. User direction (2026-08-29): the practice call must rely on the
LLM for its responses, and the practice avatar may use a Perxona voice. Separately, "Practice
again" must re-enter the call directly instead of resetting to Welcome.

## Decisions

- The Turn Router stays **blocking** and stays separate from the end-of-call Judge
  (ADR-0006), but its source changes: the homelab LLM, prompted with the scenario's
  **persona directive** + **scenario brief** + rubric and the raw transcript history,
  returns the outcome (advance / repeat / hint / help / reject-English / call-done) **and
  authors the avatar's next Japanese line**.
- The authored turn graph is demoted to a deterministic **fallback** for LLM timeout,
  malformed output, or no-LLM, and remains the source of Prep Lines, hints, and the
  no-LLM drill path. ADR-0002's "content is pre-generated" continues to govern Prep and
  the Review anchors; practice dialogue lines are now generated live inside the authored
  scenario frame.
- The practice avatar gets a fixed-target **Perxona Japanese voice**; LLM lines are spoken
  via native `present()`. BYO-TTS prerender (ADR-0004) is scoped to **Prep only**; the
  filler-Clause mechanism is retired from practice.
- **"Practice again"** re-enters Practice with the same scenario/variant (reset turns and
  recovery, re-initialize the avatar, LLM opening line). A full reset to Welcome is a
  separate action.

## Consequences

- The blocking router gets a latency budget (~8s timeout; model swappable via `LLM_MODEL`).
  Measured homelab strict-JSON latency is ~0.4–0.9s (gemma4-26b-a4b-nothink, 2026-08-29),
  so the budget is comfortable and the fallback covers the tail.
- Japanese-line-quality risk is mitigated by the persona/rubric prompt, the teineigo bar,
  and the end-of-call Judge backstop.
- The content schema grows additive `persona` / `brief` fields; the authored graph stays
  for fallback, so no-LLM and test drills keep working.
- The fallback path (timeout / malformed / unconfigured) must be covered by server tests.
