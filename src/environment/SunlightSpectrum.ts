import { wavelengthToLinearSrgb, type LinearRgb } from './RainbowOptics';

/**
 * Why sunrise is red and why twilight is blue, computed rather than picked.
 *
 * The diorama used to cross-fade between two hand-chosen colours for the sun and to read the
 * horizon out of a table of thirteen hand-chosen stops. Both looked broadly right and neither
 * could be interrogated: there was no answer to "why is it that colour at that moment" beyond
 * "somebody liked it". This module answers it from the two absorbers that actually decide the
 * matter, the same way `RainbowOptics` answers the rainbow from Snell's law.
 *
 * **Rayleigh scattering** removes short wavelengths from the direct beam in proportion to
 * roughly one over the fourth power of wavelength. It is why the low sun is red: at the
 * horizon the beam crosses about 38 times the vertical air column, and blue is extinguished
 * by nearly four orders of magnitude while red survives at fifteen percent.
 *
 * **Ozone**, absorbing across 400-650 nm in the Chappuis band, is the part every naive sky
 * model misses, and it is the reason twilight is *blue*. Rayleigh scattering alone cannot
 * make a blue twilight, because by then the illuminating beam has had its blue scattered
 * away; Hulburt showed in 1953 that the blue of the sunset zenith is about one third Rayleigh
 * and two thirds ozone, and that deeper into twilight ozone dominates outright. Without it
 * the twilight sky would be pale green or straw yellow. That claim is not decoration here --
 * it is asserted as a test.
 *
 * The geometry that makes ozone win is the tangent ray. Once the sun is below the horizon the
 * light reaching the observer has grazed the Earth, and its lowest point climbs with the
 * depression angle: about 4 km at 2 degrees, 35 km at 6, 140 km at 12. Through most of civil
 * twilight that path lies squarely in the ozone layer, and a grazing path samples tens of
 * times the vertical ozone column.
 *
 * Sources:
 *   - Hulburt, "Explanation of the Brightness and Color of the Sky, Particularly the Twilight
 *     Sky", JOSA 43(2):113 (1953) -- the one-third/two-thirds result.
 *   - Kasten & Young, "Revised optical air mass tables and approximation formula",
 *     Applied Optics 28(22):4735 (1989) -- the air-mass formula below.
 *   - Bennett, "The Calculation of Astronomical Refraction in Marine Navigation",
 *     Journal of Navigation 35(2):255 (1982) -- the refraction formula below.
 *   - Chappuis band peak: 5.23e-21 cm^2/molecule at 603 nm, secondary 4.83e-21 at 575 nm.
 *
 * Angles are radians; wavelengths nanometres; cross-sections cm^2 per molecule.
 */

/** Mean Earth radius, km. Only the ratio to layer heights matters here. */
const EARTH_RADIUS_KM = 6371;
/** Centre of the ozone layer, km. */
const OZONE_PEAK_KM = 22;
/** Gaussian width of the ozone layer, km. */
const OZONE_SCALE_KM = 5;
/** 1 Dobson unit = 2.687e16 molecules per cm^2. A standard mid-latitude column is 300 DU. */
export const DOBSON_UNIT_MOLECULES_PER_CM2 = 2.687e16;
export const DEFAULT_OZONE_DOBSON = 300;

/**
 * Rayleigh optical depth of the whole vertical atmosphere at sea level.
 *
 * The standard approximation in micrometres; the leading term is the familiar inverse fourth
 * power and the bracket is the dispersion correction. It returns 0.0973 at 550 nm, which is
 * the textbook value, and that is what the unit test pins.
 */
export function rayleighOpticalDepth(wavelengthNm: number): number {
  const um = wavelengthNm / 1000;
  const inv2 = 1 / (um * um);
  const inv4 = inv2 * inv2;
  return 0.008569 * inv4 * (1 + 0.0113 * inv2 + 0.00013 * inv4);
}

