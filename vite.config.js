import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  // Relative asset paths — the build works both locally and under
  // a GitHub Pages subpath (https://<user>.github.io/voxel-diorama/).
  base: './',
  // Keep a single Three.js instance across `three` and `three/addons` deep
  // imports (avoids the "Multiple instances of Three.js" dev warning).
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three', 'postprocessing', 'camera-controls', 'suncalc'],
  },
  build: {
    outDir: 'dist',
    // Three itself is a large, cacheable vendor chunk. Application code has a
    // separate, much smaller budget enforced by the browser smoke test.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/camera-controls/')) return 'camera-controls';
          return undefined;
        },
      },
    },
  },
  server: {
    open: true,
  },
});
