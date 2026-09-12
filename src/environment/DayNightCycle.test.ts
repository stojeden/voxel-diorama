import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
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
