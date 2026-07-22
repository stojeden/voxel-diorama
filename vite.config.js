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
    rolldownOptions: {
      input: resolve(__dirname, 'index.html'),
      preserveEntrySignatures: 'allow-extension',
      output: {
        // Keep execution order while splitting packages without recursively
        // absorbing their dependencies into whichever group is processed
        // first. In particular, postprocessing must not swallow Three.js.
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /node_modules[\\/]three[\\/]/,
              priority: 30,
              includeDependenciesRecursively: false,
            },
            {
              name: 'camera-controls',
              test: /node_modules[\\/]camera-controls[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: 'postprocessing',
              test: /node_modules[\\/]postprocessing[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  server: {
    // Multiple dev invocations must not multiply GPU-heavy Diorama tabs.
    // Open one tab explicitly only when a human or a browser test needs it.
    open: false,
  },
});
