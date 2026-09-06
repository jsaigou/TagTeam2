import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadPresenterEngine,
  type CameraAngle,
  type PresentOptions,
  type Presenter,
  type PresentationResult,
  type PresentationTarget,
} from "../lib/presenter";

// The Perxona widget's updateCameraFOV `distance` param is a no-op on this
// character rig (confirmed live: 0.05 through 5 render identically) — pan
// (vertical/horizontal) works but there's no SDK-level zoom. So the shrunk
// Prep porthole crops in with a CSS transform on the element instead: scale
// it up past its container (which clips via overflow-hidden) with the
// transform-origin biased toward the top so the crop centers on Luna's head
// rather than her torso.
const ZOOM_SCALE = 1.6;
const ZOOM_ORIGIN = "50% 27%";

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
  /** Resolve once the widget reports Ready after an (re-)initialize — present()
   *  before that fails with PRESENTER_NOT_READY. Falls through on timeout. */
  waitReady: (timeoutMs?: number) => Promise<void>;
  present: (content: string, options?: PresentOptions) => Promise<PresentationResult | undefined>;
  /** Speak a native (Perxona voice) line and resolve once playback finishes.
   *  Throws if the presentation request itself failed (PresentationResult.success === false). */
  speakText: (content: string, options?: PresentOptions) => Promise<void>;
  /** Play caller-provided audio (e.g. our own pregenerated TTS) through the
   *  avatar instead of its native voice — same completion/error contract as
   *  speakText. */
  speakAudio: (audio: ArrayBuffer, content: string, options?: PresentOptions) => Promise<void>;
  setListening: (isListening: boolean) => void;
  /** Head-to-toe vs. a video-call bust shot. "halfbody" is what makes the
   *  full-bleed Practice call read as a video call instead of a full-body
   *  render in front of the scene's background. */
  setCameraAngle: (angle: "fullbody" | "halfbody") => void;
  /** Crop in on Luna's head via a CSS scale (default ZOOM_SCALE, for the
   *  shrunk Prep porthole); `false` restores the resting framing. `scale`
   *  and `durationMs` (default 300) let callers with a bigger/slower crop
   *  in mind (the codec egg's close-up) override both without touching the
   *  already-tuned reading-porthole default. */
  setZoom: (zoomed: boolean, scale?: number, durationMs?: number) => void;
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
  const readyRef = useRef(false);

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
        el.style.transition = "transform 300ms ease";
        el.addEventListener("PRESENTER_STATUS", (event) => {
          const { status: next } = (event as CustomEvent<{ status: string }>).detail;
          readyRef.current = next === "Ready";
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
    async (token: string, target: PresentationTarget) => {
      // A (re-)initialize swaps assets: treat the widget as not-Ready until it
      // says otherwise, so callers can waitReady() before speaking.
      readyRef.current = false;
      setReady(false);
      await presenterRef.current?.initialize(token, target);
    },
    [],
  );
  const waitReady = useCallback(
    (timeoutMs = 10_000) =>
      new Promise<void>((resolve) => {
        const el = presenterRef.current;
        if (!el || readyRef.current) return resolve();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          el.removeEventListener("PRESENTER_STATUS", onStatus);
          clearTimeout(timer);
          resolve();
        };
        const onStatus = (event: Event) => {
          if ((event as CustomEvent<{ status: string }>).detail?.status === "Ready") finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        el.addEventListener("PRESENTER_STATUS", onStatus);
      }),
    [],
  );
  const present = useCallback(
    async (content: string, options?: PresentOptions) => presenterRef.current?.present(content, options),
    [],
  );
  const setListening = useCallback((isListening: boolean) => presenterRef.current?.setListening(isListening), []);
  // The npm package is types-only (no runtime enum) — the cast just satisfies
  // the widget's typed signature; the real element takes the plain string.
  const setCameraAngle = useCallback(
    (angle: "fullbody" | "halfbody") => presenterRef.current?.updateCameraAngle(angle as CameraAngle),
    [],
  );
  const setZoom = useCallback((zoomed: boolean, scale = ZOOM_SCALE, durationMs = 300) => {
    const el = presenterRef.current;
    if (!el) return;
    el.style.transition = `transform ${durationMs}ms ease`;
    el.style.transform = zoomed ? `scale(${scale})` : "";
    el.style.transformOrigin = zoomed ? ZOOM_ORIGIN : "";
  }, []);
  // Resolvers for in-flight waitForFinished() calls, so an explicit interrupt
  // (barge-in, hang-up) can release them immediately instead of relying on
  // the widget to follow up with its own event — see interruptPresentation.
  const finishWaitersRef = useRef<Set<() => void>>(new Set());
  const waitForFinished = useCallback(() => {
    const el = presenterRef.current;
    if (!el) return Promise.resolve();
    if (typeof el.addEventListener === "function") {
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          el.removeEventListener("ALL_PERFORMANCE_FINISHED", onAllFinished);
          el.removeEventListener("PERFORMANCE_STATE", onState);
          finishWaitersRef.current.delete(finish);
          clearTimeout(timer);
          resolve();
        };
        const onAllFinished = () => finish();
        // Belt-and-braces: if playback stops without the widget ever firing
        // ALL_PERFORMANCE_FINISHED (audio cuts out mid-line, or an interrupt
        // that doesn't get followed up), this used to hang here until the
        // 60s fallback below fired, freezing the whole call with it.
        // PERFORMANCE_STATE leaving "Talking" is a more reliable "she's
        // done" signal — interruptPresentation is documented to trigger it
        // ("falling back to Idle").
        const onState = (event: Event) => {
          const state = (event as CustomEvent<{ state: string }>).detail?.state;
          if (state && state !== "Talking") finish();
        };
        el.addEventListener("ALL_PERFORMANCE_FINISHED", onAllFinished);
        el.addEventListener("PERFORMANCE_STATE", onState);
        finishWaitersRef.current.add(finish);
        const timer = setTimeout(finish, 60_000);
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
  const speakAudio = useCallback(
    async (audio: ArrayBuffer, content: string, options?: PresentOptions) => {
      const result = await presenterRef.current?.presentWithAudio(audio, content, options);
      if (result && !result.success) {
        throw new Error(`presentation failed (${result.code}): ${result.message || "unknown"}`);
      }
      await waitForFinished();
    },
    [waitForFinished],
  );
  const interruptPresentation = useCallback(() => {
    presenterRef.current?.interruptPresentation();
    // Release any in-flight speakText/speakAudio right away rather than
    // trusting the widget to raise PERFORMANCE_STATE/ALL_PERFORMANCE_FINISHED
    // for this — the caller (barge-in, hang-up) already knows the line is
    // over, and this is the difference between an interrupted line and a
    // frozen call.
    finishWaitersRef.current.forEach((finish) => finish());
  }, []);
  const refreshConnectToken = useCallback((token: string) => presenterRef.current?.refreshConnectToken(token), []);

  return {
    mounted,
    ready,
    loadError,
    retry,
    resumeAudio,
    initialize,
    waitReady,
    present,
    speakText,
    speakAudio,
    setListening,
    setCameraAngle,
    setZoom,
    interruptPresentation,
    refreshConnectToken,
  };
}
