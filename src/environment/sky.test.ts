import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  goldenFactorAt,
  nightFactorAt,
  realTimeToCycleT,
  sceneBloomStrength,
  sceneExposure,
  skyColorAt,
  sunColorAt,
  sunDirectionAt,
  sunElevationAt,
} from './sky';

describe('solar model', () => {
  test('sun is below the horizon at midnight and high at noon', () => {
    expect(sunElevationAt(0)).toBeLessThan(-0.5);
    expect(sunElevationAt(0.5)).toBeGreaterThan(0.8);
    expect(Math.abs(sunElevationAt(0.25))).toBeLessThan(0.01);
    expect(Math.abs(sunElevationAt(0.75))).toBeLessThan(0.01);
  });

  test('sun direction is a unit vector rising in +X and setting in -X', () => {
    const sunrise = sunDirectionAt(0.26);
    const sunset = sunDirectionAt(0.74);
    expect(sunrise.length()).toBeCloseTo(1, 5);
    expect(sunrise.x).toBeGreaterThan(0.8);
    expect(sunset.x).toBeLessThan(-0.8);
  });

  test('night factor is 1 at midnight, 0 at noon, smooth at twilight', () => {
    expect(nightFactorAt(0)).toBeCloseTo(1, 2);
    expect(nightFactorAt(0.5)).toBeCloseTo(0, 2);
    const twilight = nightFactorAt(0.25);
    expect(twilight).toBeGreaterThan(0.05);
    expect(twilight).toBeLessThan(0.95);
  });

  test('golden hour peaks near sunrise/sunset and vanishes at noon & midnight', () => {
    expect(goldenFactorAt(0.28)).toBeGreaterThan(0.5);
    expect(goldenFactorAt(0.72)).toBeGreaterThan(0.5);
    expect(goldenFactorAt(0.5)).toBeLessThan(0.1);
    expect(goldenFactorAt(0)).toBe(0);
  });
});

describe('sky colours', () => {
  test('returns finite RGB at every sample', () => {
    for (let i = 0; i <= 40; i++) {
      const color = skyColorAt(i / 40);
      expect(Number.isFinite(color.r)).toBe(true);
      expect(Number.isFinite(color.g)).toBe(true);
      expect(Number.isFinite(color.b)).toBe(true);
    }
  });

  test('clamps inputs outside 0..1 to a safe color rather than NaN', () => {
    expect(Number.isFinite(skyColorAt(-0.5).r)).toBe(true);
    expect(Number.isFinite(skyColorAt(1.5).r)).toBe(true);
  });

  test('sun color is black when below the horizon, warm at sunrise, whiter at noon', () => {
    const midnight = sunColorAt(0.0);
    expect(midnight.r).toBe(0);

    const sunrise = sunColorAt(0.27);
    const noon = sunColorAt(0.5);
    const sunriseRedness = sunrise.r / Math.max(sunrise.b, 1e-6);
    const noonRedness = noon.r / Math.max(noon.b, 1e-6);
    expect(sunriseRedness).toBeGreaterThan(noonRedness);
  });

  test('reuses the optional out color so callers can avoid allocations', () => {
    const out = new THREE.Color();
    expect(skyColorAt(0.5, out)).toBe(out);
  });
});

describe('render exposure', () => {
  test('keeps daylight and golden-hour highlights below the old washed-out peak', () => {
    expect(sceneExposure(0, 0)).toBeCloseTo(0.46, 2);
    expect(sceneExposure(0, 1)).toBeCloseTo(0.5, 2);
    expect(sceneExposure(0, 1, 1.07)).toBeLessThan(0.54);
  });

  test('preserves stronger bloom at night than in daylight', () => {
    expect(sceneBloomStrength(1, 0)).toBeGreaterThan(sceneBloomStrength(0, 1));
    expect(sceneBloomStrength(0, 1)).toBeLessThan(0.15);
  });
});

describe('real-time mapping', () => {
  const day = (h: number, m = 0) => {
    const d = new Date(2026, 5, 10);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const times = { sunrise: day(4, 30), solarNoon: day(12, 45), sunset: day(21, 0) };

  test('maps sunrise → 0.25, solar noon → 0.5, sunset → 0.75', () => {
    expect(realTimeToCycleT(day(4, 30), times)).toBeCloseTo(0.25, 2);
    expect(realTimeToCycleT(day(12, 45), times)).toBeCloseTo(0.5, 2);
    expect(realTimeToCycleT(day(21, 0), times)).toBeCloseTo(0.75, 2);
  });

  test('interpolates monotonically across the day', () => {
    let prev = -1;
    for (let h = 0; h < 24; h++) {
      const t = realTimeToCycleT(day(h), times);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  test('falls back to fraction-of-day for invalid sun times (polar night)', () => {
    const broken = {
      sunrise: new Date(NaN),
      solarNoon: new Date(NaN),
      sunset: new Date(NaN),
    };
    expect(realTimeToCycleT(day(6), broken)).toBeCloseTo(0.25, 2);
  });
});
