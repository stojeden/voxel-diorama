# Hybrid Spike (Osiedle Centralne) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the approved hybrid look for one fragment of the city inside the real Diorama renderer, behind a developer flag, with two interchangeable geometry strategies, screen-space LOD, ground-contact checks and the chimney + RTV tower dominants, then measure it against the existing budgets.

**Architecture:** A pure, deterministic `CityModel` describes the fragment (families, metre heights, props, dominants). Emitters turn it into `SurfacePrimitive[]` per cluster. Two strategies (`direct`, `greedy`) turn the same primitives into merged `BufferGeometry` per LOD layer. One `HybridMaterial` (palette uniforms, cohorts, snow, wet, AO, styles) is shared by every layer, so LOD never changes semantics. `HybridSpike.attach` adds the meshes to the scene next to the voxel city minus the excluded blocks and pavement cells; `main.ts` only parses the flag, excludes, dynamically imports and forwards per-frame hooks.

**Tech Stack:** Three.js 0.185 (`BufferGeometryUtils.mergeGeometries`, `MeshStandardMaterial.onBeforeCompile`), TypeScript 5.9 strict, Vitest 4, Playwright 1.61 with system Chrome, Vite 8 (rolldown code splitting).

## Global Constraints

- Scope: one fragment (Osiedle Centralne), flag `?world=hybrid-direct|hybrid-greedy`, default `voxel` unchanged.
- Two strategies consume the same `SurfacePrimitive[]`; the loser is deleted after the decision.
- No bundle limit is raised. Entry chunk `index-*.js` ≤ 240 000 B (now 236 782 B): glue edits to `WorldGenerator.ts` must stay under ~600 B. `main-*.js` ≤ 50 000 B (now 33 311 B). All spike code lives in `src/world/hybrid/` and is split into the `hybrid-spike` chunk by a Vite group; `spikeFlag.ts` is the only module imported statically from `main.ts`.
- Gates: (1) frames `spike-overview`, `spike-street` (eye 1.7 m), `spike-golden`, bonus `spike-night-street`; bus never on the crosswalk; resident legible; shop windows have procedural content; far plane not blown out. (2) Metrics in the Diorama pipeline: primary + multipass triangles, draw calls, programs, generation ms, memory, p95 CPU/GPU on High and Low; thresholds ≥ 58 FPS, p95 ≤ 20.5 ms, ≤ 1400 calls, ≤ 500 geometries, ≤ 80 textures, TTI ≤ 1800 ms. (3) Screen-space LOD, hysteresis, additive layers; cohorts/themes/snow/wet/seed identical at every level. (4) Heights in metres; ×1.8 only for `pointTower` blocks `{5}`; roofs/balconies/ground floors pass collision, route and anchor checks.
- Ground contact: every spike prop declares probes on the ground within 12 mm; the bus dwell envelope never intersects the crosswalk; the check also runs at runtime after LOD changes.
- Dominants: chimney `(-58, -40)` + RTV tower, recommended site `(16, -66)`, alternative `(-70, 22)`.
- 100% procedural: geometry from Three.js primitives only; `CanvasTexture` only for sign text.
- Determinism: layout seed only (`WORLD_LAYOUT_SEED`), no per-frame randomness, no simulation RNG.
- Every task ends with `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/vitest run` green.

---

### Task 1: World mode flag, fragment definition, voxel exclusions

**Files:**
- Create: `src/world/hybrid/spikeFlag.ts`
- Create: `src/world/hybrid/spikeFlag.test.ts`
- Modify: `src/world/WorldGenerator.ts:126-150` (`generateGround`), `:1310-1327` (`buildSnowCapPositions`), `:1353-1370` (`createWorld`)

**Interfaces:**
- Produces: `parseWorldMode(value): WorldMode`, `strategyOf(mode): 'direct' | 'greedy' | null`, `SPIKE_FRAGMENT`, `SPIKE_BLOCK_SET`, `SPIKE_POINT_TOWERS`, `isSpikeGroundCell(x, z)`, `createWorld(scene, wind, options?: WorldGeneratorOptions)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/world/hybrid/spikeFlag.test.ts
import { describe, expect, test } from 'vitest';
import { BLOCK_CONFIGS, isOnRoad } from '../WorldLayout';
import { SPIKE_FRAGMENT, SPIKE_POINT_TOWERS, isSpikeGroundCell, parseWorldMode, strategyOf } from './spikeFlag';

describe('spike flag', () => {
  test('defaults to the voxel city for anything but the two hybrid modes', () => {
    expect(parseWorldMode(null)).toBe('voxel');
    expect(parseWorldMode('hybrid')).toBe('voxel');
    expect(parseWorldMode('hybrid-direct')).toBe('hybrid-direct');
    expect(parseWorldMode('hybrid-greedy')).toBe('hybrid-greedy');
    expect(strategyOf('voxel')).toBeNull();
    expect(strategyOf('hybrid-greedy')).toBe('greedy');
  });

  test('fragment blocks sit around Osiedle Centralne and the point tower is flagged explicitly', () => {
    for (const index of SPIKE_FRAGMENT.blocks) {
      const block = BLOCK_CONFIGS[index];
      expect(block.x).toBeGreaterThanOrEqual(-30);
      expect(block.x + block.w).toBeLessThanOrEqual(20);
      expect(block.z).toBeGreaterThanOrEqual(0);
      expect(block.z + block.d).toBeLessThanOrEqual(40);
    }
    expect([...SPIKE_POINT_TOWERS]).toEqual([5]);
    expect(SPIKE_FRAGMENT.blocks).toContain(5);
  });

  test('ground exclusion covers pavement inside the rectangle only', () => {
    expect(isSpikeGroundCell(-11, 27)).toBe(true);   // north pavement by the shelter
    expect(isSpikeGroundCell(-11, 24)).toBe(false);  // asphalt stays product
    expect(isOnRoad(-11, 24)).toBe(true);
    expect(isSpikeGroundCell(-11, 30)).toBe(false);  // grass stays product
    expect(isSpikeGroundCell(40, 27)).toBe(false);   // outside the rectangle
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/world/hybrid/spikeFlag.test.ts`
Expected: FAIL — module `./spikeFlag` not found.

- [ ] **Step 3: Write the flag module**

```ts
// src/world/hybrid/spikeFlag.ts
import { isOnSidewalk } from '../WorldLayout';

export type WorldMode = 'voxel' | 'hybrid-direct' | 'hybrid-greedy';
export type HybridStrategyName = 'direct' | 'greedy';

export function parseWorldMode(value: string | null | undefined): WorldMode {
  return value === 'hybrid-direct' || value === 'hybrid-greedy' ? value : 'voxel';
}

export function strategyOf(mode: WorldMode): HybridStrategyName | null {
  if (mode === 'hybrid-direct') return 'direct';
  if (mode === 'hybrid-greedy') return 'greedy';
  return null;
}

/** Osiedle Centralne: five blocks around the stop plus the pavement between them. */
export const SPIKE_FRAGMENT = {
  blocks: [3, 4, 5, 24, 25],
  ground: { minX: -30, maxX: 12, minZ: 0, maxZ: 40 },
} as const;

export const SPIKE_BLOCK_SET: ReadonlySet<number> = new Set(SPIKE_FRAGMENT.blocks);
/** Gate 4: only explicitly flagged blocks may grow to 1.8× their metre height. */
export const SPIKE_POINT_TOWERS: ReadonlySet<number> = new Set([5]);

export function isSpikeGroundCell(x: number, z: number): boolean {
  const g = SPIKE_FRAGMENT.ground;
  return x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ && isOnSidewalk(x, z);
}
```

- [ ] **Step 4: Add exclusion options to the voxel generator (three small edits)**

In `src/world/WorldGenerator.ts`:

```ts
export interface WorldGeneratorOptions {
  /** BLOCK_CONFIGS indices rendered by another system (hybrid spike). */
  excludeBlocks?: ReadonlySet<number>;
  /** Ground cells rendered by another system. */
  excludeGroundCell?: (x: number, z: number) => boolean;
}
```

`generateGround(size: number, exclude?: (x: number, z: number) => boolean)` — inside the double loop, first line: `if (exclude?.(x, z)) continue;`.

`buildSnowCapPositions(excludeBlocks?: ReadonlySet<number>)` — in the block loop: `for (const [index, block] of BLOCK_CONFIGS.entries()) { if (excludeBlocks?.has(index)) continue; ... }`.

`createWorld(scene, windUniforms, options: WorldGeneratorOptions = {})`:
```ts
allVoxels.push(...generateGround(WORLD_HALF_SIZE, options.excludeGroundCell));
// ...
for (const [index, block] of BLOCK_CONFIGS.entries()) {
  if (options.excludeBlocks?.has(index)) continue;
  allVoxels.push(...generateBlockBuilding(block));
}
// ...
const snowCapPositions = buildSnowCapPositions(options.excludeBlocks);
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run`
Expected: PASS (183 tests).

- [ ] **Step 6: Commit**

```bash
git add src/world/hybrid/spikeFlag.ts src/world/hybrid/spikeFlag.test.ts src/world/WorldGenerator.ts
git commit -m "spike(hybrid): add world mode flag, fragment definition and voxel exclusions"
```

---

### Task 2: Palette with theme/snow/wet semantics and the shared HybridMaterial

**Files:**
- Create: `src/world/hybrid/palette.ts`, `src/world/hybrid/palette.test.ts`
- Create: `src/world/hybrid/HybridMaterial.ts`

**Interfaces:**
- Produces: `PALETTE`, `PALETTE_SIZE = 32`, `P` (key → index), `resolvePalette(overrides, out)`, `resolveSnowTints(out)`, `resolveParams(out)`, `createHybridUniforms()`, `createHybridMaterial(uniforms, { transparent?, glass? })`, attribute names `aPalette`, `aCohort`, `aAo`, `aStyle`, styles `STYLE = { plain: 0, seams: 1, pavement: 2, asphalt: 3, glass: 4 }`.

