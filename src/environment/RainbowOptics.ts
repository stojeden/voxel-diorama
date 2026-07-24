/**
 * Pure geometrical-optics helpers for rainbows made by spherical water drops.
 *
 * Angles are in radians. `order` is the number of internal reflections:
 * 1 = primary rainbow, 2 = secondary rainbow.
 */

export type RainbowOrder = 1 | 2;
export type LinearRgb = readonly [red: number, green: number, blue: number];

export interface RefractiveIndexSample {
  readonly wavelengthNm: number;
  readonly refractiveIndex: number;
}

export interface RainbowCaustic {
  readonly order: RainbowOrder;
  /** Angle between the incident ray and the drop-surface normal. */
  readonly incidenceAngleRad: number;
  /** Angle inside the water drop, measured from the surface normal. */
  readonly refractionAngleRad: number;
  /** Total ray deviation before folding around the antisolar direction. */
  readonly deviationAngleRad: number;
  /** Observable angular radius around the antisolar direction. */
  readonly angularRadiusRad: number;
}

export interface RainbowRay {
  readonly order: RainbowOrder;
  readonly incidenceAngleRad: number;
  readonly refractionAngleRad: number;
  readonly angularRadiusRad: number;
  readonly throughput: number;
}

export interface RainbowSpectralSample {
  readonly wavelengthNm: number;
  readonly primaryAngleRad: number;
  readonly secondaryAngleRad: number;
  /** Display chromaticity for diagnostics; normalized, not an energy weight. */
  readonly linearRgb: LinearRgb;
  /** D65-weighted CIE response in linear sRGB, retaining relative luminance. */
  readonly spectralLinearRgb: LinearRgb;
  /** Unpolarized Fresnel throughput for the primary ray family. */
  readonly primaryEnergy: number;
  /** Unpolarized Fresnel throughput for the secondary ray family. */
  readonly secondaryEnergy: number;
}

export const WATER_REFRACTIVE_INDEX_SAMPLES: readonly RefractiveIndexSample[] = Object.freeze([
  Object.freeze({ wavelengthNm: 400, refractiveIndex: 1.34319 }),
  Object.freeze({ wavelengthNm: 450, refractiveIndex: 1.33924 }),
  Object.freeze({ wavelengthNm: 500, refractiveIndex: 1.33643 }),
  Object.freeze({ wavelengthNm: 550, refractiveIndex: 1.33432 }),
  Object.freeze({ wavelengthNm: 600, refractiveIndex: 1.33266 }),
  Object.freeze({ wavelengthNm: 650, refractiveIndex: 1.33131 }),
  Object.freeze({ wavelengthNm: 700, refractiveIndex: 1.33016 }),
]);

const MIN_WAVELENGTH_NM = WATER_REFRACTIVE_INDEX_SAMPLES[0].wavelengthNm;
const MAX_WAVELENGTH_NM =
  WATER_REFRACTIVE_INDEX_SAMPLES[WATER_REFRACTIVE_INDEX_SAMPLES.length - 1].wavelengthNm;
