import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  cloudDaylightAt,
  eclipseDiffuseFraction,
  eclipseRingRadiance,
  environmentTransitionAt,
  preethamHandoff,
  shadowNormalBias,
  shadowTexelSize,
  snapShadowFocus,
  starAlphaAt,
  umbraSemiMajorKm,
  UMBRA_SEMI_WIDTH_KM,
  umbraTraverse,
  UMBRA_TRAVERSE_LIMIT,
  umbraWallDistanceKm,
  withEclipseSky,
  withRadianceCeiling,
  withTwilightDome,
} from './DayNightCycle';
// The module's own source text: nothing in `tsc` or `vitest` reads a comment, so the doc-link
// test below has to read the file. `?raw` keeps it inside Vite's own resolution.
import dayNightCycleSource from './DayNightCycle.ts?raw';
import { beamTransmittanceColor, twilightSkyColorCached } from './SunlightSpectrum';
import { adaptingLuminance } from './ViewerAdaptation';
import { EclipseTimeline } from '../experience/EclipseTimeline';

describe('PMREM environment transition', () => {
  test('crossfades maps without changing the total environment intensity', () => {
    const samples = Array.from({ length: 21 }, (_, index) =>
      environmentTransitionAt(index / 20)
    );

    expect(samples[0].blend).toBe(0);
    expect(samples[samples.length - 1].blend).toBe(1);
    expect(new Set(samples.map((sample) => sample.intensity)).size).toBe(1);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index].blend).toBeGreaterThan(samples[index - 1].blend);
    }
  });
});

describe('environment probe radiance ceiling', () => {
  /** Largest finite half float, and the spacing between halves just below it. */
  const HALF_MAX = 65504;
  const HALF_STEP_NEAR_MAX = 32;

  // The real shader Three.js ships, so a rename upstream fails here and not in a browser.
  const patched = withRadianceCeiling(new Sky().material.fragmentShader);
  const ceiling = Number(/min\( texColor, vec3\( ([\d.]+) \) \)/.exec(patched)?.[1]);

  test('keeps the probe sky inside a half-float render target', () => {
    // Every PMREM target is HalfFloatType. Over the ceiling, SwiftShader stores NaN
    // where an M1 stores +Inf -- 4 solar-disc texels became 10 126 NaN texels of the
    // atlas, and the frame came back 94.4 per cent black with the geometry still drawn.
    expect(ceiling).toBeLessThanOrEqual(HALF_MAX);
    // Exactly representable, so rounding to nearest cannot lift it back over the limit.
    expect(ceiling % HALF_STEP_NEAR_MAX).toBe(0);
    // ...and far above anything the sky itself reaches: the brightest the disc-less sky
    // measured across a sweep of season and hour was 142.
    expect(ceiling).toBeGreaterThan(1000);
  });

  test('clamps before the write, not after it', () => {
    expect(patched.indexOf('min( texColor')).toBeLessThan(
      patched.indexOf('gl_FragColor = vec4( texColor')
    );
  });

  test('fails loudly if the Sky shader stops writing where the patch expects', () => {
    // The patch is silent when it misses, and what it prevents is a black frame on one
    // class of rasteriser only -- the kind of thing that reaches CI rather than a desk.
    expect(() => withRadianceCeiling('void main() {}')).toThrow(/radiance ceiling/);
  });
});

describe('shadow grid', () => {
  const sunDir = new THREE.Vector3(0.4, 0.7, 0.3).normalize();
  const snap = (focus: THREE.Vector3, texel: number) =>
    snapShadowFocus(
      focus,
      sunDir,
      texel,
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3()
    ).clone();

  test('sizes a texel from the frustum the camera actually gets, not the constructor', () => {
    // High profile: a 1024 map, and a street view settles the radius near 69 m.
    expect(shadowTexelSize(69.4, 1024)).toBeCloseTo(0.1355, 4);
    // A wide view drops the map to 512 over the same frustum: twice as coarse.
    expect(shadowTexelSize(69.4, 512)).toBeCloseTo(0.271, 3);
    expect(shadowTexelSize(95, 0)).toBeGreaterThan(0);
  });

  test('biases by more than the texel that hides the sill shadow it cannot draw', () => {
    // 0.2 m was the value photographed clean at a 0.136 m texel; 0.12 m was not.
    expect(shadowNormalBias(shadowTexelSize(69.4, 1024))).toBeGreaterThanOrEqual(0.2);
    // ...and it follows the texel, so a wide view is not left under-biased.
    expect(shadowNormalBias(shadowTexelSize(69.4, 512))).toBeGreaterThan(
      shadowNormalBias(shadowTexelSize(69.4, 1024))
    );
  });

  test('quantises a focus that drifts continuously', () => {
    const texel = shadowTexelSize(69.4, 1024);
    const right = new THREE.Vector3(0, 1, 0).cross(sunDir).normalize();
    // Drift the focus across the light by a tenth of a texel, forty times over.
    const seen = new Set<string>();
    let previous = snap(new THREE.Vector3(10, 2, -4), texel);
    for (let step = 1; step <= 40; step++) {
      const focus = new THREE.Vector3(10, 2, -4).addScaledVector(right, step * texel * 0.1);
      const snapped = snap(focus, texel);
      const moved = snapped.distanceTo(previous);
      // Either it did not move at all, or it moved by a whole texel. Never in between.
      expect(moved < 1e-9 || Math.abs(moved - texel) < 1e-6).toBe(true);
      seen.add(snapped.toArray().map((v) => v.toFixed(6)).join(','));
      previous = snapped;
    }
    // Four metres of drift over a 0.1355 m grid: about thirty steps, not forty positions.
    expect(seen.size).toBeLessThan(40);
    expect(seen.size).toBeGreaterThan(1);
  });

  test('keeps the frustum over what the camera looks at', () => {
    const texel = shadowTexelSize(69.4, 1024);
    const focus = new THREE.Vector3(-18, 3, 27);
    // The component along the light is untouched, so the near/far range still covers it,
    // and the focus is never displaced by more than a texel of the grid it snapped to.
    const snapped = snap(focus, texel);
    expect(snapped.dot(sunDir)).toBeCloseTo(focus.dot(sunDir), 6);
    expect(snapped.distanceTo(focus)).toBeLessThan(texel);
  });

  test('survives the sun straight overhead', () => {
    const overhead = new THREE.Vector3(0, 1, 0);
    const snapped = snapShadowFocus(
      new THREE.Vector3(4, 1, 9),
      overhead,
      0.1355,
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3()
    );
    expect(Number.isFinite(snapped.x)).toBe(true);
    expect(Number.isFinite(snapped.y)).toBe(true);
    expect(Number.isFinite(snapped.z)).toBe(true);
  });
});

