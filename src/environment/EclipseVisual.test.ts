import * as THREE from 'three';
import { afterAll, describe, expect, test } from 'vitest';
import {
  EclipseVisual,
  MAX_SOLAR_RADIANCE,
  SOLAR_RADIANCE,
  coronaRadialProfile,
  solarLimbIntensity,
} from './EclipseVisual';
import { EclipseTimeline } from '../experience/EclipseTimeline';

/**
 * THE ACCEPTANCE METRIC THIS FILE CANNOT RUN.
 *
 * **BITE CONTRAST** = mean luminance of the exposed crescent's pixels / mean luminance of
 * the moon-disc interior, on lossless PNG captures at coverage 0.50, 0.75 and 0.90.
 * **Required: >= 3.0 at all three.** It is the only number anywhere that measures the
 * owner's second sentence -- you must be able to SEE the sun being covered -- and it is the
 * gate that should veto any future disc-size, bloom or tone change that closes the bite.
 * The baseline it replaces: at coverage 0.959 the billboard made ZERO pixels of the centre
 * row brighter and the disc read a uniform 227.7 against a 250.5 sky.
 *
 * It needs a renderer, so nothing below measures it. What the tests below do instead is pin
 * the three structural properties that make it reachable, each of which was false before:
 *   1. the crescent is bright -- its DIMMEST point (the extreme limb, where a deep crescent
 *      entirely lives) is `limbOverSky` times the sky it sits on, at every partial phase;
 *   2. the moon interior is BLACK during every partial phase, so the denominator is the
 *      encoder's floor rather than a painted grey;
 *   3. nothing in the sum overflows a half-float, because an overflow is invisible on a dev
 *      GPU and only turns the frame black in CI.
 *
 * Drawn crescent width at SUN_RADIUS 0.16 (1.614 deg drawn, a deliberate 3.03x
 * exaggeration that must NOT be reduced): 0.656 deg at coverage 0.50, 0.325 at 0.75,
 * 0.134 at 0.90, 0.070 at 0.95 -- 14.2 / 7.0 / 2.9 / 1.5 px at 1080p and a 50 deg vertical
 * FOV. Those are the widths the metric is averaging over.
 */
const BITE_CONTRAST_TARGET = 3;

/** sRGB code 1 is linear 1.518e-4; nothing presented can sit below it and still be black. */
const SRGB_CODE_ONE_LINEAR = 1.518e-4;

const materialOf = (scene: THREE.Scene, name: string): THREE.ShaderMaterial =>
  (scene.getObjectByName(name) as THREE.Mesh).material as THREE.ShaderMaterial;

const shaderScene = new THREE.Scene();
const shaderVisual = new EclipseVisual(shaderScene);
afterAll(() => shaderVisual.dispose());

const solarShaderOf = (scene: THREE.Scene = shaderScene): string =>
  materialOf(scene, 'eclipse-solar-layer').fragmentShader;

const moonShaderOf = (scene: THREE.Scene = shaderScene): string =>
  materialOf(scene, 'eclipse-moon-layer').fragmentShader;

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
    // i.e. a 2^6 = 64x fall. The K + F sum gives 52.8x, which is the closest a single
    // exponent pair gets without also carrying the r^-15.9 slope inside r = 1.2.
    const drop = coronaRadialProfile(1.1) / coronaRadialProfile(2);
    expect(drop).toBeGreaterThan(40);
    expect(drop).toBeLessThan(80);

    // The defect it replaces: exp(-radial * 17.0) gives 0.257 at r = 1.5 against a ladder
    // value of 0.059, 4.4x too flat -- a uniform halo instead of a rim with streamers.
    expect(coronaRadialProfile(1.5) / coronaRadialProfile(1.1)).toBeLessThan(0.16);
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
    expect(shader).toContain('pow(r, -2.5)');
    expect(shader).not.toContain('exp(-radial * 17.0)');
    // The outer fade is a ratio of SUN_RADIUS now, so it survives any future disc resize.
    expect(shader).toContain('1.9, 2.6, coronaRadii');
  });
});

