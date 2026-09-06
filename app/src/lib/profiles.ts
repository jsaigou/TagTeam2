import { useSyncExternalStore } from "react";
import type { ThemePreference } from "./theme";

// Local, auth-free learner profiles (ADR-0010). Several people can share one
// browser: each profile carries its own name and theme preference. Nothing is
// sent to the server and nothing is synced — this is deliberately not accounts.
export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  theme: ThemePreference;
}

export interface ProfileStore {
  profiles: Profile[];
  activeId: string | null;
  /** Theme used until a profile exists, and the seed for new profiles. */
  deviceTheme: ThemePreference;
}

const STORAGE_KEY = "tagteam.profiles";

const DEFAULT_STORE: ProfileStore = { profiles: [], activeId: null, deviceTheme: "system" };

function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function load(): ProfileStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STORE;
    const parsed = JSON.parse(raw) as Partial<ProfileStore>;
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles
          .filter((p): p is Profile => !!p && typeof p.id === "string" && typeof p.name === "string")
          .map((p) => ({ ...p, theme: normalizeTheme(p.theme) }))
      : [];
    const activeId =
      typeof parsed.activeId === "string" && profiles.some((p) => p.id === parsed.activeId) ? parsed.activeId : null;
    return { profiles, activeId, deviceTheme: normalizeTheme(parsed.deviceTheme) };
  } catch {
    return DEFAULT_STORE;
  }
}

let state: ProfileStore = load();
const listeners = new Set<() => void>();

function commit(next: ProfileStore) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-browsing / storage-full: keep working in memory only.
  }
  listeners.forEach((listener) => listener());
}

export function subscribeProfiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProfileStore(): ProfileStore {
  return state;
}

export function useProfileStore(): ProfileStore {
  return useSyncExternalStore(subscribeProfiles, getProfileStore);
}

export function getActiveProfile(store: ProfileStore = state): Profile | null {
  return store.profiles.find((p) => p.id === store.activeId) ?? null;
}

export function addProfile(name: string): Profile {
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: name.trim(),
    createdAt: Date.now(),
    theme: state.deviceTheme,
  };
  commit({ ...state, profiles: [...state.profiles, profile], activeId: profile.id });
  return profile;
}

export function setActiveProfile(id: string | null) {
  commit({ ...state, activeId: id });
}

export function removeProfile(id: string) {
  commit({
    ...state,
    profiles: state.profiles.filter((p) => p.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
  });
}

export function setProfileTheme(id: string, theme: ThemePreference) {
  commit({ ...state, profiles: state.profiles.map((p) => (p.id === id ? { ...p, theme } : p)) });
}

export function setDeviceTheme(theme: ThemePreference) {
  commit({ ...state, deviceTheme: theme });
}