/**
 * What a cloud deck does to daylight.
 *
 * Every assertion here is an **external** fact -- a published relation, a standard
 * illuminance, an angular diameter -- and not a restatement of the implementation. The
 * centrepiece is that the beam and the fill, reconstructed back into klux, have to land
 * on Kasten & Czeplak's own curve: that ties the two multipliers and the exponent
 * together, so no single constant can be moved without the sum going wrong.
 *
 * **Mutation results.** Each mutation below was applied alone to `cloudDaylightAt` and the
 * file re-run; the count is how many of these eight tests went red. None survived.
 *
 * | mutation                                      | tests failed |
 * | --------------------------------------------- | ------------ |
 * | `beam: 1 - u` -> `1 - u * 0.62` (a beam floor) | 4            |
 * | `fill: 1 + (u * 2) / 3` -> `1` (today's bug)   | 3            |
 * | `fill: (u * 2) / 3` -> `(u * 3) / 3`           | 2            |
 * | `penumbra: 1 + u * 2` -> `1` (no softening)    | 2            |
 * | `penumbra: 1 + u * 2` -> `1 + u * 4`           | 2            |
 * | `** 3.4` -> `** 1` (linear in cover)           | 2            |
 * | `** 3.4` -> `** 3.5`                           | 1            |
 * | `(cloudCover - 0.12) / 0.8` -> `cloudCover`    | 7            |
 * | `clamp01(...)` -> unclamped                    | 3            |
 *
 * The `fill -> 1` row is the shipped defect this change fixes, so it is the row that had
 * to be non-zero: it is caught by the Kasten & Czeplak curve, the 10-25 klux band and the
 * thin-cloud test.
 *
 * The first run of that harness reported 0 for all nine, because its perl substitution
 * contained a "/" and silently matched nothing. A mutation harness that cannot mutate
 * looks exactly like a test that cannot fail, so every substitution is now asserted to
 * have changed the file before the run counts for anything.
 *
 * The three tests that "could not fail" found in this repository this week were all of one
 * shape: they asserted the code back to itself. `keeps every cloud amount on Kasten &
 * Czeplak's curve` is the guard against that here -- it is computed from 100, 0.75 and 3.4,
 * none of which the implementation exposes.
 */
describe('cloud cover reshapes daylight', () => {
  /** The two ends of this product's cloud dial. Measured: `WEATHER` in Weather.ts. */
  const CLEAR = 0.12;
  const OVERCAST = 0.92;
  /** The rest of the dial, in the order Weather.ts lists them. */
  const FOG = 0.55;
  const CLOUDY = 0.78;
  const SNOW = 0.85;

  /**
   * Clear noon daylight is about 100 000 lux; the clear-sky diffuse fraction is about
   * 0.15. So 85 klux arrives as beam and 15 klux as sky, and the two multipliers under
   * test are exactly the factors on those two numbers.
   */
  const CLEAR_BEAM_KLUX = 85;
  const CLEAR_SKY_KLUX = 15;
  const globalKlux = (cover: number) => {
    const light = cloudDaylightAt(cover);
    return CLEAR_BEAM_KLUX * light.beam + CLEAR_SKY_KLUX * light.fill;
  };

  /** Recomputed here from the dial ends, so the implementation cannot supply its own. */
  const oktaFraction = (cover: number) =>
    Math.min(1, Math.max(0, (cover - CLEAR) / (OVERCAST - CLEAR)));

  const dial = [CLEAR, 0.2, 0.35, FOG, 0.65, CLOUDY, SNOW, 0.9, OVERCAST];

  test("keeps every cloud amount on Kasten & Czeplak's curve", () => {
    // Kasten & Czeplak (1980), Solar Energy 24, 177-189: global horizontal irradiance
    // under N oktas is G/G_clear = 1 - 0.75 (N/8)^3.4. Put the beam and the fill back
    // together and that is the curve they have to trace.
    for (const cover of dial) {
      const published = 1 - 0.75 * oktaFraction(cover) ** 3.4;
      expect(globalKlux(cover) / 100).toBeCloseTo(published, 12);
    }
    // ...and the endpoint it is famous for: full overcast is a quarter of clear.
    expect(globalKlux(OVERCAST) / 100).toBeCloseTo(0.25, 12);
  });

  test('leaves no solar disc under full overcast', () => {
    // The CIE Standard Overcast Sky is a pure luminance distribution,
    // L(theta) = L_zenith (1 + 2 cos theta) / 3. There is no sun term in it at all, which
    // is the physical reason an overcast noon is shadowless rather than merely dim.
    expect(cloudDaylightAt(OVERCAST).beam).toBe(0);
    expect(cloudDaylightAt(1).beam).toBe(0);
  });

  test('puts the overcast sky inside the published 10-25 klux band', () => {
    // Full overcast daylight is 10 000 to 25 000 lux, all of it diffuse. The fill has to
    // *rise*, because a deck turns the beam into sky rather than swallowing it -- this is
    // the assertion the shipped code failed before the change, at 15 klux flat.
    const overcastSkyKlux = CLEAR_SKY_KLUX * cloudDaylightAt(OVERCAST).fill;
    expect(overcastSkyKlux).toBeGreaterThan(CLEAR_SKY_KLUX);
    expect(overcastSkyKlux).toBeGreaterThanOrEqual(10);
    expect(overcastSkyKlux).toBeLessThanOrEqual(25);
  });

  test('leaves a clear day exactly as it was', () => {
    // The opening frame is clear, and browserSmoke asserts its contrast and its
    // overexposed fraction. A cloud model that moves a clear sky is a regression whatever
    // else it gets right, so this is an equality and not a tolerance.
    expect(cloudDaylightAt(CLEAR)).toEqual({ beam: 1, fill: 1, penumbra: 1 });
    expect(cloudDaylightAt(0)).toEqual({ beam: 1, fill: 1, penumbra: 1 });
  });

  test('barely touches the beam under thin cloud', () => {
    // The 3.4 exponent is the whole reason a few cumulus are not a dimmer switch: at the
    // midpoint of the dial Kasten & Czeplak have lost under 8 per cent of the global,
    // where a linear model would have thrown away half the beam.
    expect(cloudDaylightAt((CLEAR + OVERCAST) / 2).beam).toBeGreaterThan(0.9);
    expect(1 - globalKlux((CLEAR + OVERCAST) / 2) / 100).toBeLessThan(0.08);
  });

  test('takes the hard shadow off rain but not off snow', () => {
    // `update` gates the shadow on `sunStrength * eclipseIrradiance * beam > 0.05`.
    // Measured on a running page at noon, clear, no eclipse: sunStrength 0.99989
    // (sunLight.intensity 2.036 = sunStrength * (1 - 0.62 * 0.12) * 2.2 before the change).
    const casts = (cover: number) => 0.99989 * cloudDaylightAt(cover).beam > 0.05;
    expect(casts(OVERCAST)).toBe(false);
    expect(casts(SNOW)).toBe(true);
    expect(casts(CLOUDY)).toBe(true);
    expect(casts(FOG)).toBe(true);
    expect(casts(CLEAR)).toBe(true);
  });

  test('widens the penumbra only as far as the filter still draws it', () => {
    // The sun is 0.53 degrees across, so a 10 m block casts a 0.0925 m penumbra. Measured
    // live on the High profile, the shadow frustum settles at 69.41 m of radius on a 1024
    // map, so one texel is 0.1356 m: the sun's own penumbra is BELOW the grid, and
    // `radius = 1` is already as sharp as the sun is. Softening can only go upward.
    const texel = shadowTexelSize(69.41188370877136, 1024);
    const sunPenumbraAt10m = 10 * Math.tan((0.53 * Math.PI) / 180);
    expect(sunPenumbraAt10m / texel).toBeLessThan(1);
    expect(cloudDaylightAt(CLEAR).penumbra).toBe(1);

    // Three r185's PCFShadowMap spends the radius on five Vogel-disk samples rotated per
    // pixel, so a wider disk buys blur at the price of dither. The gate above closes
    // first: the widest penumbra this can ever actually draw is the one just under it.
    let widest = 0;
    for (let cover = 0; cover <= 1; cover += 0.001) {
      const light = cloudDaylightAt(cover);
      if (0.99989 * light.beam > 0.05) widest = Math.max(widest, light.penumbra);
    }
    expect(widest).toBeGreaterThan(2.85);
    expect(widest).toBeLessThan(2.9);
  });

  test('is monotone across the dial and clamped off both ends', () => {
    // Weather crossfades between kinds, so every intermediate cover is reached. A
    // non-monotone beam would brighten the sun as the deck thickened.
    for (let cover = 0; cover < 1; cover += 0.01) {
      expect(cloudDaylightAt(cover + 0.01).beam).toBeLessThanOrEqual(
        cloudDaylightAt(cover).beam
      );
      expect(cloudDaylightAt(cover + 0.01).fill).toBeGreaterThanOrEqual(
        cloudDaylightAt(cover).fill
      );
    }
    // Off the dial in both directions: a negative cover must not brighten the sun past
    // clear, and cover above the dial's top must not drive the fill past full overcast.
    expect(cloudDaylightAt(-1)).toEqual({ beam: 1, fill: 1, penumbra: 1 });
    expect(cloudDaylightAt(2).fill).toBe(cloudDaylightAt(OVERCAST).fill);
    expect(cloudDaylightAt(2).penumbra).toBe(3);
  });
});

