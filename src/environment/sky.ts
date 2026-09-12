import * as THREE from 'three';
import { beamTransmittanceColor, twilightSkyColorCached } from './SunlightSpectrum';

/** Two degrees below the horizon, the physical twilight hue is fully in. */
const TWILIGHT_BLEND_DEPTH_RAD = THREE.MathUtils.degToRad(2);
/** Scattered light this faint hands the sky back to the authored night colour. */
const TWILIGHT_HANDBACK_BRIGHTNESS = 0.002;
/** How far the blend is allowed to go: the stops keep a say, they were not guesses. */
const TWILIGHT_MAX_BLEND = 0.8;

/**
 * Pure solar/colorimetry helpers for the day/night cycle.
 * Side-effect free so they can be unit-tested.
 *
 * There are two time axes here, and keeping them apart is the whole design.
 *
 * `t` is the **clock**: fraction of the 24-hour day, 0.5 = solar noon. The simulation
 * advances it linearly, so when a season shortens the night the night is genuinely shorter
 * to sit and watch -- not merely relabelled on the HUD.
 *
 * `phase` is the **solar phase**: the canonical 0..1 where 0.25 is sunrise, 0.5 noon and
 * 0.75 sunset, whatever the season did to the clock. Anything authored against the sun
 * rather than against a wall clock belongs on this axis -- the horizon colour ramp below,
 * and every checkpoint whose name is a claim about the light.
 *
 * The two axes coincided exactly until seasons arrived, because the sun used to be a plain
 * sinusoid that rose at 0.25 and set at 0.75 on every day of an eternal year.
 */

/**
 * Warsaw, 52.23 degrees north. The diorama is a Polish town, so the sun is Poland's.
 *
 * Latitude and declination together fix noon altitude, day length and the depth of the
 * night; there is no separate dial for any of them, and there should not be, because in the
 * sky there is not one either.
 */
const LATITUDE = THREE.MathUtils.degToRad(52.23);

/**
 * Solar declination for a day of the year, the standard cosine approximation.
 *
 * Good to a fraction of a degree, which is far finer than a voxel diorama can show. What it
 * does not model: atmospheric refraction (which lifts real sunrise about four minutes early)
 * and the equation of time (which slides solar noon against the wall clock by up to a
 * quarter of an hour). Neither changes the shape of a day here.
 */
export function declinationForDayOfYear(dayOfYear: number): number {
  return THREE.MathUtils.degToRad(-23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365));
}

/** 21 June. Noon altitude 61.2 degrees, day 16.5 hours, full night under four. */
export const JUNE_DECLINATION_DEG = 23.44;
/** 15 October: leaves down, sun low. Noon altitude 28.3 degrees, day 10.3 hours. */
export const AUTUMN_DECLINATION_DEG = -9.5;

/**
 * Hour angle at which the sun crosses the geometric horizon: half the day, in radians.
 *
 * Zero through a polar night and PI through a polar day. Neither happens at 52 degrees, but
 * the callers below divide by this and by its complement, so both ends are clamped away from
 * zero rather than left to produce infinities in a lighting model.
 */
export function sunriseHourAngle(declination: number): number {
  const cosH = -Math.tan(LATITUDE) * Math.tan(declination);
  if (cosH <= -1) return Math.PI;
  if (cosH >= 1) return 0;
  return Math.acos(cosH);
}

const FULL_NIGHT_ELEVATION_DEG = -10;
const FULL_DAY_ELEVATION_DEG = 18;
const DIRECT_SUN_FADE_ELEVATION_DEG = 14;

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function smooth(value: number): number {
  const v = clamp01(value);
  return v * v * (3 - 2 * v);
}

/** Hour angle for a clock time: 0 at solar noon, negative before it. */
function hourAngle(t: number): number {
  return 2 * Math.PI * (clamp01(t) - 0.5);
}

/**
 * Clock time to solar phase: the season stretches the day, this undoes the stretch.
 *
 * Daylight maps onto 0.25..0.75 and darkness onto the two outer quarters, so a colour ramp
 * or a checkpoint written against "just after sunrise" still means that in October, when
 * just after sunrise is two hours later on the clock and the sun climbs half as high.
 */
