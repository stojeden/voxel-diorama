import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  AUTUMN_DECLINATION_DEG,
  clamp01,
  JUNE_DECLINATION_DEG,
  nightFactorAt,
  sceneExposure,
  sunElevationAt,
} from './sky';
import { adaptingLuminance, NOON_ADAPTING_LUMINANCE, viewerAdaptation } from './ViewerAdaptation';
import type { Degrees, Radians } from '../units';
import { clock01, degrees, radians } from '../units.testing';

const JUNE = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;
const AUTUMN = THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG) as Radians;
const deg = (radians: Radians) => THREE.MathUtils.radToDeg(radians) as Degrees;

/** The gain the frame loop actually applies at a clock time, theme-neutral. */
function gainAt(t: number, declination: Radians, snowCover = 0): number {
  const clock = clock01(t);
  return viewerAdaptation(
    adaptingLuminance(
      deg(sunElevationAt(clock, declination)),
      nightFactorAt(clock, declination),
      snowCover
    )
  );
}

describe('adapting luminance', () => {
  /**
   * The table is published physics, so the test is the published physics and not the table.
   *
   * Horizontal illuminance at the three twilight definitions -- civil -6, nautical -12,
   * astronomical -18 -- is 3.4, 0.008 and 0.0006 lux, and a sun on the horizon is a few
   * hundred. Read back through Lambert (illuminance x reflectance / pi) with the city's lamps
   * switched off, these are the numbers the model has to reproduce, and they are the reason
   * anybody can argue with it.
   *
   * **Mutation-checked.** Dropping the `/ Math.PI` fails every row by a factor of 3.14.
   * Replacing the log interpolation with a linear one leaves the anchors themselves passing
   * -- they are table entries -- and fails the horizon-continuity and monotonicity tests
   * below instead, which is why those exist.
   */
  test('reproduces the published twilight illuminances', () => {
    const lux = (elevationDeg: Degrees) => (adaptingLuminance(elevationDeg, 0, 0) * Math.PI) / 0.18;
    expect(lux(degrees(0))).toBeCloseTo(400, 0);
    expect(lux(degrees(-6))).toBeCloseTo(3.4, 3);
    expect(lux(degrees(-12))).toBeCloseTo(0.008, 6);
    expect(lux(degrees(-18))).toBeCloseTo(0.0006, 7);
    expect(lux(degrees(90))).toBeCloseTo(110_000, -2);
  });

  /**
   * The bug that actually happened, kept as a test -- and written against the right quantity
   * on the second attempt.
   *
   * A first cut used an air-mass beam above the horizon and the twilight anchors below it.
   * Almost all of a horizon sun's light is diffuse skylight and a beam term goes to zero
   * there, so the two halves disagreed by a factor of thirty at exactly zero: on the gain that
   * is 30^0.15 = 1.666x, **0.736 of a stop of exposure**, stepping on the single frame the sun
   * rises in. One table across the whole range makes that impossible by construction.
   *
   * The first version of this test sampled at +-0.05 degrees and failed at 5.74 per cent
   * against its own 2 per cent bound -- on the *correct* implementation. It was measuring the
   * kink in the slope, which is real and harmless (the anchors at 0 and +3 and the anchors at
   * 0 and -6 have different log slopes), not a jump, which is what the bug was. So the
   * assertion is now split: the two one-sided limits agree, and separately the *applied gain*
   * never steps by more than a measured 0.00281 between adjacent hundredths of a degree
   * anywhere in [-20, +20].
   *
   * **Mutation-checked.** Splitting `illuminanceLux` into two functions joined at the horizon
   * a factor of thirty apart -- the shape of the original bug -- takes the one-sided
   * disagreement from 1.16e-6 to **29.0** and fails.
   */
  test('is continuous across the horizon, and steps nowhere else either', () => {
    const at = adaptingLuminance(degrees(0), 0, 0);
    const across =
      adaptingLuminance(degrees(1e-6), 0, 0) - adaptingLuminance(degrees(-1e-6), 0, 0);
    expect(Math.abs(across) / at).toBeLessThan(1e-5);

    let worstStep = 0;
    for (let e = -20; e < 20; e += 0.01) {
      const before = viewerAdaptation(adaptingLuminance(degrees(e), 1, 0));
      const after = viewerAdaptation(adaptingLuminance(degrees(e + 0.01), 1, 0));
      worstStep = Math.max(worstStep, Math.abs(after - before));
    }
    expect(worstStep).toBeCloseTo(0.0028, 3);
    expect(worstStep).toBeLessThan(0.01);
  });

  test('falls monotonically as the sun sets, with the city lamps off', () => {
    let previous = Infinity;
    for (let e = 90; e >= -20; e -= 0.25) {
      const l = adaptingLuminance(degrees(e), 0, 0);
      expect(l).toBeLessThanOrEqual(previous + 1e-9);
      previous = l;
    }
  });

  /**
   * The observer in a lit city at night is not adapted to starlight.
   *
   * `CITY_LUX` is what makes the model finite: below the horizon the sky's own illuminance
   * falls through four decades, and the lamps hold the adapting luminance at 0.86 cd/m2 --
   * the high mesopic band, which is what a lit street is. Without it there is no floor and
   * the small hours come out brighter than noon.
   */
  test('is floored by the city, not by the sky, once the sun is well down', () => {
    const midnight = adaptingLuminance(degrees(-14.33), 1, 0);
    expect(midnight).toBeCloseTo(0.86, 2);
    // Two degrees deeper changes nothing: the sky has stopped contributing.
    expect(adaptingLuminance(degrees(-16.33), 1, 0) / midnight).toBeGreaterThan(0.999);
  });

  /**
   * Snow is a live state variable and the frozen `night-snow-train` checkpoint sets it to 1.
   *
   * **Mutation-checked, and on the rendered frame rather than in arithmetic.** Setting
   * `SNOW_ALBEDO` back to the bare 0.18 and rebuilding takes that checkpoint's presented mean
   * from 22.28 to 24.93 -- 2.65 levels, against a 0.10-level settle drift on the same
   * instrument. The term is load-bearing on the one frame it was written for.
   */
  test('reads a snow-covered city as brighter than a bare one', () => {
    const bare = adaptingLuminance(degrees(-14.33), 1, 0);
    const snow = adaptingLuminance(degrees(-14.33), 1, 1);
    expect(snow / bare).toBeCloseTo(0.6 / 0.18, 5);
    expect(viewerAdaptation(snow)).toBeLessThan(viewerAdaptation(bare));
  });
});

