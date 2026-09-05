import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Self-host the Silero VAD model/worklet + onnxruntime-web wasm binaries
    // (copied at build time; too large for git, no third-party CDN at runtime).
    viteStaticCopy({
      targets: [
        { src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', dest: 'vad', rename: { stripBase: true } },
        { src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', dest: 'vad', rename: { stripBase: true } },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', dest: 'ort', rename: { stripBase: true } },
        { src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', dest: 'ort', rename: { stripBase: true } },
      ],
    }),
  ],
  // NOTE: do not optimizeDeps.exclude onnxruntime-web — vad-web's CJS
  // `require("onnxruntime-web/wasm")` needs the dep optimizer's interop in
  // dev, or rolldown leaves a require stub that throws in the browser.
  server: {
    proxy: {
      // Thin backend (see ../server) — token mint, STT, BYO-TTS.
      '/api': 'http://localhost:8787',
    },
  },
})