describe("the twilight dome's hand-off from Preetham", () => {
  /**
   * Three.js's own `sunIntensity`, rebuilt from the constants in the shader it ships.
   *
   * Read out of the source rather than copied, because the whole point of the hand-off is
   * that it is the exact complement of *that* function: if an upgrade retunes `cutoffAngle`
   * or `steepness`, the elevation where the dome goes dark moves and this has to move with
   * it. A copied 1.611 would keep agreeing with itself while disagreeing with the renderer.
   */
  const vertexShader = new Sky().material.vertexShader;
  const constant = (name: string) =>
    Number(new RegExp(`float ${name} = ([\\d.]+)`).exec(vertexShader)?.[1]);
  const cutoffAngle = constant('cutoffAngle');
  const steepness = constant('steepness');
  const sunIntensity = (elevationRad: number) =>
    Math.max(0, 1 - Math.exp(-(cutoffAngle - (Math.PI / 2 - elevationRad)) / steepness));

  test('reaches full strength exactly where Three.js stops lighting the sky', () => {
    expect(Number.isFinite(cutoffAngle)).toBe(true);
    expect(Number.isFinite(steepness)).toBe(true);
    // 2.30769 degrees below the horizon: 61% of civil twilight with no dome at all.
    const cutoffDeg = THREE.MathUtils.radToDeg(cutoffAngle - Math.PI / 2);
    expect(cutoffDeg).toBeCloseTo(2.30769, 5);
    expect(sunIntensity(THREE.MathUtils.degToRad(-cutoffDeg))).toBe(0);
    expect(preethamHandoff(THREE.MathUtils.degToRad(-cutoffDeg))).toBe(1);
    expect(preethamHandoff(THREE.MathUtils.degToRad(-6))).toBe(1);
  });

  test('is the complement of vSunE, so the two sum to one sky', () => {
    const horizon = sunIntensity(0);
    for (const degrees of [-2.2, -2, -1.5, -1, -0.5, -0.1]) {
      const elevation = THREE.MathUtils.degToRad(degrees);
      expect(preethamHandoff(elevation) + sunIntensity(elevation) / horizon).toBeCloseTo(1, 12);
    }
    // The measured shape, from the table in the defect report: vSunE keeps 57% of its
    // sunset value one degree down and 13% two degrees down.
    expect(preethamHandoff(THREE.MathUtils.degToRad(-1))).toBeCloseTo(0.43, 2);
    expect(preethamHandoff(THREE.MathUtils.degToRad(-2))).toBeCloseTo(0.865, 3);
  });

  test('is exactly zero in daylight, so the dome is untouched above the horizon', () => {
    // Not "close to zero": the whole term is multiplied by this, so an exact zero is what
    // makes a daylit frame bit-identical with the patch in place. Measured on the live
    // build at +20 degrees and at noon, the frame moved by 0.002% and 0.085% -- which is
    // the composer's own frame-to-frame noise, not this.
    for (const degrees of [0, 0.5, 2.3, 20, 61]) {
      expect(preethamHandoff(THREE.MathUtils.degToRad(degrees))).toBe(0);
    }
  });
});

describe('the twilight dome patch', () => {
  const stock = new Sky().material.fragmentShader;
  // The constructor's order, reproduced: twilight adds, then the ceiling clamps.
  const patched = withRadianceCeiling(withTwilightDome(stock));

  test('keeps the radiance ceiling downstream of the only term that adds light', () => {
    // Item 11: over 65504 a half-float target stores NaN on one rasteriser and +Inf on
    // another, and PMREM turned four such texels into 10 109. The eclipse patch only ever
    // mixes toward something darker; this one sums. If it ever lands after the clamp the
    // overflow is back, and nothing else in the suite would notice.
    const added = patched.indexOf('texColor += twilight.x');
    const clamped = patched.indexOf('min( texColor');
    const written = patched.indexOf('gl_FragColor = vec4( texColor');
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(clamped);
    expect(clamped).toBeLessThan(written);
  });

  test('takes the belt colour from the atmosphere, not from a palette', () => {
    // The Belt of Venus is lit by a beam that has grazed the limb -- the one twilight path
    // that goes *under* the ozone layer rather than through its Chappuis band, which is why
    // it is pink where the zenith is blue. So the literal in the shader has to be the
    // spectrum this repo already computes for a sun on the horizon, normalised.
    const limb = beamTransmittanceColor(0);
    const peak = Math.max(...limb);
    const expected = limb.map((c) => (c / peak).toFixed(4)).join();
    expect(patched).toContain(`vec3( ${expected} )`);
    // ...and that spectrum really is the red end: blue is gone entirely at the limb.
    expect(limb[2] / peak).toBe(0);
    expect(limb[0] / peak).toBe(1);
  });

  test('mixes between two colours whose red/blue straddle one, the right way up', () => {
    // Hosek & Wilkie name Preetham's inverted antisolar gradient as its headline defect,
    // and the diorama measures it: R/B 3.96 at 3 degrees of elevation against 1.14 at 15,
    // where the sky is blue-grey low and pink above. The fix is only as good as its two
    // endpoints, so pin them: the ozone model's hue at the top, the limb's at the bottom.
    const limb = beamTransmittanceColor(0);
    expect(limb[0] / Math.max(limb[2], 1e-30)).toBeGreaterThan(1);
    for (const degrees of [-0.5, -1, -2, -2.308, -3, -4, -6]) {
      const hue = twilightSkyColorCached(THREE.MathUtils.degToRad(degrees)).color;
      // Measured across that whole span: 0.231 to 0.233, never anywhere near red.
      expect(hue[0] / hue[2]).toBeLessThan(0.25);
      expect(hue[2]).toBe(1);
    }
  });

  test('refuses to be applied after the ceiling rather than quietly working', () => {
    // The wrong order compiles and renders: it is only wrong on a rasteriser that stores
    // over-range halves as NaN, which is not the one anybody develops on. So the patch
    // itself will not go second, and a rig assembled the wrong way round fails to build
    // instead of shipping item 11 again.
    expect(() => withTwilightDome(withRadianceCeiling(stock))).toThrow(/ceiling came first/);
  });

  test('fails loudly if the Sky shader stops offering either anchor', () => {
    expect(() => withTwilightDome('void main() {}')).toThrow(/twilight dome/);
    expect(() => withTwilightDome('uniform float time;')).toThrow(/twilight dome/);
    expect(() => withTwilightDome('gl_FragColor = vec4( texColor, 1.0 );')).toThrow(
      /twilight dome/
    );
  });
});

