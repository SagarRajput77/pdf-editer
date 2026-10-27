import { defineConfig } from 'vite';

export default defineConfig({
  // pdf.js v4 ships modern ESM (top-level await), so target a recent baseline.
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
