// The speech-bubble + leaf mark, inlined so it can be sized and travels with
// the bundle (the same art ships as /favicon.svg and the touch icons). Here the
// fills are theme tokens, not the favicon's fixed gradient: at small sizes on a
// dark surface a #386641→#22301f bubble vanishes into the card.
export function BrandMark({
  className = "",
  bubbleFill = "var(--primary)",
}: {
  className?: string;
  /** Override when the mark sits on a --primary-colored surface (e.g. Luna's
   *  door) — the default matches --background surfaces like the top bar. */
  bubbleFill?: string;
}) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <path
        d="M8 12h48a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H26l-12 10v-10h-6a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8z"
        fill={bubbleFill}
      />
      <path
        d="M32 46c-9 0-16-6.5-16-15 0-7 4.5-12.5 11-14.5C29 16 30 15.5 32 15c2 .5 3 1 5 .5C43.5 18.5 48 24 48 31c0 8.5-7 15-16 15z"
        fill="var(--accent)"
      />
      <path
        d="M26.5 35.5C34 27 42 25.5 44.5 24.5 46 27 46.5 30 46 32.5c-7.5 8.5-16 7-19.5 3z"
        fill="var(--background)"
        fillOpacity="0.7"
      />
    </svg>
  );
}