/**
 * Ozone Chappuis absorption cross-section, cm^2 per molecule.
 *
 * A two-lobe fit to the published band rather than measured data: the continuum runs from
 * about 400 to 650 nm with its maximum at 603 nm and a second, slightly smaller maximum at
 * 575 nm. Three-digit accuracy is not the point -- the *shape* is, because it is the shape
 * that eats orange and green out of a grazing beam and leaves blue behind.
 */
export function ozoneCrossSection(wavelengthNm: number): number {
  const lobe = (centre: number, width: number, peak: number) => {
    const d = (wavelengthNm - centre) / width;
    return peak * Math.exp(-0.5 * d * d);
  };
  return lobe(603, 48, 5.23e-21) + lobe(575, 32, 1.9e-21) + lobe(500, 40, 0.9e-21);
}

/**
 * Relative optical air mass, Kasten & Young (1989).
 *
 * Secant of the zenith angle would reach infinity at the horizon; this does not, because the
 * atmosphere is a shell and not a slab. It peaks near 38 at the horizon, which is the number
 * that turns the setting sun red.
 */
export function airMass(apparentElevationRad: number): number {
  const elevationDeg = (apparentElevationRad * 180) / Math.PI;
  const zenithDeg = 90 - elevationDeg;
  if (zenithDeg >= 96.07995) return 40;
  const z = (zenithDeg * Math.PI) / 180;
  return 1 / (Math.cos(z) + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));
}

/**
 * Atmospheric refraction at a true elevation, radians. Bennett (1982).
 *
 * About 34 arcminutes at the horizon, which is why the sun is already geometrically below it
 * when its lower limb appears to touch: 34 minutes of refraction plus 16 of solar radius is
 * the 0.833 degrees that defines sunrise.
 */
export function refractionRad(trueElevationRad: number): number {
  const h = (trueElevationRad * 180) / Math.PI;
  const arcminutes = 1 / Math.tan(((h + 7.31 / (h + 4.4)) * Math.PI) / 180);
  return ((Math.max(arcminutes, 0) / 60) * Math.PI) / 180;
}

/** Apparent elevation of a body whose true elevation is given: refraction lifts it. */
export function apparentElevation(trueElevationRad: number): number {
  return trueElevationRad + refractionRad(trueElevationRad);
}

/**
 * Height of the lowest point of the ray that reaches the observer, km.
 *
 * Above the horizon there is no grazing and the answer is zero. Below it, the ray has crossed
 * the terminator and its tangent height climbs as the secant of the depression -- the number
 * that decides whether twilight light has been through the ozone layer or over it.
 */
export function tangentRayHeightKm(elevationRad: number): number {
  if (elevationRad >= 0) return 0;
  return EARTH_RADIUS_KM * (1 / Math.cos(elevationRad) - 1);
}

/** Scale height of the air density profile, km. */
const AIR_SCALE_KM = 8;

/**
 * Slant column along a tangent ray, as a multiple of the vertical column.
 *
 * Integrated numerically rather than approximated, because the approximation is where the
 * first attempt went wrong: it used the *surface* air mass for a ray whose lowest point is
 * twenty kilometres up, and produced a red twilight at every depression angle.
 *
 * A ray that grazes the Earth at height `tangentKm` passes through points at height
 * sqrt((R+h)^2 + s^2) - R, so the integral is over the chord and the profile decides the
 * rest. For air it gives about 70 times the vertical column at the ground -- twice the
 * surface air mass, since the ray crosses the dense atmosphere on both sides of the tangent
 * -- falling to six times at twenty kilometres. **That fall is why twilight exists at all:**
 * the beam that lights the sky after sunset survives because it never comes near the ground.
 */
function tangentSlantFactor(tangentKm: number, density: (heightKm: number) => number): number {
  const radius = EARTH_RADIUS_KM + tangentKm;
  // Vertical column of the same profile, for the ratio.
  let vertical = 0;
  const dz = 0.25;
  for (let z = 0; z < 120; z += dz) vertical += density(z) * dz;
  let slant = 0;
  const ds = 2;
  for (let s = 0; s < 1200; s += ds) {
    const height = Math.sqrt(radius * radius + s * s) - EARTH_RADIUS_KM;
    if (height > 120) break;
    slant += 2 * density(height) * ds;
  }
  return slant / Math.max(vertical, 1e-12);
}

