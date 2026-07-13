import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PROFILES } from '../performance/QualityManager';
import { createWorld } from './WorldGenerator';
import { BLOCK_CONFIGS, BUS_STOPS, LAMP_SPECS } from './WorldLayout';

describe('world rendering budget', () => {
  test('keeps dynamic lamp lighting cheap enough for laptop GPUs', () => {
    const scene = new THREE.Scene();
    const windUniforms = { uTime: { value: 0 }, uWind: { value: 0 } };
    const world = createWorld(scene, windUniforms);

    // Every real fixture is a candidate, but the day/night controller only
    // enables the nearest profile-budgeted subset.
    expect(world.streetLights).toHaveLength(LAMP_SPECS.length);
    expect(world.windowLights).toHaveLength(BLOCK_CONFIGS.length);
    expect(world.busStopLights).toHaveLength(BUS_STOPS.length);
    expect(QUALITY_PROFILES.high.streetLightBudget).toBeLessThanOrEqual(8);
    expect(QUALITY_PROFILES.high.busStopLightBudget).toBeLessThanOrEqual(2);
    expect(QUALITY_PROFILES.high.windowLightBudget).toBeLessThanOrEqual(3);
    expect(world.streetLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.windowLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.busStopLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.streetLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.busStopLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowGlowMaterials.length).toBeGreaterThan(0);
    expect(world.busStopGlowMaterials.length).toBeGreaterThan(0);
    world.dispose();
  });
});
