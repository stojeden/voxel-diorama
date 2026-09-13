import * as THREE from 'three';
import { clamp01, JUNE_DECLINATION_DEG, sunElevationAt } from './sky';
import type { Clock01, Degrees, Radians } from '../units';

/**
 * The viewer's eye, as a multiplier on the authored exposure curve in `sky.ts`.
 *
 * Split out of `sky.ts` rather than added to it: this is atmospheric physics, and it rides the
 * eagerly-loaded `atmosphere-physics` chunk -- the same call `playground` and
 * `experience-signals` record, where growth stays visible instead of hiding behind a bigger
 * entry budget. The entry chunk had 894 bytes free when this arrived and the model is 662 of
 * them; inlined it would have left 232, less headroom than the 531 the last budget raise was
 * granted to escape. The chunk carries its own byte gate in `browserSmoke.mjs`, so the split
 * is not a place to hide.
 */

/**
 * Horizontal illuminance against solar elevation, in lux. Published anchors, log-interpolated.
 *
 * These are the standard figures for a clear sky: full sun overhead is around 110 000 lx, the
 * horizon a few hundred, the end of civil twilight (-6) 3.4, of nautical twilight (-12) 0.008
 * and of astronomical twilight (-18) 0.0006. Eight decades, which is the range the picture
 * has to survive and the shipped exposure curve spans 0.52 stops of.
 *
 * **One table across the whole range, so it is continuous at the horizon by construction.**
 * The obvious first cut -- an air-mass beam above the horizon, twilight anchors below it --
 * steps by a factor of thirty at zero, because almost all of a horizon sun's light is diffuse
 * skylight and a beam term goes to zero there. That is a visible exposure jump on the frame
 * the sun rises in, and {@link adaptingLuminance} is tested for continuity because of it.
 */
const ILLUMINANCE_LUX: readonly (readonly [number, number])[] = [
  [90, 110_000], [60, 88_000], [45, 69_000], [30, 45_000], [20, 27_000], [13, 14_900],
  [6, 4_300], [3, 1_200], [0, 400], [-6, 3.4], [-12, 0.008], [-18, 0.0006],
];

/**
 * What the city gives itself after dark, in lux. A lit residential street, EN 13201 P-class.
 *
 * **This is the physically important term, not a floor to stop a divide by zero.** An observer
 * standing in a lit city at night is not dark-adapted to starlight; they are adapted to the
 * pavement under the lamp. It holds the deepest June midnight at 0.86 cd/m2 -- the high
 * mesopic band, which is what a lit street is -- and so holds the largest gain any hour of any
 * season asks for to 3.7017 against the guard of {@link MAX_ADAPTATION_GAIN}. Without it the
 * gain runs away below the horizon and the small hours come out brighter than noon.
 */
const CITY_LUX = 15;

/**
 * Mean reflectance of the world, bare and under full snow.
 *
 * 0.18 is the standard mid-grey and the right figure for a bare city. Snow is not: fresh snow
 * is 0.80 and bare urban fabric 0.15, and a snow-covered city -- vertical walls, cleared road,
 * lit windows -- is neither. 0.6 is a judgement between two published numbers, and the reason
 * it is here rather than left at a constant is that `night-snow-train` is a frozen checkpoint
 * whose whole premise is `setSnowCover(1)`: a constant 0.18 under-reads the adapting luminance
 * there by a factor of three and opens the eye 17 per cent further than this model's own
 * physics asks, on the brightest world state the product can occupy at night.
 */
const BARE_ALBEDO = 0.18;
const SNOW_ALBEDO = 0.6;

/**
 * How much of the physical log-range survives adaptation. 1 would be a light meter; 0 is the
 * fixed curve this multiplies.
 *
 * **This is the one free parameter in the model and it is not physiology.** Stevens' brightness
 * exponent, applied honestly, says a faithful civil twilight belongs at a few per cent of
 * noon's brightness -- which is the black frame that shipped. The exponent that produces a
 * picture is a property of the display, not of a retina, so it was chosen against a measured
 * criterion instead: the value that most nearly holds the frame's *contrast sensitivity*
 * constant across the day, d(code level)/d(ln scene radiance) at each hour's own operating
 * point. Measured on the built bundle over a seven-point gain sweep at eight elevations, the
 * spread of that sensitivity across the day is 3.39x at 0 (no adaptation), bottoms at 2.55x
 * for 0.10 and 2.62x for 0.125-0.175, and rises again to 3.53x by 0.25. 0.15 sits in the flat
 * region and is the largest value in it, so it buys the most twilight for the least distortion
 * of the day's shape: the presented mean spans 1.74 stops against 12.5 stops of adapting
 * luminance.
 */
