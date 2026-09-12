import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  nightFactorAt,
  sunElevationAt,
} from './sky';

/**
 * The aurora is the one visual nothing else guards, and it is driven from outside its own file.
 *
 * `DayNightCycle` gates the curtains on
 * `auroraTarget * clamp01((night - 0.6) / 0.3) * (1 - cloudCover)`, so its entire existence
 * hangs on `nightFactorAt` — which lives in `sky.ts` and is art direction, retuned twice this
 * week. It also appears only on clear nights and only about every other simulated day
 * (`ExperienceDirector` rolls `random() < 0.5`), so a change that deleted it would pass every
 * gate in this repository and surface as somebody eventually noticing it had stopped happening.
 *
 * These tests do not pin the ramp constants. They pin the *consequence*: that both seasons
 * still reach a night deep enough for the curtains to appear at full strength, and that the
 * aurora waits for the sun to actually set.
 */

const JUNE = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG);
const AUTUMN = THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG);
/** The gate in `DayNightCycle.update`, minus the cloud and per-day terms. */
const auroraStrength = (night: number) => Math.min(1, Math.max(0, (night - 0.6) / 0.3));
const SAMPLES = 4000;

const nightAt = (clock: number, declination: number) =>
  nightFactorAt(clock, declination);

const hoursVisible = (declination: number) => {
  let lit = 0;
  for (let i = 0; i < SAMPLES; i++) {
    if (auroraStrength(nightAt(i / SAMPLES, declination)) > 0.015) lit++;
  }
  return (lit / SAMPLES) * 24;
};

const peakStrength = (declination: number) => {
  let peak = 0;
  for (let i = 0; i < SAMPLES; i++) {
    peak = Math.max(peak, auroraStrength(nightAt(i / SAMPLES, declination)));
  }
  return peak;
};

describe('the aurora can still happen', () => {
  /**
   * The June case is the one that can actually be lost.
   *
   * At 52.23 north a midsummer sun bottoms out at -14.33 degrees and never reaches
   * astronomical darkness at all, so a night ramp anchored much deeper than nautical twilight
   * would leave a Polish June permanently short of the 0.6 the curtains need.
   */
  /**
   * Mutation-checked, so its reach is known rather than assumed: moving the night anchor to
   * -25 fails this with a June peak of 0.692, and -30 with 0.328. It does **not** fail at -18,
   * because -18 genuinely does not hurt the aurora — June's -14.33 still clears the gate at
   * full strength. This guards existence, which is the thing that could vanish unnoticed; it
   * deliberately does not pin the tuning.
   */
  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s reaches full aurora strength at some point in the night', (_label, declination) => {
    expect(peakStrength(declination)).toBeCloseTo(1, 5);
  });

  test('a Polish June still gets several hours of it', () => {
    // Measured 7.10 h under the ramps of 2026-09-12, against 8.03 under the ones before them.
    // The bound is deliberately far below both: this guards existence, not a tuning choice.
    expect(hoursVisible(JUNE)).toBeGreaterThan(3);
    expect(hoursVisible(AUTUMN)).toBeGreaterThan(hoursVisible(JUNE));
  });

  /**
   * And it waits for the sun to set, which it did not always do.
   *
   * Before the ramps were retuned the curtains could fade in at a solar elevation of +2.12
   * degrees -- in full daylight, with the sun still above the horizon. That is now -1.18.
   */
  test('does not appear while the sun is still up', () => {
    // Sample the real curve rather than inverting it: the highest sun at any instant of a June
    // day that still shows the curtains. Before the retune this was +2.12 degrees -- the aurora
    // could fade in while the sun was still above the horizon.
    let highestLitSun = -90;
    for (let i = 0; i < SAMPLES; i++) {
      const clock = i / SAMPLES;
      if (auroraStrength(nightAt(clock, JUNE)) > 0) {
        highestLitSun = Math.max(
          highestLitSun,
          THREE.MathUtils.radToDeg(sunElevationAt(clock, JUNE))
        );
      }
    }
    expect(highestLitSun).toBeLessThan(0);
  });
});
