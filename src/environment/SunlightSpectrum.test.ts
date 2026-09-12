import { describe, expect, test } from 'vitest';
import {
  airMass,
  beamTransmittanceColor,
  ozoneCrossSection,
  ozoneSlantFactor,
  rayleighOpticalDepth,
  refractionRad,
  shadowHeightKm,
  tangentRayHeightKm,
  twilightSkyColor,
  twilightSkyColorCached,
} from './SunlightSpectrum';

const deg = (d: number) => (d * Math.PI) / 180;
const arcmin = (rad: number) => (rad * 180 * 60) / Math.PI;

describe('published constants', () => {
  /**
   * These are not self-consistency checks. Each one is a number somebody measured, and the
   * point of pinning them is that a plausible-looking refactor of the formulae cannot quietly
   * move the physics.
   */
  test('Rayleigh optical depth matches the textbook value at 550 nm', () => {
    expect(rayleighOpticalDepth(550)).toBeCloseTo(0.0973, 4);
    // The inverse-fourth-power law, stated as a ratio rather than assumed.
    expect(rayleighOpticalDepth(450) / rayleighOpticalDepth(650)).toBeCloseTo(4.5, 1);
  });

  test('refraction at the horizon is about 34 arcminutes', () => {
    expect(arcmin(refractionRad(0))).toBeGreaterThan(33);
    expect(arcmin(refractionRad(0))).toBeLessThan(36);
    // And it collapses fast with altitude: about a minute at 45 degrees.
    expect(arcmin(refractionRad(deg(45)))).toBeCloseTo(1, 0);
  });

  test('air mass is 1 overhead and about 38 at the horizon (Kasten & Young)', () => {
    expect(airMass(deg(90))).toBeCloseTo(1, 3);
    expect(airMass(deg(30))).toBeCloseTo(2, 1);
    expect(airMass(0)).toBeGreaterThan(37);
    expect(airMass(0)).toBeLessThan(39);
  });

  /**
   * The Chappuis cross-section, pinned to the two values the module's Sources line quotes.
   *
   * Nothing pinned this before, and nothing had to: the old fit used the published 603 nm
   * peak as one lobe's *amplitude* and then added two more lobes on top of it, so the
   * function returned 6.56e-21 at 603 nm and 6.47e-21 at 575 -- about 30 per cent above the
   * numbers cited three lines away, which is a 300 DU ozone column quietly behaving like 390.
   * The amplitudes are now solved so the sum passes through both published points.
   */
  test('the ozone fit returns the published Chappuis values', () => {
    expect(ozoneCrossSection(603)).toBeCloseTo(5.23e-21, 23);
    expect(ozoneCrossSection(575)).toBeCloseTo(4.83e-21, 23);

    // A smooth curve through two points 28 nm apart peaks between them, so the fit's own
    // maximum is 5.28e-21 near 596 nm: 1 per cent over the published peak, not 30.
    let peak = 0;
    let peakNm = 0;
    for (let nm = 400; nm <= 750; nm += 0.05) {
      const sigma = ozoneCrossSection(nm);
      if (sigma > peak) {
        peak = sigma;
        peakNm = nm;
      }
    }
    expect(peakNm).toBeCloseTo(596, 0);
    expect(peak / 5.23e-21).toBeLessThan(1.02);

    // And the band is a band: it falls away on both sides of the Chappuis continuum.
    expect(ozoneCrossSection(450)).toBeLessThan(ozoneCrossSection(500));
    expect(ozoneCrossSection(500)).toBeLessThan(ozoneCrossSection(550));
    expect(ozoneCrossSection(700)).toBeLessThan(ozoneCrossSection(650));
  });
});

