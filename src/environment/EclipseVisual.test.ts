import * as THREE from 'three';
import { afterAll, describe, expect, test } from 'vitest';
import {
  CORONA_K_F_CROSSOVER_RADII,
  EclipseVisual,
  MAX_SOLAR_RADIANCE,
  MOON_BILLBOARD_LIMIT,
  MOON_CENTER_CHUNK,
  MOON_REVEAL_COVERAGE,
  MOON_REVEAL_SKY_FRACTION,
  SOLAR_RADIANCE,
  coronaRadialProfile,
  glslFloat,
  MOON_DISC_RADIUS,
  SUN_DISC_RADIUS,
  solarLimbIntensity,
} from './EclipseVisual';
import { EclipseTimeline, eclipseCoverageAtSeparation } from '../experience/EclipseTimeline';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  clockFromSolarPhase,
  sunDirectionAt,
} from './sky';
import { ECLIPSE_VIEW_SOLAR_PHASE } from '../experience/AuthoredMoments';
import type { Radians, SolarPhase01 } from '../units';

/**
 * THE ACCEPTANCE METRIC, REDEFINED SO THAT IT CAN FAIL.
 *
 * **BITE CONTRAST** = mean scene-linear radiance of the exposed crescent / scene-linear
 * radiance of the SKY BESIDE THE DISC, at coverage 0.50, 0.75 and 0.90.
 * **Required: >= 3.0 at all three.**
 *
 * The denominator used to be the moon-disc interior, and the same change that introduced the
 * metric drove that interior to exactly 0 at every coverage it is measured at. A ratio with a
 * zero denominator gates nothing. The stand-in assertion was worse: it divided a scene-linear
 * radiance (200) by a display-linear sRGB floor (1.518e-4), asserted the result exceeded 3,
 * and got 1.3e6 -- a number that could not have come out below 3 for any code anybody could
 * have written. The same unit confusion sat under `limbOverSky`, a scene-linear ratio checked
 * against a presented-contrast target.
 *
 * The sky beside the disc is also the thing the baseline actually measured as broken: at
 * coverage 0.959 the drawn disc read luma 168 against a 251 sky, and the billboard made ZERO
 * pixels of the centre row brighter. So the metric now compares the two quantities the probe
 * compared, in the units the shader works in, and the presented-code checks below compare
 * sRGB codes to sRGB codes. Nothing in this file compares the two kinds of number.
 *
 * Drawn crescent width at SUN_RADIUS 0.16 (1.614 deg drawn, a deliberate 3.03x
 * exaggeration that must NOT be reduced): 0.656 deg at coverage 0.50, 0.325 at 0.75,
 * 0.134 at 0.90, 0.070 at 0.95 -- 14.2 / 7.0 / 2.9 / 1.5 px at 1080p and a 50 deg vertical
 * FOV. Those are the widths the metric is averaging over.
 */
const BITE_CONTRAST_TARGET = 3;

/** The coverages the metric is quoted at. */
const METRIC_COVERAGES = [0.5, 0.75, 0.9] as const;

/* ------------------------------------------------------------------ *
 * The presented picture, so the tests can talk about codes not radiance
 * ------------------------------------------------------------------ */

/** three's ACES fit, verbatim from tonemapping_pars_fragment. */
const rrtAndOdtFit = (v: number): number =>
  (v * (v + 0.0245786) - 0.000090537) / (v * (0.98372899 * v + 0.432951) + 0.238081);

/**
 * Both ACES matrices have unit row sums, so a neutral colour goes through the fit as a
 * scalar. Every radiance in this file is treated as neutral; the tints are all within 8 per
 * cent of white on their largest channel and none of the conclusions turn on hue.
 */
const acesToneMap = (v: number): number => Math.min(1, Math.max(0, rrtAndOdtFit(v)));

const encodeSrgb = (linear: number): number =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;

const decodeSrgb = (encoded: number): number =>
  encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;