/**
 * An eclipse has to remove the light it is removing.
 *
 * The fills, the dome, the reflections and the fog each carried their own eclipse ramp, every
 * one of them shallower than the beam's, and a black clip in `CinematicGrade` had been hiding
 * the difference by destroying the dark half of every totality frame. With the clip gone the
 * `totality` checkpoint's whole-frame mean rose 53.12 to 82.36 at an exposure that did not
 * move. {@link eclipseDiffuseFraction} replaces those ramps with one quantity and grounds it in
 * published illuminance rather than in taste.
 *
 * Every assertion below is an **external** fact -- a published horizontal illuminance, a full
 * moon, the geometry of an umbra, the arithmetic of a half-float target -- or a relation
 * between two modules that neither of them states on its own. The illuminance figures are read
 * back through `ViewerAdaptation`'s own table and the standard 0.18 mid-grey, so no constant in
 * `DayNightCycle` is allowed to supply its own expected value.
 *
 * **Mutation results.** Each mutation was applied alone and the file re-run; the count is how
 * many of these tests went red. The harness asserts that each substitution actually changed the
 * file before the run counts for anything -- a harness that cannot mutate looks exactly like a
 * test that cannot fail, and this repository has been burned by that once. The first five rows
 * are the 2026-09-12 darkness rework's, re-run against this file and unchanged; the rest are
 * the umbra ring's.
 *
 * | mutation                                                          | tests failed |
 * | ------------------------------------------------------------------ | ------------ |
 * | `max(irradiance, floor)` -> `irradiance + (floor - 0.025) * totality` | 2          |
 * | `max(irradiance, floor)` -> `irradiance` (no floor at all)          | 1            |
 * | `max(irradiance, floor)` -> `floor` (no beam term)                  | 3            |
 * | `UMBRAL_SKYGLOW` 0.13 -> 0.0014 (the physical figure)               | 1            |
 * | `UMBRAL_SKYGLOW` 0.13 -> 0.30                                       | 3            |
 * | dome `texColor * eclipseSkyFlux` -> `texColor`                      | 2            |
 * | dome sum -> `mix( texColor, eclipseSky, eclipseDarkness )`          | 2            |
 * | ring `abs( direction.y )` -> `max( direction.y, 0.0 )`              | 1            |
 * | the ring's height law removed (band becomes the whole dome)         | 2            |
 * | `ECLIPSE_RING_SCALE_HEIGHT_KM` 8 -> 48 (six times the scale height)  | 1            |
 * | footprint made circular (`a = b`, so no bearing at all)             | 2            |
 * | traverse pinned to mid-totality (no 180-degree swing)               | 1            |
 * | `UMBRA_TRAVERSE_LIMIT` 0.9 -> 0.99 (observer on the wall)           | 1            |
 * | `ECLIPSE_RING_GAIN` 1.2536 -> 10.53 (the rejected calibration)      | 1            |
 * | `ECLIPSE_UMBRAL_ZENITH` -> the 0.40 cd/m2 figure both proposals gave | 2           |
 * | ring no longer gated on `eclipseTotality`                           | 1            |
 * | a dangling `{@link}` reintroduced                                   | 1            |
 * | the ceiling patch removed from the constructor                      | 0 -- throws  |
 * | `uniforms.eclipseSkyFlux.value` fed `1 - irradiance`                | 0 -- no test |
 * | `umbraWall`'s outer `max( ..., 0.0 )` removed                       | 0 -- cannot  |
 *
 * The last three rows are the honest gaps, left in the table rather than tidied away.
 *
 * No test here builds a `DayNightCycle`, so nothing in this file can observe the order the
 * constructor applies the three sky patches in, nor what `update` writes into a uniform.
 * {@link withEclipseSky} therefore refuses to run on a shader that is not already clamped, so
 * that mutation stops the page at construction instead of shipping a half-float overflow to
 * somebody else's rasteriser; the guard itself is covered by `refuses to be applied before the
 * ceiling`. The flux assignment has no such backstop and is a real hole: what it feeds is one
 * line, `uniforms.eclipseSkyFlux.value = eclipseState.irradiance`, and the only thing standing
 * behind it is that inverting it would make an uneclipsed sky black rather than subtly wrong.
 *
 * `umbraWall`'s outer clamp cannot be killed by any test, and that is a property of the code
 * rather than of the suite: the quadratic's positive root is positive for every observer inside
 * the footprint, and {@link UMBRA_TRAVERSE_LIMIT} keeps the observer inside it. The clamp is
 * insurance against a state the traverse cannot reach, which is exactly why it is cheap.
 *
 * The first row is the defect this suite caught in its own author's first draft. Written as a
 * sum, the diffuse light *rose* 0.0291 to 0.130 across second contact -- the world brightening
 * as the moon finishes covering the sun, which is the same non-monotonicity, in the same
 * direction, that this change was written to remove from the ambient fill.
 */