describe('the direct beam', () => {
  test('reddens monotonically as the sun descends', () => {
    const warmth = (elevationDeg: number) => {
      const [r, , b] = beamTransmittanceColor(deg(elevationDeg));
      return r / Math.max(b, 1e-9);
    };
    let previous = warmth(80);
    for (const elevation of [60, 40, 20, 10, 5, 2, 0]) {
      const now = warmth(elevation);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
  });

  /**
   * The horizon sun, re-measured after the colour conversion was fixed.
   *
   * This test used to assert `r > g * 3` and pass on 0.0549 against 0.0489, a margin of 12
   * per cent supplied entirely by a bug: the integral ran through `wavelengthToLinearSrgb`,
   * the *display* helper, which clamps its wavelength argument to [400, 700] nm. The sample
   * grid ran 390 to 730, so 710 and 730 nm -- by far the best-surviving wavelengths in a
   * horizon beam -- were both painted with 700 nm's chromaticity, counting the red end of the
   * spectrum three times at one wavelength. Removing the clamp without fixing the rest of the
   * conversion would have taken r/g to 1.38 and failed this test.
   *
   * With the D65-weighted CIE response the rainbow integrates with, the horizon sun is redder
   * than the artefact claimed, not less: r/g = 5.32. The factor asserted is the measured one,
   * not a round number chosen first.
   */
  test('the horizon sun is red by a factor of five, not merely warm', () => {
    const [r, g, b] = beamTransmittanceColor(0);
    expect(r / g).toBeGreaterThan(5.2);
    expect(r / g).toBeLessThan(5.5);
    // Blue is gone entirely: the unclipped integral lands at -8e-4 of white, which is a
    // gamut artefact of summing signed CIE weights, and is clipped to zero.
    expect(b).toBe(0);
    // A high sun is near-neutral by comparison: 1.21 at sixty degrees.
    const [hr, , hb] = beamTransmittanceColor(deg(60));
    expect(hr / hb).toBeLessThan(1.5);
  });

  /**
   * The clipping contract, which is what makes the signed conversion safe to hand to a
   * renderer. `sky.ts` divides this colour by its brightest channel; a channel that came back
   * negative -- and the raw integral does go negative, blue reaches -8e-4 of white at the
   * horizon -- would come out of that division as a negative sRGB component.
   */
  test('every elevation returns an in-gamut colour, reddening all the way down', () => {
    for (let elevationDeg = 90; elevationDeg >= 0; elevationDeg -= 1) {
      const colour = beamTransmittanceColor(deg(elevationDeg));
      for (const channel of colour) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
      // The atmosphere only ever takes more blue than red, at every height of the sun.
      expect(colour[0]).toBeGreaterThanOrEqual(colour[1]);
      expect(colour[1]).toBeGreaterThanOrEqual(colour[2]);
    }
  });
});

describe('twilight', () => {
  /**
   * Hulburt (1953): the blue of the twilight sky is about one third Rayleigh scattering and
   * two thirds ozone absorption at sunset, and ozone alone deeper in.
   *
   * This is the single assertion that justifies the module. An implementation that dropped
   * ozone would still produce a smooth, plausible, entirely wrong sky, and every other test
   * here would pass.
   *
   * What the test asserts changed when the colour conversion was fixed, and the change is
   * worth naming. It used to claim the ozone-free twilight zenith was *red* -- and that was
   * true of the old code, because the display-normalised conversion handed every long
   * wavelength a full-strength red channel regardless of how little of it the eye actually
   * sees. Through the D65-weighted CIE response, the ozone-free zenith at 4 degrees comes out
   * [0.862, 0.979, 1.000]: pale and very nearly neutral, with blue and green all but tied.
   * So the assertion is now the one the model can actually support -- ozone is what makes the
   * zenith *blue* rather than pale -- and the swing it produces is more than twice what the
   * old artefact showed: the blue-to-red ratio goes 1.16 -> 4.30, a factor of 3.71.
   */
  test('is blue because of ozone, and pale without it', () => {
    const withOzone = twilightSkyColor(deg(-4)).color;
    const withoutOzone = twilightSkyColor(deg(-4), { ozoneDobson: 0 }).color;

    // With ozone: unmistakably blue -- red is under a quarter of blue.
    expect(withOzone[2]).toBeGreaterThan(withOzone[1]);
    expect(withOzone[0]).toBeLessThan(withOzone[2] * 0.25);
    // Without it: pale. Every channel within 15 per cent of the brightest, and the blue
    // excess down to a fifth of what ozone gives.
    expect(Math.min(...withoutOzone)).toBeGreaterThan(0.85 * Math.max(...withoutOzone));
    const ratio = (c: readonly number[]) => c[2] / Math.max(c[0], 1e-9);
    expect(ratio(withoutOzone)).toBeLessThan(1.2);
    // The swing is a change of character, not a tint. Measured at 3.71x on the blue-to-red
    // ratio; the bound is set below that rather than at a round number chosen first.
    expect(ratio(withOzone) / ratio(withoutOzone)).toBeGreaterThan(3.5);
  });

  test('Earth\'s shadow climbs as the square of the depression angle', () => {
    expect(shadowHeightKm(0)).toBe(0);
    expect(shadowHeightKm(deg(-2))).toBeCloseTo(3.9, 0);
    expect(shadowHeightKm(deg(-6))).toBeCloseTo(35, 0);
    expect(shadowHeightKm(deg(-12))).toBeCloseTo(142, 0);
    // Doubling the depression roughly quadruples the height.
    expect(shadowHeightKm(deg(-8)) / shadowHeightKm(deg(-4))).toBeCloseTo(4, 0);
  });

  /**
   * The ozone path peaks where the tangent ray crosses the layer -- as an actual comparison.
   *
   * The version this replaces never compared two angles. It asserted that the factor at 4
   * degrees is above 20 and that the factor at 10 degrees is below 1, both of which are true
   * of curves with their peak anywhere from 1 degree to 6, and it is why a docblock claiming
   * the ray was still under the ozone at 2 degrees and peaking at 6 survived: measured, the
   * peak is 51.7 at 4.30 degrees, and 6 degrees is already past the far side of the cliff at
   * 0.70. A scan for the maximum is the assertion that has to be made.
   */
  test('the ozone path peaks where the tangent ray crosses the layer', () => {
    let peak = 0;
    let peakDeg = 0;
    for (let d = 0; d >= -10; d -= 0.005) {
      const slant = ozoneSlantFactor(deg(d));
      if (slant > peak) {
        peak = slant;
        peakDeg = d;
      }
    }
    // The peak sits at 4.30 degrees of depression, not at 2 and not at 6.
    expect(peakDeg).toBeGreaterThan(-4.5);
    expect(peakDeg).toBeLessThan(-4.1);
    expect(peak).toBeGreaterThan(50);
    expect(peak).toBeLessThan(53);

    // It peaks there because that is where the ray's lowest point is inside the layer: 18 km
    // against a layer centred at 22 with a 5 km width. (A shade low, because the ray spends
    // longer in the denser air below the centre than above it.)
    expect(tangentRayHeightKm(deg(peakDeg))).toBeGreaterThan(15);
    expect(tangentRayHeightKm(deg(peakDeg))).toBeLessThan(22);

    // And it is a peak, not a plateau: nearly twice the factor two degrees up, and two orders
    // of magnitude more than two degrees down, where the ray has climbed clear of the layer.
    expect(peak / ozoneSlantFactor(deg(-2))).toBeGreaterThan(1.7);
    expect(peak / ozoneSlantFactor(deg(-6))).toBeGreaterThan(50);
    expect(ozoneSlantFactor(deg(-6))).toBeLessThan(1);
    expect(ozoneSlantFactor(deg(-7))).toBeLessThan(1e-4);
  });

  /**
   * How far the brightness actually falls, measured rather than rounded up to a good story.
   *
   * `at(0)` is 1 by definition -- the horizon value is the reference the ratio is taken
   * against -- so asserting it is close to 1 tests nothing at all, and it is gone. What is
   * worth pinning is the *shape*: 1.9 orders of magnitude across civil twilight, not the
   * three the module claimed in two places, with three orders arriving at 7.50 degrees.
   */
  test('brightness falls by 1.9 orders of magnitude across civil twilight', () => {
    const at = (d: number) => twilightSkyColor(deg(d)).relativeBrightness;
    const orders = (d: number) => Math.log10(at(0) / at(d));

    expect(at(-2)).toBeLessThan(0.7);
    expect(at(-4)).toBeLessThan(0.2);
    // End of civil twilight: a factor of 82, which is 1.9 orders and not three.
    expect(at(-6)).toBeCloseTo(1.22e-2, 3);
    expect(orders(-6)).toBeGreaterThan(1.85);
    expect(orders(-6)).toBeLessThan(1.95);
    // Three orders is a nautical-twilight number: measured, it arrives at 7.50 degrees.
    expect(orders(-7.6)).toBeGreaterThan(3);
    expect(orders(-7.4)).toBeLessThan(3);

    let previous = Infinity;
    for (let d = 0; d >= -12; d -= 0.5) {
      const value = at(d);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  /**
   * The two ends of the model's validity, both undocumented until now and both untested.
   *
   * The zenith integral stops at 120 km, so once Earth's shadow passes that height the loop
   * has nothing to iterate and the answer is a hard, silent black. And before that, on the
   * way down, the modelled hue gives up and turns red -- the straw-to-red the whole module
   * exists to avoid. The second assertion here is the one that makes that artefact harmless:
   * it is already hundreds of times darker than the brightness at which `sky.ts` hands the
   * sky back to its authored night colour (TWILIGHT_HANDBACK_BRIGHTNESS, 0.002).
   */
  test('goes hard black past 11.03 degrees, and turns red only far below use', () => {
    // Earth's shadow reaches the 120 km ceiling at 11.03 degrees of depression.
    expect(shadowHeightKm(deg(-11.03))).toBeLessThan(120);
    expect(shadowHeightKm(deg(-11.04))).toBeGreaterThan(120);
    for (const d of [-11.04, -11.5, -15, -45]) {
      const dark = twilightSkyColor(deg(d));
      expect(dark.relativeBrightness).toBe(0);
      expect(dark.color).toEqual([0, 0, 0]);
    }

    // The hue holds blue until 10.2 degrees down, and the sky is long gone by then.
    const HANDBACK = 0.002; // sky.ts, TWILIGHT_HANDBACK_BRIGHTNESS
    let hueTurnedAt = 0;
    for (let d = 0; d >= -11; d -= 0.01) {
      const { color } = twilightSkyColor(deg(d));
      if (color[2] < color[0]) {
        hueTurnedAt = d;
        break;
      }
    }
    expect(hueTurnedAt).toBeLessThan(-10);
    expect(twilightSkyColor(deg(hueTurnedAt)).relativeBrightness).toBeLessThan(HANDBACK / 100);
    // The consumer has stopped looking three degrees earlier, at 7.12.
    expect(twilightSkyColor(deg(-7.2)).relativeBrightness).toBeLessThan(HANDBACK);
    expect(twilightSkyColor(deg(-7)).relativeBrightness).toBeGreaterThan(HANDBACK);
  });

  /**
   * The cache stands in for the integral at arbitrary angles, so that is what to compare.
   *
   * The version this replaces re-derived the quarter-degree quantum inline and then compared
   * the cache against the integral evaluated *at the same quantised angle* -- two paths that
   * are identical by construction. It could only fail if the cache were broken and the
   * inlined constant drifted at the same time. The question a caller actually has is how far
   * the cached answer can be from the true one at the angle they asked about, so the
   * comparison is against the unquantised integral, with the error stated as a tolerance.
   */
  test('the cache is within a stated tolerance of the integral it stands in for', () => {
    let worstHue = 0;
    let worstBrightness = 0;
    for (let d = 0; d >= -7.2; d -= 0.01) {
      const cached = twilightSkyColorCached(deg(d));
      const exact = twilightSkyColor(deg(d));
      for (let c = 0; c < 3; c++) {
        worstHue = Math.max(worstHue, Math.abs(cached.color[c] - exact.color[c]));
      }
      worstBrightness = Math.max(
        worstBrightness,
        Math.abs(cached.relativeBrightness / exact.relativeBrightness - 1)
      );
    }
    // Hue is nearly flat in elevation, so quantising it is almost free: an eighth of a degree
    // moves a channel by 2.4e-4 at worst, over the whole range a caller can see.
    expect(worstHue).toBeLessThan(1e-3);
    // Brightness is not flat -- it falls by a factor of 82 across civil twilight and faster
    // after -- so the same eighth of a degree costs up to 24 per cent, worst at -7.1 where
    // the curve is steepest. That is the tolerance, stated: this is a hue cache, not a
    // photometer, and its one consumer uses the brightness as a fade weight.
    expect(worstBrightness).toBeLessThan(0.3);

    // And it is a cache: the same angle twice is the identical object, not a re-integration.
    expect(twilightSkyColorCached(deg(-3))).toBe(twilightSkyColorCached(deg(-3)));
  });
});
