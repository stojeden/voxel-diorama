import { describe, expect, test } from 'vitest';
import { BUS_STOPS, GROUND_SURFACE_Y } from '../WorldLayout';
import { buildCityModel } from './CityModel';
import { busDwellEnvelope, checkClearance, checkModel, checkProbes } from './GroundContact';

describe('ground contact', () => {
  test('flags floating and sunken probes beyond 12 mm', () => {
    const ground = () => GROUND_SURFACE_Y;
    const report = checkProbes(
      [
        { id: 'ok', x: 0, y: GROUND_SURFACE_Y + 0.01, z: 0 },
        { id: 'float', x: 0, y: GROUND_SURFACE_Y + 0.05, z: 0 },
        { id: 'sink', x: 0, y: GROUND_SURFACE_Y - 0.03, z: 0 },
      ],
      ground
    );
    expect(report.ok).toBe(false);
    expect(report.checked).toBe(3);
    expect(report.violations.map((v) => `${v.id}:${v.kind}`)).toEqual(['float:float', 'sink:sink']);
  });

  test('the bus envelope at Osiedle Centralne is 8 m long behind the lead point and off the crosswalk', () => {
    const stop = BUS_STOPS[0];
    expect(stop.label).toBe('Osiedle Centralne');
    const envelope = busDwellEnvelope(stop);
    expect(envelope.maxX - envelope.minX).toBeGreaterThanOrEqual(7.99);
    expect(envelope.maxX - envelope.minX).toBeLessThan(8.6);
    const model = buildCityModel();
    expect(checkClearance('bus', envelope, [{ id: 'crosswalk', ...model.crosswalk }])).toEqual([]);
  });

  test('overlaps are reported with the zone they hit', () => {
    const violations = checkClearance('bin', { minX: 0, maxX: 1, minZ: 0, maxZ: 1 }, [{ id: 'crosswalk', minX: 0.5, maxX: 2, minZ: 0.5, maxZ: 2 }]);
    expect(violations).toEqual([{ id: 'bin', kind: 'overlap', against: 'crosswalk' }]);
  });

  test('the whole fragment model passes', () => {
    const report = checkModel(buildCityModel(), BUS_STOPS[0]);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checked).toBeGreaterThan(10);
  });
});
