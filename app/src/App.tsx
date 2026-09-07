import { useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "./BrandMark";
import { fetchConnectConfig, type ConnectConfig } from "./lib/api";
import { usePresenter } from "./hooks/use-presenter";
import { ErrorBoundary } from "./ErrorBoundary";
import Flow, { HEADER_H, PORTHOLE_SIZE, PORTHOLE_TRANSITION_MS, PHONE_TRANSITION_MS, type StageLayout } from "./Flow";
import { addProfile, getActiveProfile, removeProfile, setActiveProfile, useProfileStore } from "./lib/profiles";
import { useTheme, type ThemePreference } from "./lib/theme";
import {
  EASTER_EGG_IDS,
  EASTER_EGG_LABELS,
  setEasterEggEnabled,
  setEasterEggsAlways,
  useEasterEggsAlways,
  useEnabledEasterEggs,
} from "./lib/easter-eggs";

const DEFAULT_LAYOUT: StageLayout = {
  fullscreen: false,
  visible: false,
  left: 16,
  top: HEADER_H + 16,
  size: PORTHOLE_SIZE,
  animate: false,
  bandTop: HEADER_H + 40,
};

// Raised-edge bevel with the depth falling to the bottom right.
const PORTHOLE_SHADOW =
  "4px 5px 0 rgb(0 0 0 / 0.35), 10px 14px 28px rgb(0 0 0 / 0.45), " +
  "inset 3px 3px 6px rgb(255 255 255 / 0.35), inset -4px -4px 8px rgb(0 0 0 / 0.3)";
// Luna's porthole is a character, not chrome — its resize/reposition gets a
// spring-flavored overshoot (easeOutBack) so it reads as alive, not robotic.
const EASE_BOUNCE = "cubic-bezier(0.34, 1.56, 0.64, 1)";
// The phone rect is UI chrome, not a character — plain strong ease-in-out,
// no overshoot.
const EASE_SMOOTH = "cubic-bezier(0.77, 0, 0.175, 1)";

const PORTHOLE_CRT_KEYFRAMES = `
@keyframes porthole-crt-flicker { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.55; } }
`;

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Shared by every element that tracks the phone rect (stage, content band,
// bezel) so they move as one piece instead of the stage animating while its
// frame snaps.
function phoneTransition(animate: boolean) {
  if (!animate || reducedMotion()) return "none";
  return (
    `left ${PHONE_TRANSITION_MS}ms ${EASE_SMOOTH}, top ${PHONE_TRANSITION_MS}ms ${EASE_SMOOTH}, ` +
    `width ${PHONE_TRANSITION_MS}ms ${EASE_SMOOTH}, height ${PHONE_TRANSITION_MS}ms ${EASE_SMOOTH}`
  );
}

function stageView(layout: StageLayout) {
  if (!layout.visible) {
    return {
      className: "fixed overflow-hidden border-white bg-card pointer-events-none",
      style: { display: "none" } as React.CSSProperties,
    };
  }
  if (layout.fullscreen) {
    return {
      className: `fixed overflow-hidden bg-card pointer-events-none${
        layout.framed ? " rounded-[2.4rem]" : ""
      }`,
      style: {
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        transition: phoneTransition(layout.animate),
      } as React.CSSProperties,
    };
  }
  return {
    className: "fixed z-20 overflow-hidden border-white bg-card pointer-events-none",
    style: {
      left: layout.left,
      top: layout.top,
      width: layout.size,
      height: layout.size,
      borderRadius: layout.size * 0.16,
      borderWidth: layout.size >= PORTHOLE_SIZE ? 8 : 6,
      boxShadow: PORTHOLE_SHADOW,
      transition:
        layout.animate && !reducedMotion()
          ? `left ${PORTHOLE_TRANSITION_MS}ms ${EASE_BOUNCE}, top ${PORTHOLE_TRANSITION_MS}ms ${EASE_BOUNCE}, ` +
            `width ${PORTHOLE_TRANSITION_MS}ms ${EASE_BOUNCE}, height ${PORTHOLE_TRANSITION_MS}ms ${EASE_BOUNCE}`
          : "none",
      // Active egg's filter in place only — left/top/width/height above are
      // completely untouched by `eggOverlay`. An earlier version instead
      // resized this element to fill the screen, which broke the presenter
      // widget's internal rendering permanently (see easter-eggs project memory).
      ...(layout.eggOverlay === "codec"
        ? {
            filter:
              "sepia(1) hue-rotate(55deg) saturate(4.5) brightness(1.25) contrast(1.15) " +
              "drop-shadow(0 0 6px rgba(0,255,0,0.7))",
          }
        : layout.eggOverlay === "ayb"
          ? {
              filter: "saturate(1.3) contrast(1.15) drop-shadow(0 0 6px rgba(70,130,255,0.6))",
            }
          : null),
    } as React.CSSProperties,
  };
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 opacity-70" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Closes a menu on pointer-down anywhere outside its wrapper. A full-viewport
// scrim can't be used here: the header's backdrop-blur makes it the containing
// block for fixed descendants, so a `fixed inset-0` scrim would only cover the
// 48px bar itself.
function useOutsideClose(open: boolean, setOpen: (open: boolean) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, setOpen]);
  return ref;
}

const MENU_PANEL = "absolute right-0 top-full z-10 mt-2 rounded-lg border border-border bg-card p-2 shadow-lg";

function ProfileMenu() {
  const store = useProfileStore();
  const active = getActiveProfile(store);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useOutsideClose(open, setOpen);

  const create = () => {
    if (!draft.trim()) return;
    addProfile(draft);
    setDraft("");
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-sm hover:border-primary transition-colors"
      >
        <span className="max-w-32 truncate">{active ? active.name : "Guest"}</span>
        <ChevronDown />
      </button>
      {open && (
        <div role="menu" aria-label="Learners" className={`${MENU_PANEL} w-60 space-y-1`}>
            {store.profiles.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No learners on this device yet.</p>
            )}
            {store.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setActiveProfile(profile.id);
                  setOpen(false);
                }}
                className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  profile.id === store.activeId ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {profile.name}
              </button>
            ))}
            <div className="flex gap-1 pt-1">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
                placeholder="Add learner…"
                aria-label="Learner name"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={create}
                disabled={!draft.trim()}
                className="rounded border border-border px-2 py-1 text-sm disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {active && (
              <button
                type="button"
                onClick={() => removeProfile(active.id)}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-destructive"
              >
                Remove {active.name}
              </button>
            )}
        </div>
      )}
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

