# ADR-0003: Vertical slice first — one scenario × one variant in the MVP

We build the entire flow (Intake → Prep → Practice → Summary) end to end for a single
scenario and a single variant before scaling to 5 scenarios × 3 variants. This is a direct
reaction to the prior attempt, which failed partly from feature sprawl. The full content set
is authored and validated, but only one slice is wired into the running app initially.
