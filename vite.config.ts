import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],  // prevent Vite from pre-bundling WASM
  },
  build: {
    target: 'esnext',                   // needed for top-level await, WASM
  },
  worker: {
    format: 'es',                       // ES module workers
  },
})
