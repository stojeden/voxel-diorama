import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { QUALITY_PROFILES } from '../performance/QualityManager';
import { createWorld } from './WorldGenerator';
import {
  BLOCK_CONFIGS,
  BUS_SHELTER_ROOF_Y,
  BUS_STOPS,
  GROUND_SURFACE_Y,
  LAMP_SPECS,
  STATION_STOPS,
} from './WorldLayout';

describe('world rendering budget', () => {
  test('keeps dynamic lamp lighting cheap enough for laptop GPUs', () => {
    const scene = new THREE.Scene();
    const windUniforms = {
      uTime: { value: 0 },
      uWind: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
    };
    const world = createWorld(scene, windUniforms);

    // Every real fixture is a candidate, but the day/night controller only
    // enables the nearest profile-budgeted subset.
    expect(world.streetLights).toHaveLength(LAMP_SPECS.length);
    expect(world.windowLights).toHaveLength(BLOCK_CONFIGS.length);
    expect(world.busStopLights).toHaveLength(BUS_STOPS.length);
    expect(world.stationLights).toHaveLength(STATION_STOPS.length);
    expect(QUALITY_PROFILES.high.streetLightBudget).toBeLessThanOrEqual(8);
    expect(QUALITY_PROFILES.high.busStopLightBudget).toBeLessThanOrEqual(2);
    expect(QUALITY_PROFILES.high.stationLightBudget).toBe(STATION_STOPS.length);
    expect(QUALITY_PROFILES.high.windowLightBudget).toBeLessThanOrEqual(3);
    expect(world.streetLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.windowLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.busStopLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.stationLights.filter((light) => light.visible)).toHaveLength(0);
    expect(world.streetLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.busStopLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.stationLights.filter((light) => light.castShadow)).toHaveLength(0);
    expect(world.windowGlowMaterials.length).toBeGreaterThan(0);
    expect(new Set(world.windowGlowMaterials.map((entry) => entry.cohort)).size).toBe(5);
    expect(world.busStopGlowMaterials.length).toBeGreaterThan(0);
    expect(world.stationGlowMaterials.length).toBeGreaterThan(0);
    expect(world.stationGlowMesh.count).toBe(STATION_STOPS.length);
    world.dispose();
  });
});

describe('the bus-stop safety light hangs under the shelter roof', () => {
  test('below the roof, not on top of it', () => {
    const scene = new THREE.Scene();
    const world = createWorld(scene, {
      uTime: { value: 0 },
      uWind: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
    });
    scene.updateMatrixWorld(true);
    // The roof's underside is the top of the posts; the light must be under it, and high
    // enough to clear a standing figure's head.
    const underside = GROUND_SURFACE_Y + BUS_SHELTER_ROOF_Y;
    for (const light of world.busStopLights) {
      const y = light.getWorldPosition(new THREE.Vector3()).y;
      expect(y, `${light.name} sits on or above the roof`).toBeLessThan(underside);
      expect(y - GROUND_SURFACE_Y, `${light.name} is below head height`).toBeGreaterThan(1.9);
    }
  });
});
