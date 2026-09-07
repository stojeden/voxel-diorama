import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  environmentTransitionAt,
  shadowNormalBias,
  shadowTexelSize,
  snapShadowFocus,
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
