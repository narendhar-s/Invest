import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        // Forward WebSocket upgrades (live candle stream) to the backend.
        ws: true,
      },
      // The NarenInvestment sub-app is served by the backend under /naren.
      // Proxy it so the Invest dev server (5173) can reach the Naren tabs too.
      '/naren': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
