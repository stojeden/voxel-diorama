import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  // Keep a single Three.js instance across `three` and `three/addons` deep
  // imports (avoids the "Multiple instances of Three.js" dev warning).
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three', 'camera-controls', 'suncalc'],
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  server: {
    open: true,
  },
});
