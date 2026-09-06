# app — TagTeam frontend

React 19 + TypeScript + Vite + Tailwind v4 (CSS-first: no `tailwind.config`, tokens live in
`src/index.css`). The whole UI is two files: `src/App.tsx` (persistent top bar — brand left,
learner chip + settings right — plus presenter stage, content band, desktop phone bezel) and
`src/Flow.tsx` (the five screen phases — Welcome / Intake / Prep / Practice / Review — plus
the shared `LineCard` / `BigButton` primitives). The stage, band and phone rect are all
viewport-measured, so every layout offset adds `HEADER_H` (exported from `Flow.tsx`), the
single source of truth for the bar's height. `Doors.tsx` + `lib/door-timeline.ts` are the
readiness-gated load cover over the porthole (ADR-0011): pure timeline math, imperative
per-frame DOM writes, portaled to `<body>` above the stage.

```sh
npm run dev      # Vite dev server; proxies /api → http://localhost:8787
npm run build    # tsc -b && vite build → dist/ (the Express server serves it)
npm run lint     # oxlint
```

## Theming

Light / Dark / System (ADR-0010). `src/lib/theme.ts` resolves the preference to an explicit
`.dark` class on `<html>` — System via `matchMedia`, re-resolved live on OS changes — so
`src/index.css` keeps exactly two palette blocks (`:root` and `:root.dark`) rather than
duplicating the dark tokens under a media query. `index.html` applies the class pre-paint so a
stored dark preference never flashes light, and updates the `theme-color` meta to match.
Add new colors as CSS variables in both palette blocks and alias them in `@theme`; do not
hardcode hex values in components.

## Learner profiles

Local and auth-free (ADR-0010). `src/lib/profiles.ts` stores
`{ profiles, activeId, deviceTheme }` in `localStorage["tagteam.profiles"]`; the theme
preference rides on the active profile, falling back to `deviceTheme` before any profile
exists. Names are cosmetic — they greet the learner but are never sent to the Turn Router or
the Judge.
