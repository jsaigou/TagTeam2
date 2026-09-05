import { useCallback, useEffect, useRef, useState } from "react";
import type { MicVAD as MicVADType } from "@ricky0123/vad-web";

export interface VadUtterance {
  base64: string;
  mimeType: string;
}

export interface UseVad {
  /** Mic open and frames being analyzed. */
  listening: boolean;
  /** Confirmed speech in progress (past the misfire threshold). */
  speech: boolean;
  error: string | null;
  /** Load the model, open the mic, start detection. */
  start: () => Promise<void>;
  /** Destroy the instance — releases mic, model and audio graph. */
  stop: () => void;
  /** Gate detection (while the avatar speaks or a turn processes).
   *  pause/start on MicVAD keep the loaded model; cycles are cheap. */
  setPaused: (p: boolean) => void;
}

/** PCM16 WAV container for a 16 kHz mono Float32Array utterance. */
function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Speech-segmentation VAD on Silero V5 (@ricky0123/vad-web, onnxruntime-web
 * WASM) — chosen over energy thresholding for reliability: a real speech
 * model rejects room noise, keyboard clicks and breaths that RMS energy
 * mistakes for speech. Assets are self-hosted (/vad/ model + worklet, /ort/
 * wasm — copied at build time by vite-plugin-static-copy). Utterances arrive
 * as 16 kHz mono Float32Arrays and leave as base64 PCM WAV for the STT proxy.
 */
export function useVad(onUtterance: (u: VadUtterance) => void | Promise<void>): UseVad {
  const [listening, setListening] = useState(false);
  const [speech, setSpeech] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cbRef = useRef(onUtterance);
  useEffect(() => {
    cbRef.current = onUtterance;
  }, [onUtterance]);

  const instanceRef = useRef<Promise<MicVADType> | null>(null);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);

  const getInstance = useCallback(() => {
    if (!instanceRef.current) {
      instanceRef.current = (async () => {
        // Lazy chunk: onnxruntime-web's JS (~500 kB) loads only when a call
        // is actually dialed, not on app start.
        const { MicVAD } = await import("@ricky0123/vad-web");
        return MicVAD.new({
          model: "v5",
          baseAssetPath: "/vad/",
          onnxWASMBasePath: "/ort/",
          // Barge-in listens while the avatar speaks: the browser's echo
          // canceller must keep the avatar's own voice out of the mic feed.
          getStream: () =>
            navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true },
            }),
          onSpeechRealStart: () => setSpeech(true),
          onVADMisfire: () => setSpeech(false),
          onSpeechEnd: async (audio) => {
            setSpeech(false);
            if (busyRef.current) return;
            busyRef.current = true;
            try {
              const bytes = new Uint8Array(await encodeWav(audio).arrayBuffer());
              let bin = "";
              const CHUNK = 0x8000;
              for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
              await cbRef.current({ base64: btoa(bin), mimeType: "audio/wav" });
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              busyRef.current = false;
            }
          },
        });
      })().catch((err) => {
        instanceRef.current = null; // allow a retry after a failed load
        throw err;
      });
    }
    return instanceRef.current;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const vad = await getInstance();
      pausedRef.current = false;
      await vad.start();
      setListening(vad.listening);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Mic/VAD unavailable: ${message}`);
      throw err;
    }
  }, [getInstance]);

  const stop = useCallback(() => {
    const instance = instanceRef.current;
    instanceRef.current = null;
    pausedRef.current = false;
    busyRef.current = false;
    setListening(false);
    setSpeech(false);
    if (instance) void instance.then((vad) => vad.destroy()).catch(() => {});
  }, []);

  const setPaused = useCallback((p: boolean) => {
    if (pausedRef.current === p) return;
    pausedRef.current = p;
    const instance = instanceRef.current;
    if (!instance) return;
    void instance
      .then(async (vad) => {
        if (p) await vad.pause();
        else await vad.start();
        setListening(vad.listening);
      })
      .catch(() => {});
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { listening, speech, error, start, stop, setPaused };
}
