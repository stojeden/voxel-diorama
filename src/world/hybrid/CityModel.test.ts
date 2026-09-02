import { describe, expect, test } from 'vitest';
import { BLOCK_CONFIGS, BUS_ROUTE_CURVE, BUS_STOPS, GROUND_SURFACE_Y, isOnRoad } from '../WorldLayout';
import { buildCityModel, groundHeightAt } from './CityModel';
import { floorPlan } from './families';

describe('hybrid city model', () => {
  const model = buildCityModel();

  test('keeps every block height in metres and grows only the flagged point tower', () => {
    expect(model.buildings).toHaveLength(5);
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
    expect(floorPlan('walkup', 10, false)).toMatchObject({ floors: 4, roof: 'gable' });
  });

  test('footprints never change', () => {
    for (const b of model.buildings) {
      const block = BLOCK_CONFIGS[b.index];
      expect([b.x, b.z, b.w, b.d]).toEqual([block.x, block.z, block.w, block.d]);
    }
  });

  test('the crosswalk stays clear of the dwelling bus and lies on the road', () => {
    const stop = BUS_STOPS[0];
    const lead = BUS_ROUTE_CURVE.getPointAt(stop.atT);
    const busMinX = lead.x - 8;
    const busMaxX = lead.x;
    const cw = model.crosswalk;
    expect(cw.maxX < busMinX - 2 || cw.minX > busMaxX + 2).toBe(true);
    expect(isOnRoad(Math.round((cw.minX + cw.maxX) / 2), 24)).toBe(true);
  });

  test('ground is flush: pavement, forecourt and grass share the product surface height', () => {
    expect(groundHeightAt(model, -11, 27)).toBe(GROUND_SURFACE_Y);
    expect(groundHeightAt(model, -2, 29)).toBe(GROUND_SURFACE_Y);
    expect(groundHeightAt(model, 30, 30)).toBe(GROUND_SURFACE_Y);
  });

  test('every prop has ground probes and stands on pavement or forecourt cells', () => {
    const paved = new Set([...model.pavement, ...model.forecourt].map((c) => `${c.x},${c.z}`));
    expect(model.props.length).toBeGreaterThanOrEqual(6);
    for (const prop of model.props) {
      expect(prop.probes.length).toBeGreaterThan(0);
      for (const probe of prop.probes) {
        expect(paved.has(`${Math.round(probe.x)},${Math.round(probe.z)}`)).toBe(true);
        expect(probe.y).toBe(GROUND_SURFACE_Y);
      }
    }
  });

  test('is deterministic', () => {
    expect(JSON.stringify(buildCityModel())).toBe(JSON.stringify(model));
  });
});