// Shared pill switch for the two boolean-ish settings below (theme uses its
// own radio-style buttons instead — only these two are literal on/off toggles).
function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <span className={`inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${on ? "bg-primary" : "bg-border"}`}>
      <span
        className={`block h-3 w-3 mt-0.5 rounded-full bg-card transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}`}
      />
    </span>
  );
}

function SettingsMenu() {
  const { preference, setPreference } = useTheme();
  const easterEggsAlways = useEasterEggsAlways();
  const enabledEggs = useEnabledEasterEggs();
  const [open, setOpen] = useState(false);
  const rootRef = useOutsideClose(open, setOpen);
  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-full border border-border bg-card p-1.5 hover:border-primary transition-colors"
      >
        <GearIcon />
      </button>
      {open && (
        <div role="menu" aria-label="Settings" className={`${MENU_PANEL} w-48 space-y-1`}>
            <p className="px-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Theme</p>
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={preference === option.value}
                onClick={() => setPreference(option.value)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors ${
                  preference === option.value ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {option.label}
              </button>
            ))}
            <p className="px-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Easter eggs
            </p>
            {EASTER_EGG_IDS.map((id) => {
              const on = enabledEggs.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => setEasterEggEnabled(id, !on)}
                  className="w-full flex items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                >
                  <span>{EASTER_EGG_LABELS[id]}</span>
                  <ToggleSwitch on={on} />
                </button>
              );
            })}
            <p className="px-2 pb-1 text-[11px] text-muted-foreground">
              {enabledEggs.length >= 2
                ? "Both on — 50/50 chance which one plays."
                : enabledEggs.length === 1
                  ? "Only one enabled — it always plays when an egg fires."
                  : "None enabled — no eggs will play."}
            </p>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={easterEggsAlways}
              onClick={() => setEasterEggsAlways(!easterEggsAlways)}
              className="w-full flex items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted transition-colors"
            >
              <span>Always show on Prep</span>
              <ToggleSwitch on={easterEggsAlways} />
            </button>
        </div>
      )}
    </div>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