- [ ] **Step 1: Write the failing palette test**

```ts
// src/world/hybrid/palette.test.ts
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { COLORS } from '../WorldLayout';
import { P, PALETTE, PALETTE_SIZE, resolvePalette, resolveParams } from './palette';

describe('hybrid palette', () => {
  test('fits the uniform array and has unique keys', () => {
    expect(PALETTE.length).toBeLessThanOrEqual(PALETTE_SIZE);
    expect(new Set(PALETTE.map((e) => e.key)).size).toBe(PALETTE.length);
  });

  test('theme overrides of the origin colour move derived entries by the same relative shift', () => {
    const base = resolvePalette({});
    const retro = resolvePalette({ [COLORS.concrete]: 0x9a9286 });
    const i = P.plasterWarm;
    const origin = new THREE.Color(COLORS.concrete).getHSL({ h: 0, s: 0, l: 0 });
    const override = new THREE.Color(0x9a9286).getHSL({ h: 0, s: 0, l: 0 });
    const baseC = new THREE.Color(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).getHSL({ h: 0, s: 0, l: 0 });
    const retroC = new THREE.Color(retro[i * 3], retro[i * 3 + 1], retro[i * 3 + 2]).getHSL({ h: 0, s: 0, l: 0 });
    expect(retroC.l - baseC.l).toBeCloseTo(override.l - origin.l, 2);
    // an entry without origin is untouched
    const g = P.glass;
    expect(retro[g * 3]).toBeCloseTo(base[g * 3], 6);
  });

  test('wet and snow flags follow the material semantics of the voxel city', () => {
    const params = resolveParams();
    expect(params[P.asphalt * 4 + 2]).toBe(1);   // wet-reactive
    expect(params[P.pavement * 4 + 2]).toBe(1);
    expect(params[P.plasterWarm * 4 + 2]).toBe(0);
    expect(params[P.roofFlat * 4 + 3]).toBe(1);   // has snow tint
    expect(params[P.glass * 4 + 3]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/world/hybrid/palette.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the palette**

```ts
// src/world/hybrid/palette.ts
import * as THREE from 'three';
import { COLORS } from '../WorldLayout';

export interface PaletteEntry {
  readonly key: string;
  readonly base: number;
  /** Original COLORS value this entry is derived from (theme overrides propagate). */
  readonly origin?: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly wet: boolean;
  readonly snow: number | null;
  /** Constant emissive strength (aviation lights, lamp heads, lit signs). */
  readonly emissive?: number;
}

export const PALETTE_SIZE = 32;
const M = (key: string, base: number, o: Partial<PaletteEntry> = {}): PaletteEntry => ({
  key, base, roughness: 0.9, metalness: 0, wet: false, snow: null, ...o,
});

export const PALETTE: readonly PaletteEntry[] = [
  M('plasterWarm', 0xc9a366, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterRose', 0xb98577, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterOlive', 0x9aa07c, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterSand', 0xd1b990, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterGrey', 0xa89f93, { origin: COLORS.concrete, roughness: 0.92 }),
  M('prefabLight', 0xb9b1a3, { origin: COLORS.concrete, roughness: 0.94 }),
  M('prefabCool', 0xaeb0ae, { origin: COLORS.concrete, roughness: 0.94 }),
  M('towerGrey', 0xadb0b3, { origin: COLORS.concrete, roughness: 0.94 }),
  M('plinth', 0x6f6d66, { origin: COLORS.concreteDark, roughness: 0.95 }),
  M('trim', 0xc9c3b5, { origin: COLORS.concreteLight, roughness: 0.85, snow: 0xe9eef4 }),
  M('frame', 0xdcd6c8, { roughness: 0.8 }),
  M('roofFlat', 0x44474c, { origin: COLORS.roof, roughness: 0.96, snow: 0xe9eef4 }),
  M('roofTile', 0x8d4b39, { roughness: 0.9, snow: 0xe9eef4 }),
  M('roofSheet', 0x3a444c, { roughness: 0.6, metalness: 0.3, snow: 0xe9eef4 }),
  M('glass', 0x3a5266, { origin: COLORS.window, roughness: 0.06, metalness: 0.85 }),
  M('glassWarm', 0x4a3f37, { roughness: 0.1, metalness: 0.6 }),
  M('curtain', 0x7a7466, { roughness: 0.9 }),
  M('accentGold', 0xc98a3a, { origin: COLORS.accent, roughness: 0.75 }),
  M('accentRose', 0xb8746a, { origin: COLORS.accentPink, roughness: 0.75 }),
  M('accentBlue', 0x4c7f99, { origin: COLORS.accentBlue, roughness: 0.75 }),
  M('steel', 0x55606a, { origin: COLORS.steel, roughness: 0.42, metalness: 0.65 }),
  M('wood', 0x6b4a30, { origin: COLORS.sleeper, roughness: 0.8 }),
  M('pavement', 0x9c988c, { origin: COLORS.sidewalk, roughness: 1, wet: true, snow: 0xcdd2d7 }),
  M('kerb', 0xb3afa2, { origin: COLORS.sidewalk, roughness: 1, wet: true, snow: 0xd4d8dc }),
  M('marking', 0xd8d1a8, { origin: COLORS.roadMarking, roughness: 1, wet: true }),
  M('asphalt', 0x34363b, { origin: COLORS.road, roughness: 1, wet: true, snow: 0x4a4c52 }),
  M('interior', 0x3b332c, { roughness: 0.95 }),
  M('goodsA', 0xd9a441, { roughness: 0.8 }),
  M('goodsB', 0x5a8f4a, { roughness: 0.8 }),
  M('concrete', 0x8e8d86, { origin: COLORS.concrete, roughness: 0.95, snow: 0xe9eef4 }),
  M('aviationRed', 0xff2a1e, { roughness: 0.5, emissive: 1.6 }),
  M('lamp', 0xfff1cc, { roughness: 0.6, emissive: 0.6 }),
];

export const P: Record<string, number> = Object.fromEntries(PALETTE.map((e, i) => [e.key, i]));

const hsl = { h: 0, s: 0, l: 0 };
const tmp = new THREE.Color();
const wrap01 = (v: number) => ((v % 1) + 1) % 1;

/** Linear RGB triplets for `uPalette`. Overrides are keyed by original COLORS values, like Themes. */
export function resolvePalette(overrides: Record<number, number>, out = new Float32Array(PALETTE_SIZE * 3)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    const entry = PALETTE[i];
    tmp.setHex(entry.base);
    const override = entry.origin !== undefined ? overrides[entry.origin] : undefined;
    if (override !== undefined && override !== entry.origin) {
      const baseHsl = { ...tmp.getHSL(hsl) };
      const originHsl = { ...new THREE.Color(entry.origin!).getHSL(hsl) };
      const overHsl = { ...new THREE.Color(override).getHSL(hsl) };
      tmp.setHSL(
        wrap01(overHsl.h + (baseHsl.h - originHsl.h)),
        THREE.MathUtils.clamp(overHsl.s + (baseHsl.s - originHsl.s), 0, 1),
        THREE.MathUtils.clamp(overHsl.l + (baseHsl.l - originHsl.l), 0, 1)
      );
    }
    out[i * 3] = tmp.r; out[i * 3 + 1] = tmp.g; out[i * 3 + 2] = tmp.b;
  }
  return out;
}

export function resolveSnowTints(out = new Float32Array(PALETTE_SIZE * 3)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    tmp.setHex(PALETTE[i].snow ?? PALETTE[i].base);
    out[i * 3] = tmp.r; out[i * 3 + 1] = tmp.g; out[i * 3 + 2] = tmp.b;
  }
  return out;
}

/** vec4 per entry: roughness, metalness, wet-reactive, has-snow-tint. */
export function resolveParams(out = new Float32Array(PALETTE_SIZE * 4)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    const e = PALETTE[i];
    out[i * 4] = e.roughness; out[i * 4 + 1] = e.metalness; out[i * 4 + 2] = e.wet ? 1 : 0; out[i * 4 + 3] = e.snow ? 1 : 0;
  }
  return out;
}

export function resolveEmissive(out = new Float32Array(PALETTE_SIZE)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) out[i] = PALETTE[i].emissive ?? 0;
  return out;
}
```

- [ ] **Step 4: Write the material**

```ts
// src/world/hybrid/HybridMaterial.ts
import * as THREE from 'three';
import { WINDOW_COHORT_COUNT } from '../../environment/CityRhythm';
import { PALETTE_SIZE, resolveEmissive, resolvePalette, resolveParams, resolveSnowTints } from './palette';

export const STYLE = { plain: 0, seams: 1, pavement: 2, asphalt: 3, glass: 4 } as const;

export interface HybridUniforms {
  uPalette: THREE.IUniform<Float32Array>;
  uSnowTint: THREE.IUniform<Float32Array>;
  uParams: THREE.IUniform<Float32Array>;
  uEmissive: THREE.IUniform<Float32Array>;
  uCohort: THREE.IUniform<Float32Array>;
  uSnow: THREE.IUniform<number>;
  uWet: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uLit: THREE.IUniform<THREE.Color>;
}

export function createHybridUniforms(): HybridUniforms {
  return {
    uPalette: { value: resolvePalette({}) },
    uSnowTint: { value: resolveSnowTints() },
    uParams: { value: resolveParams() },
    uEmissive: { value: resolveEmissive() },
    uCohort: { value: new Float32Array(WINDOW_COHORT_COUNT) },
    uSnow: { value: 0 },
    uWet: { value: 0 },
    uNight: { value: 0 },
    uLit: { value: new THREE.Color(0xffdd88) },
  };
}