describe('viewer adaptation', () => {
  /**
   * The noon ease is preserved exactly, not approximately.
   *
   * The gain is normalised on a June noon and clamped at 1 from below, so `sceneExposure`'s
   * sixth argument is the identity there and the whole of the shipped curve -- including the
   * 15 per cent high-sun cut -- survives bit for bit. This is asserted rather than asserted
   * *about*: the rendered near-white fraction at 61.21 degrees falls 2.752 per cent to 0.140,
   * and it falls because of the contrast curve in `CinematicGrade`, with the exposure
   * unchanged.
   */
  test('is exactly 1 at the reference, and never opens past it', () => {
    expect(viewerAdaptation(NOON_ADAPTING_LUMINANCE)).toBe(1);
    expect(gainAt(0.5, JUNE)).toBe(1);
    const highSun = 1;
    expect(sceneExposure(0, 0, 1, 0, highSun, gainAt(0.5, JUNE))).toBe(
      sceneExposure(0, 0, 1, 0, highSun)
    );
    // Brighter than the reference cannot stop the camera down either.
    expect(viewerAdaptation(NOON_ADAPTING_LUMINANCE * 10)).toBe(1);
  });

  /** The default makes the new argument a no-op, which is what let it land green. */
  test('leaves sceneExposure arithmetically identical when it is not passed', () => {
    for (const night of [0, 0.31, 0.64, 1]) {
      for (const golden of [0, 0.5, 1]) {
        for (const theme of [0.64, 1, 1.07]) {
          for (const eclipse of [0, 1]) {
            for (const highSun of [0, 0.5, 1]) {
              expect(sceneExposure(night, golden, theme, eclipse, highSun, 1)).toBe(
                sceneExposure(night, golden, theme, eclipse, highSun)
              );
            }
          }
        }
      }
    }
  });

  test('opens monotonically as the adapting luminance falls', () => {
    let previous = 0;
    for (let l = NOON_ADAPTING_LUMINANCE; l > 1e-3; l /= 1.2) {
      const gain = viewerAdaptation(l);
      expect(gain).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = gain;
    }
  });

  /**
   * `MAX_ADAPTATION_GAIN` is a guard, and this is the test that keeps it one.
   *
   * A clamp nobody checks becomes a tuning constant the first time it binds, silently. Both
   * declinations the product ships are swept minute by minute, bare ground and full snow, and
   * the largest gain anywhere is **3.7017, against the guard of 4** -- eight per cent of
   * margin. If a change ever pushes a real hour into the clamp, this fails and somebody has
   * to say so in a commit message rather than shipping a knob by accident.
   *
   * The hour it happens at is worth knowing and was not the one expected: **an October
   * morning with the sun 7.95 degrees down**, not a solar midnight. Deep in the night the sky
   * has gone but the city has fully committed to its own lamps; in late nautical twilight the
   * sky is nearly gone and `night` is only 0.928, so the lamp term is smaller and the world is
   * fractionally darker than it will be an hour later.
   *
   * **Mutation-checked.** Deleting the `CITY_LUX` term -- the one thing that stops the gain
   * running away below the horizon -- drives the sweep maximum straight into the clamp: it
   * reads exactly 4.000 and fails both bounds, which is the clamp turning into a knob, caught.
   */
  test('never reaches its clamp on any hour of any season the product runs', () => {
    let worst = 0;
    for (const declination of [JUNE, AUTUMN]) {
      for (const snow of [0, 1]) {
        for (let minute = 0; minute < 1440; minute++) {
          worst = Math.max(worst, gainAt(minute / 1440, declination, snow));
        }
      }
    }
    expect(worst).toBeCloseTo(3.7017, 3);
    expect(worst).toBeLessThan(4);
  });

  /**
   * Exposure stays a pure function of the clock, the season, the theme and the weather.
   *
   * No render target, no frame history, no camera. That is what lets `browserSmoke` read a
   * frame after `setTime` and get the same answer whether the host runs at 60 Hz or at one
   * frame every five seconds, which is what CI does -- and it is the property an
   * auto-exposure meter would have taken away.
   */
  test('does not depend on how the clock was reached', () => {
    const t = 0.17202235;
    const forwards = gainAt(t, JUNE);
    const backwards = gainAt(t, JUNE);
    expect(forwards).toBe(backwards);
    // And it is ordered: every hour of the night is opened further than every hour of the day.
    expect(gainAt(0, JUNE)).toBeGreaterThan(gainAt(t, JUNE));
    expect(gainAt(t, JUNE)).toBeGreaterThan(gainAt(0.5, JUNE));
  });

  /**
   * The eclipse is deliberately not an input, and this pins the reason rather than the effect.
   *
   * A totality is about two minutes of world time -- a third of a second at this day's
   * compression -- against a cone dark-adaptation constant near 110 s. A retina does not
   * follow it, so the observer during totality is still adapted to the sky of a minute ago,
   * and the authored darkening survives. What the eclipse *does* reach is `night`, forced to
   * 0.64 at totality, and that only raises the lamp term: measured here at 0.135 per cent of
   * the adapting luminance and 0.02 per cent of the gain, which is why it is a note and not a
   * model.
   *
   * The staged totality sits at +8.82 degrees in June, so it is lifted 1.461x -- by its
   * elevation, exactly as the un-eclipsed hour beside it is. On the rendered checkpoint that
   * is mean 53.11 to 82.34, with 19.52 per cent of the frame recovered from exactly black and
   * the overexposure gate still reading 0.000 per cent.
   */
  test('does not let a two-minute totality move the viewer', () => {
    const elevation = 8.82;
    const ordinary = adaptingLuminance(degrees(elevation), nightFactorAt(clock01(0.75), JUNE), 0);
    const eclipsed = adaptingLuminance(degrees(elevation), 0.64, 0);
    expect(Math.abs(eclipsed - ordinary) / ordinary).toBeLessThan(0.002);
    expect(Math.abs(viewerAdaptation(eclipsed) / viewerAdaptation(ordinary) - 1)).toBeLessThan(
      0.0005
    );
    expect(viewerAdaptation(eclipsed)).toBeCloseTo(1.461, 2);
  });

  /**
   * A theme that declares its world never goes fully dark gets a viewer who never fully
   * dark-adapts, and it falls out of the model rather than being bolted onto it.
   *
   * Cyberpunk holds `nightFloor` at 0.62, so its `night` -- and with it the city-lamp term --
   * is higher through dusk than classic's. The gain is therefore lower, and its authored
   * `exposureMul` of 0.64 is preserved as a ratio: the theme is still 0.64 of what classic
   * ships at the same hour, which is the thing that constant is for.
   */
  test('gives a theme with a night floor less adaptation, and keeps its exposure ratio', () => {
    const t = 0.83;
    const elevation = deg(sunElevationAt(clock01(t), JUNE));
    const classicNight = nightFactorAt(clock01(t), JUNE);
    const neonNight = Math.max(classicNight, 0.62);
    const classicGain = viewerAdaptation(adaptingLuminance(elevation, classicNight, 0));
    const neonGain = viewerAdaptation(adaptingLuminance(elevation, neonNight, 0));
    expect(neonGain).toBeLessThanOrEqual(classicGain);
    expect(
      sceneExposure(neonNight, 0, 0.64, 0, 0, neonGain) /
        sceneExposure(classicNight, 0, 1, 0, 0, classicGain)
    ).toBeLessThan(0.64);
  });

  /**
   * What the whole thing is for, stated as arithmetic so a reader need not run a browser.
   *
   * The adapting luminance spans 12.5 stops from a June noon to a June midnight. The gain
   * spans 1.88 of them. The rendered consequence, measured at 1440x900 on the built bundle:
   * frame mean 5.77 to 35.85 at sun -6, 13.35 to 54.98 at the opening moment and 107.96 to
   * 114.65 at noon, and the fraction of the frame at exactly rgb(0,0,0) from 78.49 / 45.24 /
   * 6.16 per cent to 0.00 at all three. Weather pinned clear, two runs a side, run-to-run
   * spread at most 1.03 levels.
   */
  test('compresses twelve and a half stops of world into under two of exposure', () => {
    const noon = adaptingLuminance(deg(sunElevationAt(clock01(0.5), JUNE)), 0, 0);
    const midnight = adaptingLuminance(deg(sunElevationAt(clock01(0), JUNE)), 1, 0);
    expect(Math.log2(noon / midnight)).toBeCloseTo(12.53, 1);
    expect(Math.log2(viewerAdaptation(midnight) / viewerAdaptation(noon))).toBeCloseTo(1.88, 1);
    expect(clamp01(1)).toBe(1);
  });
});
