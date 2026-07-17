import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { POSTMAN_STOP_TS, POSTMAN_UNIFORM_COLOR, Postman } from './Postman';

describe('postman and dog interaction', () => {
  test('keeps the complete opaque rider visible while the dog gives chase', () => {
    const scene = new THREE.Scene();
    const postman = new Postman(scene);
    let sawChase = false;
    let maxReaction = 0;

    for (let frame = 0; frame < 140; frame++) {
      postman.update(0.25, frame * 0.25, 0.32);
      const state = postman.getDebugState();
      if (state.dogMode === 'chase') {
        sawChase = true;
        expect(state.active).toBe(true);
        expect(state.bikeVisible).toBe(true);
        expect(state.riderGroupVisible).toBe(true);
        expect(state.riderVisible).toBe(true);
        expect(state.riderOpacity).toBe(1);
        expect(state.riderHiddenParts).toBe(0);
        expect(state.riderWorldY).toBeGreaterThan(2);
      }
      maxReaction = Math.max(maxReaction, state.chaseReaction);
    }

    expect(sawChase).toBe(true);
    expect(maxReaction).toBeGreaterThan(0.25);
    postman.dispose();
  });

  test('keeps bicycle and rider visibility synchronized for the complete route and next day', () => {
    const scene = new THREE.Scene();
    const postman = new Postman(scene);

    postman.update(0.1, 0, 0.2);
    let state = postman.getDebugState();
    expect(state.bikeVisible).toBe(false);
    expect(state.riderGroupVisible).toBe(false);

    let sawActive = false;
    let sawFinished = false;
    for (let frame = 0; frame < 600; frame++) {
      postman.update(0.25, frame * 0.25, 0.32);
      state = postman.getDebugState();
      expect(state.bikeVisible).toBe(state.active);
      expect(state.riderGroupVisible).toBe(state.active);
      expect(state.riderVisible).toBe(state.active);
      expect(state.riderOpacity).toBe(1);
      expect(state.riderHiddenParts).toBe(0);
      expect(state.riderMeshCount).toBeGreaterThanOrEqual(10);
      if (state.active) expect(state.riderWorldY).toBeGreaterThan(2);
      sawActive ||= state.active;
      if (sawActive && !state.active) {
        sawFinished = true;
        break;
      }
    }

    expect(sawActive).toBe(true);
    expect(sawFinished).toBe(true);
    expect(state.deliveryStops).toEqual(POSTMAN_STOP_TS);
    expect(state.deliveryStops).toHaveLength(3);
    expect(state.deliveryStops[0]).toBeLessThan(state.deliveryStops[1]);
    expect(state.deliveryStops[1]).toBeLessThan(state.deliveryStops[2]);

    // Moving the clock backwards within the same day must not restart a route.
    postman.update(0.1, 200, 0.6);
    postman.update(0.1, 201, 0.32);
    state = postman.getDebugState();
    expect(state.active).toBe(false);

    // Only an actual day wrap arms the next morning round.
    postman.update(0.1, 202, 0.95);
    postman.update(0.1, 203, 0.02);
    postman.update(0.1, 204, 0.32);
    state = postman.getDebugState();
    expect(state.active).toBe(true);
    expect(state.bikeVisible).toBe(true);
    expect(state.riderGroupVisible).toBe(true);
    postman.dispose();
  });

  test('uses a blue postal uniform with an attached cap, satchel and badge', () => {
    const scene = new THREE.Scene();
    const postman = new Postman(scene);
    const uniform = scene.getObjectByName('postman-uniform') as THREE.Mesh;
    const material = uniform.material as THREE.MeshStandardMaterial;

    expect(material.color.getHex()).toBe(POSTMAN_UNIFORM_COLOR);
    expect(scene.getObjectByName('postman-cap')).toBeTruthy();
    expect(scene.getObjectByName('postman-cap-brim')).toBeTruthy();
    expect(scene.getObjectByName('postman-satchel')).toBeTruthy();
    expect(scene.getObjectByName('postman-satchel-strap')).toBeTruthy();
    expect(scene.getObjectByName('postman-badge')).toBeTruthy();

    const bike = scene.getObjectByName('postman-bike') as THREE.Group;
    const rider = scene.getObjectByName('postman-rider') as THREE.Group;
    expect(rider.parent).toBe(bike);
    bike.updateWorldMatrix(true, true);
    expect(rider.matrixWorld.elements.every(Number.isFinite)).toBe(true);
    expect(rider.position.length()).toBeLessThan(2);

    postman.dispose();
  });

  test('does not resume a stale dog chase after an eclipse reaction', () => {
    const scene = new THREE.Scene();
    const postman = new Postman(scene);
    let elapsed = 0;

    for (let frame = 0; frame < 240 && postman.getDebugState().dogMode !== 'chase'; frame++) {
      elapsed += 0.25;
      postman.update(0.25, elapsed, 0.32);
    }
    expect(postman.getDebugState().dogMode).toBe('chase');

    postman.setEclipseReaction({
      attention: 1,
      movementScale: 0.2,
      eyeProtection: 1,
      projection: 1,
      dogAlert: 1,
    });
    for (let frame = 0; frame < 32; frame++) {
      elapsed += 0.25;
      postman.update(0.25, elapsed, 0.32);
    }
    expect(postman.getDebugState().dogMode).toBe('returnHome');

    postman.setEclipseReaction({
      attention: 0,
      movementScale: 1,
      eyeProtection: 0,
      projection: 0,
      dogAlert: 0,
    });
    for (let frame = 0; frame < 240 && postman.getDebugState().dogMode !== 'home'; frame++) {
      elapsed += 0.25;
      postman.update(0.25, elapsed, 0.32);
    }
    expect(postman.getDebugState().dogMode).toBe('home');
    postman.dispose();
  });
});
