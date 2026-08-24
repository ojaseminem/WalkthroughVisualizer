import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// `base: './'` keeps every asset path relative, so the same build works from a
// GitHub Pages project subpath, an S3 bucket root, or inside a client's iframe
// with no rebuild.
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@wv/core': fileURLToPath(new URL('../../packages/core/src/index.js', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { host: '0.0.0.0', port: 5173 },
});
