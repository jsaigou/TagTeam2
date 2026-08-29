import { useEffect, useRef, useState } from "react";
import { fetchConnectConfig, type ConnectConfig } from "./lib/api";
import { usePresenter } from "./hooks/use-presenter";
import { ErrorBoundary } from "./ErrorBoundary";
import Flow from "./Flow";

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<ConnectConfig | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMsg, setLoadMsg] = useState("");
  const [stageFullscreen, setStageFullscreen] = useState(false);

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

  if (loadState !== "ready" || !config) {
    return (
      <>
        <div
          ref={stageRef}
          className="fixed inset-x-0 top-0 bottom-1/4 sm:bottom-1/3 bg-card border-b border-border pointer-events-none"
        />
        <main className="min-h-svh bg-background text-foreground p-6">
          <div className="relative z-10">
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
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <div
        ref={stageRef}
        className={
          stageFullscreen
            ? "fixed inset-0 bg-card pointer-events-none"
            : "fixed inset-x-0 top-0 bottom-1/4 sm:bottom-1/3 bg-card border-b border-border pointer-events-none"
        }
      />
      <ErrorBoundary>
        <Flow
          presenter={presenter}
          token={config.connect_token}
          config={config}
          onFullscreenStage={setStageFullscreen}
        />
      </ErrorBoundary>
      {!presenter.mounted && !presenter.loadError && (
        <p className="relative z-10 text-center text-xs text-muted-foreground -mt-4 mb-4">loading presenter engine…</p>
      )}
      {presenter.loadError && (
        <div className="relative z-10 text-center text-sm text-destructive p-4">
          Presenter error: {presenter.loadError.message}
          <button onClick={presenter.retry} className="ml-3 px-3 py-1 rounded bg-destructive text-white">
            Retry
          </button>
        </div>
      )}
    </>
  );
}
