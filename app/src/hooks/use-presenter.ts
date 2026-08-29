import { useCallback, useEffect, useRef, useState } from "react";
import { loadPresenterEngine, type Presenter, type PresentationTarget } from "../lib/presenter";

export interface UsePresenterOptions {
  stageRef: React.RefObject<HTMLDivElement | null>;
  presenterUrl?: string;
  onConnectTokenExpired?: () => void;
  onSpeechFinished?: () => void;
}

export interface UsePresenter {
  mounted: boolean;
  ready: boolean;
  loadError: Error | null;
  retry: () => void;
  resumeAudio: () => Promise<void>;
  initialize: (connectToken: string, target: PresentationTarget) => Promise<void>;
  present: (content: string) => Promise<unknown>;
  presentWithAudio: (audio: ArrayBuffer, transcript: string) => Promise<unknown>;
  /** Speak a line and resolve once playback finishes (awaits ALL_PERFORMANCE_FINISHED). */
  speakWithAudio: (audio: ArrayBuffer, transcript: string) => Promise<void>;
  /** Speak a native (Perxona voice) line and resolve once playback finishes. */
  speakText: (content: string) => Promise<void>;
  interruptPresentation: () => void;
  refreshConnectToken: (token: string) => void;
}

/** Owns the imperative `<sv-presenter>` lifecycle (adapted from motion-browser). */
export function usePresenter(options: UsePresenterOptions): UsePresenter {
  const { stageRef, presenterUrl, onConnectTokenExpired, onSpeechFinished } = options;
  const presenterRef = useRef<Presenter | null>(null);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const onExpiredRef = useRef(onConnectTokenExpired);
  const onSpeechFinishedRef = useRef(onSpeechFinished);
  const urlRef = useRef(presenterUrl);

  useEffect(() => {
    onExpiredRef.current = onConnectTokenExpired;
  }, [onConnectTokenExpired]);
  useEffect(() => {
    onSpeechFinishedRef.current = onSpeechFinished;
  }, [onSpeechFinished]);
  useEffect(() => {
    urlRef.current = presenterUrl;
  }, [presenterUrl]);

  useEffect(() => {
    let disposed = false;

    async function mount() {
      try {
        setLoadError(null);
        await loadPresenterEngine(urlRef.current);
        const stage = stageRef.current;
        if (disposed || !stage) return;

        const el = document.createElement("sv-presenter") as Presenter;
        el.hidden = true;
        el.style.width = "100%";
        el.style.height = "100%";
        el.addEventListener("PRESENTER_STATUS", (event) => {
          const { status: next } = (event as CustomEvent<{ status: string }>).detail;
          if (next === "Ready") {
            el.hidden = false;
            setReady(true);
            el.updateCameraFOV({ distance: 1, vertical: 0, horizontal: 4.5 });
          } else {
            setReady(false);
          }
        });
        el.addEventListener("CONNECT_TOKEN_EXPIRED", () => onExpiredRef.current?.());
        el.addEventListener("ALL_PERFORMANCE_FINISHED", () => onSpeechFinishedRef.current?.());
        stage.append(el);
        presenterRef.current = el;
        setMounted(true);
      } catch (err) {
        if (!disposed) setLoadError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    void mount();
    return () => {
      disposed = true;
      presenterRef.current?.remove();
      presenterRef.current = null;
      setMounted(false);
    };
  }, [stageRef, retryCount]);

  const retry = useCallback(() => setRetryCount((c) => c + 1), []);
  const resumeAudio = useCallback(async () => presenterRef.current?.resumeAudioPlayback(), []);
  const initialize = useCallback(
    async (token: string, target: PresentationTarget) => presenterRef.current?.initialize(token, target),
    [],
  );
  const present = useCallback(async (content: string) => presenterRef.current?.present(content), []);
  const presentWithAudio = useCallback(
    async (audio: ArrayBuffer, transcript: string) => presenterRef.current?.presentWithAudio(audio, transcript),
    [],
  );
  const waitForFinished = useCallback(() => {
    const el = presenterRef.current;
    if (!el) return Promise.resolve();
    if (typeof el.addEventListener === "function") {
      return new Promise<void>((resolve) => {
        let done = false;
        const onFinish = () => {
          if (done) return;
          done = true;
          el.removeEventListener("ALL_PERFORMANCE_FINISHED", onFinish);
          resolve();
        };
        el.addEventListener("ALL_PERFORMANCE_FINISHED", onFinish);
        setTimeout(onFinish, 60_000);
      });
    }
    return Promise.resolve();
  }, []);
  const speakWithAudio = useCallback(
    async (audio: ArrayBuffer, transcript: string) => {
      await presentWithAudio(audio, transcript);
      await waitForFinished();
    },
    [presentWithAudio, waitForFinished],
  );
  const speakText = useCallback(
    async (content: string) => {
      await present(content);
      await waitForFinished();
    },
    [present, waitForFinished],
  );
  const interruptPresentation = useCallback(() => presenterRef.current?.interruptPresentation(), []);
  const refreshConnectToken = useCallback((token: string) => presenterRef.current?.refreshConnectToken(token), []);

  return {
    mounted,
    ready,
    loadError,
    retry,
    resumeAudio,
    initialize,
    present,
    presentWithAudio,
    speakWithAudio,
    speakText,
    interruptPresentation,
    refreshConnectToken,
  };
}