export function solarPhaseAt(t: number, declination: number): number {
  const H = hourAngle(t);
  const H0 = sunriseHourAngle(declination);
  const day = Math.min(Math.max(H0, 1e-4), Math.PI - 1e-4);
  const night = Math.PI - day;
  if (Math.abs(H) <= day) return 0.5 + 0.25 * (H / day);
  if (H > 0) return 0.75 + 0.25 * ((H - day) / night);
  return 0.25 * ((H + Math.PI) / night);
}

/** Solar phase back to clock time. The inverse of {@link solarPhaseAt}. */
export function clockFromSolarPhase(phase: number, declination: number): number {
  const p = clamp01(phase);
  const H0 = sunriseHourAngle(declination);
  const day = Math.min(Math.max(H0, 1e-4), Math.PI - 1e-4);
  const night = Math.PI - day;
  let H: number;
  if (p >= 0.25 && p <= 0.75) H = day * ((p - 0.5) / 0.25);
  else if (p > 0.75) H = day + ((p - 0.75) / 0.25) * night;
  else H = -Math.PI + (p / 0.25) * night;
  return clamp01(0.5 + H / (2 * Math.PI));
}

/**
 * Sun elevation in radians at a clock time. Positive = above horizon.
 *
 * The spherical triangle, not a sinusoid: declination and latitude set the noon altitude and
 * the horizon crossings together, which is why a June night here bottoms out near -14 degrees
 * and never reaches the -18 of astronomical darkness. Poland in June genuinely has no
 * astronomical night, and the diorama should not pretend otherwise.
 */
export function sunElevationAt(t: number, declination: number): number {
  const H = hourAngle(t);
  const sinAlt =
    Math.sin(LATITUDE) * Math.sin(declination) +
    Math.cos(LATITUDE) * Math.cos(declination) * Math.cos(H);
  return Math.asin(Math.min(1, Math.max(-1, sinAlt)));
}

/**
 * Unit direction vector pointing FROM the scene TOWARD the sun.
 * Sunrise in the +X "east", noon toward +Z, sunset at -X.
 *
 * +Z is therefore south, which is where a northern-hemisphere noon sun stands. The seasonal
 * model keeps that: what changes with declination is how high it gets and how far north of
 * east it rises, which is the part that makes an October afternoon read as October.
 */
export function sunDirectionAt(
  t: number,
  declination: number,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  const H = hourAngle(t);
  const sinD = Math.sin(declination);
  const cosD = Math.cos(declination);
  const sinP = Math.sin(LATITUDE);
  const cosP = Math.cos(LATITUDE);
  return out
    .set(
      -cosD * Math.sin(H),
      sinD * sinP + cosD * cosP * Math.cos(H),
      cosD * sinP * Math.cos(H) - sinD * cosP
    )
    .normalize();
}

/** 1 deep at night, 0 in full daylight, smooth twilight band in between. */
export function nightFactorAt(t: number, declination: number): number {
  const elevationDeg = THREE.MathUtils.radToDeg(sunElevationAt(t, declination));
  return 1 - smooth(
    (elevationDeg - FULL_NIGHT_ELEVATION_DEG) /
      (FULL_DAY_ELEVATION_DEG - FULL_NIGHT_ELEVATION_DEG)
  );
}

/**
 * Direct sunlight ramps in more slowly than the solar disc crosses the horizon.
 * This keeps the first shadowed frame from reading as an abrupt light switch.
 */
export function directSunFactorAt(t: number, declination: number): number {
  const elevation = sunElevationAt(t, declination);
  const elevationDeg = THREE.MathUtils.radToDeg(elevation);
  const altitudeStrength = Math.pow(clamp01(Math.sin(elevation) * 1.5), 0.85);
  const horizonFade = smooth(elevationDeg / DIRECT_SUN_FADE_ELEVATION_DEG);
  return altitudeStrength * horizonFade;
}

/**
 * Golden-hour factor: peaks while the sun sits low above the horizon
 * (sunrise & sunset), zero at night and at high noon.
 */
