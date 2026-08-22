import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Port 5174 keeps the whole local stack addressable at once: DSH's web host
 * owns 3080, its docs site owns 5173, and iMap owns 8085.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: {
      // The fixture feed lives at the repo root, outside this app's directory.
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
