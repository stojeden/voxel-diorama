import { describe, expect, test } from 'vitest';
import {
  PRIMARY_RAINBOW_MAX_ANGLE_RAD,
  RAINBOW_SPECTRAL_SAMPLES,
  SECONDARY_RAINBOW_MAX_ANGLE_RAD,
  horizonIntersectionDeltaAzimuth,
  rainbowCaustic,
  rainbowCausticAt,
  rainbowRayAtImpact,
  waterRefractiveIndexAt,
  wavelengthToLinearSrgb,
} from './RainbowOptics';

const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

describe('water dispersion', () => {
  test('uses exact table values and linear interpolation', () => {
    expect(waterRefractiveIndexAt(400)).toBe(1.34319);
    expect(waterRefractiveIndexAt(700)).toBe(1.33016);
    expect(waterRefractiveIndexAt(425)).toBeCloseTo((1.34319 + 1.33924) / 2, 10);
  });

  test('clamps unsupported wavelengths and keeps non-finite input safe', () => {
    expect(waterRefractiveIndexAt(350)).toBe(1.34319);
    expect(waterRefractiveIndexAt(750)).toBe(1.33016);
    expect(waterRefractiveIndexAt(Number.NaN)).toBe(1.33432);
  });
});

describe('stationary-deviation caustics', () => {
  test('reproduces the visible-spectrum primary and secondary angle ranges', () => {
    const violetPrimary = toDegrees(rainbowCausticAt(400, 1).angularRadiusRad);
    const redPrimary = toDegrees(rainbowCausticAt(700, 1).angularRadiusRad);
    const violetSecondary = toDegrees(rainbowCausticAt(400, 2).angularRadiusRad);
    const redSecondary = toDegrees(rainbowCausticAt(700, 2).angularRadiusRad);

    expect(violetPrimary).toBeCloseTo(40.619, 3);
    expect(redPrimary).toBeCloseTo(42.493, 3);
    expect(redSecondary).toBeCloseTo(50.144, 3);
    expect(violetSecondary).toBeCloseTo(53.526, 3);

    expect(violetPrimary).toBeGreaterThanOrEqual(40.618);
    expect(redPrimary).toBeLessThanOrEqual(42.493);
    expect(redSecondary).toBeGreaterThanOrEqual(50.143);
    expect(violetSecondary).toBeLessThanOrEqual(53.527);
  });

  test('satisfies Snell and stationary-caustic conditions for both orders', () => {
    for (const order of [1, 2] as const) {
      const refractiveIndex = waterRefractiveIndexAt(550);
      const caustic = rainbowCaustic(refractiveIndex, order)!;

      expect(Math.sin(caustic.incidenceAngleRad)).toBeCloseTo(
        refractiveIndex * Math.sin(caustic.refractionAngleRad),
        12
      );
      expect(
        Math.cos(caustic.incidenceAngleRad) /
          (refractiveIndex * Math.cos(caustic.refractionAngleRad))
      ).toBeCloseTo(1 / (order + 1), 12);
    }
  });

  test('rejects non-physical refractive indices instead of returning NaN', () => {
    expect(rainbowCaustic(Number.NaN, 1)).toBeNull();
    expect(rainbowCaustic(1, 1)).toBeNull();
    expect(rainbowCaustic(2, 1)).toBeNull();
  });

  test('traces complete drop rays with area-sampled impact parameters', () => {
    const primaryRays = Array.from({ length: 2_048 }, (_, index) =>
      rainbowRayAtImpact(550, 1, Math.sqrt((index + 0.5) / 2_048))
    ).filter((ray) => ray !== null);
    const secondaryRays = Array.from({ length: 2_048 }, (_, index) =>
      rainbowRayAtImpact(550, 2, Math.sqrt((index + 0.5) / 2_048))
    ).filter((ray) => ray !== null);
    const primaryCaustic = rainbowCausticAt(550, 1).angularRadiusRad;
    const secondaryCaustic = rainbowCausticAt(550, 2).angularRadiusRad;

    expect(Math.max(...primaryRays.map((ray) => ray.angularRadiusRad)))
      .toBeCloseTo(primaryCaustic, 5);
    expect(Math.min(...secondaryRays.map((ray) => ray.angularRadiusRad)))
      .toBeCloseTo(secondaryCaustic, 5);
    expect(primaryRays.every((ray) => ray.throughput > 0)).toBe(true);
    expect(secondaryRays.every((ray) => ray.throughput > 0)).toBe(true);
    expect(rainbowRayAtImpact(550, 1, Number.NaN)).toBeNull();
    expect(rainbowRayAtImpact(550, 1, 1)).toBeNull();
  });
});

