# ADR-0011: Luna's door — a readiness-gated cover over the porthole masks presenter init

Reintroduced 2026-09-06 from the prior app's "doors" load cover, in narrowed form. Measured
dead time in TagTeam2: Start → presenter `Ready` ≈ **3.8 s warm**, entirely inside
`presenter.initialize()` (connect-token mint ≈1–2 ms; the presenter CDN script is already
loaded during Welcome); `waitReady`'s 10 s cap is the outer bound. Previously that wait was a
disabled-looking Welcome with the text "warming up Luna…".

**Function, not the old implementation.** The prior app's doors were a fixed 6350 ms
time-driven sequence that never awaited or observed the launch promise ("doubles as
asset-loading cover") — on a slow init the cover lifted on schedule onto a still-loading
stage. TagTeam2's cover inverts that: `begin()` enters Intake immediately (the rest of the
screen is live at once) and the cover's **swing-open is gated on `presenter.ready`**; a slow
init holds the doors shut (breathing seam + "waking Luna…") until `CAP_MS` (9 s), then fades
anyway so the normal loading/error UI can show — it can never trap the learner. Tap / Enter /
Space skips with a 200 ms fade. `prefers-reduced-motion` collapses the theatre to an opaque
panel cross-fade. No knock SFX in v1 (the ringback already owns audio-masking); the skin is
brand tokens (`--primary` leaves, `--accent` knobs/seam, `--background` jamb), not the prior
app's walnut.

**Shape and placement.** Porthole-only, not full-viewport: what loads is Luna, so cover Luna;
the rest of Intake stays usable and the reveal needs no repositioning. `Doors.tsx` portals to
`document.body` (the band and stage are stacking contexts — an overlay inside them paints
below the presenter's opaque canvas; the prior app hit the same bug) and positions itself
imperatively from a `measure()` callback each frame so it tracks band scroll without
re-rendering. The opaque jamb hides the loading porthole from frame zero and lifts only as the
leaves part. While the cover holds, the stage stays `visible: false` (the doors are the
porthole's surface until the swing reveals her — the prior app hid the stage for the same
reason). Timeline math is a pure `computeDoorFrame(t, openAt, swing)` in
`lib/door-timeline.ts` (deterministic, skippable); per-frame values are written to the DOM
imperatively, no React re-render per frame.

**Layout coupling fixed along the way.** The porthole pose is measured from the band, whose
per-phase top offset commits only in *response* to the pose push — so the first push after a
phase change measured one offset stale and posed the porthole 24 px off its slot on
Welcome→Intake. Intake/Prep now measure a dedicated slot ref (`slotRef`), and a short
post-push timer re-poses once the offset lands (hidden behind the cover regardless).

**Not done:** no app-side test harness exists for the timeline (house tests are server-side
`node --test`); verified live in the browser instead.

**Verification notes (2026-09-06).** Numerically: the cover sits at the settled slot rect from
its first frame (band-relative measurement), contains the stage rect with a 12 px overscan,
the stage stays `display:none` for the whole cover window, and the sequence holds → swings on
Ready → reveals → dismisses (skip and the 9 s cap exercised). Two harness caveats worth
knowing: Orca's tab does not paint between forced captures, so rAF-driven work (the door
timeline and the pose pushes) runs in bursts and produces frozen, misleading composites —
early "bezel peeking" frames were that starvation, not user-facing behavior. As a belt and
braces for real backgrounded tabs too, a 100 ms interval re-asserts the pose/gate while the
cover is up, and the cover root carries an inline max z-index so no presenter layer can paint
over it. A real-browser eyeball of the swing is still the one check the harness can't give.