export function goldenFactorAt(t: number, declination: number): number {
  const elevationDeg = THREE.MathUtils.radToDeg(sunElevationAt(t, declination));
  if (elevationDeg < -6) return 0;
  const lowSun = 1 - smooth((elevationDeg - 4) / 22); // fades out above ~26°
  const aboveHorizon = smooth((elevationDeg + 6) / 8); // fades in from -6°
  return clamp01(lowSun * aboveHorizon);
}

/** Exposure curve with highlight headroom for pale concrete and snow. */
export function sceneExposure(
  night: number,
  golden: number,
  themeMultiplier = 1,
  eclipse = 0
): number {
  const day = 1 - clamp01(night);
  return (
    (0.34 + day * 0.12 + clamp01(golden) * 0.04) *
    themeMultiplier *
    (1 - clamp01(eclipse) * 0.18)
  );
}

/** Bloom remains atmospheric at night without washing out sunlit facades. */
export function sceneBloomStrength(night: number, golden: number, themeMultiplier = 1): number {
  return (0.08 + clamp01(night) * 0.38 + clamp01(golden) * 0.04) * themeMultiplier;
}

interface ColorStop {
  time: number;
  color: THREE.Color;
}

/**
 * Horizon/fog colour over the day — richer than the sky shader's zenith.
 *
 * Keyed on **solar phase**, not on the clock. These stops were authored against a sun that
 * always set at 0.75, and the red one at 0.745 is a sunset: read against a June clock it
 * would turn the sky red in the middle of the afternoon, with the sun still thirteen degrees
 * up. On the phase axis it stays where it was written -- at sunset, whenever the season puts
 * sunset.
 */
const FOG_STOPS: ColorStop[] = [
  { time: 0.0, color: new THREE.Color(0x0d1024) },
  { time: 0.19, color: new THREE.Color(0x131233) },
  { time: 0.235, color: new THREE.Color(0x57375a) },
  { time: 0.27, color: new THREE.Color(0xe07b4a) },
  { time: 0.32, color: new THREE.Color(0xf2b27a) },
  { time: 0.4, color: new THREE.Color(0xbcd6ea) },
  { time: 0.5, color: new THREE.Color(0xa9cce6) },
  { time: 0.6, color: new THREE.Color(0xbcd6ea) },
  { time: 0.69, color: new THREE.Color(0xf0a868) },
  { time: 0.745, color: new THREE.Color(0xd96a45) },
  { time: 0.785, color: new THREE.Color(0x5e3a63) },
  { time: 0.83, color: new THREE.Color(0x16143a) },
  { time: 1.0, color: new THREE.Color(0x0d1024) },
];

export function skyColorAt(
  t: number,
  declination: number,
  out: THREE.Color = new THREE.Color()
): THREE.Color {
  const clamped = solarPhaseAt(t, declination);
  let lower = FOG_STOPS[0];
  let upper = FOG_STOPS[FOG_STOPS.length - 1];
  for (let i = 0; i < FOG_STOPS.length - 1; i++) {
    if (clamped >= FOG_STOPS[i].time && clamped <= FOG_STOPS[i + 1].time) {
      lower = FOG_STOPS[i];
      upper = FOG_STOPS[i + 1];
      break;
    }
  }
  const range = upper.time - lower.time;
  const frac = range > 0 ? (clamped - lower.time) / range : 0;
  out.lerpColors(lower.color, upper.color, smooth(frac));

  /**
   * Below the horizon, take the hue from the atmosphere and keep the brightness from the art.
   *
   * The stops were chosen by eye and they are good; what they cannot know is *why* twilight
   * is the colour it is, which is ozone. So the physical model supplies chromaticity only:
   * it is rescaled to the stop's own luminance before the blend, because it is normalised to
   * its brightest channel and would otherwise light the night sky up like noon.
   *
   * The blend fades in over the first two degrees below the horizon and fades back out as
   * the scattered light collapses past civil twilight -- by then there is nothing left for
   * single scattering to describe, and the table's own night colour is the better answer.
   */
  const elevation = sunElevationAt(t, declination);
  if (elevation >= 0) return out;
  const twilight = twilightSkyColorCached(elevation);
  const depth = clamp01(-elevation / TWILIGHT_BLEND_DEPTH_RAD);
  const lit = clamp01(twilight.relativeBrightness / TWILIGHT_HANDBACK_BRIGHTNESS);
  const weight = depth * lit * TWILIGHT_MAX_BLEND;
  if (weight <= 0) return out;

  const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [pr, pg, pb] = twilight.color;
  const physicalLuma = Math.max(luminance(pr, pg, pb), 1e-6);
  const stopLuma = luminance(out.r, out.g, out.b);
  const scale = stopLuma / physicalLuma;
  out.setRGB(
    out.r + (pr * scale - out.r) * weight,
    out.g + (pg * scale - out.g) * weight,
    out.b + (pb * scale - out.b) * weight,
    THREE.LinearSRGBColorSpace
  );
  return out;
}