describe('an eclipse removes the light it removes', () => {
  const timeline = new EclipseTimeline();
  /** Standard mid-grey. `ViewerAdaptation` reflects the bare city off it, Lambertian. */
  const BARE_ALBEDO = 0.18;
  /** Undo `adaptingLuminance` to recover the published horizontal illuminance, in lux. */
  const illuminanceLux = (elevationDeg: number) =>
    (adaptingLuminance(elevationDeg, 0, 0) * Math.PI) / BARE_ALBEDO;
  /** The band the staged eclipse's sun stands in, in every season. See `EclipseView.test.ts`. */
  const ECLIPSE_SUN_ELEVATION = [3, 10] as const;
  const totalityFraction = () => eclipseDiffuseFraction(timeline.seek(0.5).irradiance);

  test('attenuates the diffuse sky exactly like the beam through every partial phase', () => {
    // The moon's penumbra is thousands of kilometres across, so every parcel of air the camera
    // can see scattering is lit by the *same* partially covered sun. Beam and skylight are then
    // one quantity under one attenuation, and the beam's is what `EclipseTimeline` computes
    // from the overlap area. Exact equality, because "the same attenuation" is the claim.
    let checked = 0;
    for (let progress = 0; progress <= 0.36; progress += 0.005) {
      const state = timeline.seek(progress);
      expect(state.totality).toBe(0);
      if (state.irradiance <= totalityFraction()) continue;
      expect(eclipseDiffuseFraction(state.irradiance)).toBe(state.irradiance);
      checked++;
    }
    // ...and that is most of the run-up to second contact, not a handful of samples.
    expect(checked).toBeGreaterThan(50);
  });

  test('never lets the world brighten as the moon covers more of the sun', () => {
    // The one thing an eclipse may not do. A sum of a falling beam and a rising totality term
    // does exactly this at second contact, because `irradiance` has already bottomed out on
    // `EclipseTimeline`'s own floor and has nothing left to pay the rise with.
    let previous = Number.POSITIVE_INFINITY;
    for (let progress = 0; progress <= 0.5; progress += 0.001) {
      const value = eclipseDiffuseFraction(timeline.seek(progress).irradiance);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
    // ...and the whole way down is a real fall, not a flat line that satisfies the above for
    // the wrong reason.
    expect(previous).toBeLessThan(0.2 * eclipseDiffuseFraction(timeline.seek(0).irradiance));
  });

  test('leaves an uneclipsed hour bit for bit unchanged', () => {
    // Not "close to 1" -- exactly 1, and exactly 1 through the multiplication, because this
    // multiplies the ambient, the hemisphere and the environment intensity on every frame of
    // every hour of the day. `Object.is`, so a -0 could not pass either.
    expect(timeline.seek(1).irradiance).toBe(1);
    expect(Object.is(eclipseDiffuseFraction(1), 1)).toBe(true);
    for (const intensity of [0.16, 0.22, 0.42, 0.7104359849976685, 2.0363, 1e-8, 0]) {
      expect(intensity * eclipseDiffuseFraction(1)).toBe(intensity);
    }
  });

  test('puts totality between a real totality and the hour it interrupts', () => {
    // Published horizontal illuminance at totality is 1 to 100 lx. The staged eclipse's own sun
    // stands 3 to 10 degrees up in every season, which this rig's own table puts in the klx.
    for (const elevation of ECLIPSE_SUN_ELEVATION) {
      const hour = illuminanceLux(elevation);
      expect(hour).toBeGreaterThan(1_000);
      const totality = hour * totalityFraction();
      // Brighter than any real totality -- deliberately, and written down here rather than
      // discovered later by somebody holding the frame against a photograph.
      expect(totality).toBeGreaterThan(100);
      // ...but still the better part of an order of magnitude below the hour it interrupts.
      expect(hour / totality).toBeGreaterThan(7);
    }
  });

  test('floors on the skyglow around the umbra, which is not the corona', () => {
    // What lights the ground at totality is sunlit air outside a 100-270 km shadow, not the
    // corona -- that is a full moon's worth of light, 0.25 lx, against the hour's own
    // thousands. If this floor is ever tuned down to something the corona could account for,
    // the physical story in the docblock has stopped being true and this says so.
    const FULL_MOON_LUX = 0.25;
    const floor = illuminanceLux(ECLIPSE_SUN_ELEVATION[0]) * totalityFraction();
    expect(floor / FULL_MOON_LUX).toBeGreaterThan(100);
  });

  test('keeps the stars lit at totality', () => {
    // The star gate reads the same eclipse state, and a totality starfield is a feature with
    // tests of its own. A darker world may not be bought by turning it off.
    const totality = timeline.seek(0.5);
    expect(totality.stars).toBe(1);
    const alpha = starAlphaAt(
      totality.irradiance,
      totality.stars,
      (1 - totality.irradiance) * 0.52 + totality.totality * 0.12,
      0
    );
    expect(alpha).toBeGreaterThan(0.8);
  });

  describe('the dome patch', () => {
    const stock = new Sky().material.fragmentShader;
    // The constructor's order, reproduced: the ceiling clamps, then the eclipse patch runs.
    const patched = withEclipseSky(withRadianceCeiling(stock));
    /** Only what this patch inserted: the stock shader has `pow` and `abs` of its own. */
    const inserted = patched.slice(
      patched.indexOf('vec2 uS ='),
      patched.lastIndexOf('gl_FragColor')
    );
    const vec3 = (name: string) =>
      /vec3\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)/
        .exec(patched.slice(patched.indexOf(`vec3 ${name} =`)))!
        .slice(1, 4)
        .map(Number);

    test('attenuates the dome by the surviving flux, sent as the flux', () => {
      // A crossfade cannot darken a sky: whatever the blend is, `1 - blend` of a
      // full-brightness daytime dome survives it. Measured on the built bundle at the
      // `totality` checkpoint, that remainder was 14.2 per cent of the dome and four fifths of
      // the frame's light -- taking it alone to zero moved the whole frame from 0.4393 of the
      // uneclipsed hour to 0.0998.
      expect(patched).not.toContain('mix( texColor, eclipseSky');
      // The scale is the surviving solar flux and it arrives *as* the flux. The form it
      // replaces, `texColor * ( 1.0 - eclipseDarkness )`, was the same quantity sent through a
      // subtraction the shader then undid -- which cost 2.4e-7 of relative precision and, more
      // to the point, hid the fact that the dome was already being scaled at all from a
      // reviewer reading the shader.
      expect(patched).toContain('texColor * eclipseSkyFlux');
      expect(patched).not.toContain('1.0 - eclipseDarkness');
      expect(patched).toContain('uniform float eclipseSkyFlux;');
      // ...and it is exactly `texColor` with no eclipse, which is what leaves a day identical.
      // `toBe`, not a tolerance: `irradiance` is exactly 1 and `eclipseDarkness` exactly 0
      // whenever no eclipse is running, so this is an IEEE identity or it is a regression.
      const dome = (tex: number, sky: number, flux: number, darkness: number) =>
        tex * flux + sky * darkness;
      for (const tex of [0, 0.004, 1, 142, 4096, 59999.5]) {
        expect(dome(tex, 0.55, 1, 0)).toBe(tex);
      }
      // The round trip the uniform removes, so the cost is written down rather than asserted
      // away: float32( 1 - float32( 0.025 ) ) does not come back as 0.025.
      const roundTrip = Math.fround(1 - Math.fround(1 - Math.fround(0.025)));
      expect(roundTrip).not.toBe(Math.fround(0.025));
    });

    test('stays under the radiance ceiling although it now adds light', () => {
      // The ceiling is applied upstream, and the twilight dome's rule is that nothing
      // downstream of it may add radiance: over 65504 a half-float target stores NaN on one
      // rasteriser and +Inf on another, and PMREM turned four such texels into 10 109. This
      // patch sums, so it needs its own argument -- the result is a convex combination of
      // `texColor`, already clamped, and a constant, so it cannot exceed the larger of the two.
      // That holds only while the constant stays far below the ceiling, which is what is
      // asserted; it is not a property the expression keeps on its own.
      const ceiling = Number(/min\( texColor, vec3\( ([\d.]+) \) \)/.exec(patched)?.[1]);
      expect(ceiling).toBeGreaterThan(1000);
      const zenith = vec3('eclipseZenith');
      // The ring is an `exp` of a non-positive argument times its gain, so the gain *is* its
      // supremum -- no sampling of directions can find a brighter one. That is the whole bound.
      const gain = Number(/\)\s*\)\s*\)\s*\n?\s*\* ([\d.]+);/.exec(patched)?.[1]);
      expect(gain).toBeGreaterThan(0);
      expect(Math.max(...zenith.map((z) => z + gain))).toBeLessThan(ceiling);
      for (const wall of [0, 1e-9, 69.3, 159, 1037, 1e6]) {
        for (const y of [-1.0000001, -0.5, 0, 0.5, 1, 1.0000001]) {
          for (const channel of eclipseRingRadiance(wall, y)) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(gain);
          }
        }
      }
      expect(patched.indexOf('min( texColor')).toBeLessThan(
        patched.indexOf('texColor * eclipseSkyFlux')
      );
    });

    test('cannot put a NaN on the dome however `direction` rounds', () => {
      // Cheap hardening, not a reproduced defect. The term this replaces was
      // `pow( 1.0 - abs( direction.y ), 12.0 )`: `pow` with a negative base is undefined in
      // GLSL, and a `normalize()` that rounded `abs( direction.y )` to just over 1 would have
      // handed it one. A NaN there survives `* eclipseDarkness` even at 0, so it would reach
      // the dome on every frame of every hour, not only during an eclipse.
      expect(inserted).not.toContain('pow(');
      for (const y of [1 + Number.EPSILON, 1.0000001, 2, -2, 1e6]) {
        for (const channel of eclipseRingRadiance(159, y)) expect(Number.isFinite(channel)).toBe(true);
      }
      // The guard is inside the shader too, and it is the same `max` the CPU form uses.
      expect(patched).toContain('max( 1.0 - uUp * uUp, 1e-4 )');
    });

    test('holds the ring to the horizon, above it and below it', () => {
      // The diorama is a floating plate, so a good half of the frame is sky *below* the
      // horizon. `1 - clamp( direction.y, 0.0, 1.0 )` is 1 for every one of those directions,
      // which stood the ring at full strength across the whole lower dome and turned the frame
      // into a pink wash. A 360-degree sunset is a band at the horizon: it falls off both ways.
      const at = (elevationDeg: number) =>
        eclipseRingRadiance(159, Math.sin((elevationDeg * Math.PI) / 180))[0];
      expect(at(30)).toBeCloseTo(at(-30), 15);
      // Half brightness at 2.0 degrees and 5 per cent by 8.5 -- the measured "red color
      // observed in the lowest 8 degrees of the sky", Applied Optics 14, 2831 (1975). The
      // `pow( 1 - |y|, 12 )` this replaces was at half value at 3.22 degrees -- an earlier
      // comment said 11.9, which belongs to the exponent-3 term the change before this one
      // had already removed. So the gain here is shape, not height: the old term was the same
      // in every direction, and at the contacts this law is the taller of the two.
      expect(at(2) / at(0)).toBeCloseTo(0.5, 2);
      expect(at(8.5) / at(0)).toBeLessThan(0.06);
      expect(at(8.5) / at(0)).toBeGreaterThan(0.03);
      // ...and the band is genuinely tighter where the wall is nearer, which a function of
      // elevation alone cannot be: at second contact's 69 km wall it reaches 4.6 degrees.
      const near = (elevationDeg: number) =>
        eclipseRingRadiance(69.3, Math.sin((elevationDeg * Math.PI) / 180))[0];
      expect(near(4.57) / near(0)).toBeCloseTo(0.5, 2);
    });

    test('computes the same ring in GLSL as it does here', () => {
      // The wall solve and the ring exponential are written twice -- once in TypeScript, where
      // it can be tested, and once in GLSL, because a fragment shader cannot call a function on
      // the CPU. So the two are held against each other numerically, not by eye: everything the
      // shader is built from is parsed back out of the shader text and run through the same
      // arithmetic. A constant that drifts in one copy and not the other fails here.
      expect(inserted).toContain('uUp = abs( direction.y )');
      const extinction = /vec3\( ([\d.]+),([\d.]+),([\d.]+) \)\s*\n?\s*\+ uUp/
        .exec(inserted)!
        .slice(1, 4)
        .map(Number);
      const scaleHeight = Number(/\+ uUp \/ \( ([\d.]+)\.0 \*/.exec(inserted)?.[1]);
      const gain = Number(/\*\s*([\d.]+);\s*\nvec3 eclipseSky/.exec(inserted)?.[1]);
      expect(scaleHeight).toBeGreaterThan(0);
      expect(gain).toBeGreaterThan(0);
      for (const wall of [0, 12, 69.3, 159, 1037]) {
        for (const y of [-0.99, -0.5, -0.03, 0, 0.03, 0.5, 0.99]) {
          const up = Math.abs(y);
          const climb = up / (scaleHeight * Math.sqrt(Math.max(1 - up * up, 1e-4)));
          const fromShader = extinction.map((beta) => Math.exp(-wall * (beta + climb)) * gain);
          const fromModule = eclipseRingRadiance(wall, y);
          for (let channel = 0; channel < 3; channel++) {
            expect(fromModule[channel]).toBeCloseTo(fromShader[channel], 12);
          }
        }
      }
    });

    test('adds the ring only at totality, so partial phases keep their character', () => {
      // Before second contact the only eclipse colour on the dome is the authored umbral
      // zenith, and a partial eclipse has to read as a dimmed day rather than a blue one.
      expect(patched).toContain('eclipseZenith + eclipseRing * eclipseTotality');
    });

    test('gives the umbra a bearing, and swings it through 180 degrees', () => {
      // The owner's fourth sentence. A ring that looks the same in every direction is not a
      // shadow you are standing inside; the footprint is an ellipse 6.5:1 at this eclipse's
      // 8.82 degree sun, and the observer crosses it from one end to the other.
      const semiMajor = umbraSemiMajorKm((8.819420050862682 * Math.PI) / 180);
      expect(semiMajor / 159).toBeCloseTo(6.52, 2);
      const wall = (traverse: number, alongSun: number, acrossSun: number) =>
        umbraWallDistanceKm(semiMajor, semiMajor * UMBRA_TRAVERSE_LIMIT * traverse, alongSun, acrossSun);
      // Mid-totality is symmetric: broadside is 159 km -- the umbra's own half-width -- and
      // both ends of the long axis are 1037 km away, which Rayleigh has already taken to zero.
      expect(wall(0, 0, 1)).toBeCloseTo(159, 6);
      expect(wall(0, 1, 0)).toBeCloseTo(semiMajor, 6);
      expect(wall(0, 1, 0)).toBeCloseTo(wall(0, -1, 0), 6);
      // C2 and C3 are not, and they are mirror images of each other. Positive traverse is
      // toward the sun, so the bright side is antisolar at second contact and sunward at
      // third: the measured "dark to the west and blue to the east" at C2, reversing by C3.
      expect(wall(-1, -1, 0)).toBeLessThan(wall(-1, 1, 0));
      expect(wall(1, 1, 0)).toBeLessThan(wall(1, -1, 0));
      expect(wall(-1, -1, 0)).toBeCloseTo(wall(1, 1, 0), 6);
      expect(wall(-1, -1, 0)).toBeCloseTo(semiMajor * (1 - UMBRA_TRAVERSE_LIMIT), 6);
      // ...and the swing is monotone across the traverse rather than a flip at the midpoint.
      let previous = Number.POSITIVE_INFINITY;
      for (let traverse = -1; traverse <= 1.0001; traverse += 0.05) {
        const sunward = wall(traverse, 1, 0);
        expect(sunward).toBeLessThan(previous);
        previous = sunward;
      }
      // The traverse itself needs no new state: `separation` is the only thing on
      // `EclipseRenderState` that still moves once coverage has pinned at 1, and it sweeps
      // exactly the observer's crossing. The endpoints are read back off the timeline's own
      // coverage law rather than copied out of it.
      const timeline = new EclipseTimeline();
      expect(umbraTraverse(timeline.seek(0.42).separation)).toBeCloseTo(-1, 6);
      expect(umbraTraverse(timeline.seek(0.5).separation)).toBe(0);
      expect(umbraTraverse(timeline.seek(0.58).separation)).toBeCloseTo(1, 6);
      // ...and it is clamped, because the partial phases run the separation far past totality's.
      expect(umbraTraverse(timeline.seek(0).separation)).toBe(-1);
      expect(umbraTraverse(timeline.seek(0.2).separation)).toBe(-1);
      expect(umbraTraverse(timeline.seek(1).separation)).toBe(1);
    });

    /**
     * The ring's sRGB codes, through the tone-mapping path this repo actually renders through.
     *
     * Not "an ACES slope". `bootstrap.ts` runs `NoToneMapping` on the renderer and does the
     * tone map in the composer's final pass, `ToneMappingEffect({ mode: ACES_FILMIC })`, whose
     * shader is `#include <tonemapping_pars_fragment>` -- three r185's own
     * `ACESFilmicToneMapping`: `color *= toneMappingExposure / 0.6`, the ACES input matrix,
     * `RRTAndODTFit`, the output matrix, `saturate`. `toneMappingExposure` is set by
     * `WebGLRenderer.setProgram` from `renderer.toneMappingExposure`, which `main.ts` drives
     * from `sceneExposure`, so the uniform does reach this shader although the renderer's own
     * tone mapping is off.
     *
     * The exposure is that function's own value at the staged eclipse's totality, computed
     * from the repo's own parts and not assumed: `t01` 0.79628 from `eclipseViewClock`, sun
     * +8.8194 degrees, `nightFactorAt` 0.0745 raised to 0.627 by the eclipse's own
     * `darkness * 0.52 + totality * 0.12`, `goldenFactorAt` 0.8771, `highSunFactor` 0,
     * classic theme, and `viewerAdaptation` 1.4606 on top -- **E = 0.50286**. A reviewer's
     * 0.257 for the same frame is a little over half of that, which is where an earlier
     * attempt's ring came out 16x too bright and clipped to white; at the real exposure the
     * error would have been worse, not better.
     *
     * These are the sky's own terms. The surviving Preetham dome sits under them
     * (`irradiance` 0.025 of it) and `CinematicGrade` runs after, so a photograph of the frame
     * will not read these exactly -- what this pins is that the ring is bright, warm,
     * directional, and **on no channel at 255**.
     */
    test('presents the ring below clipping at every bearing of the traverse', () => {
      const EXPOSURE = 0.50286;
      const DARKNESS = 0.975;
      const ACES_IN = [
        [0.59719, 0.076, 0.0284],
        [0.35458, 0.90834, 0.13383],
        [0.04823, 0.01566, 0.83777],
      ];
      const ACES_OUT = [
        [1.60475, -0.10208, -0.00327],
        [-0.53108, 1.10813, -0.07276],
        [-0.07367, -0.00605, 1.07602],
      ];
      const byColumns = (columns: number[][], v: number[]) =>
        [0, 1, 2].map((row) => columns.reduce((sum, column, i) => sum + column[row] * v[i], 0));
      const rrtAndOdtFit = (v: number[]) =>
        v.map(
          (x) =>
            (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081)
        );
      const transfer = (d: number) =>
        d <= 0.0031308 ? 12.92 * d : 1.055 * Math.pow(d, 1 / 2.4) - 0.055;
      const displayCode = (scene: number[]) =>
        byColumns(
          ACES_OUT,
          rrtAndOdtFit(byColumns(ACES_IN, scene.map((x) => (x * EXPOSURE) / 0.6)))
        ).map((d) => Math.round(255 * transfer(Math.min(1, Math.max(0, d)))));

      const zenith = vec3('eclipseZenith');
      const semiMajor = umbraSemiMajorKm((8.819420050862682 * Math.PI) / 180);
      const skyAt = (traverse: number, alongSun: number, acrossSun: number) => {
        const wall = umbraWallDistanceKm(
          semiMajor,
          semiMajor * UMBRA_TRAVERSE_LIMIT * traverse,
          alongSun,
          acrossSun
        );
        const ring = eclipseRingRadiance(wall, 0);
        return displayCode(zenith.map((z, i) => (z + ring[i]) * DARKNESS));
      };

      // C2: the bright side is antisolar, and the horizon toward the sun is as dark as the
      // zenith -- 1037 km of shadowed air is 1970 km of it, which no channel survives.
      expect(skyAt(-1, 0, 1)).toEqual([184, 157, 96]);
      expect(skyAt(-1, -1, 0)).toEqual([169, 128, 58]);
      expect(skyAt(-1, 1, 0)).toEqual([0, 2, 15]);
      // Mid-totality: symmetric, a deep orange-red band broadside and nothing along the axis.
      expect(skyAt(0, 0, 1)).toEqual([141, 83, 31]);
      expect(skyAt(0, 1, 0)).toEqual([1, 2, 15]);
      expect(skyAt(0, -1, 0)).toEqual([1, 2, 15]);
      // C3: the mirror of C2. The sunward horizon lights up as totality ends, which is the
      // whole point of giving the umbra a bearing.
      expect(skyAt(1, 0, 1)).toEqual([184, 157, 96]);
      expect(skyAt(1, 1, 0)).toEqual([169, 128, 58]);
      expect(skyAt(1, -1, 0)).toEqual([0, 2, 15]);
      // A ring that clips to white is worse than no ring: an earlier attempt at this model was
      // rejected for a clipped rgb(242, 231, 194) at C2/C3. Nothing here reaches 255.
      for (const traverse of [-1, -0.5, 0, 0.5, 1]) {
        for (let bearing = 0; bearing < 64; bearing++) {
          const angle = (bearing / 64) * 2 * Math.PI;
          for (const channel of skyAt(traverse, Math.cos(angle), Math.sin(angle))) {
            expect(channel).toBeLessThan(250);
          }
        }
      }
    });

    /**
     * The umbral zenith's level, which until now was right for no recorded reason.
     *
     * Two earlier proposals put it at (0.0009, 0.0020, 0.0078) and (0.0012, 0.0027, 0.0105) --
     * both derived from the measured 0.40 cd/m2 zenith, and both an order of magnitude below
     * what this output can show. `RRTAndODTFit` subtracts before it scales, so the curve
     * crosses zero at a positive input and everything under it presents at display code 0.
     *
     * A note handed to this change put that floor at scene-linear 1.2031e-2 and the shipped
     * blue at 2.91x above it, presenting at code 3.85. **That arithmetic does not hold**, and
     * the reason is the exposure: 1.2031e-2 is the floor at E = 0.1837, and this repo's own
     * `sceneExposure` at the staged totality returns 0.50286 -- because `nightFactorAt` is
     * lifted to 0.627 by the eclipse itself and `viewerAdaptation` then multiplies by 1.4606.
     * At the real exposure the floor is 3.88e-3, the shipped blue clears it by 9.0x, and it
     * presents at code 15, not 4. The constant is kept; the reason it is right is different
     * from the one that was offered for it, and that is worth a test rather than a footnote.
     */
    test('keeps the umbral zenith above the floor the tone curve puts under it', () => {
      const EXPOSURE = 0.50286;
      // `RRTAndODTFit` is `a / b` with `a = v * ( v + 0.0245786 ) - 0.000090537`, so display
      // radiance crosses zero at the positive root of that quadratic, whatever `b` is.
      const root = (-0.0245786 + Math.sqrt(0.0245786 ** 2 + 4 * 0.000090537)) / 2;
      const floor = root / (EXPOSURE / 0.6);
      expect(floor).toBeCloseTo(3.8814e-3, 7);
      const zenith = vec3('eclipseZenith');
      // Blue carries the hue and has to clear the floor with room to spare; green is the check
      // that the colour is not a single channel; red is deliberately at the floor, because the
      // zenith at totality is blue-violet and a red one would be the old warm wash returning.
      expect(zenith[2] / floor).toBeGreaterThan(8);
      expect(zenith[1] / floor).toBeGreaterThan(2);
      expect(zenith[0] / floor).toBeLessThan(1.2);
      // The two proposals this rejects. The note offered for the shipped constant said both
      // sat under the floor on *every* channel and would have put the whole zenith on code 0;
      // at the real exposure that is not true either -- their blues clear it by 2.0x and 2.7x.
      // What is true, and is the reason they are still wrong, is that both lose red *and*
      // green: a zenith with two dead channels is a pure-blue primary, a hue no sky has, and
      // the first thing a dithered gradient bands on.
      for (const proposal of [
        [0.0009, 0.002, 0.0078],
        [0.0012, 0.0027, 0.0105],
      ]) {
        expect(proposal[0]).toBeLessThan(floor);
        expect(proposal[1]).toBeLessThan(floor);
        expect(proposal[2]).toBeGreaterThan(floor);
      }
    });

    /**
     * Every `{@link}` in the module names something the module can see.
     *
     * `{@link ECLIPSE_SKY_LEVEL}` stood in this file pointing at a symbol that has never
     * existed anywhere in the repository. A doc link is the only navigation these long
     * docblocks have, and a dead one sends the next reader looking for a constant that is not
     * there -- which is worse than no link, because it reads as a promise that the level is
     * written down somewhere.
     *
     * Anchored on the source text rather than on the compiler because that is where the defect
     * lives: nothing in `tsc` or `vitest` looks at a comment.
     */
    test('leaves no dangling doc links in the module', () => {
      const source = dayNightCycleSource;
      const declared = new Set<string>();
      for (const [, name] of source.matchAll(
        /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
      )) {
        declared.add(name);
      }
      // ...and anything the module imported, which is equally in scope for a doc link.
      for (const [, names] of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from/g)) {
        for (const entry of names.split(',')) {
          const name = entry.replace(/\btype\b/, '').trim().split(/\s+as\s+/).pop();
          if (name) declared.add(name);
        }
      }
      // Class members are reachable through the class, so a bare method name counts too.
      for (const [, name] of source.matchAll(/\n {2}(?:private |readonly )*([A-Za-z_$][\w$]*)\(/g)) {
        declared.add(name);
      }
      const dangling = [...source.matchAll(/\{@link\s+([A-Za-z_$][\w$]*)/g)]
        .map(([, name]) => name)
        .filter((name) => !declared.has(name));
      expect(dangling).toEqual([]);
      // ...and the harness can actually find links, rather than passing on an empty match.
      expect(source.match(/\{@link\s/g)?.length).toBeGreaterThan(10);
    });

    test('refuses to be applied before the ceiling rather than quietly working', () => {
      // This patch sums, so it is downstream of the clamp or it is item 11 again. The
      // constructor's order cannot be asserted from here without building a renderer, so the
      // patch enforces it itself and a rig assembled the wrong way round fails to start.
      expect(() => withEclipseSky(stock)).toThrow(/eclipse atmosphere patch/);
    });

    test('fails loudly if the Sky shader stops writing where the patch expects', () => {
      expect(() => withEclipseSky('void main() {}')).toThrow(/eclipse atmosphere patch/);
      // A shader carrying the clamp but no longer the write is the other half of the guard.
      expect(() => withEclipseSky('texColor = min( texColor, vec3( 60000.0 ) );')).toThrow(
        /eclipse atmosphere patch/
      );
    });
  });
});

