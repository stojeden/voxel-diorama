import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  cloudDaylightAt,
  environmentTransitionAt,
  shadowNormalBias,
  shadowTexelSize,
  snapShadowFocus,
  withRadianceCeiling,
} from './DayNightCycle';

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
