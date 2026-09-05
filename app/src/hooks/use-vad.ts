import { useCallback, useEffect, useRef, useState } from "react";

export interface VadUtterance {
  base64: string;
  mimeType: string;
}

interface Chunk {
  t: number;
  data: Blob;
}

const FRAME_MS = 40; // analysis tick
const PREROLL_MS = 400; // audio kept from before speech onset
const TRAIL_MS = 700; // trailing silence that ends an utterance
const MIN_SPEECH_MS = 300; // shorter blips are noise, not turns
const MAX_UTTER_MS = 10_000; // hard cap on one utterance
const CALIB_MS = 500; // noise-floor measurement after start/unpause
const ONSET_MS = 120; // loud frames required to confirm speech start

export interface UseVad {
  /** Mic stream open and being analyzed. */
  listening: boolean;
  /** Speech detected right now. */
  speech: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  /** Gate analysis (while the avatar speaks or a turn is processing). */
  setPaused: (p: boolean) => void;
}

/**
 * Zero-dependency browser VAD: RMS energy from an AnalyserNode drives a
 * rolling MediaRecorder. Chunks arrive on a 100ms timeslice into a ring
 * buffer; when an utterance ends (trailing silence or the cap) the slice
 * [onset − preroll, end] is assembled into a blob and handed to the callback.
 * The stream requests echoCancellation + noiseSuppression, and `setPaused`
 * gates analysis while the avatar speaks (half-duplex).
 */
export function useVad(onUtterance: (u: VadUtterance) => void | Promise<void>): UseVad {
  const [listening, setListening] = useState(false);
  const [speech, setSpeech] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cbRef = useRef(onUtterance);
  useEffect(() => {
    cbRef.current = onUtterance;
  }, [onUtterance]);

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Chunk[]>([]);
  const pausedRef = useRef(false);
  const busyRef = useRef(false);
  const calibUntilRef = useRef(0);
  const floorRef = useRef(0.01);
  const speechSinceRef = useRef(0);
  const silenceSinceRef = useRef(0);
  const inSpeechRef = useRef(false);

  const emitUtterance = useCallback(async (from: number, to: number) => {
    const rec = recRef.current;
    inSpeechRef.current = false;
    speechSinceRef.current = 0;
    silenceSinceRef.current = 0;
    setSpeech(false);
    if (busyRef.current || !rec || to - from < MIN_SPEECH_MS) return;
    const chunks = chunksRef.current.filter((c) => c.t >= from - 150 && c.t <= to + 150);
    if (chunks.length === 0) return;
    busyRef.current = true;
    try {
      const mimeType = rec.mimeType || "audio/webm";
      const blob = new Blob(chunks.map((c) => c.data), { type: mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      await cbRef.current({ base64: btoa(bin), mimeType });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      calibUntilRef.current = performance.now() + CALIB_MS;
    }
  }, []);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser || !recRef.current) return;
    const now = performance.now();

    // Prune the ring buffer (keep ~3s: preroll + trailing window).
    while (chunksRef.current.length && chunksRef.current[0].t < now - 3000) chunksRef.current.shift();

    if (pausedRef.current) {
      if (inSpeechRef.current) {
        inSpeechRef.current = false;
        setSpeech(false);
      }
      speechSinceRef.current = 0;
      silenceSinceRef.current = 0;
      calibUntilRef.current = now + CALIB_MS;
      return;
    }

    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);

    if (now < calibUntilRef.current) {
      floorRef.current = Math.max(floorRef.current * 0.9 + rms * 0.1, 0.002);
      return;
    }

    const startThresh = Math.max(floorRef.current * 3.2, 0.02);
    const stopThresh = startThresh * 0.6;

    if (!inSpeechRef.current) {
      if (rms > startThresh) {
        if (speechSinceRef.current === 0) speechSinceRef.current = now;
        else if (now - speechSinceRef.current >= ONSET_MS) {
          inSpeechRef.current = true;
          silenceSinceRef.current = 0;
          setSpeech(true);
        }
      } else {
        speechSinceRef.current = 0;
        // Track the ambient floor while quiet so thresholds adapt.
        floorRef.current = floorRef.current * 0.95 + rms * 0.05;
      }
      return;
    }

    const tooLong = now - speechSinceRef.current >= MAX_UTTER_MS;
    if (rms < stopThresh) {
      if (silenceSinceRef.current === 0) silenceSinceRef.current = now;
      if (now - silenceSinceRef.current >= TRAIL_MS || tooLong) {
        void emitUtterance(speechSinceRef.current - PREROLL_MS, now);
      }
    } else {
      silenceSinceRef.current = 0;
      if (tooLong) void emitUtterance(speechSinceRef.current - PREROLL_MS, now);
    }
  }, [emitUtterance]);

  const start = useCallback(async () => {
    if (recRef.current) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      ctxRef.current = ctx;
      analyserRef.current = analyser;

      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push({ t: performance.now(), data: e.data });
      };
      rec.start(100);
      recRef.current = rec;

      floorRef.current = 0.01;
      pausedRef.current = false;
      calibUntilRef.current = performance.now() + CALIB_MS;
      timerRef.current = window.setInterval(tick, FRAME_MS);
      setListening(true);
    } catch (err) {
      setError(`Mic unavailable: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }, [tick]);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    analyserRef.current = null;
    chunksRef.current = [];
    inSpeechRef.current = false;
    busyRef.current = false;
    setListening(false);
    setSpeech(false);
  }, []);

  const setPaused = useCallback((p: boolean) => {
    pausedRef.current = p;
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { listening, speech, error, start, stop, setPaused };
}
