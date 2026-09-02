import { describe, expect, test } from 'vitest';
import { buildCityModel } from '../CityModel';
import { emitBuilding } from '../architecture';
import { emitStreetscape } from '../streetscape';
import { buildDirect } from './DirectSurfaceStrategy';
import { buildGreedy } from './GreedyVoxelStrategy';
import { ATTRIBUTES } from './strategy';

const model = buildCityModel();
const tenement = emitBuilding(model.buildings.find((b) => b.family === 'tenement')!);
const street = emitStreetscape(model);

for (const [name, build] of [['direct', buildDirect], ['greedy', buildGreedy]] as const) {
  describe(`${name} strategy`, () => {
    const result = build(tenement);

    test('emits non-indexed geometries with the shared attribute set for every class and layer', () => {
      expect(result.geometries.size).toBeGreaterThan(0);
      for (const [key, geometry] of result.geometries) {
        expect(key).toMatch(/^(opaque|glass|glassClear|glow):[012]$/);
        for (const attribute of ATTRIBUTES) expect(geometry.getAttribute(attribute)).toBeDefined();
        expect(geometry.index).toBeNull();
        const count = geometry.getAttribute('position').count;
        expect(count % 3).toBe(0);
        for (const attribute of ATTRIBUTES) expect(geometry.getAttribute(attribute).count).toBe(count);
      }
      expect(result.geometries.has('opaque:0')).toBe(true);
      // Glazing sits in layer 0 with the massing: it is what makes a distant
      // cluster read as a building, and the detail layers add only what frames it.
      expect(result.geometries.has('glass:0')).toBe(true);
    });

    test('is deterministic', () => {
      const again = build(tenement);
      const a = result.geometries.get('opaque:0')!.getAttribute('position').array as Float32Array;
      const b = again.geometries.get('opaque:0')!.getAttribute('position').array as Float32Array;
      expect(b.length).toBe(a.length);
      expect(Array.from(b.subarray(0, 300))).toEqual(Array.from(a.subarray(0, 300)));
    });

    test('reports stats', () => {
      expect(result.stats.name).toBe(name);
      expect(result.stats.triangles[0]).toBeGreaterThan(0);
      expect(result.stats.vertices).toBeGreaterThan(0);
      expect(result.stats.bytes).toBeGreaterThan(0);
      expect(result.stats.generationMs).toBeGreaterThanOrEqual(0);
    });

    test('handles the streetscape with tori, planes and kerbs', () => {
      const streetResult = build(street);
      expect(streetResult.geometries.get('opaque:0')!.getAttribute('position').count).toBeGreaterThan(0);
      expect(streetResult.geometries.get('opaque:1')!.getAttribute('position').count).toBeGreaterThan(0);
    });
  });
}

describe('direct strategy', () => {
  test('keeps thin frames in layer 2', () => {
    const result = buildDirect(tenement);
    expect(result.geometries.get('opaque:2')!.getAttribute('position').count).toBeGreaterThan(0);
  });
});

describe('greedy strategy', () => {
  test('reports its grid and how many thin dimensions it had to dilate', () => {
    const result = buildGreedy(tenement);
    expect(result.stats.extra.cell).toBe(0.25);
    expect(result.stats.extra.dilated).toBeGreaterThan(0);
    expect(result.stats.extra.cells).toBeGreaterThan(1000);
  });

  test('voxelised walls carry the wall palette and the seams style of the tenement body', () => {
    const result = buildGreedy(tenement);
    const palette = result.geometries.get('opaque:0')!.getAttribute('aPalette').array as Float32Array;
    const spec = model.buildings.find((b) => b.family === 'tenement')!;
    expect(Array.from(palette)).toContain(spec.tint);
  });
});
