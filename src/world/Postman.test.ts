import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { Postman } from './Postman';

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
        expect(state.riderVisible).toBe(true);
        expect(state.riderOpacity).toBe(1);
      }
      maxReaction = Math.max(maxReaction, state.chaseReaction);
    }

    expect(sawChase).toBe(true);
    expect(maxReaction).toBeGreaterThan(0.25);
    postman.dispose();
  });
});
