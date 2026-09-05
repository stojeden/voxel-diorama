import { describe, expect, test } from 'vitest';
import { BEACON_DAY, BEACON_PEAK, BEACON_PERIOD, beaconGlow } from './beacons';

describe('obstruction beacons', () => {
  test('bright at night, barely awake by day, never over the palette peak', () => {
    let brightestNight = 0;
    let brightestDay = 0;
    for (let i = 0; i < 400; i++) {
      const seconds = (i / 400) * BEACON_PERIOD;
      brightestNight = Math.max(brightestNight, beaconGlow(seconds, 1, 0));
      brightestDay = Math.max(brightestDay, beaconGlow(seconds, 0, 0));
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
      const value = beaconGlow((i / steps) * BEACON_PERIOD, 1, 0);
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
    const floorA = beaconGlow(0, 1, 0);
    const peakB = beaconGlow(0, 1, 0.5);
    expect(peakB).toBeCloseTo(BEACON_PEAK, 3);
    expect(floorA).toBeLessThan(BEACON_PEAK * 0.2);
    const half = BEACON_PERIOD / 2;
    expect(beaconGlow(half, 1, 0)).toBeCloseTo(BEACON_PEAK, 3);
    expect(beaconGlow(half, 1, 0.5)).toBeLessThan(BEACON_PEAK * 0.2);
  });

  test('the flash is visible in a few seconds of real time, in either clock mode', () => {
    // The phase is seconds of presentation time, so it does not care whether a day takes
    // 240 s or 24 h. It used to be 160 turns of `t01`: in real time that is one flash
    // every nine minutes, which is not a flashing light.
    const seen: number[] = [];
    for (let frame = 0; frame < 90; frame++) seen.push(beaconGlow(frame / 30, 1, 0));
    const peak = Math.max(...seen);
    const floor = Math.min(...seen);
    expect(peak).toBeGreaterThan(BEACON_PEAK * 0.9);
    expect(floor).toBeLessThan(BEACON_PEAK * 0.25);
    // Three seconds of real time is two flashes.
    let crossings = 0;
    for (let i = 1; i < seen.length; i++) {
      const mid = BEACON_PEAK * 0.5;
      if ((seen[i - 1] < mid) !== (seen[i] < mid)) crossings += 1;
    }
    expect(crossings).toBeGreaterThanOrEqual(3);
  });

  test('the same elapsed time always gives the same flash', () => {
    for (const seconds of [0, 0.37, 4.5, 91.3]) {
      expect(beaconGlow(seconds + BEACON_PERIOD, 1, 0)).toBeCloseTo(beaconGlow(seconds, 1, 0), 6);
      expect(beaconGlow(seconds + 3 * BEACON_PERIOD, 1, 0.5)).toBeCloseTo(beaconGlow(seconds, 1, 0.5), 6);
    }
  });
});
