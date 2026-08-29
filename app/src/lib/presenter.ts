// Presenter engine bootstrap + typed handle for the `<sv-presenter>` web
// component. Adapted from the Perxona motion-browser reference. The engine URL
// is passed from the server config; empty auto-discovers via the region.

export interface PresentationTarget {
  avatarId: string;
  sceneId: string;
  voiceId?: string;
}

export type Presenter = HTMLElement & {
  initialize: (token: string, target: PresentationTarget) => Promise<void>;
  resumeAudioPlayback: () => Promise<void>;
  present: (content: string) => Promise<unknown>;
  interruptPresentation: () => void;
  refreshConnectToken: (token: string) => void;
  updateCameraFOV: (opts: { distance: number; vertical: number; horizontal: number }) => void;
};

const DEFAULT_URL = "https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js";

let enginePromise: Promise<string> | null = null;

/** Load the presenter engine script once; resolve with the CDN URL used. */
export function loadPresenterEngine(presenterUrl?: string): Promise<string> {
  if (!enginePromise) {
    const url = presenterUrl || DEFAULT_URL;
    enginePromise = new Promise<string>((resolve, reject) => {
      if (customElements.get("sv-presenter")) return resolve(url);
      const script = document.createElement("script");
      script.type = "module";
      script.src = url;
      script.onload = () => resolve(url);
      script.onerror = () => reject(new Error(`failed to load presenter engine: ${url}`));
      document.head.append(script);
    });
  }
  return enginePromise;
}
