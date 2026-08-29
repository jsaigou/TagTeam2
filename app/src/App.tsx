import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConnectConfig, transcribeAudio, synthesizeSpeech } from "./lib/api";
import { usePresenter } from "./hooks/use-presenter";

const HELLO_LINE = "はじめまして。歯科医院の受付です。ご用件をどうぞ。";

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { mounted, ready, loadError, retry, resumeAudio, initialize, present, presentWithAudio } =
    usePresenter({ stageRef });
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState("loading…");
  const [sttText, setSttText] = useState("");

  // Preload engine + config, initializing Luna (coach avatar) once ready.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await fetchConnectConfig();
        if (cancelled) return;
        setToken(cfg.connect_token);
        setStatus("ready — press Start to hear Luna");
        // Wait for the presenter to mount, then initialize Luna (windowed coach).
        // initialize() is called from the button so audio unlock is a gesture.
      } catch (err) {
        if (!cancelled) setStatus(`config error: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (!token) return;
    try {
      setStatus("unlocking audio…");
      await resumeAudio();
      await initialize(token, {
        avatarId: "01KD2H4NWSZP4Y3CK8P3PSHTYP", // cc051_meeks (Luna)
        sceneId: "01K4NYB6627539QRJR2HXESJJK", // sova_anime_1
        voiceId: "01KTBJGRFKWS029KQKQBC3318V", // guide voice — native present() needs it
      });
      setStatus("Luna ready — speaking a line");
    } catch (err) {
      setStatus(`init error: ${(err as Error).message}`);
    }
  }, [token, resumeAudio, initialize]);

  const speakNative = useCallback(async () => {
    try {
      setStatus("speaking (native Perxona voice)…");
      await present(HELLO_LINE);
      setStatus("done (native voice)");
    } catch (err) {
      setStatus(`native error: ${(err as Error).message}`);
    }
  }, [present]);

  const speakByo = useCallback(async () => {
    try {
      setStatus("synthesizing BYO-TTS…");
      const wav = await synthesizeSpeech(HELLO_LINE);
      await resumeAudio();
      await presentWithAudio(wav, HELLO_LINE);
      setStatus("done (BYO-TTS audio)");
    } catch (err) {
      setStatus(`byo error: ${(err as Error).message}`);
    }
  }, [resumeAudio, presentWithAudio]);

  const selfCheckStt = useCallback(async () => {
    try {
      setStatus("synthesizing STT sample…");
      const wav = await synthesizeSpeech("わたしは田中です。予約したいです。");
      const bytes = new Uint8Array(wav);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64 = btoa(bin);
      setStatus("transcribing (homelab STT)…");
      const { text } = await transcribeAudio(b64);
      setSttText(text);
      setStatus("STT done");
    } catch (err) {
      setStatus(`stt error: ${(err as Error).message}`);
    }
  }, []);

  return (
    <main className="min-h-svh bg-background text-foreground p-6">
      <h1 className="text-2xl font-semibold">TagTeam — S0 spike</h1>
      <p className="text-muted-foreground mb-4">
        Verify: Luna (coach avatar) renders + speaks; BYO-TTS audio plays; STT returns Japanese.
      </p>

      <div className="flex gap-3 mb-4">
        <button
          onClick={start}
          disabled={!token}
          className="px-4 py-2 rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          Start (unlock + init Luna)
        </button>
        <button
          onClick={speakNative}
          disabled={!ready}
          className="px-4 py-2 rounded border border-border disabled:opacity-50"
        >
          Speak (native Perxona)
        </button>
        <button
          onClick={speakByo}
          disabled={!ready}
          className="px-4 py-2 rounded border border-border disabled:opacity-50"
        >
          Speak (BYO-TTS)
        </button>
        <button
          onClick={selfCheckStt}
          className="px-4 py-2 rounded border border-border"
        >
          STT self-check
        </button>
        {loadError && (
          <button onClick={retry} className="px-4 py-2 rounded bg-destructive text-white">
            Retry engine
          </button>
        )}
      </div>

      <div className="mb-4 text-sm">
        <span className="font-mono">{status}</span>
        {sttText && <div className="mt-2">STT returned: <span className="font-mono">{sttText}</span></div>}
      </div>

      <div ref={stageRef} className="w-72 h-72 rounded-xl overflow-hidden border border-border bg-card" />
      {loadError && <p className="text-sm text-red-600 mt-2">Presenter error: {loadError.message}</p>}
      {!mounted && !loadError && <p className="text-sm mt-2">loading presenter engine…</p>}
    </main>
  );
}
