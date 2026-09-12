import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { OPENING_SOLAR_PHASE } from '../experience/AuthoredMoments';
import {
  airMassAt,
  AUTUMN_DECLINATION_DEG,
  clockFromSolarPhase,
  directSunFactorAt,
  goldenFactorAt,
  highSunFactor,
  JUNE_DECLINATION_DEG,
  nightFactorAt,
  noonElevation,
  realTimeToCycleT,
  sceneBloomStrength,
  sceneExposure,
  skyColorAt,
  solarPhaseAt,
  sunColorAt,
  sunDirectionAt,
  sunElevationAt,
  sunriseHourAngle,
} from './sky';

const JUNE = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG);
const AUTUMN = THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG);
const deg = (radians: number) => THREE.MathUtils.radToDeg(radians);
/** Hours the sun spends below `limit` degrees, by direct sampling rather than by formula. */
const hoursBelow = (declination: number, limit: number) => {
  let count = 0;
  const samples = 20_000;
  for (let i = 0; i < samples; i++) {
    if (deg(sunElevationAt(i / samples, declination)) < limit) count++;
  }
  return (count / samples) * 24;
};
/** The morning clock time at which the sun stands at `elevationDeg`, found by bisection. */
const clockAtElevation = (elevationDeg: number, declination: number) => {
  let low = 0;
  let high = 0.5;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (deg(sunElevationAt(mid, declination)) < elevationDeg) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

describe('solar model', () => {
  /**
   * The two seasons, as Warsaw actually has them.
   *
   * These are the numbers the whole feature is for, so they are asserted directly rather
   * than left to emerge: a regression that flattened the sun back into a sinusoid would
   * still pass every smoothness test below, and fail here.
   */
  test('June and October differ in noon altitude and day length, at Poland\'s latitude', () => {
    expect(deg(noonElevation(JUNE))).toBeCloseTo(61.2, 1);
    expect(deg(noonElevation(AUTUMN))).toBeCloseTo(28.3, 1);

    const dayHours = (declination: number) => (sunriseHourAngle(declination) / Math.PI) * 24;
    expect(dayHours(JUNE)).toBeCloseTo(16.5, 1);
    expect(dayHours(AUTUMN)).toBeCloseTo(10.3, 1);

    // The owner's ask, stated as the thing a viewer sees: June's night is the short one.
    expect(hoursBelow(JUNE, 0)).toBeLessThan(8);
    expect(hoursBelow(AUTUMN, 0)).toBeGreaterThan(13);
  });

  test('a Polish June has no astronomical night, and October does', () => {
    // Below -18 degrees is astronomical darkness. At 52 north in June the sun never gets
    // there, and the diorama must not invent a darkness the country does not have.
    expect(hoursBelow(JUNE, -18)).toBe(0);
    expect(hoursBelow(AUTUMN, -18)).toBeGreaterThan(6);
  });

  test('sunset is later in June than in autumn, and sunrise earlier', () => {
    expect(clockFromSolarPhase(0.75, JUNE)).toBeGreaterThan(clockFromSolarPhase(0.75, AUTUMN));
    expect(clockFromSolarPhase(0.25, JUNE)).toBeLessThan(clockFromSolarPhase(0.25, AUTUMN));
    expect(clockFromSolarPhase(0.75, JUNE)).toBeCloseTo(20.27 / 24, 2);
    expect(clockFromSolarPhase(0.25, AUTUMN)).toBeCloseTo(6.83 / 24, 2);
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: the horizon is crossed exactly where the phase says it is', (_label, declination) => {
    expect(sunElevationAt(0.5, declination)).toBeGreaterThan(0.3);
    expect(Math.abs(sunElevationAt(clockFromSolarPhase(0.25, declination), declination)))
      .toBeLessThan(0.01);
    expect(Math.abs(sunElevationAt(clockFromSolarPhase(0.75, declination), declination)))
      .toBeLessThan(0.01);
    expect(sunElevationAt(clockFromSolarPhase(0, declination), declination)).toBeLessThan(-0.1);
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: clock and solar phase are inverses of each other', (_label, declination) => {
    for (let phase = 0; phase <= 1.0001; phase += 0.02) {
      const round = solarPhaseAt(clockFromSolarPhase(phase, declination), declination);
      expect(round).toBeCloseTo(Math.min(phase, 1), 5);
    }
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: sun direction is a unit vector rising in +X and setting in -X', (_label, declination) => {
    const sunrise = sunDirectionAt(clockFromSolarPhase(0.26, declination), declination);
    const sunset = sunDirectionAt(clockFromSolarPhase(0.74, declination), declination);
    expect(sunrise.length()).toBeCloseTo(1, 5);
    expect(sunrise.x).toBeGreaterThan(0.5);
    expect(sunset.x).toBeLessThan(-0.5);
    // Noon stands south, which is +Z, in both seasons.
    expect(sunDirectionAt(0.5, declination).z).toBeGreaterThan(0.4);
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: night factor is 1 at solar midnight and 0 at noon', (_label, declination) => {
    expect(nightFactorAt(clockFromSolarPhase(0, declination), declination)).toBeCloseTo(1, 2);
    expect(nightFactorAt(0.5, declination)).toBeCloseTo(0, 2);
    const twilight = nightFactorAt(clockFromSolarPhase(0.25, declination), declination);
    expect(twilight).toBeGreaterThan(0.05);
    expect(twilight).toBeLessThan(0.95);
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: dawn stays in twilight instead of switching on', (_label, declination) => {
    const at = (phase: number) => nightFactorAt(clockFromSolarPhase(phase, declination), declination);
    expect(at(0.25)).toBeGreaterThan(0.5);

    let previous = at(0.22);
    for (let phase = 0.222; phase <= 0.34; phase += 0.002) {
      const night = at(phase);
      expect(night).toBeLessThanOrEqual(previous + 1e-9);
      expect(previous - night).toBeLessThan(0.04);
      previous = night;
    }
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: direct sunlight fades in after sunrise rather than snapping on', (_label, declination) => {
    const at = (phase: number) =>
      directSunFactorAt(clockFromSolarPhase(phase, declination), declination);
    expect(at(0.25)).toBeCloseTo(0, 6);
    expect(at(0.252)).toBeLessThan(0.02);
    expect(at(0.32)).toBeGreaterThan(0.05);

    let previous = at(0.252);
    for (let phase = 0.254; phase <= 0.5; phase += 0.002) {
      const strength = at(phase);
      expect(strength).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = strength;
    }
  });

  /**
   * A low sun must read as a low sun. This is the defect the two ramps were retuned for.
   *
   * The external fact is the illuminance. At 4.4 degrees of elevation a clear sky delivers
   * several thousand lux against the hundred thousand of noon; at the end of civil
   * twilight, six degrees below the horizon, it delivers about one. The first is
   * unambiguously day and the second unambiguously night, and the factor that decides how
   * dark the city looks -- and that gates every window light in `DayNightCycle` -- has to
   * agree with both of them.
   *
   * Against the constants this replaces, the second half of the test passed and the first
   * half did not: -10 and +18 returned 0.479 at 4.4 degrees, so the diorama was still half
   * in night 36 minutes into a June morning, with its own opening moment inside that band.
   */
  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: a sun above the horizon reads as day, civil twilight still as night', (_label, declination) => {
    expect(nightFactorAt(clockAtElevation(4.4, declination), declination)).toBeLessThan(0.3);
    expect(nightFactorAt(clockAtElevation(-6, declination), declination)).toBeGreaterThan(0.8);
  });

  /**
   * The direct beam at a low sun, checked against the path it crosses rather than taste.
   *
   * A directional light's intensity is the *beam*: three charges every surface its own
   * N dot L, so the only loss left to model at a low sun is the length of the path. At 4.4
   * degrees that path is 11.42 air masses against a June noon's 1.14, and Meinel's clear-sky
   * transmission over them is **0.230** of the noon beam. That is the published number and it
   * is asserted as the published number: an earlier draft pinned full strength at 30 degrees
   * instead of at the top, which returned 0.275 and was covered by a band wide enough to hide
   * the difference. The old double cosine returned 0.037 -- an order of magnitude under.
   */
  test('the direct beam at a low sun is Meinel\'s 0.230 of noon, not a twenty-seventh', () => {
    const noon = directSunFactorAt(0.5, JUNE);
    const ratio = directSunFactorAt(clockAtElevation(4.4, JUNE), JUNE) / noon;
    expect(ratio).toBeCloseTo(0.23, 2);
  });

  /**
   * Midday keeps its shape, which pinning the scale lower would have flattened.
   *
   * With full strength pinned at 30 degrees every elevation above it clamps to exactly 1, so
   * a June middle of the day delivers identical light from ten in the morning to four in the
   * afternoon. Pinned at the top the beam still climbs the way the air mass says: 0.836 at 30
   * degrees, 0.941 at 45, 1.0 at the 61.21 this latitude tops out at.
   */
  test('the beam still climbs through midday instead of clamping', () => {
    const at = (deg: number) => directSunFactorAt(clockAtElevation(deg, JUNE), JUNE);
    expect(at(30)).toBeCloseTo(0.836, 2);
    expect(at(45)).toBeCloseTo(0.941, 2);
    expect(at(61.21)).toBeCloseTo(1, 2);
    expect(at(45)).toBeGreaterThan(at(30));
    expect(at(61.21)).toBeGreaterThan(at(45));
  });

  /**
   * The air mass is Kasten and Young's (1989), and it is held to their numbers.
   *
   * Two independent published facts. Above twenty degrees or so a relative air mass is
   * within a percent of the plane-parallel secant 1/sin(h), which is what a textbook uses
   * up there; and at the horizon, where that secant diverges, the Kasten-Young value is
   * 37.92 -- the "thirty-eight vertical atmospheres" `sunColorAt` was already written
   * around. A typo in either exponent misses one of the two.
   */
  test('air mass matches the published Kasten-Young values', () => {
    for (const elevation of [30, 45, 60, 90]) {
      expect(airMassAt(elevation)).toBeCloseTo(1 / Math.sin(THREE.MathUtils.degToRad(elevation)), 1);
    }
    expect(airMassAt(0)).toBeCloseTo(37.92, 1);
  });

  /**
   * The opening moment arrives with a sun, because that is what it is authored to be.
   *
   * {@link OPENING_SOLAR_PHASE} resolves to 2.87 degrees under June's declination, 24
   * minutes after sunrise. `DayNightCycle` casts the sun's shadow above a direct factor of
   * 0.05, and the old ramp did not reach that until 4.93 degrees -- 40 minutes in -- so the
   * frame the product opens on had no key light and no shadow, and its night factor was
   * 0.561. Both halves of this would have failed before the retune.
   */
  test('the opening moment is lit by the sun it is authored around', () => {
    const opening = clockFromSolarPhase(OPENING_SOLAR_PHASE, JUNE);
    expect(deg(sunElevationAt(opening, JUNE))).toBeCloseTo(2.87, 1);
    expect(directSunFactorAt(opening, JUNE)).toBeGreaterThan(0.05);
    expect(nightFactorAt(opening, JUNE)).toBeLessThan(0.5);
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: the sunset curve mirrors the sunrise curve', (_label, declination) => {
    for (let offset = 0; offset <= 0.2; offset += 0.01) {
      const morning = clockFromSolarPhase(0.25 + offset, declination);
      const evening = clockFromSolarPhase(0.75 - offset, declination);
      expect(nightFactorAt(morning, declination)).toBeCloseTo(
        nightFactorAt(evening, declination),
        9
      );
    }
  });

  test.each([
    ['June', JUNE],
    ['autumn', AUTUMN],
  ])('%s: golden hour sits near the horizon, not at noon or midnight', (_label, declination) => {
    const at = (phase: number) => goldenFactorAt(clockFromSolarPhase(phase, declination), declination);
    expect(at(0.28)).toBeGreaterThan(0.5);
    expect(at(0.72)).toBeGreaterThan(0.5);
    expect(at(0.5)).toBeLessThan(0.35);
    expect(at(0)).toBe(0);
  });

  /**
   * Written the other way round first, asserting that October keeps the sun in the warm
   * band all day. It does not, and the measurement says so plainly: the golden band is a
   * fixed slice of elevation, and both seasons cross it in about the same time -- 4.4 hours
   * in June against 4.2 in October, because October's shallower climb is cancelled by
   * October's shorter day. What actually separates the seasons is the noon altitude, which
   * the first test already pins.
   */
  test('neither season lingers longer in the golden band than the other', () => {
    const goldenHours = (declination: number) => {
      let total = 0;
      const samples = 20_000;
      for (let i = 0; i < samples; i++) total += goldenFactorAt(i / samples, declination);
      return (total / samples) * 24;
    };
    expect(goldenHours(JUNE)).toBeCloseTo(4.4, 1);
    expect(goldenHours(AUTUMN)).toBeCloseTo(4.2, 1);
  });
});