const NOISE = /* glsl */ `
  float hbHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float hbNoise(vec3 x) { vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hbHash(i), hbHash(i + vec3(1,0,0)), f.x), mix(hbHash(i + vec3(0,1,0)), hbHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hbHash(i + vec3(0,0,1)), hbHash(i + vec3(1,0,1)), f.x), mix(hbHash(i + vec3(0,1,1)), hbHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

export function createHybridMaterial(uniforms: HybridUniforms, options: { transparent?: boolean } = {}): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: !!options.transparent,
    opacity: options.transparent ? 0.42 : 1,
    depthWrite: !options.transparent,
  });
  material.envMapIntensity = 1;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPalette; attribute float aCohort; attribute float aAo; attribute float aStyle;
        varying float vPalette; varying float vCohort; varying float vAo; varying float vStyle; varying vec3 vWPos; varying vec3 vWNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vPalette = aPalette; vCohort = aCohort; vAo = aAo; vStyle = aStyle;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uPalette[${PALETTE_SIZE}]; uniform vec3 uSnowTint[${PALETTE_SIZE}]; uniform vec4 uParams[${PALETTE_SIZE}]; uniform float uEmissive[${PALETTE_SIZE}];
        uniform float uCohort[${WINDOW_COHORT_COUNT}]; uniform float uSnow; uniform float uWet; uniform float uNight; uniform vec3 uLit;
        varying float vPalette; varying float vCohort; varying float vAo; varying float vStyle; varying vec3 vWPos; varying vec3 vWNormal;
        ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        int hbIdx = int(vPalette + 0.5);
        vec4 hbPrm = uParams[hbIdx];
        vec3 hbCol = uPalette[hbIdx];
        float hbUp = clamp(vWNormal.y, 0.0, 1.0);
        float hbN = hbNoise(vWPos * 0.9) * 0.55 + hbNoise(vWPos * 4.1) * 0.3 + hbNoise(vWPos * 15.0) * 0.15;
        float hbActivity = 0.0;
        if (vStyle > 3.5) {
          if (vCohort > -0.5) { hbActivity = uCohort[int(vCohort + 0.5)]; }
          hbCol = mix(hbCol, uLit, hbActivity);
        } else {
          hbCol *= 1.0 + (hbN - 0.5) * 0.08;
          if (vStyle < 1.5) hbCol *= 1.0 - 0.16 * (1.0 - smoothstep(-0.5, 1.6, vWPos.y)) * (1.0 - hbUp);
          if (vStyle > 0.5 && vStyle < 1.5) {
            float vc = abs(vWNormal.x) > 0.5 ? vWPos.z : vWPos.x;
            float fy = abs(fract((vWPos.y + 0.5) / 2.8 + 0.5) - 0.5) * 2.8;
            float fx = abs(fract(vc / 3.0 + 0.5) - 0.5) * 3.0;
            hbCol *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.05, min(fy, fx))) * (1.0 - hbUp);
          }
          if (vStyle > 1.5 && vStyle < 2.5 && hbUp > 0.5) {
            vec2 g = abs(fract(vWPos.xz * 2.0 + 0.5) - 0.5) * 0.5;
            hbCol *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.02, min(g.x, g.y)));
          }
          if (vStyle > 2.5 && vStyle < 3.5 && hbUp > 0.5) {
            hbCol *= 1.0 - 0.09 * smoothstep(0.55, 0.75, hbNoise(vWPos * 0.35 + 7.0));
          }
          hbCol = mix(hbCol, uSnowTint[hbIdx], uSnow * hbPrm.w * smoothstep(0.35, 0.8, hbUp));
          hbCol *= 1.0 - uWet * hbPrm.z * 0.38;
        }
        diffuseColor.rgb = hbCol * vAo;`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(hbPrm.x, 0.12, uWet * hbPrm.z);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = mix(hbPrm.y, 0.45, uWet * hbPrm.z);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uLit * hbActivity * (0.02 + uNight * 1.23);
        totalEmissiveRadiance += uPalette[hbIdx] * uEmissive[hbIdx];`);
  };
  material.customProgramCacheKey = () => `hybrid-${options.transparent ? 'clear' : 'opaque'}`;
  return material;
}
```

Note: attributes are declared with `attribute`; three defines `attribute`→`in` for GLSL3. `hbPrm`/`hbIdx`/`hbActivity` are declared at `main()` scope so the roughness/metalness/emissive chunks can read them.

- [ ] **Step 5: Run tests and typecheck**

Run: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run src/world/hybrid`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/world/hybrid/palette.ts src/world/hybrid/palette.test.ts src/world/hybrid/HybridMaterial.ts
git commit -m "spike(hybrid): palette with theme/snow/wet semantics and shared material"
```

---

### Task 3: Semantic city model (families, metre heights, streetscape, props, dominants)

**Files:**
- Create: `src/world/hybrid/families.ts`, `src/world/hybrid/CityModel.ts`, `src/world/hybrid/CityModel.test.ts`

**Interfaces:**
- Produces: `Family`, `Side`, `familyOf(index)`, `floorPlan(family, heightMetres, pointTower): FloorPlan`, `BuildingSpec`, `PropSpec`, `DominantSpec`, `CityModel`, `buildCityModel(): CityModel`, `groundHeightAt(model, x, z)`, `GROUND = GROUND_SURFACE_Y`, `KERB_HEIGHT = 0.12`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/world/hybrid/CityModel.test.ts
import { describe, expect, test } from 'vitest';
import { BLOCK_CONFIGS, BUS_ROUTE_CURVE, BUS_STOPS, GROUND_SURFACE_Y, isOnRoad } from '../WorldLayout';
import { buildCityModel, groundHeightAt } from './CityModel';
import { floorPlan } from './families';