// One consistent bar on every screen: back (when available) + brand left,
// learner + settings right. `goBack` is the exact same handler the hardware/
// gesture back button calls (Flow reports it via onBackAvailable) — one
// definition of "what back means here," not two to keep in sync.
function AppHeader({ goBack }: { goBack: (() => void) | null }) {
  return (
    <header
      className="fixed inset-x-0 top-0 z-40 border-b border-border bg-card/85 backdrop-blur"
      style={{ height: HEADER_H }}
    >
      <div className="flex h-full items-center justify-between px-3 sm:px-4">
        <div className="flex items-center gap-2">
          {goBack && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="rounded-full border border-border bg-card p-1.5 hover:border-primary transition-colors"
            >
              <BackIcon />
            </button>
          )}
          <BrandMark className="h-7 w-7" />
          <span className="wordmark text-lg leading-none">
            Tag<span className="text-primary">Team</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ProfileMenu />
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<ConnectConfig | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMsg, setLoadMsg] = useState("");
  const [layout, setLayout] = useState<StageLayout>(DEFAULT_LAYOUT);
  const [goBack, setGoBack] = useState<(() => void) | null>(null);

  // Token refresh — ref so usePresenter can call it before presenter is available.
  const refreshTokenRef = useRef<() => void>(() => {});

  const presenter = usePresenter({
    stageRef,
    presenterUrl: config?.presenterUrl,
    onConnectTokenExpired: () => refreshTokenRef.current(),
  });

  useEffect(() => {
    let alive = true;
    fetchConnectConfig()
      .then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        setLoadState("ready");
      })
      .catch((err) => {
        if (!alive) return;
        setLoadMsg(`config error: ${(err as Error).message}`);
        setLoadState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    refreshTokenRef.current = () => {
      fetchConnectConfig()
        .then((cfg) => {
          setConfig(cfg);
          presenter.refreshConnectToken(cfg.connect_token);
        })
        .catch(() => {
          setLoadState("error");
          setLoadMsg("token refresh failed");
        });
    };
  }, [presenter]);

  const onStageLayout = useCallback((next: StageLayout) => setLayout(next), []);
  const onBackAvailable = useCallback((fn: (() => void) | null) => setGoBack(() => fn), []);

  if (loadState !== "ready" || !config) {
    const view = stageView(DEFAULT_LAYOUT);
    return (
      <>
        <AppHeader goBack={null} />
        <div ref={stageRef} className={view.className} style={view.style} />
        <main
          className="fixed inset-x-0 bottom-0 overflow-y-auto text-foreground p-6"
          style={{ top: DEFAULT_LAYOUT.bandTop }}
        >
          <p>{loadState === "loading" ? "Loading lesson…" : "Couldn’t load the lesson."}</p>
          {loadMsg && <p className="text-muted-foreground text-sm">{loadMsg}</p>}
          {loadState === "error" && (
            <button
              onClick={() => window.location.reload()}
              className="mt-3 px-4 py-2 rounded bg-primary text-primary-foreground"
            >
              Retry
            </button>
          )}
        </main>
      </>
    );
  }

  const view = stageView(layout);
  // The band shares the stage's exact rect whenever the stage is a bounded
  // "phone" (practice's call screen) — otherwise a caption or control bar
  // could land outside the video on a wide desktop window. Every other phase
  // keeps the normal full-width flow, offset below the top bar.
  const bandClassName = layout.fullscreen
    ? `fixed overflow-y-auto z-10${layout.framed ? " rounded-[2.4rem]" : ""}`
    : "fixed inset-x-0 bottom-0 overflow-y-auto z-10";
  const bandStyle: React.CSSProperties = layout.fullscreen
    ? {
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        transition: phoneTransition(layout.animate),
      }
    : { top: layout.bandTop };
  return (
    <>
      <AppHeader goBack={goBack} />
      <div ref={stageRef} className={view.className} style={view.style} />
      {/* Codec egg: scanline/vignette/flicker clipped to Luna's own window,
          same rect + rounded corners as the porthole itself (never a separate
          resized element — see stageView's `eggOverlay` branch above). */}
      {!layout.fullscreen && layout.visible && layout.eggOverlay === "codec" && (
        <div
          className="fixed z-[21] overflow-hidden pointer-events-none"
          style={{
            left: layout.left,
            top: layout.top,
            width: layout.size,
            height: layout.size,
            borderRadius: layout.size * 0.16,
          }}
        >
          <style>{PORTHOLE_CRT_KEYFRAMES}</style>
          <div
            className="absolute inset-0"
            style={{
              background:
                "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)",
            }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "radial-gradient(ellipse at center, transparent 35%, rgba(0,0,0,0.6) 100%)" }}
          />
          <div
            className="absolute inset-0"
            style={{ background: "rgba(0,255,0,0.05)", animation: "porthole-crt-flicker 0.12s infinite" }}
          />
        </div>
      )}
      {/* "All your base" egg's CATS costume, drawn OVER Luna's window (z-[21],
          same as the codec scanlines above), never touching her actual
          element underneath — same "decorate, don't resize/reposition" rule
          as the codec egg (see easter-eggs project memory). QA caught the
          first version approximating CATS as a literal cat (ears/whiskers) —
          CATS is a name, not a species: the Zero Wing final boss, described
          (per Toaplan/Villains-wiki summaries) as green-skinned with
          "weirdly-shaped" upright hair and an enormous purple cloak, seen
          only as a hologram. Approximated here as jagged green hair poking
          above the frame (clip-path zigzag) and a purple cloak draping past
          the frame's bottom edges (clip-path scallop) — pure CSS, no
          copyrighted sprite art. */}
      {!layout.fullscreen && layout.visible && layout.eggOverlay === "ayb" && (
        <div
          className="fixed z-[21] pointer-events-none"
          style={{ left: layout.left, top: layout.top, width: layout.size, height: layout.size }}
        >
          <div
            className="absolute inset-x-0"
            style={{
              top: -layout.size * 0.16,
              height: layout.size * 0.34,
              background: "#3f9e35",
              clipPath:
                "polygon(0% 100%, 8% 20%, 18% 100%, 28% 5%, 38% 100%, 50% 15%, 62% 100%, 74% 8%, 84% 100%, 92% 25%, 100% 100%)",
            }}
          />
          <div
            className="absolute"
            style={{
              left: -layout.size * 0.12,
              right: -layout.size * 0.12,
              bottom: 0,
              height: layout.size * 0.44,
              background: "#4b1d6e",
              clipPath:
                "polygon(0% 40%, 10% 15%, 20% 35%, 30% 10%, 40% 32%, 50% 5%, 60% 32%, 70% 10%, 80% 35%, 90% 15%, 100% 40%, 100% 100%, 0% 100%)",
            }}
          />
        </div>
      )}
      {/* Content band: own scroll region; Flow measures it to pose the porthole. */}
      <div ref={bandRef} className={bandClassName} style={bandStyle}>
        <ErrorBoundary>
          <Flow
            presenter={presenter}
            token={config.connect_token}
            config={config}
            scrollRef={bandRef}
            onStageLayout={onStageLayout}
            onBackAvailable={onBackAvailable}
          />
        </ErrorBoundary>
        {!presenter.mounted && !presenter.loadError && (
          <p className="text-center text-xs text-muted-foreground mb-4">loading presenter engine…</p>
        )}
        {presenter.loadError && (
          <div className="text-center text-sm text-destructive p-4">
            Presenter error: {presenter.loadError.message}
            <button onClick={presenter.retry} className="ml-3 px-3 py-1 rounded bg-destructive text-destructive-foreground">
              Retry
            </button>
          </div>
        )}
      </div>
      {/* Phone bezel: decorative only, drawn around the same rect whenever it's
          letterboxed inside a wider viewport (desktop) — frames idle/dialing/
          connected alike so the whole call reads as one phone throughout. */}
      {layout.fullscreen && layout.framed && (
        <div
          className="fixed z-20 pointer-events-none rounded-[2.8rem] border-[10px] border-neutral-900"
          style={{
            left: layout.left - 10,
            top: layout.top - 10,
            width: (layout.width ?? 0) + 20,
            height: (layout.height ?? 0) + 20,
            boxShadow: "0 30px 60px -20px rgb(0 0 0 / 0.5)",
            transition: phoneTransition(layout.animate),
          }}
        >
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-1/3 h-1 rounded-full bg-white/30" />
        </div>
      )}
    </>
  );
}
