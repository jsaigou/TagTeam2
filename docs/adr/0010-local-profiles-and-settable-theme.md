# ADR-0010: Local auth-free learner profiles + a settable Light/Dark/System theme

Reintroduced from the prior TagTeam app in narrowed form (2026-09-06), per the phase that
restores branding, multi-user support, and a theme setting. **Profiles are local and
auth-free**: `src/lib/profiles.ts` keeps `{ profiles, activeId, deviceTheme }` in
`localStorage["tagteam.profiles"]`, each profile being `{ id, name, createdAt, theme }`. The
Welcome screen offers chips to switch learner, an input to add one, and remove for the active
one. This deliberately does **not** reintroduce the old app's better-auth + SQLite stack:
`AGENTS.md`/`PLAN.md` exclude accounts and databases because feature sprawl sank the prior
attempt, and TagTeam2 has no per-user data to protect (no history, progress, or saved
scenarios — sessions are transient), so auth would guard an empty room while adding the first
write-path and first storage dependency to a one-dependency server. Names are **cosmetic
only**: they greet the learner on Welcome and in Luna's spoken intake greeting, and are never
sent to `/api/route-turn` or `/api/review`, so `rules.mjs`'s "never invent or assume the
learner's name" guard stays true; filling slots from the profile is a possible later sprint,
not part of this one. Theme is a **per-profile preference** (the old app's browser-global
`tagteam.theme` key let two people on one browser fight over it), with a device-level fallback
until a profile exists. Three states — Light / Dark / System — resolved in `src/lib/theme.ts`
to an explicit `.dark` class on `<html>` via `matchMedia`, so `src/index.css` holds exactly two
palette blocks instead of duplicating the dark tokens under a media query; `index.html`
applies the class pre-paint to avoid a light flash, fixing a defect the old implementation
had. Brand identity (Fraunces display face, speech-bubble + leaf mark, favicon/touch-icon set,
`theme-color` meta) is carried by **one persistent top bar on every screen** — mark + wordmark
left, learner chip and settings menu right (added later on 2026-09-06 after the first
Welcome-only arrangement read as a poster rather than an app; the bar's inline mark uses theme
tokens instead of the favicon's fixed gradient, which vanishes into the dark card at 24 px).
Because the stage, content band and phone rect are all viewport-measured, the bar's height is
a single exported constant (`HEADER_H` in `Flow.tsx`) that every layout offset adds, and
`StageLayout.bandTop` became a numeric px offset rather than a Tailwind class. No further
chrome (footer, side nav) and no second brand block on Welcome.
