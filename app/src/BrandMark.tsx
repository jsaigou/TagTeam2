import { useId } from "react";

const BUBBLE_D = "M8 12h48a8 8 0 0 1 8 8v20a8 8 0 0 1-8 8H26l-12 10v-10h-6a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8z";
const LEAF_D =
  "M32 46c-9 0-16-6.5-16-15 0-7 4.5-12.5 11-14.5C29 16 30 15.5 32 15c2 .5 3 1 5 .5C43.5 18.5 48 24 48 31c0 8.5-7 15-16 15z";
const HIGHLIGHT_D = "M26.5 35.5C34 27 42 25.5 44.5 24.5 46 27 46.5 30 46 32.5c-7.5 8.5-16 7-19.5 3z";

export function BrandMark({
  className = "",
  variant = "token",
}: {
  className?: string;
  /** "token" (default): theme-aware fills for a --background surface like
   *  the top bar. "fixed": the original favicon's literal gradient + palette
   *  (#386641→#22301f bubble, #a7c957 leaf, #f2e8cf highlight) — for a
   *  surface that is itself a theme token (Luna's door plaque), where a
   *  token-matched fill would vanish into its own matching background. */
  variant?: "token" | "fixed";
}) {
  const gradientId = useId();
  if (variant === "fixed") {
    return (
      <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
        <path d={BUBBLE_D} fill={`url(#${gradientId})`} />
        <path d={LEAF_D} fill="#a7c957" />
        <path d={HIGHLIGHT_D} fill="#f2e8cf" fillOpacity="0.7" />
        <defs>
          <linearGradient id={gradientId} x1="8" y1="12" x2="8" y2="50" gradientUnits="userSpaceOnUse">
            <stop stopColor="#386641" />
            <stop offset="1" stopColor="#22301f" />
          </linearGradient>
        </defs>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      <path d={BUBBLE_D} fill="var(--primary)" />
      <path d={LEAF_D} fill="var(--accent)" />
      <path d={HIGHLIGHT_D} fill="var(--background)" fillOpacity="0.7" />
    </svg>
  );
}
