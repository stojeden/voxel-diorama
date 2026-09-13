import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  airMassAt,
  clockFromSolarPhase,
  directSunFactorAt,
  highSunFactor,
  JUNE_DECLINATION_DEG,
  nightFactorAt,
  solarPhaseAt,
  sunElevationAt,
} from './environment/sky';
import { adaptingLuminance } from './environment/ViewerAdaptation';
import { isGroceryOpen } from './world/hybrid/shopHours';
import { ExperienceDirector } from './experience/ExperienceDirector';
import { ECLIPSE_VIEW_SOLAR_PHASE, OPENING_SOLAR_PHASE } from './experience/AuthoredMoments';
import type { HybridFrame } from './world/hybrid/HybridSpike';
import type { Clock01, Degrees, Radians, SolarPhase01, WallClock01 } from './units';
import { clock01, degrees, radians, solarPhase01, wallClock01 } from './units.testing';

/**
 * The brands, asserted the only way a type can be: by the compiler refusing the wrong call.
 *
 * **`@ts-expect-error` is a real assertion here and nowhere else in this repository.** It
 * fails the typecheck if the line it sits on *compiles* -- so every one of these is a test
 * that the swap it describes is now impossible, and deleting a brand turns this file red
 * rather than green. That is the inversion that makes it worth writing: the usual rule
 * against the directive exists because it hides an error, and here its whole job is to
 * require one.
 *
 * Each directive must sit on the line the error is reported on, which is why the offending
 * calls are written one per line rather than wrapped.
 *
 * Every defect below has happened. Six of the seven cost a day each.
 */

const JUNE = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;
const NOON = clock01(0.5);

describe('the two time axes cannot be swapped', () => {
  /**
   * Instances one to six: an authored moment read as a clock.
   *
   * `ECLIPSE_VIEW_SOLAR_PHASE` is 0.715 as a phase -- 19:07 and 8.8 degrees of elevation in
   * June. Read as a clock it is 17:10 and 25.9 degrees: nearly two hours and seventeen
   * degrees away, and since the eclipse camera stands *opposite* the sun, a different shot.
   */
  test('a solar phase is not a clock reading', () => {
    // @ts-expect-error a SolarPhase01 where the solar model wants a Clock01
    sunElevationAt(ECLIPSE_VIEW_SOLAR_PHASE, JUNE);
    // @ts-expect-error the same swap through the night ramp
    nightFactorAt(OPENING_SOLAR_PHASE, JUNE);
    // @ts-expect-error and through the beam
    directSunFactorAt(OPENING_SOLAR_PHASE, JUNE);
    // @ts-expect-error `ExperienceDirector.setTime` takes a clock; a phase must be resolved
    new ExperienceDirector({ daySeconds: 100 }).setTime(OPENING_SOLAR_PHASE);

    // The conversion is what makes it legal, and it is not the identity: resolving the
    // opening phase against June's declination moves it more than an hour off its own value.
    const opened = clockFromSolarPhase(OPENING_SOLAR_PHASE, JUNE);
    expect(Math.abs(opened - OPENING_SOLAR_PHASE) * 24).toBeGreaterThan(1);
  });

  test('a clock reading is not a solar phase', () => {
    const noon = clock01(0.5);
    // @ts-expect-error a Clock01 where the inverse conversion wants a SolarPhase01
    clockFromSolarPhase(noon, JUNE);

    // And the round trip that is legal still has to be written as a round trip.
    expect(clockFromSolarPhase(solarPhaseAt(noon, JUNE), JUNE)).toBeCloseTo(0.5, 9);
  });

  /**
   * The seventh instance, which was sitting unexploded in `HybridFrame`.
   *
   * `sunT` and `clockT` are the same number in simulation and different numbers in real
   * time, so a swap passes every test and only a viewer with real time on ever sees it --
   * a grocery that opens at sunrise instead of at six. Distinct brands are what stop it.
   */
  test('the lighting clock is not the wall clock', () => {
    const frame = { sunT: clock01(0.5), clockT: wallClock01(0.5) } as Pick<
      HybridFrame,
      'sunT' | 'clockT'
    >;
    // @ts-expect-error the lighting clock cannot be stored as the hour the HUD prints
    frame.clockT = frame.sunT;
    // @ts-expect-error nor the hour driven through the sun
    frame.sunT = frame.clockT;
    // @ts-expect-error opening hours read the wall clock, never the lighting phase
    isGroceryOpen(frame.sunT);
    // @ts-expect-error and the solar model reads the lighting clock, never the wall clock
    sunElevationAt(frame.clockT, JUNE);

    // Both brands are still plain numbers at run time: the shop's hours are unchanged.
    expect(isGroceryOpen(wallClock01(12 / 24))).toBe(true);
    expect(isGroceryOpen(wallClock01(3 / 24))).toBe(false);
  });

  test('a bare number is not on either axis', () => {
    // @ts-expect-error 0.5 alone does not say which of the three 0..1 axes it is on
    sunElevationAt(0.5, JUNE);
    // @ts-expect-error nor does it here
    isGroceryOpen(0.5);
  });
});

describe('degrees and radians cannot be swapped', () => {
  /**
   * The convention this replaces was `elevationDeg` against `elevationRad`, kept by hand
   * across about fifty sites. It held -- but nothing was checking it, and a declination is
   * the place it would not have: `JUNE_DECLINATION_DEG` is 23.44, which is also a perfectly
   * plausible number of radians as far as `Math.sin` is concerned.
   */
  test('an angle in degrees is not an angle in radians', () => {
    // @ts-expect-error 23.44 degrees handed to the spherical triangle as radians
    sunElevationAt(NOON, JUNE_DECLINATION_DEG);
    // @ts-expect-error the high-sun ease converts for itself and wants radians
    highSunFactor(degrees(61.2));
  });

  test('an angle in radians is not an angle in degrees', () => {
    const elevation = sunElevationAt(NOON, JUNE);
    // @ts-expect-error Kasten-Young is written in degrees and the sun model returns radians
    airMassAt(elevation);
    // @ts-expect-error the illuminance table is anchored in degrees
    adaptingLuminance(elevation, 0, 0);

    // Converted, both are ordinary calls -- and June noon is the 61.2 degrees the model claims.
    const elevationDeg = THREE.MathUtils.radToDeg(elevation) as Degrees;
    expect(elevationDeg).toBeCloseTo(61.2, 1);
    expect(airMassAt(elevationDeg)).toBeCloseTo(1.14, 2);
  });
});

describe('the brands are erased', () => {
  /**
   * The point of the whole exercise: none of this exists at run time.
   *
   * A branded number is a number, so every operator, every `Math` call and every comparison
   * behaves exactly as it did. The stronger proof is not here but in the build -- the entry
   * chunk is byte-identical to the one before the brands arrived -- and this is the part of
   * it a unit test can hold.
   */
  test('a branded value is the number it was', () => {
    const t: Clock01 = clock01(0.25);
    const phase: SolarPhase01 = solarPhase01(0.25);
    const hour: WallClock01 = wallClock01(0.25);
    const angle: Radians = radians(0.25);
    expect(t + phase + hour + angle).toBe(1);
    expect(typeof t).toBe('number');
    expect(JSON.stringify({ t })).toBe('{"t":0.25}');
  });
});
