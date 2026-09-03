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

  test('layer 0 carries the glazing itself, so a distant cluster still reads as a building', () => {
    for (const spec of model.buildings) {
      const { primitives } = emitBuilding(spec);
      const glazing = primitives.filter((p) => p.cls === 'glass');
      expect(glazing.length, `${spec.index}: no glazing`).toBeGreaterThan(0);
      // Every dwelling pane is in layer 0: the simplification at level 0 is the absence
      // of the frames, sills and reveals around the pane, not the absence of the pane.
      // A shopfront is the exception -- its display glass is transparent, so layer 0
      // carries the dark interior behind it instead and the glass arrives at layer 1.
      expect(glazing.filter((p) => p.layer !== 0), `${spec.index}: dwelling glazing outside layer 0`).toEqual([]);
      const clear = primitives.filter((p) => p.cls === 'glassClear');
      expect(clear.every((p) => p.layer === 1), `${spec.index}: display glass outside layer 1`).toBe(true);
      const lit = glazing.filter((p) => p.cohort >= 0);
      expect(lit.length).toBeGreaterThanOrEqual(spec.floors * 4);
      expect(lit.every((p) => p.cohort < 5)).toBe(true);
    }
  });

  test('nothing in layer 0 is drawn twice, so a level switch never doubles a surface', () => {
    for (const spec of model.buildings) {
      const { primitives } = emitBuilding(spec);
      const seen = new Map<string, number>();
      for (const p of primitives) {
        if (p.kind === 'prism') continue;
        const key = `${p.cls}|${p.x.toFixed(3)}|${p.y.toFixed(3)}|${p.z.toFixed(3)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const doubled = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
      expect(doubled, `${spec.index}: coincident surfaces of one class`).toEqual([]);
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

  test('crosswalk bars run across the carriageway and stay inside the crossing', () => {
    const cw = model.crosswalk;
    const bars = primitives.filter((p) => p.palette === P.marking && p.layer === 0);
    expect(bars.length).toBe(cw.stripes);
    for (const bar of bars) {
      expect(bar.kind).toBe('box');
      if (bar.kind !== 'box') continue;
      // A bar is long along the carriageway and narrow across it, so a pedestrian
      // steps over successive stripes.
      expect(bar.w).toBeGreaterThan(bar.d);
      expect(bar.x - bar.w / 2).toBeGreaterThanOrEqual(cw.minX - 1e-9);
      expect(bar.x + bar.w / 2).toBeLessThanOrEqual(cw.maxX + 1e-9);
      expect(bar.z - bar.d / 2).toBeGreaterThanOrEqual(cw.minZ - 1e-9);
      expect(bar.z + bar.d / 2).toBeLessThanOrEqual(cw.maxZ + 1e-9);
    }
    // Bars and gaps of one width: consecutive centres are exactly two bar widths apart.
    const zs = bars.map((b) => (b.kind === 'box' ? b.z : 0)).sort((a, b) => a - b);
    const across = bars[0].kind === 'box' ? bars[0].d : 0;
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(across * 2, 6);
  });

  test('draws three bicycles whose six wheels are believable wheels, not hoops', () => {
    const tori = primitives.filter((p) => p.kind === 'torus');
    // Each wheel is a tyre plus a rim inside it: a bare hoop reads as wire.
    expect(tori.length).toBe(12);
    const tyres = tori.filter((p) => p.kind === 'torus' && p.tube > 0.03);
    expect(tyres.length).toBe(6);
    for (const tyre of tyres) {
      if (tyre.kind !== 'torus') continue;
      const diameter = 2 * (tyre.radius + tyre.tube);
      expect(diameter).toBeGreaterThan(0.65);
      expect(diameter).toBeLessThan(0.78);
      expect(tyre.tube).toBeGreaterThanOrEqual(0.04);
    }
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
