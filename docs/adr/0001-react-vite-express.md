# ADR-0001: React 19 + Vite + Tailwind frontend, thin Express backend

We build the frontend in React 19 + TypeScript + Vite + Tailwind + shadcn/ui, matching
Perxona's own `motion-browser` reference app, so the proven `<sv-presenter>` integration
(`lib/presenter.ts` loader + `usePresenter` hook) can be adapted directly. The backend is a
thin Express (Node ≥22) server that mints the Connect token, proxies catalog/STT/LLM, and
serves the built app. This mirrors the connect-kit sample's auth model (one shared service
account mints a `connect_token` for the browser).

**Update (Sprint 5):** shadcn/ui was not installed — the project uses lightweight custom
components (`BigButton`, `LineCard`) which are sufficient for the MVP. The Tailwind CSS
variables follow the shadcn convention for theming, but no `components.json` or `components/ui/`
directory exists. This is acceptable: shadcn can be installed later if richer UI components
are needed (dialogs, dropdowns, etc.).
