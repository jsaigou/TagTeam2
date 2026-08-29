import { useEffect, useRef, useState } from "react";
import { fetchConnectConfig } from "./lib/api";
import { usePresenter } from "./hooks/use-presenter";
import Flow from "./Flow";

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const presenter = usePresenter({ stageRef });
  const [token, setToken] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadMsg, setLoadMsg] = useState("");

  useEffect(() => {
    let alive = true;
    fetchConnectConfig()
      .then((cfg) => {
        if (!alive) return;
        setToken(cfg.connect_token);
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

  if (loadState !== "ready" || !token) {
    return (
      <main className="min-h-svh bg-background text-foreground p-6">
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
    );
  }

  return (
    <>
      <Flow presenter={presenter} stageRef={stageRef} token={token} />
      {!presenter.mounted && !presenter.loadError && (
        <p className="text-center text-xs text-muted-foreground -mt-4 mb-4">loading presenter engine…</p>
      )}
      {presenter.loadError && (
        <div className="text-center text-sm text-destructive p-4">
          Presenter error: {presenter.loadError.message}
          <button onClick={presenter.retry} className="ml-3 px-3 py-1 rounded bg-destructive text-white">
            Retry
          </button>
        </div>
      )}
    </>
  );
}