const BLACK = new THREE.Color(0x000000);

/** The sun's altitude at solar noon: 90 degrees minus the gap between latitude and declination. */
export function noonElevation(declination: number): number {
  return Math.PI / 2 - Math.abs(LATITUDE - declination);
}

/**
 * Direct sunlight colour, from the atmosphere rather than from two hand-picked endpoints.
 *
 * This used to interpolate between a chosen orange and a chosen off-white by elevation. It
 * now asks {@link beamTransmittanceColor} what the atmosphere does to the spectrum along the
 * actual path: Rayleigh scattering over the Kasten-Young air mass, ozone over its own, and
 * aerosol. At sixty degrees that is a near-neutral white; on the horizon, where the beam
 * crosses thirty-eight vertical atmospheres, blue is gone by four orders of magnitude and
 * what is left is the red of a real sunset.
 *
 * Normalised to its brightest channel, because this is a *colour*: the brightness of direct
 * sun is already owned by `directSunFactorAt` and the exposure curve, and returning an
 * unnormalised transmittance here would dim the sun twice.
 */
export function sunColorAt(
  t: number,
  declination: number,
  out: THREE.Color = new THREE.Color()
): THREE.Color {
  const elevation = sunElevationAt(t, declination);
  if (elevation <= 0) return out.copy(BLACK);
  const [r, g, b] = beamTransmittanceColor(elevation);
  const peak = Math.max(r, g, b, 1e-9);
  return out.setRGB(r / peak, g / peak, b / peak, THREE.LinearSRGBColorSpace);
}

export interface RealSunTimes {
  sunrise: Date;
  solarNoon: Date;
  sunset: Date;
}

/**
 * Map a real wall-clock instant onto the simulated 0..1 day so that the
 * REAL sunrise lands on t=0.25, solar noon on t=0.5 and sunset on t=0.75.
 * Falls back to plain fraction-of-day when times are invalid (polar nights).
 */
export function realTimeToCycleT(now: Date, times: RealSunTimes): number {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayMs = 24 * 3600 * 1000;
  const frac = (now.getTime() - dayStart.getTime()) / dayMs;

  const sr = times.sunrise?.getTime?.();
  const noon = times.solarNoon?.getTime?.();
  const ss = times.sunset?.getTime?.();
  if (!sr || !noon || !ss || Number.isNaN(sr) || Number.isNaN(noon) || Number.isNaN(ss)) {
    return clamp01(frac);
  }

  const nowMs = now.getTime();
  const startMs = dayStart.getTime();
  const endMs = startMs + dayMs;

  const lerpSeg = (x: number, x0: number, x1: number, y0: number, y1: number) =>
    y0 + ((x - x0) / Math.max(x1 - x0, 1)) * (y1 - y0);

  if (nowMs < sr) return clamp01(lerpSeg(nowMs, startMs, sr, 0, 0.25));
  if (nowMs < noon) return clamp01(lerpSeg(nowMs, sr, noon, 0.25, 0.5));
  if (nowMs < ss) return clamp01(lerpSeg(nowMs, noon, ss, 0.5, 0.75));
  return clamp01(lerpSeg(nowMs, ss, endMs, 0.75, 1));
}
