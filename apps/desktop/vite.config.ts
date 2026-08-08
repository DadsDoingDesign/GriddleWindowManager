import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

// Multi-page app: one HTML entry per Tauri webview route.
// The hidden main window loads /brain; overlays load /overlay?gridId=...;
// the settings window loads /settings.
export default defineConfig({
  plugins: [svelte()],
  // Tauri CLI owns the terminal; don't let Vite clear its output.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        brain: resolve(import.meta.dirname, 'brain.html'),
        overlay: resolve(import.meta.dirname, 'overlay.html'),
        settings: resolve(import.meta.dirname, 'settings.html'),
      },
    },
  },
})
