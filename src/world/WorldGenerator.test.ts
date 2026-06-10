import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createWorld } from './WorldGenerator';

describe('world rendering budget', () => {
  test('keeps dynamic lamp lighting cheap enough for laptop GPUs', () => {
    const scene = new THREE.Scene();
    const windUniforms = { uTime: { value: 0 }, uWind: { value: 0 } };
    const world = createWorld(scene, windUniforms);

    expect(world.streetLights.length).toBeLessThanOrEqual(10);
    expect(world.windowLights.length).toBeLessThanOrEqual(8);
    expect(world.streetLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowGlowMaterials.length).toBeGreaterThan(0);
  });
});