const airDensity = (heightKm: number) => Math.exp(-heightKm / AIR_SCALE_KM);
const ozoneDensity = (heightKm: number) => {
  const d = (heightKm - OZONE_PEAK_KM) / OZONE_SCALE_KM;
  return Math.exp(-0.5 * d * d);
};

/**
 * Rayleigh path length for a given solar elevation, as a multiple of the vertical column.
 *
 * Above the horizon the atmosphere is a shell seen from inside it and Kasten & Young apply.
 * Below it the sun lights the sky only along a tangent ray, and the path is the chord
 * integral instead.
 */
export function airSlantFactor(elevationRad: number): number {
  if (elevationRad >= 0) return airMass(apparentElevation(elevationRad));
  return tangentSlant(tangentRayHeightKm(elevationRad), AIR_SLANT_TABLE);
}

/**
 * Tangent slant factors, tabulated at build-up rather than integrated per call.
 *
 * The integral depends on nothing but the tangent height, and the twilight model below needs
 * it a few hundred times per evaluation. Left as a live integral it cost 4.1 ms a call, which
 * is a quarter of a frame for one colour.
 */
const SLANT_TABLE_STEP_KM = 0.5;
const SLANT_TABLE_TOP_KM = 130;
function buildSlantTable(density: (heightKm: number) => number): Float64Array {
  const entries = Math.ceil(SLANT_TABLE_TOP_KM / SLANT_TABLE_STEP_KM) + 1;
  const table = new Float64Array(entries);
  for (let i = 0; i < entries; i++) {
    table[i] = tangentSlantFactor(i * SLANT_TABLE_STEP_KM, density);
  }
  return table;
}
function tangentSlant(heightKm: number, table: Float64Array): number {
  if (heightKm <= 0) return table[0];
  const x = heightKm / SLANT_TABLE_STEP_KM;
  const i = Math.floor(x);
  if (i >= table.length - 1) return table[table.length - 1];
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}
const AIR_SLANT_TABLE = buildSlantTable(airDensity);
const OZONE_SLANT_TABLE = buildSlantTable(ozoneDensity);

/**
 * Ozone slant column as a multiple of the vertical column.
 *
 * Above the horizon, the ordinary geometry of a shell at the layer's altitude. Below it, the
 * tangent integral through the layer -- and the shape of that curve is the whole mechanism of
 * a blue twilight. At two degrees of depression the ray still runs under the ozone; by six it
 * is through the middle of it and samples some fifty times the vertical column, which is
 * enough to remove the orange that Rayleigh scattering left behind; past fifteen it has
 * climbed above the layer and there is nothing left to light anyway.
 */
export function ozoneSlantFactor(elevationRad: number): number {
  if (elevationRad >= 0) {
    const shell = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + OZONE_PEAK_KM);
    const cos = Math.cos(elevationRad);
    return 1 / Math.sqrt(Math.max(1 - shell * shell * cos * cos, 1e-6));
  }
  return tangentSlant(tangentRayHeightKm(elevationRad), OZONE_SLANT_TABLE);
}

export interface AtmosphereOptions {
  /** Ozone column in Dobson units. 300 is a standard mid-latitude value. */
  ozoneDobson?: number;
  /** Aerosol optical depth at 550 nm. 0.05 is a clean day, 0.3 a hazy one. */
  aerosolOpticalDepth?: number;
}

/** Per-wavelength constants, computed once: the inner loop runs these hundreds of times. */
const SAMPLE_WAVELENGTHS_NM = [
  390, 410, 430, 450, 470, 490, 510, 530, 550, 570, 590, 610, 630, 650, 670, 690, 710, 730,
];

