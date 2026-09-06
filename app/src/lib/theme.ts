import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { getActiveProfile, getProfileStore, setDeviceTheme, setProfileTheme, subscribeProfiles } from "./profiles";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const DARK_MQ = "(prefers-color-scheme: dark)";

// Mirrors the <meta name="theme-color"> and the pre-paint script in index.html —
// keep all three in sync when the palettes in index.css change.
const THEME_COLOR: Record<ResolvedTheme, string> = { light: "#386641", dark: "#1a241a" };

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia(DARK_MQ).matches ? "dark" : "light";
}

export function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[resolved]);
}

export function useTheme() {
  const store = useSyncExternalStore(subscribeProfiles, getProfileStore);
  const preference = getActiveProfile(store)?.theme ?? store.deviceTheme;
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(preference);
      setResolved(next);
      applyTheme(next);
    };
    apply();
    const mq = window.matchMedia(DARK_MQ);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [preference]);

  // Per-profile once a profile exists; device-level until then, so the toggle
  // works on first visit before anyone has named themselves.
  const setPreference = useCallback((next: ThemePreference) => {
    const current = getProfileStore();
    const active = getActiveProfile(current);
    if (active) setProfileTheme(active.id, next);
    else setDeviceTheme(next);
  }, []);

  return { preference, resolved, setPreference };
}
