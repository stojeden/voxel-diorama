import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { starAlphaAt } from './DayNightCycle';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  nightFactorAt,
  sunElevationAt,
} from './sky';

/**
 * The star field had nothing watching it, and it was wrong for as long as that was true.
 *
 * `starAlphaAt` thresholds `nightFactorAt`, which is art direction in `sky.ts` retuned three
 * times this month. Under the pair that shipped, `(night - 0.45) / 0.5`, the first stars came
 * out at a solar elevation of **+1.33 degrees** -- above the horizon, in daylight, every day
 * of the year. Before the 2026-09-12 ramp retune the same constants meant +4.93. Nobody
 * noticed either, because nothing in this repository looks at the sky: every gate here passes
 * a star field that switches on at noon.
 *
 * So these tests pin the *consequence*, the way `aurora.test.ts` does, not the constants:
 * that the first star waits for the sun to be properly down, that both seasons still get a
 * fully starry sky and hours of it, and that an eclipse can still bring stars out at midday.
 * A retune inside the twilight band is free; leaving the band is not.
 *
 * They reach the real `starAlphaAt`, so a change to the production expression fails here. What
 * they cannot reach is `DayNightCycle.update` itself -- the two lines that turn this alpha into
 * `starMaterial.opacity` and `starField.visible`, and the `> 0.6` shooting-star gate, need a
 * WebGL context. {@link VISIBLE_ALPHA} below is therefore a copy of the visibility threshold
 * and not the thing itself.
 */

const JUNE = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG);
const AUTUMN = THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG);
/** `DayNightCycle.update` sets `starField.visible = starAlpha > 0.02`. */
const VISIBLE_ALPHA = 0.02;
/** One sample per 4.32 simulated seconds: enough that the first-star elevation converges. */
const SAMPLES = 20000;

/** A clear night with no eclipse: the two terms the sky itself does not supply are zero. */
const alphaAt = (clock: number, declination: number) =>
  starAlphaAt(nightFactorAt(clock, declination), 0, 0, 0);

/** The highest the sun stands at any instant of the day that already shows a star. */
const firstStarElevationDeg = (declination: number) => {
  let highest = -90;
  for (let i = 0; i < SAMPLES; i++) {
    const clock = i / SAMPLES;
    if (alphaAt(clock, declination) > 0) {
      highest = Math.max(highest, THREE.MathUtils.radToDeg(sunElevationAt(clock, declination)));
    }
  }
  return highest;
};

const peakAlpha = (declination: number) => {
  let peak = 0;
  for (let i = 0; i < SAMPLES; i++) peak = Math.max(peak, alphaAt(i / SAMPLES, declination));
  return peak;
};

const hoursVisible = (declination: number) => {
  let lit = 0;
  for (let i = 0; i < SAMPLES; i++) {
    if (alphaAt(i / SAMPLES, declination) > VISIBLE_ALPHA) lit++;
  }
  return (lit / SAMPLES) * 24;
};

