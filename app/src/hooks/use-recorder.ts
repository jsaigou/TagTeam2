import { useCallback, useRef, useState } from "react";

/**
 * Microphone recorder via MediaRecorder. Produces a browser-encoded audio blob
 * (webm/opus typically) plus a base64 string for the STT proxy.
 */
export function useRecorder() {
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Mic unavailable: ${message}`);
      throw err;
    }
  }, []);

  const stop = useCallback(async (): Promise<{ base64: string; mimeType: string }> => {
    const rec = recRef.current;
    if (!rec || rec.state === "inactive") throw new Error("Not recording");
    const mimeType = rec.mimeType || "audio/webm";
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mimeType }));
      rec.stop();
      rec.stream.getTracks().forEach((t) => t.stop());
    });
    setRecording(false);
    recRef.current = null;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { base64: btoa(bin), mimeType };
  }, []);

  const cancel = useCallback(() => {
    recRef.current?.stream?.getTracks().forEach((t) => t.stop());
    recRef.current?.stop();
    recRef.current = null;
    chunksRef.current = [];
    setRecording(false);
  }, []);

  return { recording, error, start, stop, cancel };
}
