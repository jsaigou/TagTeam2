/**
 * CATS costume (tableau) for the "all your base" egg, drawn OVER Luna's live
 * porthole. The presenter element owns the head; this SVG wraps it as CATS'
 * body — sized (CATS_CLOAK_SCALE in App.tsx) so the cloak extends far beyond
 * the porthole boundaries and Luna's live head reads small, like CATS atop his
 * huge cloak in the Zero Wing "main screen" frame (aybabtu.png).
 *
 * Compositing (critical, see easter-eggs project memory): this sits at z-[21],
 * ON TOP of Luna's live <sv-presenter>. We never paint over her face/eyes/mouth:
 * the cloak occupies only the below-chin region and the shoulders peak at the
 * far outer edges, so the head region (centre-upper) stays open. The container
 * is centred on the porthole, so her head lands near (50, ~42) in this
 * 0..100 viewBox. Luna is never resized/repositioned — only `presenter.setZoom`
 * (a CSS transform) does, from Flow.tsx. Pure original vector art evoking the
 * character — no trace/copy of any copyrighted sprite. Dialogue boxes render in
 * a separate z-[30] portal (Flow.tsx's AybOverlay) so they stay in front of the
 * cloak.
 */
export const CATS_CLOAK_SCALE = 2.4;

const PURPLE = "#5a2b7a";
const PURPLE_SHADE = "#3a1b52";
const PURPLE_DEEP = "#2a1240";
const PURPLE_HL = "#7a41a0";
const TEAL = "#255a60";
const TEAL_DARK = "#143a40";
const TEAL_HL = "#4f8f98";

export default function AybCostume() {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <radialGradient id="aybGlow" cx="50%" cy="58%" r="82%">
          <stop offset="0%" stopColor="#ff8a1e" stopOpacity="0.5" />
          <stop offset="45%" stopColor="#ee5a12" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#ee5a12" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Big orange backlight behind the whole figure. */}
      <rect x="0" y="0" width="100" height="100" fill="url(#aybGlow)" />

      {/* Main cape body: gently sloped draped shoulders that peak at the FAR
          outer edges (outside Luna's head) and sit LOW (below the chin), with a
          centre neckline that dips below the head — the whole mouth zone stays
          open. The cape sweeps out to every canvas edge. */}
      <path
        fill={PURPLE}
        d="M 0 100 L 0 64
            C 2 56, 8 51, 17 50
            C 26 49, 34 53, 39 58
            C 42 61, 45 63, 50 63
            C 55 63, 58 61, 61 58
            C 66 53, 74 49, 83 50
            C 92 51, 98 56, 100 64
            L 100 100 Z"
      />

      {/* Shoulder shading — subtle draped fold, merged into the cape so it reads
          as cloth rather than separate rounded lobes. */}
      <path
        fill={PURPLE_SHADE}
        d="M 0 100 L 0 72 C 6 64, 20 62, 30 70 C 36 76, 38 84, 38 100 Z"
      />
      <path
        fill={PURPLE_SHADE}
        d="M 100 100 L 100 72 C 94 64, 80 62, 70 70 C 64 76, 62 84, 62 100 Z"
      />
      {/* Ruffled highlight along each shoulder. */}
      <path fill={PURPLE_HL} opacity="0.7" d="M 2 70 C 9 65, 20 64, 28 70 C 22 75, 11 77, 3 77 Z" />
      <path fill={PURPLE_HL} opacity="0.7" d="M 98 70 C 91 65, 80 64, 72 70 C 78 75, 89 77, 97 77 Z" />

      {/* High collar band wrapping the neck — thin and low (below the chin). */}
      <path
        fill={PURPLE_DEEP}
        d="M 42 57 C 45 54, 55 54, 58 57 C 60 60, 58 62, 54 63 L 46 63 C 42 62, 40 60, 42 57 Z"
      />

      {/* Flowing fold lines sweeping down the cape. */}
      <path
        fill={PURPLE_DEEP}
        d="M 14 68 C 22 63, 32 65, 39 73 C 33 82, 24 91, 17 98 C 13 89, 11 77, 14 68 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 86 68 C 78 63, 68 65, 61 73 C 67 82, 76 91, 83 98 C 87 89, 89 77, 86 68 Z"
      />
      <path fill={PURPLE_DEEP} d="M 47 84 C 49 78, 51 78, 53 84 C 51 94, 49 94, 47 84 Z" />
      <path fill={PURPLE_DEEP} d="M 18 92 C 28 85, 40 87, 48 96 C 40 100, 28 100, 19 98 Z" />

      {/* Red gem on the collar (character's left / viewer's right). */}
      <circle cx="63" cy="60" r="3.6" fill="#8a2018" />
      <circle cx="63" cy="60" r="2.5" fill="#e8483a" />
      <circle cx="62" cy="59" r="1" fill="#ffffff" opacity="0.85" />

      {/* Dark-teal swept-up crest — sits just above Luna's head. */}
      <path
        fill={TEAL_DARK}
        d="M 37 31 L 41 15 L 45 29 L 49 12 L 53 29 L 57 15 L 61 31
            C 58 26, 54 25, 50 25 C 46 25, 42 26, 37 31 Z"
      />
      <path
        fill={TEAL}
        d="M 38 30 L 42 17 L 46 28 L 49 14 L 52 28 L 56 17 L 60 30
            C 57 26, 53 25, 50 25 C 47 25, 43 26, 38 30 Z"
      />
      {/* Highlight strokes on the crest. */}
      <path fill={TEAL_HL} d="M 42 17 L 45 27 L 46 17 L 44 26 Z" />
      <path fill={TEAL_HL} d="M 56 17 L 53 27 L 52 17 L 54 26 Z" />
      {/* Side hair tufts framing the temples — outer edges only. */}
      <path fill={TEAL} d="M 36 33 C 35 28, 35 24, 39 22 L 38 31 C 36 34, 35 34, 36 33 Z" />
      <path fill={TEAL} d="M 64 33 C 65 28, 65 24, 61 22 L 62 31 C 64 34, 65 34, 64 33 Z" />
    </svg>
  );
}
