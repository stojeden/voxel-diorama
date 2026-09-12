import { RAINBOW_SPECTRAL_SAMPLES, type LinearRgb } from './RainbowOptics';

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
 * roughly one over the fourth power of wavelength. It is why the low sun is red: a sun at
 * true elevation zero is refracted up to 0.57 degrees apparent, where Kasten & Young give
 * 30.5 vertical air columns (their formula peaks at 37.9, but only for a sun that is
 * *apparently* on the horizon, which a real one never is). Over those 30.5 columns Rayleigh
 * scattering alone leaves 1.2e-3 of 450 nm and 0.22 of 650 nm -- blue down by three orders
 * of magnitude while red keeps a fifth. Ozone and aerosol then take 650 nm down to 0.049.
 *
 * **Ozone**, absorbing across 400-650 nm in the Chappuis band, is the part every naive sky
 * model misses, and it is the reason twilight is *blue*. Rayleigh scattering alone cannot
 * make a blue twilight, because by then the illuminating beam has had its blue scattered
 * away; Hulburt showed in 1953 that the blue of the sunset zenith is about one third Rayleigh
 * and two thirds ozone, and that deeper into twilight ozone dominates outright. That is not
 * decoration here -- it is asserted as a test. Delete the Chappuis band from this model and
 * the zenith at 4 degrees of depression goes from [0.23, 0.54, 1.00] to [0.86, 0.98, 1.00]:
 * its blue-to-red ratio collapses from 4.30 to 1.16, a factor of 3.7, and what is left is a
 * pale near-neutral sky. (Hulburt calls the ozone-free twilight pale green or straw yellow.
 * This model does not go that far; it goes as far as pale. The straw yellow the module used
 * to produce for that case was an artefact of a display-normalised colour conversion, which
 * gave every red wavelength a full-strength red channel no matter how little of it the eye
 * can see -- see the note on the spectral grid, below.)
 *
 * The geometry that makes ozone win is the tangent ray. Once the sun is below the horizon the
 * light reaching the observer has grazed the Earth, and its lowest point climbs with the
 * depression angle: 3.9 km at 2 degrees, 35.1 km at 6, 142 km at 12. Between about 2 and 5
 * degrees of depression that path lies squarely in the ozone layer and samples tens of times
 * the vertical ozone column (see {@link ozoneSlantFactor} for the measured curve); above 6
 * degrees it has climbed clear of the layer, and by then the only air still in sunlight above
 * the observer is the thin stuff between 35 and 120 km.
 *
 * Sources:
 *   - Hulburt, "Explanation of the Brightness and Color of the Sky, Particularly the Twilight
 *     Sky", JOSA 43(2):113 (1953) -- the one-third/two-thirds result.
 *   - Kasten & Young, "Revised optical air mass tables and approximation formula",
 *     Applied Optics 28(22):4735 (1989) -- the air-mass formula below.
 *   - Bennett, "The Calculation of Astronomical Refraction in Marine Navigation",
 *     Journal of Navigation 35(2):255 (1982) -- the refraction formula below.
 *   - Chappuis band peak: 5.23e-21 cm^2/molecule at 603 nm, secondary 4.83e-21 at 575 nm.
 *     {@link ozoneCrossSection} reproduces both to 0.02 per cent; it did not before.
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
 * A **three**-lobe fit, and the amplitudes are solved rather than picked: with the widths
 * held fixed, the two red lobes are whatever makes the *sum* pass through both published
 * points, 5.23e-21 at 603 nm and 4.83e-21 at 575 nm. It returns 5.229e-21 and 4.829e-21
 * there, within 0.02 per cent of each.
 *
 * The previous version used the published 603 nm peak as one lobe's amplitude and added the
 * others on top, so the sum overshot: 6.56e-21 at 603 nm, 6.47e-21 at 575, a maximum of
 * 6.82e-21 at 590. That is 30 per cent high across the band -- a 300 DU column behaving like
 * 390 DU -- and nothing in the sources justified it.
 *
 * Two things this fit still does not claim. Its maximum is 5.28e-21 at 596 nm, not at 603:
 * one smooth curve through two points 28 nm apart has to peak between them, and 1 per cent
 * over the published peak is the price of hitting both. And the 500 nm lobe is pinned by
 * neither published point -- it is the band's blue wing, where the fit gives 1.42e-21 and
 * where being wrong costs little, because Rayleigh scattering dominates blue anyway.
 *
 * Three-digit accuracy across the whole band is not the point; the *shape* is, because it is
 * the shape that eats orange and green out of a grazing beam and leaves blue behind.
 */