describe('hybrid city model', () => {
  const model = buildCityModel();

  test('keeps every block height in metres and grows only the flagged point tower', () => {
    for (const b of model.buildings) {
      const block = BLOCK_CONFIGS[b.index];
      expect(b.heightMetres).toBe(block.h);
      if (b.pointTower) {
        expect(b.index).toBe(5);
        expect(b.bodyHeight).toBeCloseTo(Math.round((block.h * 1.8) / 2.8) * 2.8, 5);
      } else {
        expect(Math.abs(b.bodyHeight - block.h)).toBeLessThanOrEqual(1.5);
      }
      expect(b.floors).toBeGreaterThanOrEqual(3);
    }
  });

  test('floor plans are deterministic and family-specific', () => {
    expect(floorPlan('slab', 15, false)).toMatchObject({ floorHeight: 2.8, floors: 5, roof: 'flat' });
    expect(floorPlan('tenement', 15, false)).toMatchObject({ groundFloorHeight: 3.7, floorHeight: 3.3, floors: 4, roof: 'hip' });
    expect(floorPlan('tower', 16, true).bodyHeight).toBeCloseTo(28, 5);
    expect(floorPlan('tower', 16, false).bodyHeight).toBeCloseTo(16.8, 5);
  });

  test('footprints never change', () => {
    for (const b of model.buildings) {
      const block = BLOCK_CONFIGS[b.index];
      expect([b.x, b.z, b.w, b.d]).toEqual([block.x, block.z, block.w, block.d]);
    }
  });

  test('the crosswalk stays clear of the dwelling bus and off the pavement', () => {
    const stop = BUS_STOPS[0];
    const lead = BUS_ROUTE_CURVE.getPointAt(stop.atT);
    const busMinX = lead.x - 8, busMaxX = lead.x;      // 8 m bus, heading +x, lead at the stop point
    const cw = model.crosswalk;
    expect(cw.maxX < busMinX - 2 || cw.minX > busMaxX + 2).toBe(true);
    expect(isOnRoad(Math.round((cw.minX + cw.maxX) / 2), 24)).toBe(true);
  });

  test('ground is flush: pavement, forecourt and grass share the product surface height', () => {
    expect(groundHeightAt(model, -11, 27)).toBe(GROUND_SURFACE_Y);
    expect(groundHeightAt(model, -2, 29)).toBe(GROUND_SURFACE_Y);
    expect(groundHeightAt(model, 30, 30)).toBe(GROUND_SURFACE_Y);
  });

  test('every prop has ground probes and lies on pavement or forecourt cells', () => {
    const paved = new Set([...model.pavement, ...model.forecourt].map((c) => `${c.x},${c.z}`));
    for (const prop of model.props) {
      expect(prop.probes.length).toBeGreaterThan(0);
      for (const probe of prop.probes) {
        expect(paved.has(`${Math.round(probe.x)},${Math.round(probe.z)}`)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node_modules/.bin/vitest run src/world/hybrid/CityModel.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write families.ts**

```ts
// src/world/hybrid/families.ts
export type Family = 'slab' | 'tower' | 'tenement' | 'walkup';
export type RoofKind = 'flat' | 'hip' | 'gable';

const TOWERS = new Set([5, 10, 30]);
const TENEMENTS = new Set([6, 7, 23, 24, 25, 26, 27]);
const WALKUPS = new Set([0, 2, 9, 12, 16, 21, 28]);

export function familyOf(index: number): Family {
  if (TOWERS.has(index)) return 'tower';
  if (TENEMENTS.has(index)) return 'tenement';
  if (WALKUPS.has(index)) return 'walkup';
  return 'slab';
}

export interface FloorPlan {
  floorHeight: number;
  groundFloorHeight: number;
  floors: number;
  bodyHeight: number;
  roof: RoofKind;
  roofHeight: number;
}

/**
 * Gate 4: the metre height from the layout is the truth; floors are derived. Only a
 * flagged point tower grows (×1.8). Pitched roofs sit on top of the body height.
 */
export function floorPlan(family: Family, heightMetres: number, pointTower: boolean): FloorPlan {
  if (family === 'tenement') {
    const groundFloorHeight = 3.7, floorHeight = 3.3;
    const upper = Math.max(2, Math.round((heightMetres - groundFloorHeight - 1.2) / floorHeight));
    return { floorHeight, groundFloorHeight, floors: upper + 1, bodyHeight: groundFloorHeight + upper * floorHeight, roof: 'hip', roofHeight: 3.2 };
  }
  if (family === 'walkup') {
    return { floorHeight: 2.75, groundFloorHeight: 2.75, floors: 4, bodyHeight: 11, roof: 'gable', roofHeight: 1.9 };
  }
  const floorHeight = 2.8;
  const target = family === 'tower' && pointTower ? heightMetres * 1.8 : heightMetres;
  const floors = Math.max(3, Math.round(target / floorHeight));
  return { floorHeight, groundFloorHeight: floorHeight, floors, bodyHeight: floors * floorHeight, roof: 'flat', roofHeight: 0 };
}
```

- [ ] **Step 4: Write CityModel.ts**

```ts
// src/world/hybrid/CityModel.ts
import { BLOCK_CONFIGS, BUILDING_ENTRANCES, GROUND_SURFACE_Y, WORLD_LAYOUT_SEED, isOnRoad, type ColorHex } from '../WorldLayout';
import { P } from './palette';
import { SPIKE_FRAGMENT, SPIKE_POINT_TOWERS, isSpikeGroundCell } from './spikeFlag';
import { familyOf, floorPlan, type Family, type FloorPlan } from './families';

export const GROUND = GROUND_SURFACE_Y;
export const KERB_HEIGHT = 0.12;
export type Side = '+x' | '-x' | '+z' | '-z';

export interface BuildingSpec extends FloorPlan {
  index: number; family: Family; pointTower: boolean;
  x: number; z: number; w: number; d: number; cx: number; cz: number;
  heightMetres: number; accent: ColorHex; tint: number; seed: number;
  entrance: { side: Side; along: number } | null;
  /** Side facing Aleja Południowa (z ≈ 24); tenements put shops and balconies there. */
  avenueSide: Side;
}

export interface GroundProbe { x: number; y: number; z: number; }
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number; }
export type PropKind = 'bikeRack' | 'bicycle' | 'bicycleLeaning' | 'bin' | 'planter' | 'noticeBoard' | 'hedge';
export interface PropSpec {
  id: string; kind: PropKind; x: number; z: number; ry: number;
  /** Points that must lie on the ground (12 mm tolerance). */
  probes: GroundProbe[];
  clearance?: Rect;
}
export interface CrosswalkSpec { minX: number; maxX: number; minZ: number; maxZ: number; stripes: number; }
export interface DominantSpec { kind: 'chimney' | 'rtvTower'; x: number; z: number; height: number; }
export interface CityModel {
  buildings: BuildingSpec[];
  pavement: Array<{ x: number; z: number }>;
  kerbs: Array<{ x: number; z: number; side: Side }>;
  forecourt: Array<{ x: number; z: number }>;
  crosswalk: CrosswalkSpec;
  props: PropSpec[];
  dominants: DominantSpec[];
}

function hash01(...nums: number[]): number {
  let h = 2166136261 ^ WORLD_LAYOUT_SEED;
  for (const n of nums) { h ^= Math.floor(n * 1000) | 0; h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

const TINTS: Record<Family, number[]> = {
  slab: [P.prefabLight, P.prefabCool, P.plasterGrey],
  tower: [P.towerGrey, P.prefabCool],
  tenement: [P.plasterWarm, P.plasterRose, P.plasterOlive, P.plasterSand],
  walkup: [P.plasterSand, P.plasterWarm],
};

export const FORECOURT: Rect = { minX: -4, maxX: 5, minZ: 28, maxZ: 31 };
export const CROSSWALK: CrosswalkSpec = { minX: -3.2, maxX: -1.8, minZ: 22, maxZ: 26, stripes: 5 };
export const RTV_SITES = { recommended: { x: 16, z: -66 }, alternative: { x: -70, z: 22 } } as const;
export const CHIMNEY_SITE = { x: -58, z: -40 } as const;

export function buildCityModel(): CityModel {
  const buildings: BuildingSpec[] = SPIKE_FRAGMENT.blocks.map((index) => {
    const b = BLOCK_CONFIGS[index];
    const family = familyOf(index);
    const pointTower = SPIKE_POINT_TOWERS.has(index);
    const plan = floorPlan(family, b.h, pointTower);
    const cx = b.x + b.w / 2 - 0.5, cz = b.z + b.d / 2 - 0.5;
    const e = BUILDING_ENTRANCES.find((entry) => entry.block === b);
    let entrance: BuildingSpec['entrance'] = null;
    if (e) {
      const dx = e.outsideX - e.doorX, dz = e.outsideZ - e.doorZ;
      entrance = dz !== 0
        ? { side: dz > 0 ? '+z' : '-z', along: e.doorX - cx }
        : { side: dx > 0 ? '+x' : '-x', along: e.doorZ - cz };
    }
    const tints = TINTS[family];
    return {
      ...plan, index, family, pointTower, x: b.x, z: b.z, w: b.w, d: b.d, cx, cz,
      heightMetres: b.h, accent: b.accent, seed: hash01(index, 17),
      tint: tints[Math.floor(hash01(index, 3) * tints.length) % tints.length],
      entrance, avenueSide: cz > 24 ? '-z' : '+z',
    };
  });

  const g = SPIKE_FRAGMENT.ground;
  const pavement: CityModel['pavement'] = [];
  const kerbs: CityModel['kerbs'] = [];
  for (let x = g.minX; x <= g.maxX; x++) for (let z = g.minZ; z <= g.maxZ; z++) {
    if (!isSpikeGroundCell(x, z)) continue;
    pavement.push({ x, z });
    if (isOnRoad(x + 1, z)) kerbs.push({ x, z, side: '+x' });
    if (isOnRoad(x - 1, z)) kerbs.push({ x, z, side: '-x' });
    if (isOnRoad(x, z + 1)) kerbs.push({ x, z, side: '+z' });
    if (isOnRoad(x, z - 1)) kerbs.push({ x, z, side: '-z' });
  }
  const paved = new Set(pavement.map((c) => `${c.x},${c.z}`));
  const forecourt: CityModel['forecourt'] = [];
  for (let x = FORECOURT.minX; x <= FORECOURT.maxX; x++) for (let z = FORECOURT.minZ; z <= FORECOURT.maxZ; z++) {
    if (!paved.has(`${x},${z}`)) forecourt.push({ x, z });
  }

  const props: PropSpec[] = [
    { id: 'rack', kind: 'bikeRack', x: -2.2, z: 29.3, ry: 0, probes: rackProbes(-2.2, 29.3) },
    { id: 'bike-a', kind: 'bicycle', x: -2.7, z: 29.3, ry: Math.PI / 2, probes: bicycleProbes(-2.7, 29.3, Math.PI / 2) },
    { id: 'bike-b', kind: 'bicycle', x: -1.7, z: 29.3, ry: Math.PI / 2, probes: bicycleProbes(-1.7, 29.3, Math.PI / 2) },
    { id: 'bike-lean', kind: 'bicycleLeaning', x: 4.75, z: 30.7, ry: 0.15, probes: bicycleProbes(4.75, 30.7, 0.15) },
    { id: 'bin', kind: 'bin', x: -3.6, z: 28.4, ry: 0, probes: [{ x: -3.6, y: GROUND, z: 28.4 }] },
    { id: 'planter', kind: 'planter', x: 1.6, z: 31.1, ry: 0, probes: [{ x: 1.2, y: GROUND, z: 31.1 }, { x: 2.0, y: GROUND, z: 31.1 }] },
    { id: 'board', kind: 'noticeBoard', x: 2.4, z: 31.25, ry: 0, probes: [{ x: 2.4, y: GROUND, z: 31.25 }] },
  ];
  return { buildings, pavement, kerbs, forecourt, crosswalk: CROSSWALK, props, dominants: [
    { kind: 'chimney', x: CHIMNEY_SITE.x, z: CHIMNEY_SITE.z, height: 46 },
    { kind: 'rtvTower', x: RTV_SITES.recommended.x, z: RTV_SITES.recommended.z, height: 62 },
  ] };
}

function bicycleProbes(x: number, z: number, ry: number): GroundProbe[] {
  const c = Math.cos(ry), s = Math.sin(ry);
  return [-0.55, 0.55].map((dx) => ({ x: x + dx * c, y: GROUND, z: z - dx * s }));
}
function rackProbes(x: number, z: number): GroundProbe[] {
  return [[-0.5, -0.3], [-0.5, 0.3], [0.5, -0.3], [0.5, 0.3]].map(([dx, dz]) => ({ x: x + dx, y: GROUND, z: z + dz }));
}

/** Flush ground: the spike does not raise the pavement (product props would sink). Kerbs are ridges. */
export function groundHeightAt(_model: CityModel, _x: number, _z: number): number {
  return GROUND;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run src/world/hybrid`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/world/hybrid/families.ts src/world/hybrid/CityModel.ts src/world/hybrid/CityModel.test.ts
git commit -m "spike(hybrid): deterministic city model with families, metre heights, streetscape and props"
```

---

### Task 4: Surface primitives and emitters (architecture, streetscape, dominants)

**Files:**
- Create: `src/world/hybrid/surface.ts` (types + helpers), `src/world/hybrid/architecture.ts`, `src/world/hybrid/streetscape.ts`, `src/world/hybrid/dominants.ts`, `src/world/hybrid/emitters.test.ts`

**Interfaces:**
- Produces: `Layer = 0|1|2`, `MaterialClass = 'opaque' | 'glass' | 'glassClear' | 'glow'`, `SurfacePrimitive` union (`box`, `plane`, `prism`, `cylinder`, `torus`), `Cluster { id, center: [x,y,z], primitives }`, `emitBuilding(spec): Cluster`, `emitStreetscape(model): Cluster`, `emitDominant(spec, low): Cluster`, `validateDominantSite(x, z)`, `dominantBearingsFromOverview()`.

Primitive contract (every kind):
```ts
export interface PrimitiveBase { layer: Layer; cls: MaterialClass; palette: number; cohort: number; style: number; ao: number; }
export interface BoxPrim extends PrimitiveBase { kind: 'box'; x: number; y: number; z: number; w: number; h: number; d: number; rx: number; ry: number; rz: number; }
export interface PlanePrim extends PrimitiveBase { kind: 'plane'; x: number; y: number; z: number; w: number; h: number; ry: number; rx: number; }
export interface PrismPrim extends PrimitiveBase { kind: 'prism'; positions: Float32Array; /* world-space triangle soup, outward CCW */ }
export interface CylinderPrim extends PrimitiveBase { kind: 'cylinder'; x: number; y: number; z: number; rTop: number; rBottom: number; h: number; segments: number; rx: number; rz: number; }
export interface TorusPrim extends PrimitiveBase { kind: 'torus'; x: number; y: number; z: number; radius: number; tube: number; ry: number; }
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/world/hybrid/emitters.test.ts
import { describe, expect, test } from 'vitest';
import { OVERVIEW_SHOT } from '../../experience/ShotDefinitions';
import { LAKE } from '../WorldLayout';
import { buildCityModel, CHIMNEY_SITE, RTV_SITES } from './CityModel';
import { emitBuilding } from './architecture';
import { emitStreetscape } from './streetscape';
import { emitDominant, validateDominantSite, bearingFromOverview } from './dominants';

const model = buildCityModel();

describe('architecture emitter', () => {
  test('every fragment building has massing in L0, openings in L1 and trim in L2', () => {
    for (const spec of model.buildings) {
      const { primitives } = emitBuilding(spec);
      const layers = new Set(primitives.map((p) => p.layer));
      expect(layers).toEqual(new Set([0, 1, 2]));
      const glass = primitives.filter((p) => p.cls === 'glass');
      expect(glass.length).toBeGreaterThanOrEqual(spec.floors * 4);
      expect(glass.every((p) => p.cohort >= 0 && p.cohort < 5)).toBe(true);
    }
  });

  test('tenements facing the avenue get shop display bays with goods', () => {
    const tenement = model.buildings.find((b) => b.family === 'tenement')!;
    const { primitives } = emitBuilding(tenement);
    expect(primitives.some((p) => p.cls === 'glassClear')).toBe(true);
    expect(primitives.filter((p) => p.layer === 2 && p.kind === 'box' && p.cls === 'opaque').length).toBeGreaterThan(20);
  });

  test('is deterministic', () => {
    const a = emitBuilding(model.buildings[0]).primitives, b = emitBuilding(model.buildings[0]).primitives;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('streetscape emitter', () => {
  test('emits pavement, kerbs, crosswalk stripes and one primitive group per prop', () => {
    const { primitives } = emitStreetscape(model);
    expect(primitives.filter((p) => p.kind === 'plane' && p.style === 2).length).toBe(model.pavement.length + model.forecourt.length);
    expect(primitives.filter((p) => p.kind === 'torus').length).toBe(6); // three bicycles
    expect(primitives.filter((p) => p.palette === 24 /* marking */ && p.layer === 0).length).toBeGreaterThanOrEqual(model.crosswalk.stripes);
  });
});

describe('dominants', () => {
  test('both sites validate and the recommended one is clear of the chimney and the lake in the default view', () => {
    expect(validateDominantSite(RTV_SITES.recommended.x, RTV_SITES.recommended.z)).toEqual([]);
    expect(validateDominantSite(RTV_SITES.alternative.x, RTV_SITES.alternative.z)).toEqual([]);
    const tower = bearingFromOverview(RTV_SITES.recommended.x, RTV_SITES.recommended.z);
    const chimney = bearingFromOverview(CHIMNEY_SITE.x, CHIMNEY_SITE.z);
    const lake = bearingFromOverview(LAKE.x, LAKE.z);
    const sep = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    expect(sep(tower, chimney)).toBeGreaterThanOrEqual(20);
    expect(sep(tower, lake)).toBeGreaterThanOrEqual(25);
    expect(OVERVIEW_SHOT.position[1]).toBeGreaterThan(0);
  });

  test('the Low variant of the tower is a strict subset in primitive count and keeps the aviation lights', () => {
    const spec = model.dominants.find((d) => d.kind === 'rtvTower')!;
    const high = emitDominant(spec, false).primitives, low = emitDominant(spec, true).primitives;
    expect(low.length).toBeLessThan(high.length / 2);
    expect(low.filter((p) => p.cls === 'glow').length).toBeGreaterThanOrEqual(3);
    expect(high.filter((p) => p.cls === 'glow').length).toBeGreaterThanOrEqual(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node_modules/.bin/vitest run src/world/hybrid/emitters.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write surface.ts**

```ts
// src/world/hybrid/surface.ts
export type Layer = 0 | 1 | 2;
export type MaterialClass = 'opaque' | 'glass' | 'glassClear' | 'glow';
export interface PrimitiveBase { layer: Layer; cls: MaterialClass; palette: number; cohort: number; style: number; ao: number; }
export interface BoxPrim extends PrimitiveBase { kind: 'box'; x: number; y: number; z: number; w: number; h: number; d: number; rx: number; ry: number; rz: number; }
export interface PlanePrim extends PrimitiveBase { kind: 'plane'; x: number; y: number; z: number; w: number; h: number; rx: number; ry: number; }
export interface PrismPrim extends PrimitiveBase { kind: 'prism'; positions: Float32Array; }
export interface CylinderPrim extends PrimitiveBase { kind: 'cylinder'; x: number; y: number; z: number; rTop: number; rBottom: number; h: number; segments: number; rx: number; rz: number; }
export interface TorusPrim extends PrimitiveBase { kind: 'torus'; x: number; y: number; z: number; radius: number; tube: number; ry: number; }
export type SurfacePrimitive = BoxPrim | PlanePrim | PrismPrim | CylinderPrim | TorusPrim;

export interface Cluster { id: string; center: [number, number, number]; radius: number; primitives: SurfacePrimitive[]; }

type Opt = Partial<Pick<PrimitiveBase, 'layer' | 'cls' | 'cohort' | 'style' | 'ao'>> & { rx?: number; ry?: number; rz?: number };
const base = (o: Opt): PrimitiveBase => ({ layer: o.layer ?? 0, cls: o.cls ?? 'opaque', palette: 0, cohort: o.cohort ?? -1, style: o.style ?? 0, ao: o.ao ?? 1 });

/** Small builder that accumulates primitives for one cluster. */
export class Emitter {
  readonly primitives: SurfacePrimitive[] = [];
  box(palette: number, x: number, y: number, z: number, w: number, h: number, d: number, o: Opt = {}): void {
    this.primitives.push({ ...base(o), kind: 'box', palette, x, y, z, w, h, d, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0 });
  }
  plane(palette: number, x: number, y: number, z: number, w: number, h: number, o: Opt = {}): void {
    this.primitives.push({ ...base(o), kind: 'plane', palette, x, y, z, w, h, rx: o.rx ?? 0, ry: o.ry ?? 0 });
  }
  cylinder(palette: number, x: number, y: number, z: number, rTop: number, rBottom: number, h: number, segments: number, o: Opt = {}): void {
    this.primitives.push({ ...base(o), kind: 'cylinder', palette, x, y, z, rTop, rBottom, h, segments, rx: o.rx ?? 0, rz: o.rz ?? 0 });
  }
  torus(palette: number, x: number, y: number, z: number, radius: number, tube: number, o: Opt = {}): void {
    this.primitives.push({ ...base(o), kind: 'torus', palette, x, y, z, radius, tube, ry: o.ry ?? 0 });
  }
  prism(palette: number, positions: Float32Array, o: Opt = {}): void {
    this.primitives.push({ ...base(o), kind: 'prism', palette, positions });
  }
  cluster(id: string, center: [number, number, number], radius: number): Cluster {
    return { id, center, radius, primitives: this.primitives };
  }
}

/** Convex roof solids as outward-facing triangle soups (positions in world space). */
export function hipRoofPositions(cx: number, y: number, cz: number, w: number, d: number, h: number, ridge: number, ov: number, rotate: boolean): Float32Array {
  const W = w / 2 + ov, D = d / 2 + ov, r = Math.max(0, ridge) / 2;
  const q = (a: number[], b: number[], c: number[], dd: number[]) => [a, b, c, a, c, dd];
  const A = [-W, 0, -D], B = [W, 0, -D], C = [W, 0, D], Dd = [-W, 0, D], R1 = [-r, h, 0], R2 = [r, h, 0];
  const tris = [...q(Dd, C, R2, R1), ...q(A, B, R2, R1), B, C, R2, A, Dd, R1, ...q(A, B, C, Dd)];
  return orient(tris, [0, h * 0.3, 0], cx, y, cz, rotate);
}
export function gableRoofPositions(cx: number, y: number, cz: number, w: number, d: number, h: number, ov: number, rotate: boolean): Float32Array {
  const W = w / 2 + ov, D = d / 2 + ov;
  const q = (a: number[], b: number[], c: number[], dd: number[]) => [a, b, c, a, c, dd];
  const A = [-W, 0, -D], B = [W, 0, -D], C = [W, 0, D], Dd = [-W, 0, D], R1 = [-W, h, 0], R2 = [W, h, 0];
  return orient([...q(Dd, C, R2, R1), ...q(A, B, R2, R1), ...q(A, B, C, Dd), A, Dd, R1, B, C, R2], [0, h * 0.3, 0], cx, y, cz, rotate);
}
function orient(tris: number[][], center: number[], cx: number, y: number, cz: number, rotate: boolean): Float32Array {
  const out = new Float32Array(tris.length * 3);
  for (let t = 0; t < tris.length; t += 3) {
    let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const n = cross(sub(b, a), sub(c, a));
    const mid = [(a[0] + b[0] + c[0]) / 3 - center[0], (a[1] + b[1] + c[1]) / 3 - center[1], (a[2] + b[2] + c[2]) / 3 - center[2]];
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0) [b, c] = [c, b];
    for (const [k, v] of [a, b, c].entries()) {
      const px = rotate ? v[2] : v[0], pz = rotate ? -v[0] : v[2];
      out[(t + k) * 3] = cx + px; out[(t + k) * 3 + 1] = y + v[1]; out[(t + k) * 3 + 2] = cz + pz;
    }
  }
  return out;
}
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
```

- [ ] **Step 4: Write architecture.ts (families → primitives; ported from the accepted hero corner)**

Facade frame helper and window/door/loggia/shop/roof emitters exactly as in the hero sketch, translated to the `Emitter` API with `layer`, `cls`, `cohort`, `style`, `ao`:
- body box: layer 0, style 1 for slab/tower (prefab seams) else 0, `ao` 1;
- plinth: layer 0, palette `P.plinth`;
- window: glass plane at out +0.015 (`cls: 'glass'`, `style: 4`, `cohort` from a deterministic hash of (building, side, bay, floor) in `0..4`), shadow strips under the lintel and along the jamb (layer 1, palette `P.interior`, ao 0.55), frame boxes (layer 2, palette `P.frame`), mullion/transom (layer 2), sill (layer 1, `P.trim`), lintel for tenements (layer 1);
- loggia: slab, side walls, parapet (accent palette from `spec.accent`: `COLORS.accent → P.accentGold`, `accentPink → P.accentRose`, `accentBlue → P.accentBlue`), rail (`P.steel`), back door glass — layer 1;
- shop bay (tenement avenue side, bays other than the door bay): stall riser and bay reveals (layer 1, `P.plasterX` shaded by ao 0.8), interior back panel (layer 1, `P.interior`), three goods boxes (layer 2, `P.goodsA`/`P.goodsB`/`P.accentRose`), clear glass front (layer 1, `cls: 'glassClear'`, `style: 4`, `cohort: -1`), frame verticals (layer 2), sign band (layer 1, accent palette), hanging sign (layer 2), awning on even bays (layer 1);
- entrance door: glass (layer 1, `cls: 'glass'`, `palette: P.glassWarm`, `cohort: -1`), frame (layer 2), canopy (layer 1), steps (layer 1), doormat (layer 2, `P.interior`), notice board next to the door (layer 2);
- roofs: flat (`P.roofFlat`, parapet `P.trim`, stair towers, vents `P.steel`, mast) or hip/gable prisms (`P.roofTile` / `P.roofSheet`) with chimneys and cornices;
- tower: stair glass strip, wrapping corner balconies, machine room, mast (layer 1/2).

The cluster centre is `(cx, GROUND + bodyHeight / 2, cz)` with radius `hypot(w, d, bodyHeight) / 2`.

- [ ] **Step 5: Write streetscape.ts**

Pavement cells → `plane(P.pavement, x, GROUND, z, 1, 1, { rx: -π/2, style: 2, layer: 0 })`; forecourt cells the same; kerbs → `box(P.kerb, …, 0.22, KERB_HEIGHT, 1.0)` on the road-facing edge, top at `GROUND + KERB_HEIGHT`, layer 0; crosswalk → `stripes` boxes `(2.4 × 0.012 × 0.5)` at `y = GROUND + 0.006`, palette `P.marking`, layer 0, spaced 1 m across `minZ..maxZ`; props (layer 1): bike rack (four posts + two top bars, `P.steel`), bicycles (two `torus` wheels radius 0.34 tube 0.03 with axle at `GROUND + 0.34`, frame boxes `P.accentRose`, saddle `P.wood`, handlebar `P.steel`), leaning bicycle (same, plus `rz = 0.2` lean applied to frame and wheels around the contact line — wheels stay on the ground because the lean pivot is the wheel contact points: y of the axle = `GROUND + 0.34·cos(0.2)`), bin (`cylinder P.steel`), planter (`P.wood` box + `P.goodsB` foliage box), notice board (`P.wood` + `P.trim`), hedge boxes along `x = 6.2, z ∈ [28.2, 31]` (`P.goodsB`, layer 1). Cluster id `streetscape`, centre `(-9, GROUND, 28)`, radius 30.

- [ ] **Step 6: Write dominants.ts**

```ts
import { OVERVIEW_SHOT } from '../../experience/ShotDefinitions';
import { BLOCK_CONFIGS, LAKE, TREE_POSITIONS, WORLD_HALF_SIZE, distanceToAnyRail, distancePointToBlock, isOnRoad } from '../WorldLayout';
```
- `validateDominantSite(x, z): string[]` returns reasons: `'road'` if any cell within radius 3 is on a road; `'block'` if `distancePointToBlock < 4` for any block; `'rail'` if `distanceToAnyRail(x, z) < 8`; `'tree'` if any tree within 3 m; `'bounds'` if `|x|` or `|z| > WORLD_HALF_SIZE - 6`; `'lake'` if inside the lake ellipse + 4 m.
- `bearingFromOverview(x, z)` = `atan2(z - camZ, x - camX)` in degrees using `OVERVIEW_SHOT.position`.
- `emitDominant(spec, low)`: chimney = 8 (High) / 4 (Low) stacked cylinders (`P.concrete` below, alternating `P.accentRose`… no: use `P.roofTile` and `P.trim` for the red/white bands), steel cap, boiler house box with industrial glass planes (High only), two aviation lights (`glow`, `P.aviationRed`, spheres approximated by `cylinder` r 0.22 h 0.44 8 segments). RTV tower: shaft 12-gon (`P.concrete`) frustum r 2.6→1.5 over 44 m, four vertical fins (`box 0.35 × 44 × 0.5`, High only) with `style: 1`, technical platform at 34 m (cylinder r 5.2 h 0.8 8 seg), railing (16 posts + ring torus, High only), three equipment boxes and two dish cylinders tilted (`rx: -0.6`, High only), upper platform at 41 m (r 3.2 h 0.5), lattice mast 44→62 m (High: four corner cylinders r 0.07 tapering with horizontal braces every 3 m; Low: one cylinder r 0.35), aviation lights: 4 on the platform edge, 2 mid-mast, 1 on top (Low: 3). Layers: shaft/platforms/mast/lights L0, fins/railing/equipment/dishes L1. Cluster radius `height / 2 + 6`.

- [ ] **Step 7: Run tests and typecheck**

Run: `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run src/world/hybrid`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/world/hybrid/surface.ts src/world/hybrid/architecture.ts src/world/hybrid/streetscape.ts src/world/hybrid/dominants.ts src/world/hybrid/emitters.test.ts
git commit -m "spike(hybrid): surface primitives and emitters for families, streetscape and dominants"
```

---

### Task 5: Direct surface strategy

**Files:**
- Create: `src/world/hybrid/strategies/DirectSurfaceStrategy.ts`, `src/world/hybrid/strategies/strategy.ts` (shared types), `src/world/hybrid/strategies/strategies.test.ts`

**Interfaces:**
- Produces: `StrategyResult { geometries: Map<string /* `${cls}:${layer}` */, THREE.BufferGeometry>; stats: StrategyStats }`, `StrategyStats { name, generationMs, triangles: [number, number, number], vertices, bytes, unsupported }`, `buildDirect(cluster): StrategyResult`, `ATTRIBUTES = ['position','normal','uv','aPalette','aCohort','aAo','aStyle']`.

- [ ] **Step 1: Failing tests** — both strategies produce every attribute, deterministic buffers, layer 2 present for direct, per-class geometries.

```ts
// strategies.test.ts
import { describe, expect, test } from 'vitest';
import { buildCityModel } from '../CityModel';
import { emitBuilding } from '../architecture';
import { buildDirect } from './DirectSurfaceStrategy';
import { buildGreedy } from './GreedyVoxelStrategy';
import { ATTRIBUTES } from './strategy';

const cluster = emitBuilding(buildCityModel().buildings[4]); // tenement 25

for (const [name, build] of [['direct', buildDirect], ['greedy', buildGreedy]] as const) {
  describe(`${name} strategy`, () => {
    const result = build(cluster);
    test('emits geometries with the shared attribute set', () => {
      expect(result.geometries.size).toBeGreaterThan(0);
      for (const geometry of result.geometries.values()) {
        for (const attribute of ATTRIBUTES) expect(geometry.getAttribute(attribute)).toBeDefined();
        expect(geometry.index).toBeNull();
      }
    });
    test('is deterministic', () => {
      const again = build(cluster);
      const key = 'opaque:0';
      expect(Array.from(again.geometries.get(key)!.getAttribute('position').array as Float32Array))
        .toEqual(Array.from(result.geometries.get(key)!.getAttribute('position').array as Float32Array));
    });
    test('reports stats', () => {
      expect(result.stats.name).toBe(name);
      expect(result.stats.triangles[0]).toBeGreaterThan(0);
      expect(result.stats.bytes).toBeGreaterThan(0);
    });
  });
}
```

- [ ] **Step 2: Run to verify failure.** `node_modules/.bin/vitest run src/world/hybrid/strategies` → FAIL (modules missing).

- [ ] **Step 3: Write strategy.ts and DirectSurfaceStrategy.ts**

`strategy.ts`: types above plus `attachAttributes(geometry, prim, count)` writing `aPalette/aCohort/aAo/aStyle` as `Float32Array(count)`; `keyOf(prim) = `${prim.cls}:${prim.layer}``; `measure(geometries)` summing `attributes.position.count / 3` per layer and bytes over all attribute arrays.

`DirectSurfaceStrategy.ts`: for each primitive create `BoxGeometry` / `PlaneGeometry` / `CylinderGeometry(rTop, rBottom, h, segments)` / `TorusGeometry(radius, tube, 8, 20)` / `BufferGeometry` from `positions` (with `computeVertexNormals`), `toNonIndexed()`, ensure `uv` exists, apply `Matrix4.compose(position, Euler(rx, ry, rz), 1)` (prisms are already in world space), attach attributes, bucket by key; `mergeGeometries(bucket, false)` per key; `computeBoundingSphere()`; return `{ geometries, stats }` with `performance.now()` timing (fallback `Date.now()` when `performance` is undefined in tests).

- [ ] **Step 4: Run tests** (greedy still missing → only direct tests can pass; temporarily skip the greedy loop entry until Task 6) — Expected: direct PASS.

- [ ] **Step 5: Commit**

```bash
git add src/world/hybrid/strategies/strategy.ts src/world/hybrid/strategies/DirectSurfaceStrategy.ts src/world/hybrid/strategies/strategies.test.ts
git commit -m "spike(hybrid): direct surface generation strategy"
```

---

### Task 6: Greedy voxel strategy on the same primitives

**Files:**
- Create: `src/world/hybrid/strategies/GreedyVoxelStrategy.ts`
- Modify: `src/world/hybrid/strategies/strategies.test.ts` (enable the greedy loop entry; add resolution/unsupported assertions)

**Interfaces:**
- Produces: `buildGreedy(cluster, options = { cell: 0.25 }): StrategyResult`; `stats.extra = { cell, cells, unsupported }`.

- [ ] **Step 1: Add failing assertions**

```ts
test('greedy reports its grid and counts primitives thinner than a cell as unsupported', () => {
  const r = buildGreedy(cluster);
  expect(r.stats.extra?.cell).toBe(0.25);
  expect(r.stats.extra?.unsupported).toBeGreaterThan(0); // 7 cm window frames cannot be voxelised at 25 cm
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

Algorithm (per cluster, per material class):
1. AABB of all primitives of that class (expand 1 cell). Grid dims `nx, ny, nz` (cap 96×160×96; otherwise raise the cell to fit).
2. `keys = new Int32Array(nx*ny*nz)` initialised to `-1`. Key packs `(layer << 24) | (palette << 16) | ((cohort + 1) << 8) | style`.
3. Fill: box → transform each candidate cell centre into box-local space (inverse of `rx, ry, rz`) and test `|l| ≤ half`; skip primitives whose smallest dimension is below `cell` and count them as `unsupported` (frames, mullions, rails, wires); plane → treat as a box of thickness `cell`; cylinder → radial test with linearly interpolated radius; torus → distance from ring ≤ tube (rounded up to one cell); prism → inside if for every triangle `dot(n, p − v0) ≤ 0` (convex), normals from the soup.
4. Greedy meshing: for each axis `d ∈ {0,1,2}` and each direction `±`, sweep slices; a face exists where `keys[cell] ≠ -1` and the neighbour across the face is `-1` or a different layer; merge runs with equal `(key, aoLevel)` into quads (0fps-style mask sweep). `aoLevel` per face from the 4 side/8 corner neighbours of the face (0..3) → `ao = 1 − level * 0.12`.
5. Emit two triangles per quad with flat normals, `uv` from quad size, attributes from the key; bucket by `${cls}:${layer}`; merge into one geometry per key.
6. Stats as in direct plus `extra`.

- [ ] **Step 4: Run tests** → PASS for both strategies.

- [ ] **Step 5: Commit**

```bash
git add src/world/hybrid/strategies/GreedyVoxelStrategy.ts src/world/hybrid/strategies/strategies.test.ts
git commit -m "spike(hybrid): greedy voxel strategy consuming the same primitives"
```

---

### Task 7: Screen-space LOD selector

**Files:**
- Create: `src/world/hybrid/ScreenSpaceLod.ts`, `src/world/hybrid/ScreenSpaceLod.test.ts`

**Interfaces:**
- Produces: `pixelsPerMetre(viewportHeightPx, fovDeg, distance)`, `LodConfig`, `DEFAULT_LOD = { enter1: 9, exit1: 7, enter2: 36, exit2: 30, cooldownSeconds: 0.25 }`, `class LodSelector { level: Layer; maxLevel: Layer; update(pxPerMetre, dt): Layer }`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from 'vitest';
import { DEFAULT_LOD, LodSelector, pixelsPerMetre } from './ScreenSpaceLod';

describe('screen-space LOD', () => {
  test('pixels per metre follow the pinhole model', () => {
    expect(pixelsPerMetre(900, 50, 100)).toBeCloseTo(9.65, 1);
    expect(pixelsPerMetre(844, 50, 100)).toBeCloseTo(9.05, 1); // portrait phone ≈ desktop
  });
  test('enters and leaves levels with hysteresis', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    expect(lod.update(8, 1)).toBe(0);
    expect(lod.update(9.5, 1)).toBe(1);
    expect(lod.update(8, 1)).toBe(1);      // between exit1 and enter1 → keep
    expect(lod.update(6.9, 1)).toBe(0);
    expect(lod.update(40, 1)).toBe(2);
    expect(lod.update(31, 1)).toBe(2);
    expect(lod.update(29, 1)).toBe(1);
  });
  test('respects the cooldown and the Low cap', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    lod.update(40, 1);
    expect(lod.update(5, 0.1)).toBe(2);    // cooldown blocks the switch
    expect(lod.update(5, 0.3)).toBe(0);    // jumps straight to the target after cooldown
    lod.maxLevel = 1;
    expect(lod.update(40, 1)).toBe(1);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement**

```ts
import type { Layer } from './surface';
export interface LodConfig { enter1: number; exit1: number; enter2: number; exit2: number; cooldownSeconds: number; }
export const DEFAULT_LOD: LodConfig = { enter1: 9, exit1: 7, enter2: 36, exit2: 30, cooldownSeconds: 0.25 };
export function pixelsPerMetre(viewportHeightPx: number, fovDeg: number, distance: number): number {
  return viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(distance, 0.01);
}
export class LodSelector {
  level: Layer = 0;
  maxLevel: Layer = 2;
  private cooldown = 0;
  constructor(private readonly config: LodConfig = DEFAULT_LOD) {}
  update(pxPerMetre: number, dt: number): Layer {
    this.cooldown = Math.max(0, this.cooldown - dt);
    let target = this.level;
    if (this.level < 2 && pxPerMetre >= this.config.enter2) target = 2;
    else if (this.level < 1 && pxPerMetre >= this.config.enter1) target = 1;
    else if (this.level === 2 && pxPerMetre < this.config.exit2) target = pxPerMetre < this.config.exit1 ? 0 : 1;
    else if (this.level === 1 && pxPerMetre < this.config.exit1) target = 0;
    if (target > this.maxLevel) target = this.maxLevel;
    if (target !== this.level && this.cooldown <= 0) { this.level = target; this.cooldown = this.config.cooldownSeconds; }
    return this.level;
  }
}
```

- [ ] **Step 4: Run → PASS. Commit** `spike(hybrid): screen-space LOD selector with hysteresis and cooldown`.

---

### Task 8: Ground contact and clearance checker

**Files:**
- Create: `src/world/hybrid/GroundContact.ts`, `src/world/hybrid/GroundContact.test.ts`

**Interfaces:**
- Produces: `GroundContactViolation { id, kind: 'float' | 'sink' | 'overlap', delta? }`, `GroundContactReport { ok, violations, checked }`, `checkProbes(probes, groundHeightAt, tolerance = 0.012)`, `checkClearance(id, rect, forbidden)`, `busDwellEnvelope(stop)`, `checkModel(model): GroundContactReport`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, test } from 'vitest';
import { BUS_STOPS, GROUND_SURFACE_Y } from '../WorldLayout';
import { buildCityModel } from './CityModel';
import { busDwellEnvelope, checkClearance, checkModel, checkProbes } from './GroundContact';

describe('ground contact', () => {
  test('flags floating and sunken probes beyond 12 mm', () => {
    const ground = () => GROUND_SURFACE_Y;
    const report = checkProbes([
      { id: 'ok', x: 0, y: GROUND_SURFACE_Y + 0.01, z: 0 },
      { id: 'float', x: 0, y: GROUND_SURFACE_Y + 0.05, z: 0 },
      { id: 'sink', x: 0, y: GROUND_SURFACE_Y - 0.03, z: 0 },
    ], ground);
    expect(report.violations.map((v) => `${v.id}:${v.kind}`)).toEqual(['float:float', 'sink:sink']);
  });
  test('bus envelope at Osiedle Centralne is 8 m long behind the lead point and off the crosswalk', () => {
    const env = busDwellEnvelope(BUS_STOPS[0]);
    expect(env.maxX - env.minX).toBeCloseTo(8, 5);
    const model = buildCityModel();
    expect(checkClearance('bus', env, [{ id: 'crosswalk', ...model.crosswalk }])).toEqual([]);
  });
  test('the whole model passes', () => {
    expect(checkModel(buildCityModel()).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

`busDwellEnvelope(stop)`: `lead = BUS_ROUTE_CURVE.getPointAt(stop.atT)`, `tangent = getTangentAt(stop.atT)`; the bus body extends 8 m *behind* the lead along `−tangent` and ±1.15 m across → return the AABB. `checkClearance` intersects rectangles. `checkModel` runs probes for all props with `groundHeightAt(model, x, z)` and clearance for the bus vs the crosswalk and the crosswalk vs every prop footprint.

Runtime variant (used in Task 10): `checkSceneContact(probes, raycaster, groundObjects)` casts from `(x, y + 2, z)` downward against the ground meshes and compares the hit `y` with the probe `y` using the same tolerance.

- [ ] **Step 4: Run → PASS. Commit** `spike(hybrid): ground contact and clearance checker`.

---

### Task 9: HybridSpike attach — scene integration, LOD groups, hooks, metrics, checkpoints

**Files:**
- Create: `src/world/hybrid/HybridSpike.ts`, `src/world/hybrid/spikeCheckpoints.ts`
- Modify: `src/main.ts` (flag, exclusions, dynamic import, per-frame hooks, debug API), `src/bootstrap.ts` (primary-pass metrics), `src/debug/DioramaDebugTypes.ts` (optional fields), `vite.config.js` (`hybrid-spike` group)

**Interfaces:**
- Produces: `attachHybridSpike(options): HybridHandle` with
  `update(camera, viewportHeightPx, t01, night, dt)`, `setTheme(palette)`, `setSnowCover(c)`, `setWetness(w)`, `setQuality(profile)`, `getMetrics(): HybridMetrics`, `checkGroundContact(): GroundContactReport`, `getBloomObjects()`, `dispose()`; `getSpikeCheckpoint(id): CheckpointDefinition | null`; `RuntimeEnv.getPrimaryPassInfo(): { triangles, calls }`.

- [ ] **Step 1: `HybridSpike.ts`**

```ts
export interface HybridSpikeOptions { scene: THREE.Scene; strategy: HybridStrategyName; quality: QualityProfile; themePalette: Record<number, number>; }
export function attachHybridSpike(o: HybridSpikeOptions): HybridHandle
```
Body: `model = buildCityModel()`; clusters = buildings.map(emitBuilding) + emitStreetscape(model) + dominants.map(d => emitDominant(d, o.quality.level === 'low'))`; `uniforms = createHybridUniforms()`; materials: `opaque`, `glass` (opaque material, bloom-selected meshes), `glassClear` (transparent), `glow` (opaque, bloom-selected); for each cluster run the strategy, create one `Mesh` per `${cls}:${layer}` geometry, `castShadow = cls !== 'glassClear'`, `receiveShadow = true`, `renderOrder` 1 for `glassClear`; `LodGroup { selector: LodSelector, center: Vector3, meshesByLayer }`; group added to the scene as `hybrid-spike`. Low quality re-emits dominants with `low = true` (rebuild dominant clusters on `setQuality` change of level). `update`: `night` → `uNight`; cohorts → `uCohort[c] = residentialWindowActivityAt(t01, c)`; per cluster `px = pixelsPerMetre(viewportHeightPx, camera.fov, camera.position.distanceTo(center) - radius)`, `level = selector.update(px, dt)`, set `mesh.visible = layer <= level`. `setTheme` → `resolvePalette(palette, uniforms.uPalette.value)`; `setSnowCover/setWetness` → uniforms; `getMetrics` → `{ strategy, generationMs, triangles: [l0,l1,l2], vertices, bytes, meshes, lodLevels: Record<clusterId, Layer>, unsupported }`; `checkGroundContact` → `checkModel(model)` merged with the scene raycast against the pavement/kerb meshes and the product ground (`window.__diorama.scene` not needed: keep references).

- [ ] **Step 2: `spikeCheckpoints.ts`** — four `CheckpointDefinition`s (`id` cast to `CheckpointId`), `busProgress: BUS_STOPS[0].atT`, `quality: 'high'`, `frozen: true`, `revision: CHECKPOINT_REVISION`, cameras from the spec table.

- [ ] **Step 3: `bootstrap.ts`** — after `composer.addPass(new RenderPass(scene, camera))`:
```ts
const primaryPass = { triangles: 0, calls: 0 };
composer.addPass(new LambdaPass(() => {
  primaryPass.triangles = renderer.info.render.triangles;
  primaryPass.calls = renderer.info.render.calls;
}));
```
and `getPrimaryPassInfo: () => primaryPass` in the returned env + interface.

- [ ] **Step 4: `main.ts`**
```ts
import { parseWorldMode, strategyOf, SPIKE_BLOCK_SET, isSpikeGroundCell } from './world/hybrid/spikeFlag';
import type { HybridHandle } from './world/hybrid/HybridSpike';
const worldMode = parseWorldMode(query.get('world'));
const hybridStrategy = strategyOf(worldMode);
const world = createWorld(env.scene, windUniforms, hybridStrategy ? { excludeBlocks: SPIKE_BLOCK_SET, excludeGroundCell: isSpikeGroundCell } : {});
let hybrid: HybridHandle | null = null;
```
After the bloom selection block and before warmup:
```ts
const hybridReady: Promise<void> = hybridStrategy
  ? import('./world/hybrid/HybridSpike').then((spike) => {
      hybrid = spike.attachHybridSpike({ scene: env.scene, strategy: hybridStrategy, quality: quality.getProfile(), themePalette: currentTheme.palette });
      env.setBloomSelection([...bloomTargets, ...hybrid.getBloomObjects()]);
      const spikeCheckpoint = requestedCheckpoint ? null : spike.getSpikeCheckpoint(query.get('checkpoint'));
      if (spikeCheckpoint) applyBootCheckpoint(spikeCheckpoint);
    })
  : Promise.resolve();
```
Hooks: quality subscribe → `hybrid?.setQuality(profile)`; `applyTheme` → `hybrid?.setTheme(currentTheme.palette)`; in `animate` after `world.setWetness(...)`: `hybrid?.setSnowCover(weather.getSnowCover()); hybrid?.setWetness(weather.getWetness()); hybrid?.update(env.camera, env.renderer.domElement.clientHeight, t01, light.night, presentationDelta);`; `getMetrics` adds `renderer.primaryTriangles/primaryCalls` from `env.getPrimaryPassInfo()`, `world: worldMode`, `hybrid: hybrid?.getMetrics() ?? null`; debug handle adds `hybridGroundContact: () => hybrid?.checkGroundContact() ?? null`; `getState` adds `world: worldMode`. Warmup: `void hybridReady.then(() => warmRenderer({...})).finally(...)`. HMR dispose: `hybrid?.dispose()`.

- [ ] **Step 5: `vite.config.js`** group before `experience-signals`:
```js
{ name: 'hybrid-spike', test: /src[\\/]world[\\/]hybrid[\\/](?!spikeFlag\.ts$)/, priority: 15, includeDependenciesRecursively: false },
```

- [ ] **Step 6: Verify** `node_modules/.bin/tsc --noEmit && node_modules/.bin/vitest run && node_modules/.bin/vite build` and check `dist/assets/index-*.js` ≤ 240 000 B, `main-*.js` ≤ 50 000 B, `hybrid-spike-*.js` exists. Then `npm run test:browser` (default smoke must stay green: the flag is off).

- [ ] **Step 7: Commit** `spike(hybrid): attach hybrid fragment behind the world flag with LOD, hooks and metrics`.

---

### Task 10: Spike smoke — frames, runtime ground contact, LOD levels

**Files:**
- Create: `scripts/spikeSmoke.mjs`

- [ ] **Step 1: Script** — for `world ∈ {hybrid-direct, hybrid-greedy}` and checkpoints `spike-overview, spike-street, spike-golden, spike-night-street`: build once, start `vite preview` on 4176, open `?seed=20260722&world=…&checkpoint=…&quality=high`, wait for `__diorama.ready`, assert zero console errors, `getMetrics().hybrid.strategy === strategy`, `hybridGroundContact().ok === true`, at `spike-street` at least one cluster at LOD 2 and at `spike-overview` no cluster above LOD 1, `renderer.calls ≤ 1400`, `geometries ≤ 500`, `textures ≤ 80`; screenshot `screenshots/spike/<world>-<checkpoint>.png` at 1440×900; also run `quality=low` for the street frame and assert LOD ≤ 1. Print a Markdown table.
- [ ] **Step 2: Run** `node scripts/spikeSmoke.mjs` and review the frames against Gate 1 (bus off the zebra, resident legible, shop content, far plane not blown out). Fix visual defects in the emitters and re-run.
- [ ] **Step 3: Commit** `spike(hybrid): spike smoke with frames, ground contact and LOD assertions`.

---

### Task 11: Benchmark — apples-to-apples in the Diorama pipeline

**Files:**
- Modify: `scripts/performanceBenchmark.mjs`

- [ ] **Step 1:** `const WORLD = process.env.BENCH_WORLD ?? 'voxel'`; URL gains `&world=${WORLD}`; when `WORLD !== 'voxel'`, `allScenarios` gains `spike-overview`, `spike-street`, `spike-golden` (`camera: 'checkpoint'`); results record `primaryTriangles`, `multipassTriangles = triangles − primaryTriangles`, `programs`, `hybrid.generationMs`, `hybrid.bytes`, `hybrid.meshes`, `performance.memory?.usedJSHeapSize ?? null`; thresholds unchanged.
- [ ] **Step 2: Run** on M1 Pro, one at a time: `BENCH_WORLD=voxel BENCH_SCENARIO=spike-overview,spike-street,spike-golden` is not valid for voxel (no spike checkpoints) → for the baseline run `BENCH_WORLD=voxel` with the standard scenarios, and for each hybrid strategy `BENCH_WORLD=hybrid-direct` / `hybrid-greedy` with `BENCH_SCENARIO=spike-overview,spike-street,spike-golden`, each at `BENCH_QUALITY=high` and `BENCH_QUALITY=low`. Save the JSON/console output under `docs/superpowers/spike/` (git-ignored screenshots stay out; numbers go into the report).
- [ ] **Step 3: Commit** `spike(hybrid): benchmark world flag and spike scenarios`.

---

### Task 12: Report and recommendation

**Files:**
- Create: `docs/superpowers/spike/2026-09-0X-hybrid-spike-report.md`

- [ ] Gate-by-gate evidence: frames (paths), measurement tables (voxel vs direct vs greedy, High and Low), LOD behaviour, semantic identity (cohort/theme/snow/wet checks via `getMetrics` + screenshots at night), heights table, ground-contact report, dominant sites with bearings, unsupported primitive counts for greedy, bundle sizes. One recommendation: implement / simplify / reject, with the losing strategy named for deletion. Publish as an artifact page for the owner.
