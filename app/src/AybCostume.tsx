/**
 * CATS costume for the "all your base" egg, drawn OVER Luna's live porthole
 * (the presenter element owns the head; this SVG wraps it as CATS' body).
 *
 * Reference: the Zero Wing "main screen" frame (aybabtu.png). CATS is the
 * pale-green humanoid boss — NOT a literal cat, despite the name — with dark
 * teal swept-up hair, an enormous ruffled purple cloak that rises to a high
 * pointed collar with a red gem, all backlit by a bright orange glow.
 *
 * Compositing (critical, see easter-eggs project memory): this sits at z-[21],
 * ON TOP of Luna's live <sv-presenter>. So we never paint over her face/eyes/
 * mouth. The cloak occupies only the lower/below-chin region (shoulders
 * downward); the side collar-frames and hair tufts stay at the outer edges; the
 * crest sits only above the hairline. The centre of the frame (x 32..68,
 * y 0..~60) is left fully open so the live head always shows through. Luna is
 * never resize/repositioned here — only `presenter.setZoom` (a CSS transform)
 * does, from Flow.tsx. Pure original vector art evoking the character — no
 * trace/copy of any copyrighted sprite. Anchored via viewBox 0 0 100 100 so it
 * scales off layout.size.
 */
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
        <radialGradient id="aybGlow" cx="50%" cy="46%" r="78%">
          <stop offset="0%" stopColor="#ff8a1e" stopOpacity="0.62" />
          <stop offset="46%" stopColor="#ee5a12" stopOpacity="0.36" />
          <stop offset="100%" stopColor="#ee5a12" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Bright orange backlight behind the figure (the reference's glow).
          Low enough opacity over the face that it warms rather than obscures. */}
      <rect x="0" y="0" width="100" height="100" fill="url(#aybGlow)" />

      {/* Main cape body: broad draped shoulders that peak at the FAR outer
          edges (well outside the face) and sit LOW (below the chin), dipping to
          a low centre neckline. The whole mouth/chin zone stays open. */}
      <path
        fill={PURPLE}
        d="M 0 100 L 0 70
            C 2 62, 8 56, 16 55
            C 24 54, 32 59, 37 64
            C 41 69, 46 70, 50 70
            C 54 70, 59 69, 63 64
            C 68 59, 76 54, 84 55
            C 92 56, 98 62, 100 70
            L 100 100 Z"
      />
      {/* Shoulder shading under the arms — broad dark lobes low at the sides. */}
      <path
        fill={PURPLE_SHADE}
        d="M 0 100 L 0 78 C 4 70, 14 66, 24 70 C 30 73, 34 79, 34 88 L 34 100 Z"
      />
      <path
        fill={PURPLE_SHADE}
        d="M 100 100 L 100 78 C 96 70, 86 66, 76 70 C 70 73, 66 79, 66 88 L 66 100 Z"
      />
      {/* Ruffled highlight along each shoulder. */}
      <path fill={PURPLE_HL} d="M 2 74 C 10 68, 22 67, 29 74 C 23 80, 12 82, 4 82 Z" />
      <path fill={PURPLE_HL} d="M 98 74 C 90 68, 78 67, 71 74 C 77 80, 88 82, 96 82 Z" />

      {/* High collar band wrapping the neck — thin and low (below the chin so
          the mouth stays clear). */}
      <path
        fill={PURPLE_DEEP}
        d="M 38 62 C 42 58, 58 58, 62 62 C 64 65, 62 68, 57 69 L 43 69 C 38 68, 36 65, 38 62 Z"
      />

      {/* Flowing fold lines on the cape. */}
      <path
        fill={PURPLE_DEEP}
        d="M 12 66 C 20 62, 28 64, 34 72 C 28 80, 20 88, 14 96 C 10 88, 9 76, 12 66 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 88 66 C 80 62, 72 64, 66 72 C 72 80, 80 88, 86 96 C 90 88, 91 76, 88 66 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 46 80 C 48 74, 52 74, 54 80 C 52 90, 48 90, 46 80 Z"
      />
      <path
        fill={PURPLE_DEEP}
        d="M 20 88 C 30 82, 42 84, 50 92 C 42 96, 30 96, 22 94 Z"
      />

      {/* Red gem set on the collar (character's left / viewer's right). */}
      <circle cx="67" cy="61" r="3.6" fill="#8a2018" />
      <circle cx="67" cy="61" r="2.6" fill="#e8483a" />
      <circle cx="66.1" cy="60.1" r="1" fill="#ffffff" opacity="0.85" />

      {/* Dark-teal swept-up crest — jagged spikes, base above the hairline. */}
      <path
        fill={TEAL_DARK}
        d="M 26 30 L 30 13 L 35 28 L 40 7 L 45 27 L 50 2 L 55 27 L 60 7 L 65 28 L 70 13 L 74 30 C 71 25, 66 23, 60 24 C 54 21, 46 21, 40 24 C 34 23, 29 25, 26 30 Z"
      />
      <path
        fill={TEAL}
        d="M 27 29 L 31 15 L 36 27 L 41 10 L 46 26 L 50 6 L 54 26 L 59 10 L 64 27 L 69 15 L 73 29 C 70 25, 65 24, 59 26 C 53 23, 47 23, 41 26 C 35 24, 30 25, 27 29 Z"
      />
      {/* Highlight along the crest spikes. */}
      <path fill={TEAL_HL} d="M 30 16 L 33 27 L 36 13 L 34 26 L 31 27 Z" />
      <path fill={TEAL_HL} d="M 49 5 L 51 25 L 53 6 L 52 24 Z" />
      <path fill={TEAL_HL} d="M 68 16 L 65 27 L 64 13 L 66 26 Z" />
      {/* Side hair tufts framing the temples — outer edges only. */}
      <path fill={TEAL} d="M 24 30 C 22 24, 22 19, 27 17 L 26 33 C 24 37, 22 35, 24 30 Z" />
      <path fill={TEAL} d="M 76 30 C 78 24, 78 19, 73 17 L 74 33 C 76 37, 78 35, 76 30 Z" />
    </svg>
  );
}
