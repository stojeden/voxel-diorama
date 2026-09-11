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
  test: {
    /**
     * Vitest 4 dropped the dist glob from its default exclude, and it never reads
     * `.git/info/exclude`. A git worktree lives under `.claude/worktrees/` -- a whole second
     * copy of `src/` -- so the local suite was collecting 717 tests where CI collects 382:
     * 39 byte-identical duplicates and, worse, 7 files asserting a five-day-old contract.
     * Those seven can go green on behaviour that has been deleted, or red on behaviour that
     * has just been changed, and the failure names a path under `.claude/` that reads like
     * tooling noise rather than a real result.
     *
     * The defaults are repeated here rather than replaced by a bare pair: writing only the
     * two new globs would drop node_modules from the exclude list and start collecting the
     * dependencies' own tests.
     */
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**', '**/dist/**'],
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
            {
              // Reversible hybrid spike: loaded only behind `?world=hybrid-*`, so the
              // experiment never spends the entry-chunk budget. `spikeFlag.ts` stays
              // with its importer (main) on purpose.
              name: 'hybrid-spike',
              test: /src[\\/]world[\\/]hybrid[\\/](?!spikeFlag\.ts$)/,
              priority: 15,
              includeDependenciesRecursively: false,
            },
            {
              // Theme dressing: the Cyberpunk styling layer for the vehicles. Only ever
              // used once someone picks the theme, and the entry chunk's budget is nearly
              // spent, so it is cacheable on its own like the fragment above.
              name: 'cyber-style',
              test: /src[\\/]world[\\/]cyber[\\/]/,
              priority: 15,
              includeDependenciesRecursively: false,
            },
            {
              // Temporal accumulation, reachable only behind `?taa=1`. Its own chunk for
              // the same reason as the two below: the entry budget is 244 000 B with a
              // couple of hundred bytes spare, and an experiment must not spend them.
              name: 'temporal-resolve',
              test: /src[\\/]effects[\\/]TemporalResolve\.ts$/,
              priority: 12,
              includeDependenciesRecursively: false,
            },
            {
              // The lakeside playground: one cohesive prop, and the entry chunk had
              // 1.1 kB left of its 244 000 B when this arrived. Splitting rather than
              // raising the budget is the same call `experience-signals` below records --
              // growth stays visible instead of hiding behind a bigger number. The
              // Cyberpunk dressing for it sits in `cyber-style` and is loaded later still.
              name: 'playground',
              test: /src[\\/]world[\\/]Playground\.ts$/,
              priority: 12,
              includeDependenciesRecursively: false,
            },
            {
              // Small, cohesive and independently cacheable world-signal logic.
              // Keeping it out of the near-limit entry chunk leaves room for the
              // UI redesign without hiding growth behind a larger budget.
              name: 'experience-signals',
              test: /src[\\/]experience[\\/](?:AmbientEvents|EclipseSchedule)\.ts$/,
              priority: 10,
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