const DEFAULT_WAVELENGTH_NM = 550;
const HALF_PI = Math.PI * 0.5;
/** CIE standard illuminant D65, sampled every 10 nm from 400 to 700 nm. */
const D65_RELATIVE_POWER = [
  82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861,
  115.923, 108.811, 109.354, 107.802, 104.79, 107.689, 104.405, 104.046,
  100, 96.3342, 95.788, 88.6856, 90.0062, 89.5991, 87.6987, 83.2886,
  83.6992, 80.0268, 80.2146, 82.2778, 78.2842, 69.7213, 71.6091,
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Relative refractive index of liquid water in air.
 *
 * The tabulated visible-spectrum values are linearly interpolated. Values
 * outside 400–700 nm are clamped because extrapolating this sparse table would
 * invent dispersion data. A non-finite input safely falls back to 550 nm.
 */
export function waterRefractiveIndexAt(wavelengthNm: number): number {
  const wavelength = clamp(
    finiteOr(wavelengthNm, DEFAULT_WAVELENGTH_NM),
    MIN_WAVELENGTH_NM,
    MAX_WAVELENGTH_NM
  );

  for (let index = 1; index < WATER_REFRACTIVE_INDEX_SAMPLES.length; index++) {
    const upper = WATER_REFRACTIVE_INDEX_SAMPLES[index];
    if (wavelength <= upper.wavelengthNm) {
      const lower = WATER_REFRACTIVE_INDEX_SAMPLES[index - 1];
      const fraction =
        (wavelength - lower.wavelengthNm) / (upper.wavelengthNm - lower.wavelengthNm);
      return (
        lower.refractiveIndex +
        (upper.refractiveIndex - lower.refractiveIndex) * fraction
      );
    }
  }

  return WATER_REFRACTIVE_INDEX_SAMPLES[WATER_REFRACTIVE_INDEX_SAMPLES.length - 1]
    .refractiveIndex;
}

/**
 * Stationary-deviation ray responsible for a rainbow caustic.
 *
 * Snell: sin(i) = n sin(r)
 * Stationarity for `order` internal reflections: dr/di = 1 / (order + 1)
 *
 * Combining both removes iterative root finding and produces stable closed
 * forms for the incidence and refraction angles.
 */
export function rainbowCaustic(
  refractiveIndex: number,
  order: RainbowOrder
): RainbowCaustic | null {
  if (!Number.isFinite(refractiveIndex) || refractiveIndex <= 1) return null;

  const raySegments = order + 1;
  const raySegmentsSquared = raySegments * raySegments;
  if (refractiveIndex >= raySegments) return null;

  const denominator = raySegmentsSquared - 1;
  const sineIncidenceSquared =
    (raySegmentsSquared - refractiveIndex * refractiveIndex) / denominator;
  const sineRefractionSquared =
    sineIncidenceSquared / (refractiveIndex * refractiveIndex);

  const incidenceAngleRad = Math.asin(Math.sqrt(clamp(sineIncidenceSquared, 0, 1)));
  const refractionAngleRad = Math.asin(Math.sqrt(clamp(sineRefractionSquared, 0, 1)));
  const deviationAngleRad =
    order * Math.PI +
    2 * incidenceAngleRad -
    2 * raySegments * refractionAngleRad;
  const angularRadiusRad =
    order === 1 ? Math.PI - deviationAngleRad : deviationAngleRad - Math.PI;

  if (
    !Number.isFinite(incidenceAngleRad) ||
    !Number.isFinite(refractionAngleRad) ||
    !Number.isFinite(deviationAngleRad) ||
    !Number.isFinite(angularRadiusRad) ||
    angularRadiusRad <= 0 ||
    angularRadiusRad >= HALF_PI
  ) {
    return null;
  }

  return {
    order,
    incidenceAngleRad,
    refractionAngleRad,
    deviationAngleRad,
    angularRadiusRad,
  };
}

/** Rainbow caustic at a wavelength, using the interpolated water dispersion. */
export function rainbowCausticAt(
  wavelengthNm: number,
  order: RainbowOrder
): RainbowCaustic {
  // The clamped water table is entirely inside the valid physical domain.
  return rainbowCaustic(waterRefractiveIndexAt(wavelengthNm), order)!;
}

/**
 * Horizontal angular offset of either arc endpoint from the antisolar azimuth.
 *
 * On the celestial sphere:
 *   cos(alpha) = cos(sunElevation) cos(deltaAzimuth)
 *
 * Returns `null` when the Sun is not above the horizon, the entire circle is
 * below the horizon, or inputs cannot describe a finite visible rainbow.
 * The two endpoints are at `antisolarAzimuth ± returnedValue`.
 */
export function horizonIntersectionDeltaAzimuth(
  angularRadiusRad: number,
  sunElevationRad: number
): number | null {
  if (
    !Number.isFinite(angularRadiusRad) ||
    !Number.isFinite(sunElevationRad) ||
    angularRadiusRad <= 0 ||
    angularRadiusRad >= HALF_PI ||
    sunElevationRad < 0 ||
    sunElevationRad > angularRadiusRad
  ) {
    return null;
  }

  const denominator = Math.cos(sunElevationRad);
  if (denominator <= 0) return null;

  const cosineDelta = Math.cos(angularRadiusRad) / denominator;
  if (cosineDelta < -1 - Number.EPSILON || cosineDelta > 1 + Number.EPSILON) {
    return null;
  }
  return Math.acos(clamp(cosineDelta, -1, 1));
}

/**
 * Fast analytic approximation of the CIE 1931 2° colour-matching functions,
 * converted to linear sRGB (D65 matrix).
 *
 * A monochromatic spectral colour is commonly outside the sRGB gamut. The raw
 * helper deliberately retains signed channels for spectral integration; the
 * exported diagnostic helper below clips and normalizes only for display.
 */
function wavelengthToLinearSrgbRaw(wavelengthNm: number): LinearRgb {
  const wavelength = clamp(
    finiteOr(wavelengthNm, DEFAULT_WAVELENGTH_NM),
    MIN_WAVELENGTH_NM,
    MAX_WAVELENGTH_NM
  );

  let t1 = (wavelength - 442) * (wavelength < 442 ? 0.0624 : 0.0374);
  let t2 = (wavelength - 599.8) * (wavelength < 599.8 ? 0.0264 : 0.0323);
  let t3 = (wavelength - 501.1) * (wavelength < 501.1 ? 0.049 : 0.0382);
  const x =
    0.362 * Math.exp(-0.5 * t1 * t1) +
    1.056 * Math.exp(-0.5 * t2 * t2) -
    0.065 * Math.exp(-0.5 * t3 * t3);

  t1 = (wavelength - 568.8) * (wavelength < 568.8 ? 0.0213 : 0.0247);
  t2 = (wavelength - 530.9) * (wavelength < 530.9 ? 0.0613 : 0.0322);
  const y = 0.821 * Math.exp(-0.5 * t1 * t1) + 0.286 * Math.exp(-0.5 * t2 * t2);

  t1 = (wavelength - 437) * (wavelength < 437 ? 0.0845 : 0.0278);
  t2 = (wavelength - 459) * (wavelength < 459 ? 0.0385 : 0.0725);
  const z = 1.217 * Math.exp(-0.5 * t1 * t1) + 0.681 * Math.exp(-0.5 * t2 * t2);

  const red = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const green = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const blue = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [red, green, blue];
}

export function wavelengthToLinearSrgb(wavelengthNm: number): LinearRgb {
  const raw = wavelengthToLinearSrgbRaw(wavelengthNm);
  const red = Math.max(0, raw[0]);
  const green = Math.max(0, raw[1]);
  const blue = Math.max(0, raw[2]);
  const peak = Math.max(red, green, blue, Number.EPSILON);
  return Object.freeze([red / peak, green / peak, blue / peak]) as LinearRgb;
}

function fresnelThroughput(
  refractiveIndex: number,
  ray: Pick<
    RainbowCaustic,
    'order' | 'incidenceAngleRad' | 'refractionAngleRad'
  >
): number {
  const cosIncidence = Math.cos(ray.incidenceAngleRad);
  const cosRefraction = Math.cos(ray.refractionAngleRad);
  const rs = (
    (cosIncidence - refractiveIndex * cosRefraction) /
    (cosIncidence + refractiveIndex * cosRefraction)
  ) ** 2;
  const rp = (
    (refractiveIndex * cosIncidence - cosRefraction) /
    (refractiveIndex * cosIncidence + cosRefraction)
  ) ** 2;
  const ts = 1 - rs;
  const tp = 1 - rp;
  return (
    ts * ts * rs ** ray.order +
    tp * tp * rp ** ray.order
  ) * 0.5;
}

/**
 * One geometrical-optics ray through a spherical drop. Sampling
 * `impactParameter²` uniformly gives the correct cross-sectional area measure
 * `2b db`; histogramming these rays therefore recovers the caustic Jacobian
 * without evaluating its singular derivative explicitly.
 */
export function rainbowRayAtImpact(
  wavelengthNm: number,
  order: RainbowOrder,
  impactParameter: number
): RainbowRay | null {
  if (
    !Number.isFinite(impactParameter) ||
    impactParameter < 0 ||
    impactParameter >= 1
  ) {
    return null;
  }
  const refractiveIndex = waterRefractiveIndexAt(wavelengthNm);
  const incidenceAngleRad = Math.asin(impactParameter);
  const refractionAngleRad = Math.asin(impactParameter / refractiveIndex);
  const deviationAngleRad =
    order * Math.PI +
    2 * incidenceAngleRad -
    2 * (order + 1) * refractionAngleRad;
  const angularRadiusRad =
    order === 1
      ? Math.PI - deviationAngleRad
      : deviationAngleRad - Math.PI;
  if (
    !Number.isFinite(angularRadiusRad) ||
    angularRadiusRad <= 0 ||
    angularRadiusRad >= HALF_PI
  ) {
    return null;
  }
  const ray = {
    order,
    incidenceAngleRad,
    refractionAngleRad,
    angularRadiusRad,
  };
  return {
    ...ray,
    throughput: fresnelThroughput(refractiveIndex, ray),
  };
}

function createSpectralSample(
  wavelengthNm: number,
  index: number
): Readonly<RainbowSpectralSample> {
  const refractiveIndex = waterRefractiveIndexAt(wavelengthNm);
  const primary = rainbowCaustic(refractiveIndex, 1)!;
  const secondary = rainbowCaustic(refractiveIndex, 2)!;
  const d65 = D65_RELATIVE_POWER[index] / 100;
  const spectralLinearRgb = wavelengthToLinearSrgbRaw(wavelengthNm)
    .map((channel) => channel * d65) as [number, number, number];
  return Object.freeze({
    wavelengthNm,
    primaryAngleRad: primary.angularRadiusRad,
    secondaryAngleRad: secondary.angularRadiusRad,
    linearRgb: wavelengthToLinearSrgb(wavelengthNm),
    spectralLinearRgb: Object.freeze(spectralLinearRgb),
    primaryEnergy: fresnelThroughput(refractiveIndex, primary),
    secondaryEnergy: fresnelThroughput(refractiveIndex, secondary),
  });
}

/**
 * Precomputed once at module initialization; render loops can consume it
 * without solving optics or allocating colours per frame.
 */
export const RAINBOW_SPECTRAL_SAMPLES: readonly Readonly<RainbowSpectralSample>[] =
  Object.freeze(D65_RELATIVE_POWER.map((_power, index) =>
    createSpectralSample(MIN_WAVELENGTH_NM + index * 10, index)
  ));

export const PRIMARY_RAINBOW_MAX_ANGLE_RAD =
  RAINBOW_SPECTRAL_SAMPLES[RAINBOW_SPECTRAL_SAMPLES.length - 1].primaryAngleRad;
export const SECONDARY_RAINBOW_MAX_ANGLE_RAD =
  RAINBOW_SPECTRAL_SAMPLES[0].secondaryAngleRad;
// The non-caustic secondary branch crosses every angle up to 90°. The grazing
// ray is not its angular supremum, so a horizon gate must use the hemisphere.
export const SECONDARY_RAINBOW_SUPPORT_MAX_ANGLE_RAD = HALF_PI;
