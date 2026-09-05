import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPresenterEngine,
  type PresentOptions,
  type Presenter,
  type PresentationResult,
  type PresentationTarget,
} from "../lib/presenter";

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
  present: (content: string, options?: PresentOptions) => Promise<PresentationResult | undefined>;
  /** Speak a native (Perxona voice) line and resolve once playback finishes.
   *  Throws if the presentation request itself failed (PresentationResult.success === false). */
  speakText: (content: string, options?: PresentOptions) => Promise<void>;
  setListening: (isListening: boolean) => void;
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
            // horizontal 0: any sideways pan un-centers Luna in the square porthole
            el.updateCameraFOV({ distance: 1, vertical: 0, horizontal: 0 });
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
  // `initialize` (Bearer JWT) is deprecated upstream in favor of
  // `initializeWithConnectKey`, but scoped Connect keys are not yet
  // provisionable — JWT stays until Perxona ships key management.
  const initialize = useCallback(
    async (token: string, target: PresentationTarget) => presenterRef.current?.initialize(token, target),
    [],
  );
  const present = useCallback(
    async (content: string, options?: PresentOptions) => presenterRef.current?.present(content, options),
    [],
  );
  const setListening = useCallback((isListening: boolean) => presenterRef.current?.setListening(isListening), []);
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
  const speakText = useCallback(
    async (content: string, options?: PresentOptions) => {
      const result = await present(content, options);
      if (result && !result.success) {
        // Fail fast instead of waiting out the 60s finish timeout on a
        // presentation that never started (no voice, not ready, …).
        throw new Error(`presentation failed (${result.code}): ${result.message || "unknown"}`);
      }
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
    speakText,
    setListening,
    interruptPresentation,
    refreshConnectToken,
  };
}
