import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ECLIPSE_CLOCK_SPAN,
  eclipseClockApproach,
  eclipseClockAt,
  eclipseViewCameraPosition,
  eclipseViewClock,
} from './EclipseView';
import { ECLIPSE_VIEW_SOLAR_PHASE } from './AuthoredMoments';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  sunDirectionAt,
  sunElevationAt,
} from '../environment/sky';
import type { Radians } from '../units';
import { radians } from '../units.testing';

const deg = (value: Radians) => THREE.MathUtils.radToDeg(value);
const SEASONS = [JUNE_DECLINATION_DEG, AUTUMN_DECLINATION_DEG, 0, -23.44];

/**
 * The staged eclipse, checked against the sky rather than against the literal.
 *
 * The shot is composed for a low, late sun the corona can stand clear of. That is a claim
 * about elevation, so elevation is what is asserted -- and it is what fails if the authored
 * moment is ever read as a clock again: under June's declination that reading puts the sun
 * 25.9 degrees up, high afternoon, and in December it puts it below the horizon.
 */
describe('the staged eclipse view', () => {
  it('stands the sun low in the sky, in every season', () => {
    for (const declinationDeg of SEASONS) {
      const declination = radians(THREE.MathUtils.degToRad(declinationDeg));
      const elevation = deg(sunElevationAt(eclipseViewClock(declination), declination));
      expect(elevation).toBeGreaterThan(3);
      expect(elevation).toBeLessThan(10);
    }
  });

  it('reads the sun at the hour the clock is locked to, not at the authored phase', () => {
    // The defect this guards: `focusEclipseView` resolved the phase for the clock but fed it
    // raw to `sunDirectionAt`, so the camera faced a sun two hours from the one lighting it.
    for (const declinationDeg of SEASONS) {
      const declination = radians(THREE.MathUtils.degToRad(declinationDeg));
      const camera = eclipseViewCameraPosition(declination, new THREE.Vector3());
      const sun = sunDirectionAt(eclipseViewClock(declination), declination, new THREE.Vector3());
      const cameraBearing = new THREE.Vector2(camera.x, camera.z).normalize();
      const awayFromSun = new THREE.Vector2(-sun.x, -sun.z).normalize();
      expect(cameraBearing.dot(awayFromSun)).toBeCloseTo(1, 5);
    }
  });

  it('is one authored moment, not a literal repeated per call site', () => {
    const equinox = radians(0);
    // At the equinox the two axes coincide, which is the only place the raw phase is a valid
    // clock -- and the only place this equality may hold.
    expect(eclipseViewClock(equinox)).toBeCloseTo(ECLIPSE_VIEW_SOLAR_PHASE, 6);
    const june = radians(THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG));
    expect(Math.abs(eclipseViewClock(june) - ECLIPSE_VIEW_SOLAR_PHASE) * 24).toBeGreaterThan(1.5);
  });
});

describe('a natural eclipse carries the clock to its hour', () => {
  const june = radians(THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG));
  const target = eclipseViewClock(june);
  const clock = (t: number) => t as ReturnType<typeof eclipseViewClock>;
  /** Signed shortest distance round the dial. */
  const around = (a: number, b: number) => {
    const d = b - a;
    return d - Math.round(d);
  };

  /** Run the trip at the actor-free 60 Hz the clock actually steps at, and record it. */
  const trip = (from: number) => {
    const path: number[] = [];
    for (let elapsed = 0; elapsed < 10; elapsed += 1 / 60) {
      const step = eclipseClockApproach(clock(from), target, elapsed);
      path.push(step.t01);
      if (step.done) return { path, seconds: elapsed };
    }
    throw new Error('never arrived');
  };

  it('ends exactly on the staged hour', () => {
    for (const from of [0.3, 0.45, 0.6, 0.79, 0.81, 0.95]) {
      const { path } = trip(from);
      expect(path[path.length - 1]).toBe(target);
    }
  });

  it('never cuts: no frame moves the sun more than a few minutes of clock', () => {
    // The old pin moved it up to twelve hours in one frame. Half a day in five eased seconds
    // peaks at 1.5x the average rate: 0.5 / 300 frames x 1.5 = 0.0025 of a day, 3.6 minutes.
    for (const from of [0.3, 0.45, 0.6]) {
      const { path } = trip(from);
      let worst = Math.abs(around(from, path[0]));
      for (let i = 1; i < path.length; i++) worst = Math.max(worst, Math.abs(around(path[i - 1], path[i])));
      expect(worst, `a cut from ${from}`).toBeLessThan(0.003);
    }
  });

  it('goes the short way round the dial, and always in the same direction', () => {
    // From the morning it runs forward through the afternoon, not back through the night.
    for (const from of [0.3, 0.6, 0.95]) {
      const { path } = trip(from);
      const direction = Math.sign(around(from, target));
      let previous = from;
      for (const t of path) {
        const step = around(previous, t);
        expect(step * direction, `turned back on the way from ${from}`).toBeGreaterThanOrEqual(0);
        previous = t;
      }
    }
  });

  it('takes longer for a longer way, within bounds', () => {
    const far = trip(target - 0.45).seconds;
    const near = trip(target - 0.01).seconds;
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(5.02);
    expect(near).toBeGreaterThanOrEqual(1.5);
  });
});

describe('the clock runs through the eclipse', () => {
  const seasons = [
    ['June', radians(THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG))],
    ['autumn', radians(THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG))],
  ] as const;

  it.each(seasons)('%s: totality lands on the authored hour, and the hour keeps moving', (_label, declination) => {
    expect(eclipseClockAt(declination, 0.5)).toBeCloseTo(eclipseViewClock(declination), 12);
    let previous = eclipseClockAt(declination, 0);
    for (let p = 0.01; p <= 1.0001; p += 0.01) {
      const t = eclipseClockAt(declination, p);
      expect(t, 'the clock stood still or ran backwards').toBeGreaterThan(previous);
      previous = t;
    }
    expect(eclipseClockAt(declination, 1) - eclipseClockAt(declination, 0)).toBeCloseTo(ECLIPSE_CLOCK_SPAN, 12);
  });

  it.each(seasons)('%s: the sun is still up at last contact', (_label, declination) => {
    // At the normal pace the 96 s eclipse would be 9.6 hours of clock and end in the night.
    const end = sunElevationAt(eclipseClockAt(declination, 1), declination);
    expect(THREE.MathUtils.radToDeg(end), 'the sun sets before the eclipse is over').toBeGreaterThan(1.5);
  });
});

