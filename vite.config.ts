import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The front-end lives in src/client and is built into ./dist, which the Worker
// serves through the `assets` binding (see wrangler.jsonc).
export default defineConfig({
  root: 'src/client',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // `npm run dev:web` proxies API calls to the local Worker (wrangler dev, port 8787)
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
