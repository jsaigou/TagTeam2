import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Thin backend (see ../server) — token mint, STT, BYO-TTS.
      '/api': 'http://localhost:8787',
    },
  },
})
