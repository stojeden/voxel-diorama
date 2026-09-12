import { describe, expect, test } from 'vitest';
import {
  airMass,
  beamTransmittanceColor,
  ozoneSlantFactor,
  rayleighOpticalDepth,
  refractionRad,
  shadowHeightKm,
  tangentRayHeightKm,
  twilightSkyColor,
  twilightSkyColorCached,
} from './SunlightSpectrum';

const deg = (d: number) => (d * Math.PI) / 180;
const arcmin = (rad: number) => (rad * 180 * 60) / Math.PI;

describe('published constants', () => {
  /**
   * These are not self-consistency checks. Each one is a number somebody measured, and the
   * point of pinning them is that a plausible-looking refactor of the formulae cannot quietly
   * move the physics.
   */
  test('Rayleigh optical depth matches the textbook value at 550 nm', () => {
    expect(rayleighOpticalDepth(550)).toBeCloseTo(0.0973, 4);
    // The inverse-fourth-power law, stated as a ratio rather than assumed.
    expect(rayleighOpticalDepth(450) / rayleighOpticalDepth(650)).toBeCloseTo(4.5, 1);
  });

  test('refraction at the horizon is about 34 arcminutes', () => {
    expect(arcmin(refractionRad(0))).toBeGreaterThan(33);
    expect(arcmin(refractionRad(0))).toBeLessThan(36);
    // And it collapses fast with altitude: about a minute at 45 degrees.
    expect(arcmin(refractionRad(deg(45)))).toBeCloseTo(1, 0);
  });

  test('air mass is 1 overhead and about 38 at the horizon (Kasten & Young)', () => {
    expect(airMass(deg(90))).toBeCloseTo(1, 3);
    expect(airMass(deg(30))).toBeCloseTo(2, 1);
    expect(airMass(0)).toBeGreaterThan(37);
    expect(airMass(0)).toBeLessThan(39);
  });
});

describe('the direct beam', () => {
  test('reddens monotonically as the sun descends', () => {
    const warmth = (elevationDeg: number) => {
      const [r, , b] = beamTransmittanceColor(deg(elevationDeg));
      return r / Math.max(b, 1e-9);
    };
    let previous = warmth(80);
    for (const elevation of [60, 40, 20, 10, 5, 2, 0]) {
      const now = warmth(elevation);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
  });

  test('the horizon sun is red, not merely warm', () => {
    const [r, g, b] = beamTransmittanceColor(0);
    expect(r).toBeGreaterThan(g * 3);
    expect(b).toBeLessThan(0.01);
    // A high sun is near-neutral by comparison.
    const [hr, , hb] = beamTransmittanceColor(deg(60));
    expect(hr / hb).toBeLessThan(1.5);
  });
});

describe('twilight', () => {
  /**
   * Hulburt (1953): the blue of the twilight sky is about one third Rayleigh scattering and
   * two thirds ozone absorption at sunset, and ozone alone deeper in. Without the Chappuis
   * band the twilight sky would be pale green or straw yellow.
   *
   * This is the single assertion that justifies the module. An implementation that dropped
   * ozone would still produce a smooth, plausible, entirely wrong sky, and every other test
   * here would pass.
   */
  test('is blue because of ozone, and straw-coloured without it', () => {
    const withOzone = twilightSkyColor(deg(-4)).color;
    const withoutOzone = twilightSkyColor(deg(-4), { ozoneDobson: 0 }).color;

    // Blue is the brightest channel when ozone is present...
    expect(withOzone[2]).toBeGreaterThan(withOzone[0]);
    expect(withOzone[2]).toBeGreaterThan(withOzone[1]);
    // ...and red is, when it is not.
    expect(withoutOzone[0]).toBeGreaterThan(withoutOzone[2]);
    // The swing is a change of character, not a tint. Measured at 1.66x on the blue-to-red
    // ratio; the bound is set below that rather than at a round number chosen first.
    const ratio = (c: readonly number[]) => c[2] / Math.max(c[0], 1e-9);
    expect(ratio(withOzone) / ratio(withoutOzone)).toBeGreaterThan(1.5);
  });

  test('Earth\'s shadow climbs as the square of the depression angle', () => {
    expect(shadowHeightKm(0)).toBe(0);
    expect(shadowHeightKm(deg(-2))).toBeCloseTo(3.9, 0);
    expect(shadowHeightKm(deg(-6))).toBeCloseTo(35, 0);
    expect(shadowHeightKm(deg(-12))).toBeCloseTo(142, 0);
    // Doubling the depression roughly quadruples the height.
    expect(shadowHeightKm(deg(-8)) / shadowHeightKm(deg(-4))).toBeCloseTo(4, 0);
  });

  test('the ozone path peaks where the tangent ray crosses the layer', () => {
    // Under the layer the ray barely samples it; through it, tens of vertical columns.
    const throughLayer = ozoneSlantFactor(deg(-4));
    expect(tangentRayHeightKm(deg(-4))).toBeGreaterThan(10);
    expect(tangentRayHeightKm(deg(-4))).toBeLessThan(25);
    expect(throughLayer).toBeGreaterThan(20);
    // Above it there is nothing left to absorb.
    expect(ozoneSlantFactor(deg(-10))).toBeLessThan(1);
  });

  test('brightness falls by orders of magnitude across civil twilight', () => {
    const at = (d: number) => twilightSkyColor(deg(d)).relativeBrightness;
    expect(at(0)).toBeCloseTo(1, 3);
    expect(at(-2)).toBeLessThan(0.7);
    expect(at(-4)).toBeLessThan(0.2);
    // End of civil twilight: two orders down on sunset.
    expect(at(-6)).toBeLessThan(0.02);
    expect(at(-8)).toBeLessThan(1e-3);
    let previous = Infinity;
    for (let d = 0; d >= -12; d -= 0.5) {
      const value = at(d);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  test('the cache returns the same answer as the integral it stands in for', () => {
    for (const d of [-0.4, -2.1, -5.7]) {
      const cached = twilightSkyColorCached(deg(d));
      const quantised = Math.round(deg(d) / ((0.25 * Math.PI) / 180)) * ((0.25 * Math.PI) / 180);
      const direct = twilightSkyColor(quantised);
      expect(cached.color[0]).toBeCloseTo(direct.color[0], 10);
      expect(cached.relativeBrightness).toBeCloseTo(direct.relativeBrightness, 10);
    }
  });
});
