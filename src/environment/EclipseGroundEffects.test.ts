import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { EclipseGroundEffects } from './EclipseGroundEffects';
import type { EclipseRenderState } from './EclipseVisual';
import { GROUND_SURFACE_Y } from '../world/WorldLayout';

const partialState: EclipseRenderState = {
  active: true,
  coverage: 0.82,
  separation: -0.2,
  irradiance: 0.2,
  corona: 0,
  beads: 0,
  stars: 0,
  totality: 0,
};

describe('EclipseGroundEffects', () => {
  test('scales tree instances and keeps shadow bands High-only', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const effects = new EclipseGroundEffects(scene);
    const crescents = scene.getObjectByName('eclipse-tree-crescents') as THREE.InstancedMesh;
    const bands = scene.getObjectByName('eclipse-shadow-bands') as THREE.Mesh;

    effects.setQuality('low');
    effects.update(camera, partialState, 1 / 60, 0);
    expect(crescents.visible).toBe(true);
    expect(crescents.count).toBe(16);
    expect(bands.visible).toBe(false);

    effects.setQuality('high');
    effects.update(camera, { ...partialState, coverage: 0.99 }, 1 / 60, 0);
    expect(crescents.count).toBe(46);
    expect(bands.visible).toBe(true);
    expect(bands.position.y).toBeCloseTo(GROUND_SURFACE_Y + 0.035);

    effects.setQuality('medium');
    effects.update(camera, { ...partialState, coverage: 0.99 }, 1 / 60, 0);
    expect(crescents.count).toBe(30);
    expect(bands.visible).toBe(false);
    effects.dispose();
  });

  test('suppresses ground optics under an opaque cloud layer', () => {
    const scene = new THREE.Scene();
    const effects = new EclipseGroundEffects(scene);
    const crescents = scene.getObjectByName('eclipse-tree-crescents') as THREE.InstancedMesh;

    effects.update(new THREE.PerspectiveCamera(), partialState, 1 / 60, 1);

    expect(crescents.visible).toBe(false);
    effects.dispose();
  });

  test('removes its scene graph and disposes every owned GPU resource once', () => {
    const scene = new THREE.Scene();
    const effects = new EclipseGroundEffects(scene);
    const crescents = scene.getObjectByName('eclipse-tree-crescents') as THREE.InstancedMesh;
    const bands = scene.getObjectByName('eclipse-shadow-bands') as THREE.Mesh;
    const resources = [
      crescents.geometry,
      crescents.material as THREE.Material,
      bands.geometry,
      bands.material as THREE.Material,
    ];
    const listeners = resources.map(() => vi.fn());
    resources.forEach((resource, index) => resource.addEventListener('dispose', listeners[index]));

    effects.dispose();
    effects.dispose();

    expect(scene.getObjectByName('eclipse-ground-effects')).toBeUndefined();
    listeners.forEach((listener) => expect(listener).toHaveBeenCalledTimes(1));
  });
});
