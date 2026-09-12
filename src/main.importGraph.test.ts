import { describe, expect, it } from 'vitest';

/**
 * The first load is what the entry chunk and every chunk it *statically* reaches add up to.
 * A module reached only through `import(...)` is fetched later, or never.
 *
 * This walks that distinction in the source rather than in the build, so it fails in
 * `vitest` in a second instead of only in the browser smoke after a full build -- and so it
 * fails on the change that caused it rather than on a byte count three commits later.
 *
 * The defect it prevents, which has already happened once: `RainbowAtmosphere` was taken out
 * of the entry chunk by adding it to the eagerly-loaded `atmosphere-physics` group in
 * vite.config.js. The entry gate went green, the first load did not move a byte, and the
 * 11 521 bytes simply stopped being watched. A chunk boundary is not lazy loading; only the
 * absence of a static import is.
 */

/**
 * Every module under `src/`, as text, keyed './like/this.ts'. Vite's own graph loader rather
 * than `node:fs`, because `tsconfig.json` gives this project the DOM and `vite/client` and no
 * node types -- a test that needs `node:fs` to typecheck is a test that breaks `tsc`.
 */
const SOURCES = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * Static module edges only.
 *
 * `import type` / `export type` are erased before the bundler ever sees them, so they carry
 * no weight and are not edges. Anything else that names a module after `from` is one --
 * including a value import used only for its side effects. `import('...')` has no `from`
 * clause and so never matches, which is exactly the line this test is drawn along.
 */
const STATIC_EDGE = /^[ \t]*(?:import|export)[ \t]+(?!type[ \t])[^;]*?\bfrom[ \t]+['"]([^'"]+)['"]/gm;
const BARE_SIDE_EFFECT_EDGE = /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;

/** Resolve a relative specifier against the importer, and land on a key `SOURCES` has. */
function resolveModule(importer: string, specifier: string): string | null {
  const segments = importer.split('/').slice(0, -1).concat(specifier.split('/'));
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  const base = `./${stack.join('/')}`;
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (candidate in SOURCES) return candidate;
  }
  // Not a project module: a vendor package (`three`, `postprocessing`) or a node built-in,
  // each of which has its own chunk and its own budget.
  return null;
}

/** Every project module statically reachable from `entry`, including `entry` itself. */
function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const module = queue.pop()!;
    const source = SOURCES[module];
    if (source === undefined) continue;
    for (const pattern of [STATIC_EDGE, BARE_SIDE_EFFECT_EDGE]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match !== null) {
        const target = match[1].startsWith('.') ? resolveModule(module, match[1]) : null;
        if (target !== null && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
        match = pattern.exec(source);
      }
    }
  }
  return seen;
}

describe('main.ts initial import graph', () => {
  const graph = staticImportGraph('./main.ts');

  it('reaches the eager modules it is supposed to, so the walk is not vacuously empty', () => {
    // A guard on the instrument, not on the product: if the resolver silently found nothing,
    // every "is not in the graph" assertion below would pass for the wrong reason.
    expect(graph.size).toBeGreaterThan(40);
    expect(graph).toContain('./bootstrap.ts');
    expect(graph).toContain('./environment/DayNightCycle.ts');
    // The rainbow's eager half: the contract, and the object that stands in for the real one
    // until the chunk lands.
    expect(graph).toContain('./environment/RainbowHandle.ts');
  });

  it('does not statically reach RainbowAtmosphere', () => {
    expect([...graph].sort()).not.toContain('./environment/RainbowAtmosphere.ts');
  });

  it('fetches RainbowAtmosphere through a dynamic import instead', () => {
    expect(SOURCES['./main.ts']).toMatch(
      /import\([ \t\n]*'\.\/environment\/RainbowAtmosphere'[ \t\n]*\)/
    );
  });

  it('keeps the eager atmosphere-physics modules clear of the rainbow as well', () => {
    // These three are the whole of the `atmosphere-physics` chunk, and that chunk is fetched
    // on the first frame. If any of them picked up an import of `RainbowAtmosphere`, the
    // 11 521 bytes would be back in the first load with nothing in main.ts to show for it.
    for (const eager of [
      './environment/SunlightSpectrum.ts',
      './environment/RainbowOptics.ts',
      './environment/ViewerAdaptation.ts',
    ]) {
      expect(graph).toContain(eager);
      expect(staticImportGraph(eager)).not.toContain('./environment/RainbowAtmosphere.ts');
    }
  });
});