const RAYLEIGH_TAU = SAMPLE_WAVELENGTHS_NM.map(rayleighOpticalDepth);
const OZONE_SIGMA = SAMPLE_WAVELENGTHS_NM.map(ozoneCrossSection);
const AEROSOL_SHAPE = SAMPLE_WAVELENGTHS_NM.map((nm) => Math.pow(nm / 550, -1.3));
const SPECTRUM_RGB = SAMPLE_WAVELENGTHS_NM.map(wavelengthToLinearSrgb);

/**
 * Spectral transmittance of the atmosphere along the beam, as a linear-RGB colour.
 *
 * Each sample wavelength is attenuated by Rayleigh scattering over the Kasten-Young air mass,
 * by ozone over its own much longer slant path, and by aerosol with the usual Angstrom
 * wavelength dependence; the surviving spectrum is then summed through the same
 * CIE-based conversion the rainbow uses. The result is normalised so that an overhead sun
 * through a clean atmosphere is white -- the model decides the *hue*, while the exposure
 * pipeline already owns absolute brightness.
 */
export function beamTransmittanceColor(
  elevationRad: number,
  options: AtmosphereOptions = {}
): LinearRgb {
  const ozoneColumn =
    ((options.ozoneDobson ?? DEFAULT_OZONE_DOBSON) * DOBSON_UNIT_MOLECULES_PER_CM2);
  const aerosol = options.aerosolOpticalDepth ?? 0.05;
  const mass = airSlantFactor(elevationRad);
  const ozonePath = ozoneSlantFactor(elevationRad);

  let r = 0;
  let g = 0;
  let b = 0;
  let whiteR = 0;
  let whiteG = 0;
  let whiteB = 0;
  for (const wavelength of SAMPLE_WAVELENGTHS_NM) {
    const rayleigh = rayleighOpticalDepth(wavelength) * mass;
    const ozone = ozoneCrossSection(wavelength) * ozoneColumn * ozonePath;
    const mie = aerosol * Math.pow(wavelength / 550, -1.3) * mass;
    const transmittance = Math.exp(-(rayleigh + ozone + mie));
    const [sr, sg, sb] = wavelengthToLinearSrgb(wavelength);
    r += sr * transmittance;
    g += sg * transmittance;
    b += sb * transmittance;
    whiteR += sr;
    whiteG += sg;
    whiteB += sb;
  }
  return [r / Math.max(whiteR, 1e-9), g / Math.max(whiteG, 1e-9), b / Math.max(whiteB, 1e-9)];
}

/** Height of the top of Earth's shadow directly above the observer, km. */
export function shadowHeightKm(solarElevationRad: number): number {
  if (solarElevationRad >= 0) return 0;
  return EARTH_RADIUS_KM * (1 / Math.cos(solarElevationRad) - 1);
}

export interface TwilightSky {
  /** Hue of the twilight sky overhead, linear RGB normalised to its brightest channel. */
  color: LinearRgb;
  /**
   * Scattered radiance relative to the same column with the sun on the horizon.
   *
   * Falls by roughly three orders of magnitude between sunset and the end of civil twilight,
   * which is the real reason the sky goes dark: not that the light reddens away, but that the
   * only air still in sunlight is thin air, high up.
   */
  relativeBrightness: number;
}

/**
 * Single-scattering model of the twilight sky overhead.
 *
 * The first two attempts at this were wrong in instructive ways. The first used the surface
 * air mass for a beam that never comes near the surface. The second fixed the path but still
 * asked the wrong question: it computed the colour of a beam arriving at the observer, when
 * after sunset no beam arrives at the observer at all. What reaches the eye is sunlight
 * scattered downward out of the air that is *still lit* above the observer's head.
 *
 * So the integral runs up the observer's zenith column. Earth's shadow stands at
 * R(sec(beta) - 1) above them -- four kilometres at two degrees of depression, thirty-five at
 * six, a hundred and forty at twelve -- and every layer above that is sunlit. A layer at
 * height z is reached by a ray whose lowest point is (R + z)cos(beta) - R, which is exactly
 * zero at the shadow's edge and climbs above it; that ray's attenuation decides the colour,
 * and the air density at z decides how much of it scatters down. Multiply, integrate, and
 * both the hue and the brightness fall out of the same geometry.
 *
 * What this does not model: multiple scattering (which fills in the deep-twilight sky and
 * keeps it from going as dark as this says), the aerosol layer that makes the purple light,
 * and any horizontal variation -- this is the zenith, not the whole dome.
 */
