import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer is a self-contained React app under electron/renderer. We build it
// to dist-renderer/ with relative asset paths so Electron can load it over file://
// in the packaged app, and serve it on a fixed port for `gui:dev`.
export default defineConfig({
  root: 'electron/renderer',
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
  },
})
