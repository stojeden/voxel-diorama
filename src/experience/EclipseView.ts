import * as THREE from 'three';
import { clockFromSolarPhase, sunDirectionAt } from '../environment/sky';
import { ECLIPSE_VIEW_SOLAR_PHASE } from './AuthoredMoments';

/**
 * The one place the staged eclipse's authored moment becomes a clock and a camera.
 *
 * `focusEclipseView` used to resolve the phase twice -- once through `clockFromSolarPhase`
 * for the checkpoint that froze the shot, and once raw into `sunDirectionAt` for the camera
 * -- which put the camera opposite a sun two hours from the one the scene was lit by. There
 * is one conversion here and both callers share it, so the two cannot drift apart again.
 */

/** Distance from the town centre the eclipse shot is taken from, in metres. */
const ECLIPSE_VIEW_DISTANCE = 148;
/** Camera height for the eclipse shot, in metres. */
const ECLIPSE_VIEW_HEIGHT = 46;

const scratchSun = new THREE.Vector3();

/**
 * Clock time (`t01`) of the staged eclipse under a given declination.
 *
 * Everything that means "the eclipse hour" -- the experience clock, the shader warm-up, the
 * camera below -- asks this, never {@link ECLIPSE_VIEW_SOLAR_PHASE} directly.
 */
export function eclipseViewClock(declination: number): number {
  return clockFromSolarPhase(ECLIPSE_VIEW_SOLAR_PHASE, declination);
}

/**
 * Where the camera stands for the staged eclipse: directly opposite the sun, so the eclipsed
 * disc sits over the town rather than behind the viewer.
 *
 * The sun is read at {@link eclipseViewClock}, which is the same hour the clock is locked to.
 */
export function eclipseViewCameraPosition(
  declination: number,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  const sun = sunDirectionAt(eclipseViewClock(declination), declination, scratchSun);
  out.set(-sun.x, 0, -sun.z).normalize().multiplyScalar(ECLIPSE_VIEW_DISTANCE);
  out.y = ECLIPSE_VIEW_HEIGHT;
  return out;
}
