import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// NarenInvestment frontend, served as an isolated sub-app under /naren by the
// merged StockWise binary. `base` makes all built asset URLs absolute under
// /naren/, and the dev proxy points at the merged backend on :8080.
export default defineConfig({
  base: '/naren/',
  plugins: [react()],
  server: {
    port: 8081,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
