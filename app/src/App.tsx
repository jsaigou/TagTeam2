import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConnectConfig, type ConnectConfig } from "./lib/api";
import { usePresenter } from "./hooks/use-presenter";
import { ErrorBoundary } from "./ErrorBoundary";
import Flow, { PORTHOLE_SIZE, type StageLayout } from "./Flow";

const DEFAULT_LAYOUT: StageLayout = {
  fullscreen: false,
  visible: false,
  left: 16,
  top: 16,
  size: PORTHOLE_SIZE,
  animate: false,
  bandTop: "top-10",
};

// Raised-edge bevel with the depth falling to the bottom right.
const PORTHOLE_SHADOW =
  "4px 5px 0 rgb(0 0 0 / 0.35), 10px 14px 28px rgb(0 0 0 / 0.45), " +
  "inset 3px 3px 6px rgb(255 255 255 / 0.35), inset -4px -4px 8px rgb(0 0 0 / 0.3)";
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

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
      transition: layout.animate
        ? `left 0.6s ${EASE}, top 0.6s ${EASE}, width 0.6s ${EASE}, height 0.6s ${EASE}`
        : "none",
    } as React.CSSProperties,
  };
}

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<ConnectConfig | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMsg, setLoadMsg] = useState("");
  const [layout, setLayout] = useState<StageLayout>(DEFAULT_LAYOUT);

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

  if (loadState !== "ready" || !config) {
    const view = stageView(DEFAULT_LAYOUT);
    return (
      <>
        <div ref={stageRef} className={view.className} style={view.style} />
        <main className={`fixed inset-x-0 bottom-0 ${DEFAULT_LAYOUT.bandTop} overflow-y-auto text-foreground p-6`}>
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
  // keeps the normal full-width, top-offset flow.
  const bandClassName = layout.fullscreen
    ? `fixed overflow-y-auto z-10${layout.framed ? " rounded-[2.4rem]" : ""}`
    : `fixed inset-x-0 bottom-0 ${layout.bandTop} overflow-y-auto z-10`;
  const bandStyle: React.CSSProperties | undefined = layout.fullscreen
    ? { left: layout.left, top: layout.top, width: layout.width, height: layout.height }
    : undefined;
  return (
    <>
      <div ref={stageRef} className={view.className} style={view.style} />
      {/* Content band: own scroll region; Flow measures it to pose the porthole. */}
      <div ref={bandRef} className={bandClassName} style={bandStyle}>
        <ErrorBoundary>
          <Flow
            presenter={presenter}
            token={config.connect_token}
            config={config}
            scrollRef={bandRef}
            onStageLayout={onStageLayout}
          />
        </ErrorBoundary>
        {!presenter.mounted && !presenter.loadError && (
          <p className="text-center text-xs text-muted-foreground mb-4">loading presenter engine…</p>
        )}
        {presenter.loadError && (
          <div className="text-center text-sm text-destructive p-4">
            Presenter error: {presenter.loadError.message}
            <button onClick={presenter.retry} className="ml-3 px-3 py-1 rounded bg-destructive text-white">
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
          }}
        >
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-1/3 h-1 rounded-full bg-white/30" />
        </div>
      )}
    </>
  );
}