export function ozoneCrossSection(wavelengthNm: number): number {
  const lobe = (centre: number, width: number, peak: number) => {
    const d = (wavelengthNm - centre) / width;
    return peak * Math.exp(-0.5 * d * d);
  };
  return lobe(603, 48, 4.73e-21) + lobe(575, 32, 6.84e-22) + lobe(500, 40, 0.9e-21);
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
 * Tangent slant factors, tabulated at module load rather than integrated per call.
 *
 * The integral depends on nothing but the tangent height, and the twilight model below needs
 * it 418 times per evaluation at 4 degrees of depression -- two profiles at each of 209 steps
 * up the zenith column. One integral measures 6.2 us here, so left live it would cost 6.5 ms
 * per twilight colour: a third of a frame, for one colour. The table is 261 entries.
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
 * a blue twilight. Measured from this function, in multiples of the vertical column:
 *
 * ```
 *   depression:   0     1      2      3      4      4.30   5      6      7
 *   tangent km:   0.0   1.0    3.9    8.7   15.6   18.0   24.3   35.1   47.9
 *   slant:       12.1  25.3   27.5   33.6   48.8   51.7   32.2    0.70   2.6e-5
 * ```
 *
 * The peak is at 4.30 degrees, where the ray's lowest point is 18.0 km -- close to the 22 km
 * centre of the layer, pulled a little low because the ray spends longer in the denser air
 * below the centre than above it. Fifty vertical columns of ozone is enough to remove the
 * orange that Rayleigh scattering left behind. Then it falls off a cliff: by 6 degrees the
 * tangent height is 35 km, 2.6 layer widths above the centre, and the ray is essentially
 * over the ozone with 0.70 columns left; by 7 degrees there is nothing there at all.
 *
 * (The docblock this replaces said the ray was still under the ozone at 2 degrees, peaked by
 * 6 and was above the layer past 15. Every one of those angles was wrong: the peak is at 4.3
 * and 6 degrees is already past the cliff.)
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

/**
 * The spectral grid, and the colorimetry that turns a spectrum into a colour.
 *
 * Both are borrowed whole from `RainbowOptics`, which already publishes them: 400 to 700 nm
 * every 10 nm, each with `spectralLinearRgb` -- the CIE 1931 response weighted by the D65
 * illuminant, in linear sRGB, **signed and unnormalised**. That last part is the whole point.
 * The obvious-looking neighbour, `wavelengthToLinearSrgb`, is documented in that module as
 * the *diagnostic* helper: it clips negative channels and rescales every wavelength to its
 * own peak channel, which throws away exactly the relative luminance an integral is summing.
 * Summing it is like adding up photographs of a spectrum instead of the spectrum.
 *
 * Two measurements of the difference. First, the white point: summing the display helper over
 * a grid gives [9.54, 5.62, 6.07], nothing like a neutral, and the old code hid that by
 * dividing each channel by its own sum. Summing `spectralLinearRgb` gives
 * [10.552, 10.580, 10.547] -- D65 white, neutral to a third of a per cent, because that is
 * what a D65-weighted CIE integral is supposed to produce. Second, the horizon sun:
 * [0.0549, 0.0163, 0.0004] before, [0.0335, 0.0063, 0.0] now.
 *
 * This grid also fixes a quieter bug. The old one ran 390..730 nm, but the display helper
 * clamps its argument to [400, 700] -- bounds copied from a water-dispersion table, with no
 * colorimetric meaning whatever -- so 390 nm was painted with 400 nm's colour and 710 and 730
 * were both painted with 700 nm's. At the horizon those are the best-surviving samples in the
 * spectrum, so the reddest end of the beam was being counted three times over at 700 nm.
 * Truncating at 700 nm instead costs almost nothing: carrying the same corrected colorimetry
 * across the old 390..730 grid gives a horizon r/g of 5.377 against 5.317 here, a difference
 * of 1.1 per cent, because the eye barely responds out there at all: the same CIE fit puts
 * its luminous response at 0.43 per cent of peak at 700 nm, 0.19 at 710 and 0.03 at 730.
 */
const SAMPLE_WAVELENGTHS_NM = RAINBOW_SPECTRAL_SAMPLES.map((sample) => sample.wavelengthNm);
const SPECTRUM_RGB = RAINBOW_SPECTRAL_SAMPLES.map((sample) => sample.spectralLinearRgb);

/**
 * Per-wavelength constants, computed once at module load.
 *
 * These are used by every integral in the file -- the zenith column below runs them 31 times
 * at each of a couple of hundred heights, and `beamTransmittanceColor` used to recompute all
 * of them inside its own loop instead, twice a frame, for a sun that moves a quarter of a
 * degree every sixty frames. That cost 3.6 us a call; it is 0.9 us now, on a grid that grew
 * from 18 wavelengths to 31. Both are small against a 16.7 ms frame, and saying so is the
 * honest version: the old comment was not describing the code underneath it.
 */
const RAYLEIGH_TAU = SAMPLE_WAVELENGTHS_NM.map(rayleighOpticalDepth);
const OZONE_SIGMA = SAMPLE_WAVELENGTHS_NM.map(ozoneCrossSection);
const AEROSOL_SHAPE = SAMPLE_WAVELENGTHS_NM.map((nm) => Math.pow(nm / 550, -1.3));
/** Sum of the spectral weights: the D65 white point, and so the normaliser for a colour. */
const WHITE_RGB: LinearRgb = [
  SPECTRUM_RGB.reduce((sum, rgb) => sum + rgb[0], 0),
  SPECTRUM_RGB.reduce((sum, rgb) => sum + rgb[1], 0),
  SPECTRUM_RGB.reduce((sum, rgb) => sum + rgb[2], 0),
];

/**
 * Spectral transmittance of the atmosphere along the beam, as a linear-RGB colour.
 *
 * Each sample wavelength is attenuated by Rayleigh scattering over the Kasten-Young air mass,
 * by ozone over its own much longer slant path, and by aerosol with the usual Angstrom
 * wavelength dependence; the surviving spectrum is then summed through the same D65-weighted
 * CIE response the rainbow integrates with. The result is divided by the same sum of an
 * unattenuated spectrum, so an overhead sun through a clean atmosphere is white -- the model
 * decides the *hue*, while the exposure pipeline already owns absolute brightness.
 *
 * A monochromatic wavelength is outside the sRGB gamut, so individual samples carry negative
 * channels and a strongly-filtered spectrum can integrate to a slightly negative one: at the
 * horizon blue lands at -8e-4 of white. That is gamut, not physics, so the sum is clipped at
 * zero **once, at the end**. Clipping per wavelength before summing is the bug this function
 * used to have.
 */
export function beamTransmittanceColor(
  elevationRad: number,
  options: AtmosphereOptions = {}
): LinearRgb {
  const ozoneColumn =
    (options.ozoneDobson ?? DEFAULT_OZONE_DOBSON) * DOBSON_UNIT_MOLECULES_PER_CM2;
  const aerosol = options.aerosolOpticalDepth ?? 0.05;
  const mass = airSlantFactor(elevationRad);
  const ozonePath = ozoneSlantFactor(elevationRad);

  let r = 0;
  let g = 0;
  let b = 0;
  for (let w = 0; w < SAMPLE_WAVELENGTHS_NM.length; w++) {
    const transmittance = Math.exp(
      -(
        RAYLEIGH_TAU[w] * mass +
        OZONE_SIGMA[w] * ozoneColumn * ozonePath +
        aerosol * AEROSOL_SHAPE[w] * mass
      )
    );
    r += SPECTRUM_RGB[w][0] * transmittance;
    g += SPECTRUM_RGB[w][1] * transmittance;
    b += SPECTRUM_RGB[w][2] * transmittance;
  }
  return [
    Math.max(r / WHITE_RGB[0], 0),
    Math.max(g / WHITE_RGB[1], 0),
    Math.max(b / WHITE_RGB[2], 0),
  ];
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
   * Measured from this model: 1.000 on the horizon, 0.61 at 2 degrees down, 0.14 at 4, and
   * 1.2e-2 at 6 -- the end of civil twilight is a factor of 82 below sunset, which is 1.9
   * orders of magnitude, not the three this once claimed. (Three orders comes up at 7.50
   * degrees, well into nautical twilight.) The fall is the real reason the sky goes dark: not
   * that the light reddens away, but that the only air still in sunlight is thin air, high up.
   */
  relativeBrightness: number;
}

/**
 * One frame asks for the same sun many times, and the sun moves a degree every four minutes.
 *
 * Quantising to a quarter of a degree makes every repeat within a frame -- and across the
 * dozens of frames the sun needs to cross that quarter degree -- a lookup. The integral costs
 * 0.16 ms measured here; at sixty frames a second, paying it once per 0.25 degrees is about
 * once every sixty frames.
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
 * R(sec(beta) - 1) above them -- 3.9 km at two degrees of depression, 35 at six, 142 at
 * twelve -- and every layer above that is sunlit. A layer at height z is reached by a ray
 * whose lowest point is (R + z)cos(beta) - R, which is exactly zero at the shadow's edge and
 * climbs above it; that ray's attenuation decides the colour, and the air density at z
 * decides how much of it scatters down. Multiply, integrate, and both the hue and the
 * brightness fall out of the same geometry.
 *
 * **The column stops at 120 km**, which is where the air runs out for any purpose this model
 * has, and that ceiling is also this function's floor. Earth's shadow reaches 120 km at 11.03
 * degrees of depression, and below that the loop has nothing to iterate over: the colour is
 * exactly black and the brightness exactly 0. For the 0.02 degrees just above it the answer
 * flickers between zero and about 3e-11, because the single surviving step sits at z = shadow
 * where the tangent height is analytically zero and floating point decides its sign. Nothing
 * warns a caller -- it is a sky colour one step and a hard black the next -- so a test pins
 * the angle.
 *
 * The approach to that floor is not to be trusted either, and the bound is worth stating
 * plainly. The hue holds its blue down to about 10.2 degrees and then collapses to red:
 * [0.36, 0.72, 1.00] at 10 degrees, [1.00, 0.03, 0.00] at 11. That last is the straw-to-red
 * the ozone in this model exists to prevent, and it is an artefact of the geometry at those
 * angles: the sunlit air is down to a sliver between the shadow top and the ceiling -- 98 to
 * 120 km at 10 degrees, 119 to 120 at 11 -- and the rays that reach it still graze the
 * ground, so what survives the path is a Rayleigh-reddened remnant with no ozone-rich
 * mid-altitude path left to colour it. What lights the real sky down there is multiple
 * scattering, which this does not model.
 *
 * The artefact is unreachable in practice, and a test pins the reason: the hue turns at 10.2
 * degrees, where the brightness is 3.3e-7 of sunset -- six thousand times below the 0.002 at
 * which `sky.ts` hands the sky back to the authored night colour, a threshold this crosses
 * three degrees earlier, at 7.12. Callers that do *not* gate on brightness must not use this
 * below about 7 degrees.
 *
 * What this does not model, besides multiple scattering: the aerosol layer that makes the
 * purple light, and any horizontal variation -- this is the zenith, not the whole dome.
 */
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
  // Clipped at zero once, at the end, for the same reason as in `beamTransmittanceColor`: a
  // spectrum integrated against signed CIE weights can leave a channel slightly outside the
  // sRGB gamut, and a negative channel is a gamut artefact rather than a colour.
  const peak = Math.max(r, g, b, 1e-30);
  return {
    color: [Math.max(r / peak, 0), Math.max(g / peak, 0), Math.max(b / peak, 0)],
    // Against the same column with the sun exactly on the horizon, so the number reads as
    // "a fraction of the light there was at sunset" rather than as an arbitrary scale.
    relativeBrightness: (r + g + b) / horizonReferenceRadiance(),
  };
}