describe('the radiance ladder', () => {
  test('every magnitude is a stated ratio, and the shader ships those numbers', () => {
    // Ratio TO the sky at the eclipse hour, pinned at the limb because a deep crescent is
    // all limb: 8:1 against the brightest sky it will ever sit on, so every partial phase
    // is better than that.
    expect(SOLAR_RADIANCE.photosphere * solarLimbIntensity(0)).toBeCloseTo(
      SOLAR_RADIANCE.sky * SOLAR_RADIANCE.limbOverSky,
      9
    );
    expect(SOLAR_RADIANCE.limbOverSky).toBeGreaterThanOrEqual(BITE_CONTRAST_TARGET);

    // NASA RP-1318 Q ladder, 2^(Q - 7) against the inner corona.
    expect(SOLAR_RADIANCE.beads / SOLAR_RADIANCE.innerCorona).toBeCloseTo(32, 9);
    expect(SOLAR_RADIANCE.chromosphere / SOLAR_RADIANCE.innerCorona).toBeCloseTo(16, 9);
    expect(SOLAR_RADIANCE.prominence / SOLAR_RADIANCE.innerCorona).toBeCloseTo(4, 9);
    expect(SOLAR_RADIANCE.diamond / SOLAR_RADIANCE.innerCorona).toBeCloseTo(40, 9);
    // A bead is exposed photosphere seen through a lunar valley, so it is limb radiance.
    expect(SOLAR_RADIANCE.beads).toBeCloseTo(
      SOLAR_RADIANCE.photosphere * solarLimbIntensity(0),
      9
    );

    const shader = solarShaderOf();
    expect(shader).toContain('limbI * 666.6667;');
    expect(shader).toContain('corona * 6.25;');
    expect(shader).toContain('beadShade * 200.0;');
    expect(shader).toContain('diamond * 250.0;');
    expect(shader).toContain('chromosphere * 100.0;');
    expect(shader).toContain('prominence * 25.0;');
    // The magnitudes the baseline measured as "dimmer than the sky behind it".
    expect(shader).not.toContain('beads * 5.0');
    expect(shader).not.toContain('diamond * 9.0');
  });

  test('the worst-case sum stays far under the half-float ceiling', () => {
    // 65504 is all a HalfFloatType target holds. Over it, Metal stores +Inf and SwiftShader
    // stores NaN -- invisible on a dev GPU, a black frame in CI. This change raises the
    // photosphere 546x, so the bound is pinned rather than assumed.
    expect(MAX_SOLAR_RADIANCE).toBeCloseTo(1513.99, 1);
    expect(MAX_SOLAR_RADIANCE).toBeLessThan(65504);
    expect(65504 / MAX_SOLAR_RADIANCE).toBeGreaterThan(40);

    // No single term may on its own be within a stop of the ceiling either.
    for (const value of Object.values(SOLAR_RADIANCE)) {
      expect(value * 2).toBeLessThan(65504);
    }
  });
});

describe('the moon silhouette', () => {
  test('paints no earthshine while any photosphere is exposed', () => {
    const shader = moonShaderOf();
    // Against a photosphere at 666 there is no earthshine to see, so the partial-phase moon
    // is black. The shipped `0.5 + uTotality * 0.8` painted a flat grey over the bite at
    // every coverage, which is half of why there was no bite to see.
    expect(shader).toContain('earthshine * uTotality * 1.3');
    expect(shader).not.toContain('0.5 + uTotality * 0.8');
  });

  test('uTotality is exactly zero at every coverage the crescent is measured at', () => {
    const timeline = new EclipseTimeline();
    for (const progress of [0.1, 0.2, 0.28, 0.32, 0.35]) {
      const state = timeline.seek(progress);
      expect(state.coverage).toBeLessThan(0.985);
      expect(state.totality).toBe(0);
    }
    // ...which makes the BITE CONTRAST denominator the encoder's floor, not a painted grey.
    const crescentFloor = SOLAR_RADIANCE.photosphere * solarLimbIntensity(0);
    expect(crescentFloor / SRGB_CODE_ONE_LINEAR).toBeGreaterThan(BITE_CONTRAST_TARGET);
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
      // Separation runs contact to contact; the shader offsets the moon by it, so outside
      // [-1.25, 1.25] the moon would leave the billboard and the bite would vanish.
      expect(Math.abs(solar.uniforms.uSeparation.value as number)).toBeLessThanOrEqual(1.25);
      // Cloud never blacks the sun out entirely; 0.08 is the floor the update clamps to.
      const transmittance = solar.uniforms.uTransmittance.value as number;
      expect(transmittance).toBeGreaterThanOrEqual(0.08);
      expect(transmittance).toBeLessThanOrEqual(1);

      const coverage = moon.uniforms.uCoverage.value as number;
      expect(coverage).toBeGreaterThanOrEqual(0);
      expect(coverage).toBeLessThanOrEqual(1);
      // The one that matters for the silhouette: earthshine is gated on this, and it may
      // never be non-zero while a crescent is still exposed.
      if (coverage < 0.985) expect(moon.uniforms.uTotality.value).toBe(0);
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

describe('the drawn sun keeps its size', () => {
  test('SUN_RADIUS is unchanged at 0.16, and the moon still overhangs it', () => {
    // 0.16 uv of a 120-unit billboard at 680 units is 1.614 deg, a 3.03x exaggeration of the
    // real 0.5334 deg. It is a legibility choice, not an oversight: at true size the
    // crescent is 0.95 px at coverage 0.90 and 0.50 px at 0.95, which is the owner's second
    // sentence traded away. Both judges killed shrinking it.
    const shader = solarShaderOf();
    expect(shader).toContain('const float SUN_RADIUS = 0.16;');
    expect(shader).toContain('const float MOON_RADIUS = 0.163;');
    // Magnitude 1.01875 -- a total eclipse needs the moon larger than the sun.
    expect(0.163 / 0.16).toBeGreaterThan(1);
  });
});
