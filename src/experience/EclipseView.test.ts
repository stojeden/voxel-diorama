import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { eclipseViewCameraPosition, eclipseViewClock } from './EclipseView';
import { ECLIPSE_VIEW_SOLAR_PHASE } from './AuthoredMoments';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  sunDirectionAt,
  sunElevationAt,
} from '../environment/sky';

const deg = (radians: number) => THREE.MathUtils.radToDeg(radians);
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
      const declination = THREE.MathUtils.degToRad(declinationDeg);
      const elevation = deg(sunElevationAt(eclipseViewClock(declination), declination));
      expect(elevation).toBeGreaterThan(3);
      expect(elevation).toBeLessThan(10);
    }
  });

  it('reads the sun at the hour the clock is locked to, not at the authored phase', () => {
    // The defect this guards: `focusEclipseView` resolved the phase for the clock but fed it
    // raw to `sunDirectionAt`, so the camera faced a sun two hours from the one lighting it.
    for (const declinationDeg of SEASONS) {
      const declination = THREE.MathUtils.degToRad(declinationDeg);
      const camera = eclipseViewCameraPosition(declination, new THREE.Vector3());
      const sun = sunDirectionAt(eclipseViewClock(declination), declination, new THREE.Vector3());
      const cameraBearing = new THREE.Vector2(camera.x, camera.z).normalize();
      const awayFromSun = new THREE.Vector2(-sun.x, -sun.z).normalize();
      expect(cameraBearing.dot(awayFromSun)).toBeCloseTo(1, 5);
    }
  });

  it('is one authored moment, not a literal repeated per call site', () => {
    const equinox = 0;
    // At the equinox the two axes coincide, which is the only place the raw phase is a valid
    // clock -- and the only place this equality may hold.
    expect(eclipseViewClock(equinox)).toBeCloseTo(ECLIPSE_VIEW_SOLAR_PHASE, 6);
    const june = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG);
    expect(Math.abs(eclipseViewClock(june) - ECLIPSE_VIEW_SOLAR_PHASE) * 24).toBeGreaterThan(1.5);
  });
});
