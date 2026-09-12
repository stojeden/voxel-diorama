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
              // The atmosphere's physics: Rayleigh optical depth, the ozone Chappuis band,
              // air mass, refraction, the spectral-to-RGB conversion both the rainbow and
              // the twilight model integrate through, and the illuminance-against-elevation
              // table the viewer's dark adaptation is driven from.
              //
              // Split for room, not for laziness -- this code runs on the first frame and is
              // loaded eagerly. The entry chunk had 435 bytes left of its 249 500 when the
              // sky dome's own twilight was still unwired, and the alternative was another
              // budget raise. Splitting keeps the growth visible, which is the same call
              // `experience-signals` and `playground` below already record.
              //
              // `RainbowAtmosphere` was added to this glob on 2026-09-12 and taken back out
              // the same day. Because the chunk is eager, moving it here moved 11 521 bytes
              // from a gate that was watching to a gate that was not and saved the first load
              // nothing; it is now fetched on demand as `rainbow` below. Anything added to
              // this list is first-load weight -- put it here only if it truly runs on frame
              // one, and expect the 9 000 byte gate in `browserSmoke.mjs` to say so.
              name: 'atmosphere-physics',
              test: /src[\\/]environment[\\/](?:SunlightSpectrum|RainbowOptics|ViewerAdaptation)\.ts$/,
              priority: 12,
              includeDependenciesRecursively: false,
            },
            {
              // The city's coordinates: block grid, lake, routes, stops, the moisture zones.
              // Pure data with no dependency but Three, and it was inlined in the entry chunk
              // until the rainbow became a lazy import -- at which point it is shared between
              // an eager importer and a lazy one, so rolldown must give it a chunk of its own.
              //
              // Named rather than left to rolldown's automatic naming because it is EAGER
              // (index.html modulepreloads it), so it is first-load weight that the entry gate
              // can no longer see, and `browserSmoke.mjs` needs a stable name to put a gate on.
              // That is the whole lesson of the atmosphere-physics chunk: weight that leaves a
              // watched gate has to arrive at another one.
              name: 'world-layout',
              test: /src[\\/]world[\\/]WorldLayout\.ts$/,
              priority: 12,
              includeDependenciesRecursively: false,
            },
            {
              // The rainbow, fetched only once the air holds moisture -- see `ensureRainbow`
              // in main.ts. It is the largest module in `src/environment` and it cannot put a
              // pixel on the screen before a shower has been and gone, so it is not first-load
              // weight. Named rather than left anonymous so the split stays measurable.
              name: 'rainbow',
              test: /src[\\/]environment[\\/]RainbowAtmosphere\.ts$/,
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
