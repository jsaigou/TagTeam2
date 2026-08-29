# ADR-0002: Content is pre-generated, never generated live

All Scenario text, translations, and dialogue are authored up front and stored in the repo
(`content/`). The app never generates Japanese content live. This makes the deliverable
deterministic, reviewable, and demo-safe, and it is what enables prerendering the audio.