describe('spectral order and colour', () => {
  test('places red outside violet in the primary and reverses it in the secondary', () => {
    expect(RAINBOW_SPECTRAL_SAMPLES).toHaveLength(31);
    for (let index = 1; index < RAINBOW_SPECTRAL_SAMPLES.length; index++) {
      const previous = RAINBOW_SPECTRAL_SAMPLES[index - 1];
      const current = RAINBOW_SPECTRAL_SAMPLES[index];
      expect(current.wavelengthNm).toBeGreaterThan(previous.wavelengthNm);
      expect(current.primaryAngleRad).toBeGreaterThan(previous.primaryAngleRad);
      expect(current.secondaryAngleRad).toBeLessThan(previous.secondaryAngleRad);
    }

    expect(PRIMARY_RAINBOW_MAX_ANGLE_RAD).toBe(
      RAINBOW_SPECTRAL_SAMPLES[RAINBOW_SPECTRAL_SAMPLES.length - 1].primaryAngleRad
    );
    expect(SECONDARY_RAINBOW_MAX_ANGLE_RAD).toBe(
      RAINBOW_SPECTRAL_SAMPLES[0].secondaryAngleRad
    );
  });

  test('maps representative wavelengths to finite, normalized linear sRGB', () => {
    const violet = wavelengthToLinearSrgb(400);
    const green = wavelengthToLinearSrgb(550);
    const red = wavelengthToLinearSrgb(700);

    expect(violet[2]).toBeGreaterThan(violet[0]);
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
    expect(red[0]).toBeGreaterThan(red[1]);
    expect(red[0]).toBeGreaterThan(red[2]);

    for (const sample of RAINBOW_SPECTRAL_SAMPLES) {
      expect(sample.linearRgb.every(Number.isFinite)).toBe(true);
      expect(Math.max(...sample.linearRgb)).toBeCloseTo(1, 12);
      expect(sample.linearRgb.every((channel) => channel >= 0 && channel <= 1)).toBe(true);
      expect(sample.spectralLinearRgb.every(Number.isFinite)).toBe(true);
      expect(sample.primaryEnergy).toBeGreaterThan(0);
      expect(sample.secondaryEnergy).toBeGreaterThan(0);
      expect(sample.secondaryEnergy).toBeLessThan(sample.primaryEnergy);
    }
  });
});

describe('horizon intersections', () => {
  test('uses spherical geometry for both horizon endpoints', () => {
    const alpha = toRadians(42);
    const elevation = toRadians(10);
    const delta = horizonIntersectionDeltaAzimuth(alpha, elevation)!;
    const expected = Math.acos(Math.cos(alpha) / Math.cos(elevation));

    expect(delta).toBeCloseTo(expected, 12);
    expect(toDegrees(delta)).toBeCloseTo(41.009, 3);
  });

  test('collapses at the limiting solar elevation and rejects an invisible arc', () => {
    const alpha = toRadians(42);
    expect(horizonIntersectionDeltaAzimuth(alpha, alpha)).toBeCloseTo(0, 12);
    expect(horizonIntersectionDeltaAzimuth(alpha, toRadians(43))).toBeNull();
    expect(horizonIntersectionDeltaAzimuth(alpha, toRadians(-1))).toBeNull();
    expect(horizonIntersectionDeltaAzimuth(Number.NaN, toRadians(10))).toBeNull();
  });
});