describe('the stars wait for the dark', () => {
  /**
   * Mutation-checked, so the reach of these bounds is known rather than assumed.
   *
   * Reverting the pair to the `(night - 0.45) / 0.5` that shipped fails this at +1.33 degrees;
   * flipping the subtraction to `night + 0.76` fails it at +61.21, a starry June noon; and
   * stopping halfway back, at 0.65, fails the lower bound at -2.04. Retuning `sky.ts` instead
   * of this file fails it too, which is the point of measuring in degrees rather than in
   * factor: a full-night anchor at -20 pushes first light to -9.49 and a full-day anchor at
   * +30 lifts it to +1.38.
   *
   * What it does **not** catch is a nudge that stays inside the band -- 0.78 passes, at -4.42
   * -- and that is deliberate. This guards the twilight definition, not the tuning.
   */
  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s shows its first star during twilight, not in daylight', (_label, declination) => {
    const elevation = firstStarElevationDeg(declination);
    // Measured -4.035 degrees in June and -4.037 in autumn at this file's sampling (-4.032
    // over a 200 000-step sweep): partway through civil twilight, which is when the eye
    // really does pick up the first naked-eye stars. The bounds are the band, not the value
    // -- below the horizon at all, which is the defect, and not so late that the sky is
    // already deep into nautical twilight before anything appears.
    expect(elevation).toBeLessThan(-3);
    expect(elevation).toBeGreaterThan(-8);
  });

  /**
   * The June case is the one that can actually be lost.
   *
   * At 52.23 north a midsummer sun bottoms out at -14.33 degrees, so a full-strength anchor
   * pushed much past nautical twilight would leave a Polish June with no properly starry sky
   * at all. Measured: full strength arrives at -9.90 degrees of depression.
   *
   * Mutation-checked, and it is this test rather than the one above that catches an
   * over-correction: a threshold of 0.90 fails it at a peak of 0.4545 (its ramp would need a
   * night factor of 1.12), and putting the span back to 0.5 fails it at 0.48. Both of those
   * pass the twilight-band test, and both would have shipped a sky that never fills in. A
   * `sky.ts` retune reaches it too -- a full-night anchor at -20 leaves June at 0.7344 and
   * one at -18 leaves it at 0.9149, which is the shape of the thing the anchor comment in
   * `sky.ts` already warns about.
   */
  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s reaches a fully starry sky at some point in the night', (_label, declination) => {
    expect(peakAlpha(declination)).toBeCloseTo(1, 5);
  });

  test('and both seasons get hours of it, autumn more than June', () => {
    // Measured 6.21 h in June and 12.74 h in autumn, against 7.79 and 13.93 under the pair
    // that started them in daylight. The bound is deliberately far below both: this guards
    // existence, not a tuning choice.
    expect(hoursVisible(JUNE)).toBeGreaterThan(3);
    expect(hoursVisible(AUTUMN)).toBeGreaterThan(hoursVisible(JUNE));
  });

  /**
   * And the eclipse keeps its own stars, which do not come from the sun being down.
   *
   * `EclipseTimeline` hands totality `stars: 1`, and it reaches `starAlphaAt` through a
   * `Math.max` precisely so that a daylight eclipse can still show them. It has to be the
   * term that wins: the night factor an eclipse synthesises tops out at 0.6322, which is 0
   * of alpha under this threshold -- so without the eclipse term, totality would be starless.
   *
   * Mutation-checked: deleting the `Math.max` arm fails this at 0, and scaling it down to
   * 0.01 -- under the visibility gate, so the field would be built and never drawn -- fails
   * it too. The `toBe(0)` on 0.6322 is what makes the first claim testable at all; under the
   * pair that shipped, the eclipse's own night was worth 0.3644 of alpha and deleting the
   * eclipse term would have been nearly invisible.
   */
  test('brings the stars out at totality even at noon', () => {
    const noonNight = 0;
    expect(starAlphaAt(noonNight, 1, 0, 0)).toBeCloseTo(0.88, 10);
    expect(starAlphaAt(noonNight, 1, 0, 0)).toBeGreaterThan(VISIBLE_ALPHA);
  });

  /**
   * The partial phases, which the first draft of this change silently deleted.
   *
   * `eclipseStars` is `smootherStep(corona)` and the corona is exactly 0 below progress
   * 0.36, so on the way into and out of totality the only thing carrying stars is the night
   * the eclipse itself manufactures. Raising the twilight threshold to 0.76 took 20.02 s of
   * starfield out of every 90 s eclipse before a review caught it; the worst point measured
   * was progress 0.3665 at coverage 0.9852, alpha 0.1098 falling to 0.
   *
   * Mutation-checked: deleting the eclipse-night arm fails this at 0; moving its threshold
   * to 0.76 fails it at 0; widening its span to 0.9 fails the totality-adjacent assertion.
   */
  test('keeps the stars through the partial phases, not only at totality', () => {
    const deepPartial = 0.5048;
    expect(starAlphaAt(0, 0, deepPartial, 0)).toBeGreaterThan(VISIBLE_ALPHA);
    expect(starAlphaAt(0, 0, deepPartial, 0)).toBeCloseTo(0.1096, 3);
    // The eclipse ceiling stays well clear of the visible gate all the way up.
    expect(starAlphaAt(0, 0, 0.6322, 0)).toBeCloseTo(0.3644, 3);
    // And an ordinary bright day with no eclipse still has none.
    expect(starAlphaAt(0, 0, 0, 0)).toBe(0);
  });

  // Mutation-checked: dropping `* (1 - cloudCover)` fails this at 1.
  test('and overcast still hides them, eclipse or not', () => {
    expect(starAlphaAt(1, 0, 0, 1)).toBe(0);
    expect(starAlphaAt(0, 1, 0, 1)).toBe(0);
    expect(starAlphaAt(0, 0, 0.6322, 1)).toBe(0);
  });
});
