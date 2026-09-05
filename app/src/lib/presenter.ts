// Presenter engine bootstrap + typed handle for the `<sv-presenter>` web
// component. The full `IPresentationWidget` contract comes from the
// `@perxona/presenter-types` npm package (type-only — the runtime element
// always loads from the CDN). Adapted from the Perxona motion-browser reference.

import type { IPresentationWidget } from "@perxona/presenter-types";

export type {
  PresentOptions,
  PresentationResult,
  PresentationTarget,
} from "@perxona/presenter-types";

export type Presenter = HTMLElement & IPresentationWidget;

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
      script.onload = () => {
        // The CDN entry can define <sv-presenter> behind a dynamic import —
        // script.onload alone races the definition, and createElement on an
        // undefined tag yields an inert element with no widget methods.
        void Promise.race([
          customElements.whenDefined("sv-presenter"),
          new Promise((r) => setTimeout(r, 15_000)),
        ]).then(() => resolve(url));
      };
      script.onerror = () => reject(new Error(`failed to load presenter engine: ${url}`));
      document.head.append(script);
    });
  }
  return enginePromise;
}
