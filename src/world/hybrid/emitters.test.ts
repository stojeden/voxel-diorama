import { describe, expect, test } from 'vitest';
import { LAKE } from '../WorldLayout';
import { CHIMNEY_SITE, RTV_SITES, buildCityModel } from './CityModel';
import { emitBuilding } from './architecture';
import { P } from './palette';
import { emitStreetscape } from './streetscape';
import { bearingFromOverview, emitDominant, validateDominantSite } from './dominants';

const model = buildCityModel();

describe('architecture emitter', () => {
  test('every fragment building has massing in L0, openings in L1 and trim in L2', () => {
    for (const spec of model.buildings) {
      const { primitives } = emitBuilding(spec);
      const layers = new Set(primitives.map((p) => p.layer));
      expect(layers).toEqual(new Set([0, 1, 2]));
      const glass = primitives.filter((p) => p.cls === 'glass' && p.cohort >= 0);
      expect(glass.length).toBeGreaterThanOrEqual(spec.floors * 4);
      expect(glass.every((p) => p.cohort >= 0 && p.cohort < 5)).toBe(true);
    }
  });

  test('tenements facing the avenue get shop display bays with goods behind clear glass', () => {
    const tenement = model.buildings.find((b) => b.family === 'tenement')!;
    const { primitives } = emitBuilding(tenement);
    expect(primitives.some((p) => p.cls === 'glassClear')).toBe(true);
    expect(primitives.filter((p) => p.layer === 2 && p.kind === 'box' && p.cls === 'opaque').length).toBeGreaterThan(20);
    expect(primitives.filter((p) => p.palette === P.goodsA || p.palette === P.goodsB).length).toBeGreaterThan(0);
  });

  test('the flagged point tower is the tallest cluster and the only grown one', () => {
    const clusters = model.buildings.map((b) => ({ b, c: emitBuilding(b) }));
    const tower = clusters.find(({ b }) => b.pointTower)!;
    for (const { b, c } of clusters) {
      if (b === tower.b) continue;
      expect(c.center[1]).toBeLessThan(tower.c.center[1]);
    }
  });

  test('is deterministic', () => {
    const a = emitBuilding(model.buildings[0]).primitives;
    const b = emitBuilding(model.buildings[0]).primitives;
    expect(JSON.stringify(a, (_key, value) => (value instanceof Float32Array ? Array.from(value) : value)))
      .toBe(JSON.stringify(b, (_key, value) => (value instanceof Float32Array ? Array.from(value) : value)));
  });
});

describe('streetscape emitter', () => {
  const { primitives } = emitStreetscape(model);

  test('emits one pavement plane per paved cell, kerb ridges and crosswalk stripes', () => {
    expect(primitives.filter((p) => p.kind === 'plane' && p.style === 2).length).toBe(model.pavement.length + model.forecourt.length);
    expect(primitives.filter((p) => p.palette === P.kerb).length).toBe(model.kerbs.length);
    expect(primitives.filter((p) => p.palette === P.marking && p.layer === 0).length).toBe(model.crosswalk.stripes);
  });

  test('draws three bicycles with six wheels', () => {
    expect(primitives.filter((p) => p.kind === 'torus').length).toBe(6);
  });
});

describe('dominants', () => {
  test('both tower sites validate; the recommended one is clear of the chimney and the lake in the default view', () => {
    expect(validateDominantSite(RTV_SITES.recommended.x, RTV_SITES.recommended.z)).toEqual([]);
    expect(validateDominantSite(RTV_SITES.alternative.x, RTV_SITES.alternative.z)).toEqual([]);
    expect(validateDominantSite(CHIMNEY_SITE.x, CHIMNEY_SITE.z)).toEqual([]);
    const sep = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    const tower = bearingFromOverview(RTV_SITES.recommended.x, RTV_SITES.recommended.z);
    expect(sep(tower, bearingFromOverview(CHIMNEY_SITE.x, CHIMNEY_SITE.z))).toBeGreaterThanOrEqual(20);
    expect(sep(tower, bearingFromOverview(LAKE.x, LAKE.z))).toBeGreaterThanOrEqual(25);
  });

  test('the Low variant of the tower is much lighter and keeps its aviation lights', () => {
    const spec = model.dominants.find((d) => d.kind === 'rtvTower')!;
    const high = emitDominant(spec, false).primitives;
    const low = emitDominant(spec, true).primitives;
    expect(low.length).toBeLessThan(high.length / 2);
    expect(low.filter((p) => p.cls === 'glow').length).toBeGreaterThanOrEqual(3);
    expect(high.filter((p) => p.cls === 'glow').length).toBeGreaterThanOrEqual(7);
    expect(Math.max(...high.map((p) => (p.kind === 'cylinder' ? p.y + p.h / 2 : 0)))).toBeGreaterThan(spec.height - 1);
  });

  test('the chimney stays the heavier silhouette below the tower top', () => {
    const chimney = model.dominants.find((d) => d.kind === 'chimney')!;
    const tower = model.dominants.find((d) => d.kind === 'rtvTower')!;
    expect(chimney.height).toBeLessThan(tower.height);
    expect(emitDominant(chimney, true).primitives.length).toBeLessThan(emitDominant(chimney, false).primitives.length);
  });
});
