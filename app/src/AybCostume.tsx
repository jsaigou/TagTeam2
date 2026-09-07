/**
 * CATS costume (tableau) for the "all your base" egg, drawn OVER Luna's live
 * porthole. The presenter element owns the head; this SVG wraps it as CATS'
 * body — but sized so the cloak extends far beyond the porthole boundaries and
 * Luna (a live, small head) sits inside a much larger tableau, like CATS' head
 * atop an enormous cloak in the Zero Wing "main screen" frame (aybabtu.png).
 *
 * Compositing (critical, see easter-eggs project memory): this sits at z-[21],
 * ON TOP of Luna's live <sv-presenter>. We never paint over her face/eyes/mouth:
 * the cloak occupies only the below-chin region and the shoulders peak at the
 * far outer edges, so the head region stays open. The container is centred on
 * the porthole (see CATS_CLOAK_SCALE in App.tsx), so her head lands near (50, 44)
 * in this 0 0 100 100 viewBox. Luna is never resized/repositioned — only
 * `presenter.setZoom` (a CSS transform) does, from Flow.tsx. Pure original
 * vector art evoking the character — no trace/copy of any copyrighted sprite.
 */
export const CATS_CLOAK_SCALE = 3.2;

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
        <radialGradient id="aybGlow" cx="50%" cy="54%" r="82%">
          <stop offset="0%" stopColor="#ff8a1e" stopOpacity="0.5" />
          <stop offset="45%" stopColor="#ee5a12" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#ee5a12" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Big orange backlight behind the whole figure — soft radial that fades
          out by the canvas edges (no hard rectangular glow). */}
      <rect x="0" y="0" width="100" height="100" fill="url(#aybGlow)" />

      {/* Main cape body: broad draped shoulders whose peaks sit at the FAR
          outer edges (outside Luna's small head) and high enough to read as a
          huge cloak, dipping to a LOW centre neckline below her chin so the
          mouth zone stays open. The cape sweeps out to every canvas edge. */}
      <path
        fill={PURPLE}
        d="M 0 100 L 0 58
            C 2 50, 9 45, 19 45
            C 29 45, 37 50, 42 56
            C 45 61, 47 63, 50 63
            C 53 63, 55 61, 58 56
            C 63 50, 71 45, 81 45
            C 91 45, 98 50, 100 58
            L 100 100 Z"
      />

      {/* Shoulder shading — broad dark lobes low at the outer sides. */}
      <path
        fill={PURPLE_SHADE}
        d="M 0 100 L 0 70 C 3 62, 13 57, 24 61 C 31 64, 35 71, 35 80 L 35 100 Z"
      />
      <path
        fill={PURPLE_SHADE}
        d="M 100 100 L 100 70 C 97 62, 87 57, 76 61 C 69 64, 65 71, 65 80 L 65 100 Z"
      />
      {/* Ruffled highlight along each shoulder. */}
      <path fill={PURPLE_HL} d="M 2 66 C 9 60, 21 59, 29 66 C 23 72, 11 74, 3 74 Z" />
      <path fill={PURPLE_HL} d="M 98 66 C 91 60, 79 59, 71 66 C 77 72, 89 74, 97 74 Z" />

      {/* High collar band wrapping the neck — thin and low (below the chin). */}
      <path
        fill={PURPLE_DEEP}
        d="M 40 57 C 44 53, 56 53, 60 57 C 62 60, 60 63, 55 64 L 45 64 C 40 63, 38 60, 40 57 Z"
      />
      {/* Pointed collar tips rising toward the jaw (outer edges only). */}
      <path fill={PURPLE_SHADE} d="M 34 52 L 42 44 L 45 54 L 38 55 L 36 55 Z" />
      <path fill={PURPLE_SHADE} d="M 66 52 L 58 44 L 55 54 L 62 55 L 64 55 Z" />

      {/* Flowing fold lines sweeping down the big cape. */}
      <path
        fill={PURPLE_DEEP}
        d="M 14 66 C 22 61, 32 63, 39 71 C 33 80, 24 89, 17 97 C 13 88, 11 76, 14 66 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 86 66 C 78 61, 68 63, 61 71 C 67 80, 76 89, 83 97 C 87 88, 89 76, 86 66 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 47 82 C 49 76, 51 76, 53 82 C 51 92, 49 92, 47 82 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 18 90 C 28 83, 40 85, 48 94 C 40 98, 28 98, 19 96 Z"
      />

      {/* Red gem on the collar (character's left / viewer's right). */}
      <circle cx="66" cy="59" r="3.8" fill="#8a2018" />
      <circle cx="66" cy="59" r="2.7" fill="#e8483a" />
      <circle cx="65" cy="58" r="1.1" fill="#ffffff" opacity="0.85" />

      {/* Dark-teal swept-up crest — small, sitting above Luna's little head. */}
      <path
        fill={TEAL_DARK}
        d="M 38 44 L 42 28 L 46 42 L 50 25 L 54 42 L 58 28 L 62 44
            C 59 39, 55 38, 50 38 C 45 38, 41 39, 38 44 Z"
      />
      <path
        fill={TEAL}
        d="M 39 43 L 43 30 L 47 41 L 50 27 L 53 41 L 57 30 L 61 43
            C 58 39, 54 38, 50 38 C 46 38, 42 39, 39 43 Z"
      />
      {/* Highlight strokes on the crest. */}
      <path fill={TEAL_HL} d="M 43 30 L 46 40 L 47 30 L 45 39 Z" />
      <path fill={TEAL_HL} d="M 57 30 L 54 40 L 53 30 L 55 39 Z" />
      {/* Side hair tufts framing the temples — outer edges only. */}
      <path fill={TEAL} d="M 37 46 C 36 41, 36 37, 40 35 L 39 44 C 37 47, 36 47, 37 46 Z" />
      <path fill={TEAL} d="M 63 46 C 64 41, 64 37, 60 35 L 61 44 C 63 47, 64 47, 63 46 Z" />
    </svg>
  );
}