describe('sky colours', () => {
  test('returns finite RGB at every sample, in both seasons', () => {
    for (const declination of [JUNE, AUTUMN]) {
      for (let i = 0; i <= 40; i++) {
        const color = skyColorAt(i / 40, declination);
        expect(Number.isFinite(color.r)).toBe(true);
        expect(Number.isFinite(color.g)).toBe(true);
        expect(Number.isFinite(color.b)).toBe(true);
      }
    }
  });

  test('clamps inputs outside 0..1 to a safe color rather than NaN', () => {
    expect(Number.isFinite(skyColorAt(-0.5, JUNE).r)).toBe(true);
    expect(Number.isFinite(skyColorAt(1.5, JUNE).r)).toBe(true);
  });

  /**
   * The regression this feature could most easily have shipped.
   *
   * The horizon stops were authored against a sun that always set at 0.75. Keyed on the
   * clock, June would paint the sunset red at 17:53 with the sun still thirteen degrees up;
   * keyed on solar phase, sunset is red whenever sunset is.
   */
  test('the sunset colour lands at sunset in both seasons, not at a fixed hour', () => {
    const juneSunset = skyColorAt(clockFromSolarPhase(0.745, JUNE), JUNE);
    const autumnSunset = skyColorAt(clockFromSolarPhase(0.745, AUTUMN), AUTUMN);
    expect(juneSunset.getHex()).toBe(autumnSunset.getHex());

    // And the same clock time is a different place on the ramp in each season, which is the
    // proof it is no longer clock-keyed: at t=0.745 June is an hour short of sunset and
    // still warm, while October is already past it and into the purple.
    const june = skyColorAt(0.745, JUNE);
    const autumn = skyColorAt(0.745, AUTUMN);
    const luma = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(luma(autumn)).toBeLessThan(luma(june));
  });

  test('sun color is black below the horizon, warm near it, whiter at noon', () => {
    expect(sunColorAt(clockFromSolarPhase(0, JUNE), JUNE).r).toBe(0);
    const sunrise = sunColorAt(clockFromSolarPhase(0.27, JUNE), JUNE);
    const noon = sunColorAt(0.5, JUNE);
    expect(sunrise.r / Math.max(sunrise.b, 1e-6)).toBeGreaterThan(
      noon.r / Math.max(noon.b, 1e-6)
    );
  });

  test('reuses the optional out color so callers can avoid allocations', () => {
    const out = new THREE.Color();
    expect(skyColorAt(0.5, JUNE, out)).toBe(out);
  });
});

