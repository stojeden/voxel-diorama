import * as THREE from 'three';
import { clockFromSolarPhase, sunDirectionAt } from '../environment/sky';
import { ECLIPSE_VIEW_SOLAR_PHASE } from './AuthoredMoments';
import type { Clock01, Radians } from '../units';

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
export function eclipseViewClock(declination: Radians): Clock01 {
  return clockFromSolarPhase(ECLIPSE_VIEW_SOLAR_PHASE, declination);
}

/**
 * Where the camera stands for the staged eclipse: directly opposite the sun, so the eclipsed
 * disc sits over the town rather than behind the viewer.
 *
 * The sun is read at {@link eclipseViewClock}, which is the same hour the clock is locked to.
 */
export function eclipseViewCameraPosition(
  declination: Radians,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  const sun = sunDirectionAt(eclipseViewClock(declination), declination, scratchSun);
  out.set(-sun.x, 0, -sun.z).normalize().multiplyScalar(ECLIPSE_VIEW_DISTANCE);
  out.y = ECLIPSE_VIEW_HEIGHT;
  return out;
}

/**
 * How much clock the whole compressed eclipse spans: one hour, centred on totality.
 *
 * The clock used to stop for the eclipse's 96 seconds. It cannot simply keep its normal pace:
 * a day is 240 seconds, so 96 seconds is 9.6 hours of clock and the sun would set halfway to
 * totality. One hour keeps it moving where a viewer can see it -- the minutes tick every couple
 * of seconds and the sun sinks from about 13 to about 5 degrees under the June declination --
 * while totality still falls exactly on the hour the eclipse's light was authored at.
 */
export const ECLIPSE_CLOCK_SPAN = 1 / 24;

/**
 * The clock at a given point of the eclipse timeline: {@link eclipseViewClock} at totality
 * (progress 0.5), half an hour either side at first and last contact.
 */
export function eclipseClockAt(declination: Radians, progress: number): Clock01 {
  const t = eclipseViewClock(declination) + (THREE.MathUtils.clamp(progress, 0, 1) - 0.5) * ECLIPSE_CLOCK_SPAN;
  return (t - Math.floor(t)) as Clock01;
}

/** The longest and shortest a natural eclipse spends carrying the clock to its hour. */
const APPROACH_MAX_SECONDS = 5;
const APPROACH_MIN_SECONDS = 1.5;

/**
 * Carry the clock to where the eclipse begins instead of cutting to it.
 *
 * A natural eclipse fires at whatever hour its day's schedule picked, and the eclipse is only
 * authored -- light, sky, totality -- at {@link eclipseViewClock}. The clock used to be pinned
 * there on the next frame: up to twelve hours in one frame, the sun jumping across the sky and
 * every shadow with it. Now it travels, the short way round the dial, eased in and out, in a
 * time that grows with the distance: five seconds for half a day, a second and a half for a
 * nudge. The caller holds the eclipse itself at its first frame until `done`.
 *
 * `elapsed` is simulation seconds since the eclipse started; `target` is re-read every frame so
 * a theme fading to a new season moves the destination rather than being overshot.
 */
export function eclipseClockApproach(
  from: Clock01,
  target: Clock01,
  elapsed: number
): { t01: Clock01; done: boolean } {
  let distance = target - from;
  distance -= Math.round(distance);
  const duration =
    APPROACH_MIN_SECONDS +
    (APPROACH_MAX_SECONDS - APPROACH_MIN_SECONDS) * Math.min(1, Math.abs(distance) / 0.5);
  const k = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
  if (k >= 1) return { t01: target, done: true };
  const eased = k * k * (3 - 2 * k);
  const t = from + distance * eased;
  return { t01: (t - Math.floor(t)) as Clock01, done: false };
}