const solveFit = (target: number): number => {
  let low = 0;
  let high = 1e4;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (rrtAndOdtFit(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

/**
 * `toneMappingExposure / 0.6`, inverted from the one measurement this whole file hangs on:
 * the centre-row scan read the sky beside the disc at luma 254.4 while its scene radiance
 * was {@link SOLAR_RADIANCE.sky}. Held here rather than in the module because the module
 * must not carry a copy of the tone curve; this is the test's instrument, not the shader's.
 */
const EXPOSURE_OVER_POINT_SIX = solveFit(decodeSrgb(254.4 / 255)) / SOLAR_RADIANCE.sky;

/** Scene-linear radiance -> the 0..255 code the final pass writes, fractional for headroom. */
const presentedCode = (radiance: number): number =>
  255 * encodeSrgb(acesToneMap(radiance * EXPOSURE_OVER_POINT_SIX));

/** sRGB's linear segment: the display-linear value that first rounds UP to code 1. */
const SRGB_CODE_ONE_BOUNDARY = 0.5 / 255 / 12.92;

/* ------------------------------------------------------------------ *
 * What the blend state actually does to a fragment
 * ------------------------------------------------------------------ */

/** The radiance a fragment ADDS to the framebuffer, given the material's own blend state. */
const addedRadiance = (
  material: THREE.ShaderMaterial,
  authored: number,
  alpha: number
): number => {
  if (material.blending === THREE.CustomBlending) {
    if (material.blendSrc === THREE.OneFactor) return authored;
    if (material.blendSrc === THREE.SrcAlphaFactor) return authored * alpha;
    throw new Error(`unhandled blendSrc ${String(material.blendSrc)}`);
  }
  // NormalBlending and AdditiveBlending both multiply the source by its own alpha.
  return authored * alpha;
};

/** The fraction of the sky underneath that survives the fragment. */
const skyKept = (material: THREE.ShaderMaterial, alpha: number): number => {
  if (material.blending === THREE.CustomBlending) {
    if (material.blendDst === THREE.OneFactor) return 1;
    if (material.blendDst === THREE.OneMinusSrcAlphaFactor) return 1 - alpha;
    throw new Error(`unhandled blendDst ${String(material.blendDst)}`);
  }
  if (material.blending === THREE.AdditiveBlending) return 1;
  return 1 - alpha;
};

/* ------------------------------------------------------------------ *
 * Crescent geometry, from the same circles the timeline and shader use
 * ------------------------------------------------------------------ */

const MOON_OVER_SUN = 0.163 / 0.16;

/**
 * Mean limb intensity over the *exposed* part of the disc at a given separation, by grid
 * quadrature in solar radii. The moon centre sits at `separation * (1 + MOON_OVER_SUN)`,
 * which is `uSeparation * (SUN_RADIUS + MOON_RADIUS) / SUN_RADIUS` -- the shader's own
 * offset, expressed in the units the limb law is written in.
 */
function crescentMeanLimb(separation: number): number {
  const moonX = Math.abs(separation) * (1 + MOON_OVER_SUN);
  const steps = 900;
  let total = 0;
  let count = 0;
  for (let i = 0; i < steps; i += 1) {
    const x = -1 + (2 * (i + 0.5)) / steps;
    for (let j = 0; j < steps; j += 1) {
      const y = -1 + (2 * (j + 0.5)) / steps;
      const radius2 = x * x + y * y;
      if (radius2 > 1) continue;
      const dx = x - moonX;
      if (dx * dx + y * y < MOON_OVER_SUN * MOON_OVER_SUN) continue;
      total += solarLimbIntensity(Math.sqrt(Math.max(0, 1 - radius2)));
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** The timeline state whose coverage is `target`, found on the monotonic partial-in ramp. */
function stateAtCoverage(timeline: EclipseTimeline, target: number) {
  let low = 0;
  let high = 0.36;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (timeline.seek(mid).coverage < target) low = mid;
    else high = mid;
  }
  return timeline.seek((low + high) / 2);
}

/** The sky beside the disc: the dome keeps `texColor * irradiance` after the darkness rework. */
const skyBesideDisc = (irradiance: number): number => SOLAR_RADIANCE.sky * irradiance;

const materialOf = (scene: THREE.Scene, name: string): THREE.ShaderMaterial =>
  (scene.getObjectByName(name) as THREE.Mesh).material as THREE.ShaderMaterial;

const shaderScene = new THREE.Scene();
const shaderVisual = new EclipseVisual(shaderScene);
afterAll(() => shaderVisual.dispose());

const solarMaterial = (scene: THREE.Scene = shaderScene): THREE.ShaderMaterial =>
  materialOf(scene, 'eclipse-solar-layer');

const moonMaterial = (scene: THREE.Scene = shaderScene): THREE.ShaderMaterial =>
  materialOf(scene, 'eclipse-moon-layer');

const solarShaderOf = (scene: THREE.Scene = shaderScene): string =>
  solarMaterial(scene).fragmentShader;

const moonShaderOf = (scene: THREE.Scene = shaderScene): string =>
  moonMaterial(scene).fragmentShader;

describe('how the drawn sun composites onto the sky', () => {
  test('the emissive layer ADDS and the occluding layer REPLACES', () => {
    const solar = solarMaterial();
    // result = emitted + sky, with the alpha channel left to the passes downstream.
    expect(solar.blending).toBe(THREE.CustomBlending);
    expect(solar.blendEquation).toBe(THREE.AddEquation);
    expect(solar.blendSrc).toBe(THREE.OneFactor);
    expect(solar.blendDst).toBe(THREE.OneFactor);
    expect(solar.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(solar.blendDstAlpha).toBe(THREE.OneFactor);

    // The moon is the one thing here that genuinely occludes, so it keeps the mode that
    // replaces -- and it is the ONLY thing that occludes. The solar layer used to cut the
    // photosphere with `1.0 - moonMask` as well, and an alpha-blended layer cannot choose
    // what it attenuates: the composite was `m*moon + (1-m)*sky + (1-m)^2*photosphere`, the
    // sky occluded once and the photosphere twice. It showed as an eight-code dark line along
    // the inside of the crescent at coverage 0.90, one pixel wide, where m is strictly
    // between 0 and 1.
    expect(moonMaterial().blending).toBe(THREE.NormalBlending);
    expect(solarShaderOf()).toContain('float visibleSun = sunMask;');
    // The strong form of the same statement: the solar layer does not know about the moon's
    // coverage at all any more. It still knows where the moon IS -- the beads sit on the
    // moon's own limb -- so this is about the mask, not about the centre.
    expect(solarShaderOf()).not.toContain('moonMask');
    expect(solarShaderOf()).toContain('moonDistance');
  });

  test('emitted light is LINEAR in a term s strength, not squared', () => {
    const solar = solarMaterial();
    const authored = SOLAR_RADIANCE.innerCorona;
    // The shipped form was transparent + NormalBlending with `alpha = clamp(corona)` and
    // `color = coronaColor * corona * 6.25`, so what reached the framebuffer was
    // corona^2 * 6.25: half the strength gave a QUARTER of the light.
    for (const strength of [0.1, 0.25, 0.5, 0.75]) {
      expect(addedRadiance(solar, authored * strength, strength)).toBeCloseTo(
        addedRadiance(solar, authored, 1) * strength,
        9
      );
    }
  });

  test('the authored radial falloff is the falloff that gets emitted', () => {
    const solar = solarMaterial();
    // 48.0x from the Q table's anchor to r = 2.0. Under the squaring it emitted 48^2 = 2302x,
    // i.e. 48x too little light at r = 2.0 and exactly zero beyond the outer fade.
    const near = coronaRadialProfile(1.1);
    const far = coronaRadialProfile(2);
    const emittedNear = addedRadiance(solar, SOLAR_RADIANCE.innerCorona * near, near);
    const emittedFar = addedRadiance(solar, SOLAR_RADIANCE.innerCorona * far, far);
    expect(emittedNear / emittedFar).toBeCloseTo(near / far, 6);
  });

  test('the corona can only brighten the sky it sits on, never darken it', () => {
    const solar = solarMaterial();
    const sky = SOLAR_RADIANCE.umbralSky;
    let previous = -Infinity;
    for (let strength = 0; strength <= 1.0001; strength += 0.05) {
      // The sky underneath survives whole -- this is the assertion that a corona is light
      // added to a sky and not a surface that replaces one.
      expect(skyKept(solar, strength)).toBe(1);
      const composite =
        addedRadiance(solar, SOLAR_RADIANCE.innerCorona * strength, strength) +
        sky * skyKept(solar, strength);
      expect(composite).toBeGreaterThan(previous);
      previous = composite;
    }
    // At full strength the rim is 8x the sky it lies on, so the composite is 9x.
    expect(previous / sky).toBeCloseTo(9, 6);

    // The moon, by contrast, takes the sky away entirely where it is opaque.
    expect(skyKept(moonMaterial(), 1)).toBe(0);
  });
});

describe('solar limb darkening', () => {
  test('is the 550 nm quadratic, not the shipped 1.36:1 ramp', () => {
    // I(mu) = 0.3 + 0.93 mu - 0.23 mu^2. Hestroffer & Magnan 1998 A&A 333, 338 Table 1.
    expect(solarLimbIntensity(1)).toBeCloseTo(1, 12);
    expect(solarLimbIntensity(0.5)).toBeCloseTo(0.7075, 12);
    expect(solarLimbIntensity(0)).toBeCloseTo(0.3, 12);

    // The whole point: a crescent is made entirely of limb, so the centre-to-limb RANGE is
    // the number that decides whether a crescent looks like one. 3.33:1, not 1.22/0.9.
    expect(solarLimbIntensity(1) / solarLimbIntensity(0)).toBeCloseTo(10 / 3, 6);
  });

  test('falls monotonically from centre to limb', () => {
    let previous = Infinity;
    for (let i = 20; i >= 0; i -= 1) {
      const value = solarLimbIntensity(i / 20);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
    // Disc mean is 0.805 of centre: 2 * integral of mu * I(mu) d(mu) over the visible disc.
    let mean = 0;
    const samples = 20000;
    for (let i = 0; i < samples; i += 1) {
      const mu = (i + 0.5) / samples;
      mean += 2 * mu * solarLimbIntensity(mu);
    }
    expect(mean / samples).toBeCloseTo(0.805, 3);
  });

  test('the shader carries the same three coefficients', () => {
    const shader = solarShaderOf();
    expect(shader).toContain('float limbI = 0.3');
    expect(shader).toContain('0.93 + mu * (-0.23)');
    expect(shader).not.toContain('0.9 + limb * 0.32');
  });
});

describe('corona radial profile', () => {
  test('is a power law in solar radii anchored at the Q table s 1.1 R_sun', () => {
    // NASA RP-1318: Q=7 at 0.1 R_sun above the limb (r = 1.1) down to Q=1 at r = 2.0,
    // i.e. a 2^6 = 64x fall. The K + F sum gives 48.0x, which is the closest a single
    // exponent pair gets without also carrying the r^-15.9 slope inside r = 1.2.
    const drop = coronaRadialProfile(1.1) / coronaRadialProfile(2);
    expect(drop).toBeCloseTo(47.96, 1);
    expect(drop).toBeGreaterThan(40);
    expect(drop).toBeLessThan(80);

    // The defect it replaces: exp(-radial * 17.0) gives 0.257 at r = 1.5 against a ladder
    // value of 0.059, 4.4x too flat -- a uniform halo instead of a rim with streamers.
    expect(coronaRadialProfile(1.5) / coronaRadialProfile(1.1)).toBeLessThan(0.16);

    // Normalised at the anchor, so INNER_CORONA_RADIANCE is the radiance there and not a
    // number 1.8 per cent away from it.
    expect(coronaRadialProfile(1.1)).toBeCloseTo(1, 12);
  });

  test('the K and F terms cross inside the range the corona is drawn over', () => {
    // r^-7 = 0.018 r^-2.5 at r = 0.018^(-1/4.5) = 2.4418 R_sun, which is inside the
    // reference azimuth's 1.9 -> 2.6 fade, so the claim that F carries the outer corona is
    // true where it is drawn. Evaluating F at r/1.1 while K got r/1.1 too scales the two by
    // 1.1^7 and 1.1^2.5 -- different factors -- leaving F low by 1.1^4.5 = 1.536 and pushing
    // the crossover to 2.686, past the end of everything this shader draws.
    expect(CORONA_K_F_CROSSOVER_RADII).toBeCloseTo(2.4418, 4);
    expect(CORONA_K_F_CROSSOVER_RADII).toBeGreaterThan(2);
    expect(CORONA_K_F_CROSSOVER_RADII).toBeLessThan(2.6);
  });

  test('falls monotonically and never grows inside the limb', () => {
    let previous = Infinity;
    for (let r = 1; r <= 3.0001; r += 0.05) {
      const value = coronaRadialProfile(r);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    // r is clamped at the limb, so the profile cannot blow up toward the disc centre.
    expect(coronaRadialProfile(0)).toBe(coronaRadialProfile(1));
  });

  test('the shader uses pow in solar radii and no longer uses the exponential', () => {
    const shader = solarShaderOf();
    expect(shader).toContain('pow(r, -7.0)');
    expect(shader).toContain('pow(r / rayReach, -2.5)');
    expect(shader).not.toContain('exp(-radial * 17.0)');
    // Both powers see the SAME r, in true solar radii. Pre-dividing by the anchor was the
    // 35 per cent error in F.
    expect(shader).toContain('float r = max(coronaRadii, 1.0);');
    expect(shader).not.toContain('max(coronaRadii, 1.0) / 1.1');
  });

  test('every azimuth has its own reach, so the corona has a silhouette', () => {
    const shader = solarShaderOf();
    // The HDR rework deleted the rayLength/streamers pair -- per-azimuth radial EXTENT --
    // and left rayGain, a pure amplitude multiplier, so every ray ended on one circle.
    expect(shader).toContain('float rayReach = mix(0.8, 1.4,');
    // ...and the reach reaches both the outer fade and the F term, which is the term that
    // carries a streamer past 2.44 R_sun.
    expect(shader).toContain('1.9 * rayReach,');
    expect(shader).toContain('2.6 * rayReach, coronaRadii)');
    expect(shader).toContain('pow(r / rayReach, -2.5)');
    // Amplitude variation stays: no feature was traded for the one being restored.
    expect(shader).toContain('float rayGain = 0.35 + 0.65 * pow(coarseRays, 1.7)');
    // The drawn corona therefore ends anywhere from 2.08 to 3.64 R_sun, never on a circle.
    expect(2.6 * 0.8).toBeCloseTo(2.08, 6);
    expect(2.6 * 1.4).toBeCloseTo(3.64, 6);
  });
});

describe('the radiance ladder', () => {
  test('the two anchors are the two skies, and everything else is a stated ratio', () => {
    // Partial phase: the crescent's dimmest point is one stop under the radiance at which
    // the ACES fit saturates, so the whole 3.33:1 limb law lands on the curve's slope.
    expect(SOLAR_RADIANCE.limb).toBeCloseTo(SOLAR_RADIANCE.saturation * 0.5, 9);
    expect(SOLAR_RADIANCE.photosphere * solarLimbIntensity(0)).toBeCloseTo(
      SOLAR_RADIANCE.limb,
      9
    );
    // ...and that saturation radiance is where three's ACES fit really does clip, at this
    // hour's exposure. This is the check that keeps the anchor honest if either moves.
    expect(acesToneMap(SOLAR_RADIANCE.saturation * EXPOSURE_OVER_POINT_SIX)).toBeCloseTo(1, 6);
    expect(
      acesToneMap(SOLAR_RADIANCE.saturation * 0.999 * EXPOSURE_OVER_POINT_SIX)
    ).toBeLessThan(1);

    // Totality: the inner corona is three stops over the sky beside it.
    expect(SOLAR_RADIANCE.innerCorona / SOLAR_RADIANCE.umbralSky).toBeCloseTo(8, 9);

    // NASA RP-1318 Q ladder, 2^(Q - 7) against the inner corona.
    expect(SOLAR_RADIANCE.beads / SOLAR_RADIANCE.innerCorona).toBeCloseTo(32, 9);
    expect(SOLAR_RADIANCE.chromosphere / SOLAR_RADIANCE.innerCorona).toBeCloseTo(16, 9);
    expect(SOLAR_RADIANCE.prominence / SOLAR_RADIANCE.innerCorona).toBeCloseTo(4, 9);
    expect(SOLAR_RADIANCE.diamond / SOLAR_RADIANCE.innerCorona).toBeCloseTo(40, 9);
    // A bead is exposed photosphere at TOTALITY's exposure and the crescent is photosphere
    // at the partial phase's, so they are 11.4x apart on purpose. They coexist only in the
    // five seconds of a diamond ring, where a bead blowing out over the last sliver of
    // crescent is exactly what everybody who has stood in an umbra describes.
    expect(SOLAR_RADIANCE.beads / SOLAR_RADIANCE.limb).toBeCloseTo(11.409, 3);
  });

  test('the shader ships the numbers the ladder computes', () => {
    const shader = solarShaderOf();
    // Built through the module's own glslFloat from the module's own constants: these used
    // to be six literal strings ('limbI * 666.6667;') derived from a constant whose doc
    // comment tells the next person to re-edit it.
    expect(shader).toContain(`limbI * ${glslFloat(SOLAR_RADIANCE.photosphere)};`);
    expect(shader).toContain(`corona * ${glslFloat(SOLAR_RADIANCE.innerCorona)};`);
    expect(shader).toContain(`beads * ${glslFloat(SOLAR_RADIANCE.beads)};`);
    expect(shader).toContain(`diamond * ${glslFloat(SOLAR_RADIANCE.diamond)};`);
    expect(shader).toContain(`chromosphere * ${glslFloat(SOLAR_RADIANCE.chromosphere)};`);
    expect(shader).toContain(`prominence * ${glslFloat(SOLAR_RADIANCE.prominence)};`);
    expect(moonShaderOf()).toContain(`vec3(${glslFloat(SOLAR_RADIANCE.moonFloor)})`);
    // The magnitudes the baseline measured as "dimmer than the sky behind it".
    expect(shader).not.toContain('beads * 5.0');
    expect(shader).not.toContain('diamond * 9.0');
  });

  test('a bead peaks at the constant that names it', () => {
    const shader = solarShaderOf();
    // `beadShade = mix(0.62, 1.0, smoothstep(0.0, 0.35, mu))` sat at its 0.62 floor at
    // precisely the pixel `solarEdge` gates a bead to -- sunDistance == SUN_RADIUS, mu == 0
    // -- so the shipped bead peaked at 124 while the constant, the comment and this file all
    // said 200. A constant that is 38 per cent off is worse than no gradient at all.
    expect(shader).not.toContain('beadShade');
    expect(shader).toContain(`* beads * ${glslFloat(SOLAR_RADIANCE.beads)};`);
  });

  test('the worst-case sum stays far under the half-float ceiling', () => {
    // 65504 is all a HalfFloatType target holds. Over it, Metal stores +Inf and SwiftShader
    // stores NaN -- invisible on a dev GPU, a black frame in CI.
    expect(MAX_SOLAR_RADIANCE).toBeCloseTo(853.05, 1);
    // The layer is additive now, so what has to clear the ceiling is the sum PLUS the
    // brightest sky it can be drawn over.
    expect(MAX_SOLAR_RADIANCE + SOLAR_RADIANCE.sky).toBeLessThan(65504);
    expect(65504 / (MAX_SOLAR_RADIANCE + SOLAR_RADIANCE.sky)).toBeGreaterThan(40);

    // No single term may on its own be within a stop of the ceiling either.
    for (const value of Object.values(SOLAR_RADIANCE)) {
      expect(value * 2).toBeLessThan(65504);
    }
  });
});

describe('BITE CONTRAST: the crescent against the sky beside it', () => {
  test('is at least 3:1 in scene-linear radiance at 0.50, 0.75 and 0.90 coverage', () => {
    const timeline = new EclipseTimeline();
    const measured: number[] = [];
    for (const coverage of METRIC_COVERAGES) {
      const state = stateAtCoverage(timeline, coverage);
      expect(state.coverage).toBeCloseTo(coverage, 4);
      // The geometry the metric averages over is the timeline's own, not a copy of it.
      expect(eclipseCoverageAtSeparation(state.separation)).toBeCloseTo(coverage, 6);

      const crescent = SOLAR_RADIANCE.photosphere * crescentMeanLimb(state.separation);
      const sky = skyBesideDisc(state.irradiance);
      measured.push(crescent / sky);
      expect(crescent / sky).toBeGreaterThanOrEqual(BITE_CONTRAST_TARGET);
    }
    // It improves with coverage because the disc holds its surface brightness while the sky
    // loses its light, which is what an eclipse physically is. The value at coverage 0.50 was
    // 4.05 when this was written and is 4.19 now: `MINIMUM_IRRADIANCE` fell from 0.025 to
    // 0.0025, so `skyBesideDisc` reads a sky that has lost more of its light. The metric moved
    // in the right direction for a reason outside this file, and is pinned no more loosely.
    expect(measured[0]).toBeCloseTo(4.19, 1);
    expect(measured[2] / measured[0]).toBeGreaterThan(3);
  });

  test('the crescent presents brighter than the sky, in codes, at every partial phase', () => {
    const timeline = new EclipseTimeline();
    for (const coverage of [0.05, 0.2, 0.4, 0.6, 0.8, 0.9, 0.959]) {
      const state = stateAtCoverage(timeline, coverage);
      const crescent = presentedCode(
        SOLAR_RADIANCE.photosphere * crescentMeanLimb(state.separation)
      );
      const sky = presentedCode(skyBesideDisc(state.irradiance));
      // Codes against codes. The baseline read 168 against 251 here.
      expect(crescent).toBeGreaterThan(sky);
    }
    for (const coverage of METRIC_COVERAGES) {
      const state = stateAtCoverage(timeline, coverage);
      const crescent = presentedCode(
        SOLAR_RADIANCE.photosphere * crescentMeanLimb(state.separation)
      );
      expect(crescent - presentedCode(skyBesideDisc(state.irradiance))).toBeGreaterThan(3);
    }
  });

  test('the disc keeps presented variation instead of being one flat code', () => {
    // The old anchor put the dimmest point of the disc at 8x a sky that was itself at the
    // clip point: limb 200 and centre 666.67 both tone-mapped to 255, so the 3.33:1 range
    // this file is built around produced zero presented variation anywhere on the disc.
    const limb = presentedCode(SOLAR_RADIANCE.limb);
    const centre = presentedCode(SOLAR_RADIANCE.photosphere);
    expect(centre).toBeCloseTo(255, 1);
    expect(centre - limb).toBeGreaterThan(1);
    expect(presentedCode(200)).toBeCloseTo(255, 4);
    expect(presentedCode(666.667)).toBeCloseTo(255, 4);

    // The price of that variation: at the one moment the sky is still at the clip point --
    // coverage 0, i.e. before there is any bite -- the disc's extreme rim sits under it.
    // Under ACES that costs under two codes, and it is gone by coverage 0.1.
    const uneclipsedSky = presentedCode(SOLAR_RADIANCE.sky);
    expect(uneclipsedSky - limb).toBeLessThan(2);
  });
});

describe('the moon silhouette', () => {
  test('paints no earthshine while any photosphere is exposed', () => {
    const shader = moonShaderOf();
    // Against a photosphere at 55 there is no earthshine to see, so the partial-phase moon
    // is as dark as the encoder allows. The shipped `0.5 + uTotality * 0.8` painted a flat
    // grey over the bite at every coverage, which is half of why there was no bite to see.
    expect(shader).toContain('earthshine * uTotality * 1.3');
    expect(shader).not.toContain('0.5 + uTotality * 0.8');
  });

  test('never writes a literally black pixel, at any coverage or cloud cover', () => {
    const shader = moonShaderOf();
    // uTotality is exactly 0 below coverage 0.985 and the layer's alpha is 1, so without a
    // floor every interior pixel is written as 0.0 by design through both partial phases --
    // and exactly-black pixels are a standing invariant at 0.0000 per cent here. The max()
    // is applied after uTransmittance so cloud cannot push the disc back under it.
    expect(shader).toContain('max(interior, vec3(0.012))');
    expect(shader).toContain('vec3 interior = earthshine * uTotality * 1.3 * uTransmittance;');

    // The floor clears the code-0/code-1 rounding boundary with margin. Both sides of this
    // comparison are display-linear; the conversion happens once, here.
    const presented = acesToneMap(SOLAR_RADIANCE.moonFloor * EXPOSURE_OVER_POINT_SIX);
    expect(presented).toBeGreaterThan(SRGB_CODE_ONE_BOUNDARY);
    expect(presentedCode(SOLAR_RADIANCE.moonFloor)).toBeGreaterThanOrEqual(1);
    // It would take the exposure falling to 0.37x of this hour's before the floor stopped
    // clearing the boundary; the eclipse's own exposure cut is 0.82x.
    expect(
      acesToneMap(SOLAR_RADIANCE.moonFloor * EXPOSURE_OVER_POINT_SIX * 0.5)
    ).toBeGreaterThan(SRGB_CODE_ONE_BOUNDARY);

    // ...and it is still black to look at: 3 codes against a 251 sky at coverage 0.50.
    const timeline = new EclipseTimeline();
    const half = stateAtCoverage(timeline, 0.5);
    expect(presentedCode(SOLAR_RADIANCE.moonFloor)).toBeLessThan(8);
    expect(presentedCode(skyBesideDisc(half.irradiance))).toBeGreaterThan(240);
  });

  test('uTotality is exactly zero at every coverage the crescent is measured at', () => {
    const timeline = new EclipseTimeline();
    for (const progress of [0.1, 0.2, 0.28, 0.32, 0.35]) {
      const state = timeline.seek(progress);
      expect(state.coverage).toBeLessThan(0.985);
      expect(state.totality).toBe(0);
    }
  });
});

describe('uniforms across a swept progress', () => {
  test('stay inside their stated ranges for the whole 90 seconds', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const visual = new EclipseVisual(scene);
    const timeline = new EclipseTimeline();
    const sun = new THREE.Vector3(0.53, 0.153, -0.83).normalize();
    const solar = (scene.getObjectByName('eclipse-solar-layer') as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    const moon = (scene.getObjectByName('eclipse-moon-layer') as THREE.Mesh)
      .material as THREE.ShaderMaterial;

    const steps = 180;
    let lastTime = -1;
    for (let i = 0; i <= steps; i += 1) {
      const state = timeline.seek(i / steps);
      visual.update(camera, sun, { ...state, active: true }, 1 / 60, i / steps < 0.5 ? 0 : 1);

      expect(solar.uniforms.uTime.value).toBeGreaterThan(lastTime);
      lastTime = solar.uniforms.uTime.value;

      for (const name of ['uCorona', 'uBeads', 'uTotality', 'uProminences', 'uProminenceDetail']) {
        const value = solar.uniforms[name].value as number;
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      // Separation runs approach to approach now, not contact to contact: the moon enters
      // and leaves the picture instead of being born on the sun's limb. The bound that
      // matters is the billboard's, and it is asserted against the disc radii below.
      expect(Math.abs(solar.uniforms.uSeparation.value as number)).toBeLessThanOrEqual(1);
      // Cloud never blacks the sun out entirely; 0.08 is the floor the update clamps to.
      const transmittance = solar.uniforms.uTransmittance.value as number;
      expect(transmittance).toBeGreaterThanOrEqual(0.08);
      expect(transmittance).toBeLessThanOrEqual(1);

      // The one that matters for the silhouette: earthshine is gated on uTotality, and it
      // may never be non-zero while a crescent is still exposed.
      expect(moon.uniforms.uCoverage.value).toBeCloseTo(state.coverage, 12);
      if (state.coverage < 0.985) expect(moon.uniforms.uTotality.value).toBe(0);
    }

    visual.dispose();
  });

  test('quality levels only move uDetail, which the corona ray gain reads', () => {
    const scene = new THREE.Scene();
    const visual = new EclipseVisual(scene);
    const solar = (scene.getObjectByName('eclipse-solar-layer') as THREE.Mesh)
      .material as THREE.ShaderMaterial;

    for (const level of ['low', 'medium', 'high'] as const) {
      visual.setQuality(level);
      const detail = solar.uniforms.uDetail.value as number;
      expect(detail).toBeGreaterThanOrEqual(0);
      expect(detail).toBeLessThanOrEqual(1);
    }
    // uDetail only reaches the fine-ray mix, so dropping quality cannot dim the corona:
    // mix(0.75, 1.0, fineRays * uDetail) is bounded below by 0.75 at uDetail 0.
    expect(solarShaderOf(scene)).toContain('mix(0.75, 1.0, fineRays * uDetail)');
    visual.dispose();
  });
});

describe('the drawn sun is big enough to see covered', () => {
  /**
   * This pinned 0.16 exactly, on the grounds that both judges of the design round killed a
   * proposal to SHRINK it -- at true size the crescent is 0.95 px at coverage 0.90. That
   * reasoning is right and is kept; the exact value is not, because measurement moved it.
   *
   * With the layers isolated one at a time on the built product, the drawn photosphere adds
   * nothing during the partial phases: "sun only" is indistinguishable from "sky only" at
   * coverage 0.72 and at 0.96, because the sky beside a sun 8.8 degrees up is Preetham's
   * forward lobe clipped at 254 of 255, and an additive layer cannot beat white. Every
   * readable pixel of a partial eclipse is the MOON, which replaces the sky instead of adding
   * to it. So the only lever on "you must be able to see the sun being covered" is how many
   * pixels wide that dark bite is -- and at 0.16 it was ten.
   *
   * The bound is a floor, not an equality, so the next honest retune does not have to come
   * back here; what it may not do is give back the legibility this exists to protect.
   */
  test('the disc is at least three times life size, and the moon still overhangs it', () => {
    const shader = solarShaderOf();
    expect(shader).toContain(`const float SUN_RADIUS = ${glslFloat(SUN_DISC_RADIUS)};`);
    expect(shader).toContain(`const float MOON_RADIUS = ${glslFloat(MOON_DISC_RADIUS)};`);
    expect(moonShaderOf()).toContain(`const float SUN_RADIUS = ${glslFloat(SUN_DISC_RADIUS)};`);

    // One constant feeds both shaders now; they used to be two literals that could drift.
    const solarRadii = [...shader.matchAll(/const float (SUN|MOON)_RADIUS = ([0-9.]+);/g)];
    expect(solarRadii).toHaveLength(2);

    // 0.052 uv of a 120-unit billboard at 680 units is the real 0.5334 deg across.
    const LIFE_SIZE_UV = 0.052;
    expect(SUN_DISC_RADIUS / LIFE_SIZE_UV).toBeGreaterThan(3);
    // ...and not so large that the sun stops reading as a sun.
    expect(SUN_DISC_RADIUS / LIFE_SIZE_UV).toBeLessThan(6);
    // Magnitude 1.01875 -- a total eclipse needs the moon larger than the sun.
    expect(MOON_OVER_SUN).toBeCloseTo(1.01875, 6);
  });
});

/**
 * THE SILHOUETTE: the moon has to read as a disc crossing the sun, not as a bite growing.
 *
 * The moon layer used to mask itself with the sun's own circle -- `moonMask * max(sunMask,
 * uTotality)` -- so during both partial phases the only thing drawn was the INTERSECTION of
 * two circles. The sun beside it is invisible at this exposure (see SUN_DISC_RADIUS), so what
 * the viewer saw was a vesica standing on end, appearing in the middle of a white glare at
 * coverage 0.14 and swelling. Everything below pins the geometry that stops that.
 */
describe('the moon is drawn as a disc, and it travels', () => {
  test('the whole disc fits on the billboard for the whole traverse', () => {
    // Past MOON_BILLBOARD_LIMIT the quad runs out and the moon is cut by a straight edge,
    // which is worse than not drawing it. The two constants live in different files, so this
    // is the only place the traverse is checked against the geometry it is drawn on.
    expect(1).toBeLessThan(MOON_BILLBOARD_LIMIT);
    // ...and the same thing again from the SHADER's own geometry rather than from the
    // constant's definition. Restating `(1 - MOON) / (SUN + MOON)` here would compare
    // MOON_BILLBOARD_LIMIT with itself and pass for every possible value of all three, which
    // is a mistake this repository has already made once. What actually has to hold is that
    // the moon's far edge -- where MOON_CENTER_CHUNK puts its centre, plus its radius -- stays
    // inside the quad, whose half-width is 1 in these units.
    const farEdge = 1 * (SUN_DISC_RADIUS + MOON_DISC_RADIUS) + MOON_DISC_RADIUS;
    expect(farEdge).toBeLessThan(1);
    // 0.729 of the way out at first contact, which is as far as the moon ever gets.
    expect(farEdge).toBeCloseTo(0.729, 3);
  });

  test('the sun makes the moon opaque, it does not clip it', () => {
    const shader = moonShaderOf();
    // The defect this replaces was `moonMask * max(sunMask, uTotality)`: uTotality is 0 below
    // coverage 0.985, so through both partial phases the moon was CLIPPED to the sun's circle
    // and the only shape on screen was the intersection of the two. `max` with a reveal that
    // rises with coverage keeps the one true part of that -- full opacity over the photosphere
    // -- and lets the rest of the disc appear as the sun is covered.
    expect(shader).toContain('float mask = moonMask * max(sunMask, reveal);');
    expect(shader).not.toContain('uTotality)');
    // ...and the reveal is driven by coverage, not by where the moon happens to be.
    expect(shader).toContain('uCoverage / ');
    expect(shader).not.toContain('abs(uSeparation)');
  });

  test('both layers get the moon POSITION from one definition, and only one draws its edge', () => {
    // Both shaders need to know where the moon is -- this layer to draw it, the solar layer
    // to put the beads on its limb -- and two copies of those two lines is a seam waiting to
    // happen. The whole chunk, not a prefix of it: a truncated `toContain` would still match
    // a copy that had drifted after the point where the string stops.
    for (const shader of [solarShaderOf(), moonShaderOf()]) {
      expect(shader).toContain(MOON_CENTER_CHUNK.trim());
    }
    // The edge is a pixel wide wherever it is drawn, rather than 0.003 billboard units --
    // which was 0.26 px at the framing this was measured on and a different number of pixels
    // on every other viewport. It exists once, in the layer that occludes.
    expect(moonShaderOf()).toContain(
      'float moonEdge = max(fwidth(d) * 0.5, 1e-5);\n' +
        '    float moonMask = 1.0 - smoothstep(MOON_RADIUS - moonEdge, MOON_RADIUS + moonEdge, d);'
    );
    expect(solarShaderOf()).not.toContain('fwidth');
  });

  test('the moon crosses on a straight chord, along a direction the SKY chooses', () => {
    // It was `0.018 * sin(uSeparation * 2.4)`, which is not a chord at all: it turns back on
    // itself at |separation| = 0.654. Then it was `vec2(moonOffset, moonOffset * 0.025)`, a
    // straight chord 1.43 degrees off horizontal -- and pointing the wrong way.
    expect(MOON_CENTER_CHUNK).toContain('vec2 moonCenter = moonOffset * uMoonPath;');
    expect(MOON_CENTER_CHUNK).not.toContain('sin(');
    expect(MOON_CENTER_CHUNK).not.toMatch(/0\.0\d+/);
    // The diamond ring sits on the limb the moon has yet to cover, so it rides the same chord.
    expect(solarShaderOf()).toContain('contactSide * SUN_RADIUS * uMoonPath');
  });

  /** Drive one update at a stated sun direction and read the chord the shaders were given. */
  const moonPathFor = (sun: THREE.Vector3): THREE.Vector2 => {
    const scene = new THREE.Scene();
    const visual = new EclipseVisual(scene);
    const material = (scene.getObjectByName('eclipse-moon-layer') as THREE.Mesh)
      .material as THREE.ShaderMaterial;
    visual.update(
      new THREE.PerspectiveCamera(),
      sun.clone().normalize(),
      { ...new EclipseTimeline().seek(0.2), active: true },
      1 / 60,
      0
    );
    const path = (material.uniforms.uMoonPath.value as THREE.Vector2).clone();
    visual.dispose();
    return path;
  };

  test('at a northern noon the moon moves LEFT, which is the eclipse in every photograph', () => {
    // The case with an answer everybody already knows, and the one that catches a sign. A
    // noon sun stands due south; the moon laps it eastward; facing south, east is on the left.
    // So the bite starts on the sun's RIGHT limb and the shadow walks left. Billboard +X is
    // the camera's right vector, so a correct chord has a NEGATIVE x here.
    const noon = sunDirectionAt(
      clockFromSolarPhase(0.5 as SolarPhase01, THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians),
      THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians
    );
    const path = moonPathFor(noon);
    expect(path.x).toBeLessThan(0);
    expect(path.x).toBeCloseTo(-1, 3);
    // Due south at noon the sun rides its own parallel, so the chord is horizontal.
    expect(Math.abs(path.y)).toBeLessThan(0.01);
  });

  test('at the staged eclipse hour it crosses from the lower right to the upper left', () => {
    // 8.8 degrees up on a bearing of 297: celestial east there is 144 degrees round from
    // screen right, so the moon comes in low on the right and leaves high on the left. The
    // shipped chord had it at 1.4 degrees the OTHER way, which is the defect this pins.
    const declination = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;
    const sun = sunDirectionAt(
      clockFromSolarPhase(ECLIPSE_VIEW_SOLAR_PHASE, declination),
      declination
    );
    const path = moonPathFor(sun);
    expect(path.x).toBeLessThan(0);
    expect(path.y).toBeGreaterThan(0);
    expect((Math.atan2(path.y, path.x) * 180) / Math.PI).toBeCloseTo(143.6, 0);
    expect(path.length()).toBeCloseTo(1, 6);
  });

  test('the chord follows the sun rather than being baked, so it follows the theme', () => {
    const june = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;
    const autumn = THREE.MathUtils.degToRad(AUTUMN_DECLINATION_DEG) as Radians;
    const angle = (declination: Radians): number => {
      const path = moonPathFor(
        sunDirectionAt(clockFromSolarPhase(ECLIPSE_VIEW_SOLAR_PHASE, declination), declination)
      );
      return (Math.atan2(path.y, path.x) * 180) / Math.PI;
    };
    // The same staged hour, two declinations, two bearings, two chords -- and both of them
    // up and to the left, which is the half of this that must never depend on the season.
    expect(angle(june)).toBeCloseTo(143.6, 0);
    expect(angle(autumn)).toBeCloseTo(145.5, 0);
    expect(angle(june)).not.toBeCloseTo(angle(autumn), 1);
  });
});

describe('the sun reveals the moon, and it does so where the tone curve can show it', () => {
  /** The shader's own reveal, restated. Pinned against the shipped GLSL by the test below. */
  const revealAt = (coverage: number): number =>
    1 - MOON_REVEAL_SKY_FRACTION ** (coverage / MOON_REVEAL_COVERAGE);

  /** What the silhouette presents as against the sky beside it, under normal blending. */
  const discCode = (coverage: number, irradiance: number): number => {
    const reveal = revealAt(coverage);
    return presentedCode(
      (1 - reveal) * skyBesideDisc(irradiance) + reveal * SOLAR_RADIANCE.moonFloor
    );
  };

  test('the SHIPPED GLSL is the expression these tests reason about', () => {
    // Everything below runs against `revealAt`, a TypeScript restatement of the shader. That
    // is the right instrument -- it is the only way to get at presented levels -- but on its
    // own it pins nothing about the product: the shader could be edited to anything and the
    // tests would still pass. So the shader text is built from the SAME two constants and
    // checked here, exactly as the radiance ladder above is.
    const shader = moonShaderOf();
    expect(shader).toContain(`float reveal = 1.0 - pow(`);
    expect(shader).toContain(`      ${glslFloat(MOON_REVEAL_SKY_FRACTION)},`);
    expect(shader).toContain(`      uCoverage / ${glslFloat(MOON_REVEAL_COVERAGE)});`);
    // Not clamped: past the reveal the exponent keeps growing, which is what takes the last
    // thousandth of sky out of the disc without a second expression joined onto the first.
    expect(shader).not.toMatch(/clamp\([^)]*uCoverage/);
    expect(shader).not.toMatch(/min\(1\.0, *uCoverage/);
  });

  test('there is no moon at all until the sun is being covered', () => {
    // THE COMPLAINT THIS PINS. The first version of the silhouette faded on the moon's
    // distance from the sun, so a complete black ball crossed an empty sky for nine seconds
    // before anything happened to the sun. At coverage 0 the disc must be exactly the sky.
    expect(revealAt(0)).toBe(0);
    expect(discCode(0, 1)).toBeCloseTo(presentedCode(skyBesideDisc(1)), 12);
  });

  test('reveals itself gradually, and is opaque before the bite could look grey', () => {
    const timeline = new EclipseTimeline();
    // Presented levels against the sky beside the disc at the same moment, so the sky's own
    // darkening is in the comparison rather than pretended away.
    const rows = [0.02, 0.05, 0.1, 0.2, 0.3, MOON_REVEAL_COVERAGE, 0.5, 0.75, 0.9].map(
      (coverage) => {
        const state = stateAtCoverage(timeline, coverage);
        return {
          coverage,
          disc: discCode(state.coverage, state.irradiance),
          sky: presentedCode(skyBesideDisc(state.irradiance)),
        };
      }
    );
    // Monotone, and separated from the sky the whole way down.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].disc).toBeLessThan(rows[i - 1].disc);
    }
    // Legible as a disc by a tenth of coverage -- 5.7 s into the ninety -- which is what stops
    // the early partial phase reading as a lens with nothing around it.
    const at10 = rows.find((r) => r.coverage === 0.1)!;
    expect(at10.sky - at10.disc).toBeGreaterThan(15);
    // Black by the time the reveal is done, or the bite would be grey against the photosphere.
    const done = rows.find((r) => r.coverage === MOON_REVEAL_COVERAGE)!;
    expect(done.disc).toBeLessThan(20);
    // ...and on the MOON_MINIMUM_RADIANCE floor well before totality.
    expect(rows[rows.length - 1].disc).toBeCloseTo(
      presentedCode(SOLAR_RADIANCE.moonFloor),
      0
    );
  });

  test('ramps in PRESENTED levels, which is the thing a linear opacity ramp cannot do', () => {
    // THE DEFECT THIS PINS. The first fade here was linear in alpha, and it was a pop:
    // measured at the moon's own centre pixel on the built product,
    //
    //     separation   -1.183  -1.134  -1.084  -1.033  -1.008  -0.982
    //     centre luma     253     253     250      84       7       8
    //
    // Nothing for two thirds of the travel and then 253 to 7 in 1.3 seconds. ACES maps a sky
    // of 25 to code 254 and HALF that sky to code 252 -- two codes for half the light -- so a
    // ramp that is linear in opacity spends almost all of its travel invisible.
    const timeline = new EclipseTimeline();
    let previous = discCode(0, 1);
    let largestStep = 0;
    for (let step = 1; step <= 400; step += 1) {
      const state = timeline.seek(step / 1000);
      const code = discCode(state.coverage, state.irradiance);
      expect(code).toBeLessThanOrEqual(previous + 1e-9);
      largestStep = Math.max(largestStep, previous - code);
      previous = code;
    }
    // A thousandth of the timeline is a tenth of a second at the shipped 90 s. Run through
    // this same instrument a linear-in-opacity reveal steps about 25 levels in ONE of those;
    // this one steps under eight.
    expect(largestStep).toBeLessThan(8);
    // And it really does travel the whole way down inside those first forty seconds.
    expect(previous).toBeLessThan(12);
  });
});