describe('render exposure', () => {
  /**
   * The noon ease, pinned to what the frame sampling actually showed.
   *
   * A June sun at 61 degrees put 8.8 per cent of the rendered frame past 245 of 255; a cut of
   * 15 per cent took that to 0.12 per cent while the mean fell only from 151 to 143. October
   * noon at 28 degrees must be untouched by it, and so must every hour outside the middle of
   * a midsummer day.
   */
  test('eases exposure only when the sun is genuinely high', () => {
    const rad = (d: number) => THREE.MathUtils.degToRad(d);
    expect(highSunFactor(rad(28.3))).toBe(0);
    expect(highSunFactor(rad(42.7))).toBe(0);
    expect(highSunFactor(rad(61.2))).toBeCloseTo(1, 2);

    const noon = sceneExposure(0, 0, 1, 0, highSunFactor(rad(61.2)));
    const midMorning = sceneExposure(0, 0, 1, 0, highSunFactor(rad(42.7)));
    expect(noon / midMorning).toBeCloseTo(0.85, 2);
    // Nothing is asserted here about golden hour being darker, though it is: a rendered
    // golden-hour frame means 122 against this noon's 143. That is a fact about the *picture*
    // and the exposure number runs the other way -- golden hour carries a higher multiplier
    // precisely because its sun is weaker. A first draft of this test compared the two
    // multipliers and failed, correctly.
  });

  test('keeps daylight and golden-hour highlights below the old washed-out peak', () => {
    expect(sceneExposure(0, 0)).toBeCloseTo(0.46, 2);
    expect(sceneExposure(0, 1)).toBeCloseTo(0.5, 2);
    expect(sceneExposure(0, 1, 1.07)).toBeLessThan(0.54);
  });

  test('keeps the night legible while preserving a daylight exposure step', () => {
    expect(sceneExposure(1, 0)).toBeGreaterThanOrEqual(0.34);
    expect(sceneExposure(1, 0)).toBeLessThan(sceneExposure(0, 0));
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
