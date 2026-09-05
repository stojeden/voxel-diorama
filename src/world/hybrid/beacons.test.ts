import { describe, expect, test } from 'vitest';
import { BEACON_PEAK, BEACON_RATE, beaconGlow, BEACON_DAY } from './beacons';

describe('obstruction beacons', () => {
  test('bright at night, barely awake by day, never over the palette peak', () => {
    let brightestNight = 0;
    let brightestDay = 0;
    for (let i = 0; i < 400; i++) {
      const t01 = i / 400 / BEACON_RATE;
      brightestNight = Math.max(brightestNight, beaconGlow(t01, 1, 0));
      brightestDay = Math.max(brightestDay, beaconGlow(t01, 0, 0));
    }
    expect(brightestNight).toBeCloseTo(BEACON_PEAK, 3);
    expect(brightestDay).toBeCloseTo(BEACON_PEAK * BEACON_DAY, 3);
    expect(brightestNight).toBeLessThanOrEqual(BEACON_PEAK + 1e-6);
  });

  test('it fades, it does not switch', () => {
    // Walk one whole flash and check that no step in the ramp is a jump.
    const steps = 60;
    let previous = beaconGlow(0, 1, 0);
    let biggestStep = 0;
    let rose = false;
    let fell = false;
    for (let i = 1; i <= steps; i++) {
      const value = beaconGlow(i / steps / BEACON_RATE, 1, 0);
      biggestStep = Math.max(biggestStep, Math.abs(value - previous));
      if (value > previous) rose = true;
      if (value < previous) fell = true;
      previous = value;
    }
    expect(rose && fell, 'lampa rozjaśnia się i gaśnie w jednym cyklu').toBe(true);
    // A hard on/off would step the whole range in one frame of the ramp.
    expect(biggestStep).toBeLessThan(BEACON_PEAK * 0.25);
  });

  test('the two structures flash half a period apart', () => {
    // One is at its floor exactly when the other is at its peak, and the other way round
    // half a flash later. They cross twice per cycle -- that is what out of step means.
    const floorA = beaconGlow(0, 1, 0);
    const peakB = beaconGlow(0, 1, 0.5);
    expect(peakB).toBeCloseTo(BEACON_PEAK, 3);
    expect(floorA).toBeLessThan(BEACON_PEAK * 0.2);
    const half = 0.5 / BEACON_RATE;
    expect(beaconGlow(half, 1, 0)).toBeCloseTo(BEACON_PEAK, 3);
    expect(beaconGlow(half, 1, 0.5)).toBeLessThan(BEACON_PEAK * 0.2);
  });

  test('the same clock reading always gives the same flash', () => {
    for (const t01 of [0, 0.137, 0.5, 0.913]) {
      expect(beaconGlow(t01 + 1, 1, 0)).toBeCloseTo(beaconGlow(t01, 1, 0), 6);
      expect(beaconGlow(t01 - 3, 1, 0.5)).toBeCloseTo(beaconGlow(t01, 1, 0.5), 6);
    }
  });
});