/**
 * One frame asks for the same sun many times, and the sun moves a degree every four minutes.
 *
 * Quantising to a quarter of a degree makes every repeat within a frame -- and across the
 * dozens of frames the sun needs to cross that quarter degree -- a lookup. The integral costs
 * 0.18 ms; at sixty frames a second, paying it once per 0.25 degrees is about once every
 * sixty frames.
 */
const CACHE_STEP_RAD = (0.25 * Math.PI) / 180;
const twilightCache = new Map<number, TwilightSky>();

/** The cached form. Use this from a frame loop; the raw integral is for tests and tables. */
export function twilightSkyColorCached(solarElevationRad: number): TwilightSky {
  const key = Math.round(solarElevationRad / CACHE_STEP_RAD);
  const hit = twilightCache.get(key);
  if (hit) return hit;
  const value = twilightSkyColor(key * CACHE_STEP_RAD);
  twilightCache.set(key, value);
  return value;
}

let horizonReference = 0;
function horizonReferenceRadiance(): number {
  if (horizonReference === 0) {
    horizonReference = 1; // break the recursion; the raw sum comes back below
    const raw = twilightSkyColor(0).relativeBrightness;
    horizonReference = raw;
  }
  return horizonReference;
}

export function twilightSkyColor(
  solarElevationRad: number,
  options: AtmosphereOptions = {}
): TwilightSky {
  const ozoneColumn =
    (options.ozoneDobson ?? DEFAULT_OZONE_DOBSON) * DOBSON_UNIT_MOLECULES_PER_CM2;
  const aerosol = options.aerosolOpticalDepth ?? 0.05;
  const beta = Math.min(solarElevationRad, 0);
  const cosBeta = Math.cos(beta);
  const shadow = shadowHeightKm(beta);

  let r = 0;
  let g = 0;
  let b = 0;
  const dz = 0.5;
  for (let z = shadow; z < 120; z += dz) {
    const tangent = (EARTH_RADIUS_KM + z) * cosBeta - EARTH_RADIUS_KM;
    if (tangent < 0) continue;
    const airPath = tangentSlant(tangent, AIR_SLANT_TABLE);
    const ozonePath = tangentSlant(tangent, OZONE_SLANT_TABLE);
    // How much air sits here to do the scattering...
    const scatterers = airDensity(z) * dz;
    if (scatterers < 1e-9) break;
    // ...and how much of the atmosphere the scattered light must cross on the way down. The
    // column below z, straight down, in units of the whole vertical column.
    const belowFraction = 1 - Math.exp(-Math.max(z, 0) / AIR_SCALE_KM);
    for (let w = 0; w < SAMPLE_WAVELENGTHS_NM.length; w++) {
      const wavelength = SAMPLE_WAVELENGTHS_NM[w];
      const tau = RAYLEIGH_TAU[w];
      const beam =
        tau * airPath +
        OZONE_SIGMA[w] * ozoneColumn * ozonePath +
        aerosol * AEROSOL_SHAPE[w] * airPath;
      const downward = Math.exp(-tau * belowFraction);
      const scattered = Math.exp(-beam) * tau * scatterers * downward;
      r += SPECTRUM_RGB[w][0] * scattered;
      g += SPECTRUM_RGB[w][1] * scattered;
      b += SPECTRUM_RGB[w][2] * scattered;
    }
  }
  const peak = Math.max(r, g, b, 1e-30);
  return {
    color: [r / peak, g / peak, b / peak],
    // Against the same column with the sun exactly on the horizon, so the number reads as
    // "a fraction of the light there was at sunset" rather than as an arbitrary scale.
    relativeBrightness: (r + g + b) / horizonReferenceRadiance(),
  };
}
