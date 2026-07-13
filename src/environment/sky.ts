import * as THREE from 'three';

/**
 * Pure solar/colorimetry helpers for the day/night cycle.
 * Side-effect free so they can be unit-tested.
 *
 * Time domain `t` is normalized 0..1, where:
 *   0.00 = midnight, 0.25 = sunrise, 0.50 = solar noon, 0.75 = sunset.
 */

const MAX_SUN_ELEVATION = THREE.MathUtils.degToRad(58);
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

/** Sun elevation in radians. Positive = above horizon. */
export function sunElevationAt(t: number): number {
  return MAX_SUN_ELEVATION * Math.sin(2 * Math.PI * (clamp01(t) - 0.25));
}

/**
 * Unit direction vector pointing FROM the scene TOWARD the sun.
 * Sunrise in the +X "east", noon toward +Z, sunset at -X.
 */
export function sunDirectionAt(t: number, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
  const elevation = sunElevationAt(t);
  const azimuth = Math.PI / 2 - 2 * Math.PI * (clamp01(t) - 0.25);
  const cosE = Math.cos(elevation);
  return out.set(cosE * Math.sin(azimuth), Math.sin(elevation), cosE * Math.cos(azimuth)).normalize();
}

/** 1 deep at night, 0 in full daylight, smooth twilight band in between. */
export function nightFactorAt(t: number): number {
  const elevationDeg = THREE.MathUtils.radToDeg(sunElevationAt(t));
  return 1 - smooth(
    (elevationDeg - FULL_NIGHT_ELEVATION_DEG) /
      (FULL_DAY_ELEVATION_DEG - FULL_NIGHT_ELEVATION_DEG)
  );
}

/**
 * Direct sunlight ramps in more slowly than the solar disc crosses the horizon.
 * This keeps the first shadowed frame from reading as an abrupt light switch.
 */
export function directSunFactorAt(t: number): number {
  const elevation = sunElevationAt(t);
  const elevationDeg = THREE.MathUtils.radToDeg(elevation);
  const altitudeStrength = Math.pow(clamp01(Math.sin(elevation) * 1.5), 0.85);
  const horizonFade = smooth(elevationDeg / DIRECT_SUN_FADE_ELEVATION_DEG);
  return altitudeStrength * horizonFade;
}

/**
 * Golden-hour factor: peaks while the sun sits low above the horizon
 * (sunrise & sunset), zero at night and at high noon.
 */
export function goldenFactorAt(t: number): number {
  const elevationDeg = THREE.MathUtils.radToDeg(sunElevationAt(t));
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
    (1 - clamp01(eclipse) * 0.68)
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

/** Horizon/fog colour over the day — richer than the sky shader's zenith. */
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

export function skyColorAt(t: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  const clamped = clamp01(t);
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
  return out.lerpColors(lower.color, upper.color, smooth(frac));
}

const SUN_WARM = new THREE.Color(0xff7a33);
const SUN_COOL = new THREE.Color(0xfff2dd);
const BLACK = new THREE.Color(0x000000);

/** Direct sunlight colour: deep warm near the horizon, near-white at noon. */
export function sunColorAt(t: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  const elevation = sunElevationAt(t);
  if (elevation <= 0) return out.copy(BLACK);
  const high = clamp01(elevation / MAX_SUN_ELEVATION);
  return out.lerpColors(SUN_WARM, SUN_COOL, smooth(Math.min(high * 1.8, 1)));
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