describe('the umbra wall has a distance in every direction', () => {
  /**
   * Straight up and straight down have no horizontal bearing at all.
   *
   * The solve divided the ray's horizontal component by its own softened length, so an exactly
   * vertical ray gave the zero vector, `quadratic` collapsed to zero, and the wall came back as
   * 0 -- the observer standing ON the umbra wall, which is the single state
   * `UMBRA_TRAVERSE_LIMIT` exists to forbid. There `exp( -0 * anything )` is 1, so the ring
   * reached its full gain: a near-white dot at the pole of a near-black sky. The true limit as a
   * ray goes vertical is an infinitely distant wall, so the old code returned its opposite.
   */
  test('a bearing that cancels to zero does not read as standing on the wall', () => {
    const semiMajor = umbraSemiMajorKm((8.83 * Math.PI) / 180);
    const offset = semiMajor * UMBRA_TRAVERSE_LIMIT;
    const degenerate = umbraWallDistanceKm(semiMajor, offset, 0, 0);
    expect(degenerate, 'zerowy kierunek nie moze znaczyc zera kilometrow').toBeGreaterThan(1);

    // And it agrees with a real bearing, because that is what the shader substitutes.
    expect(degenerate).toBeCloseTo(umbraWallDistanceKm(semiMajor, offset, 1, 0), 6);
  });

  test('every bearing keeps the observer inside the umbra at the traverse limit', () => {
    const semiMajor = umbraSemiMajorKm((8.83 * Math.PI) / 180);
    const offset = semiMajor * UMBRA_TRAVERSE_LIMIT;
    let nearest = Infinity;
    for (let i = 0; i < 720; i++) {
      const angle = (i / 720) * Math.PI * 2;
      nearest = Math.min(
        nearest,
        umbraWallDistanceKm(semiMajor, offset, Math.cos(angle), Math.sin(angle))
      );
    }
    // Broadside, b * sqrt(1 - 0.81) = 69.31 km. The docblock used to say 103.6, which is the
    // distance along the MAJOR axis -- the wrong wall, and wrong in the unsafe direction.
    expect(nearest).toBeGreaterThan(60);
    expect(nearest).toBeLessThan(80);
  });
});