const ADAPTATION_EXPONENT = 0.15;

/**
 * A guard, not a knob: no hour of any season the product runs reaches it.
 *
 * The largest gain the real clock asks for is **3.7017**, and not at the hour anyone would
 * guess: an October morning with the sun 7.95 degrees down, where the sky has nearly gone
 * but `night` is still 0.928 and the city has not fully committed to its own lamps. A June
 * solar midnight is 3.68. {@link CITY_LUX} is what bounds both, because the city never goes
 * fully dark. A test sweeps both declinations minute by minute, bare and snow-covered, and
 * asserts nothing touches this, so if a change ever makes it bind the clamp turns into a
 * tuning constant and the test says so rather than the picture.
 */
const MAX_ADAPTATION_GAIN = 4;

/** June noon, the elevation the adaptation gain is normalised against. */
const NOON_ELEVATION_DEG = THREE.MathUtils.radToDeg(
  sunElevationAt(0.5 as Clock01, THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians)
) as Degrees;

function illuminanceLux(elevationDeg: Degrees): number {
  const last = ILLUMINANCE_LUX.length - 1;
  if (elevationDeg >= ILLUMINANCE_LUX[0][0]) return ILLUMINANCE_LUX[0][1];
  for (let i = 0; i < last; i++) {
    const [h0, e0] = ILLUMINANCE_LUX[i];
    const [h1, e1] = ILLUMINANCE_LUX[i + 1];
    if (elevationDeg >= h1) return e0 * Math.pow(e1 / e0, (elevationDeg - h0) / (h1 - h0));
  }
  return ILLUMINANCE_LUX[last][1];
}

/**
 * The luminance the viewer's eye is adapted to, in cd/m2: sky and city, off the ground.
 *
 * Lambertian, so illuminance times reflectance over pi. It is deliberately **not** measured
 * from the rendered frame. The scene buffer is not radiometric -- `DayNightCycle` writes an
 * ambient and a hemisphere term that together span about nine to one from night to noon, so a
 * meter pointed at the frame would be metering the art direction, and its average would be
 * dominated by the third of a twilight frame that is the dead sky dome. This reads the sun
 * geometry the code already owns, which also keeps the exposure a pure function of the clock:
 * no render target, no history, no dependence on where the camera is pointed.
 *
 * `night` carries the city's own lamps and nothing else; it is the same smoothed factor
 * `sceneExposure` already takes, so this adds no filter the exposure did not already
 * have. The solar eclipse is deliberately absent: a totality is about two minutes of world
 * time, roughly a third of a second at this day's compression, against a cone dark-adaptation
 * constant of about 110 s. A retina does not follow it, so neither does this -- the observer
 * during totality is still adapted to the sky they had a minute ago. (The eclipse does reach
 * `night`, which is forced to 0.64 at totality; measured through the lamp term that is 0.135
 * per cent of the adapting luminance and 0.02 per cent of the gain, which is why it is
 * mentioned here and not modelled.)
 */
export function adaptingLuminance(elevationDeg: Degrees, night: number, snowCover = 0): number {
  const albedo = BARE_ALBEDO + (SNOW_ALBEDO - BARE_ALBEDO) * clamp01(snowCover);
  return ((illuminanceLux(elevationDeg) + CITY_LUX * clamp01(night)) * albedo) / Math.PI;
}

/** The reference the gain is normalised against, in cd/m2. Derived, so it cannot drift. */
export const NOON_ADAPTING_LUMINANCE = adaptingLuminance(NOON_ELEVATION_DEG, 0, 0);

/**
 * Incomplete dark adaptation, as a multiplier on `sceneExposure`: 1 at a June noon.
 *
 * The pipeline's physics stays linear and correct and the *viewer* is what gets modelled --
 * which is the honest split, because a photograph of civil twilight taken at a sunset exposure
 * really is black, and what makes twilight look blue to a person is that their eye opened.
 *
 * Clamped at 1 from below on purpose: no hour may be exposed *past* a June noon, so the noon
 * ease in `sceneExposure` is preserved exactly rather than approximately. At the
 * reference elevation this returns exactly 1, and a test pins that identity.
 */
export function viewerAdaptation(adaptingLuminanceCdM2: number): number {
  const gain = Math.pow(
    NOON_ADAPTING_LUMINANCE / Math.max(adaptingLuminanceCdM2, 1e-4),
    ADAPTATION_EXPONENT
  );
  return gain < 1 ? 1 : gain > MAX_ADAPTATION_GAIN ? MAX_ADAPTATION_GAIN : gain;
}
