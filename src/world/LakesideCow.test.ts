import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { LakesideCow } from './LakesideCow';
import { GROUND_SURFACE_Y } from './WorldLayout';

/**
 * The storyline's props stand on the walkable ground, y = -0.5.
 *
 * Every height in this file was once written against a ground of +0.5, and a mechanical
 * conversion kept some of them: the farmer walked a metre above the meadow, the crate
 * floated half a metre, a sleeping cow hovered 0.36 m over the grass all night. Measured on
 * the geometry, as height over the ground, so a model change cannot hide behind a constant.
 */
interface Internals {
  farmer: { group: THREE.Group };
  crate: THREE.Mesh;
  cow: { group: THREE.Group };
  startFarmerTask(task: 'search' | 'celebrate'): void;
}

const lowestPoint = (object: THREE.Object3D): number => {
  object.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object).min.y;
};

const run = (cow: LakesideCow, seconds: number, night: number, from = 0): number => {
  let elapsed = from;
  for (let i = 0; i < Math.round(seconds / 0.05); i++) {
    elapsed += 0.05;
    cow.update(0.05, elapsed, night);
  }
  return elapsed;
};

describe('the lakeside storyline stands on the ground', () => {
  test('the farmer walks on the meadow, not a metre above it', () => {
    const cow = new LakesideCow(new THREE.Scene());
    const inside = cow as unknown as Internals;
    inside.startFarmerTask('search');
    let worst = 0;
    let elapsed = 0;
    for (let i = 0; i < 200; i++) {
      elapsed = run(cow, 0.05, 0, elapsed);
      if (!inside.farmer.group.visible) continue;
      worst = Math.max(worst, Math.abs(lowestPoint(inside.farmer.group) - GROUND_SURFACE_Y));
    }
    // The walking bob lifts him by at most 5 cm.
    expect(worst, 'the farmer is not standing on the meadow').toBeLessThan(0.07);
  });

  test('the goods crate sits on the pavement', () => {
    const cow = new LakesideCow(new THREE.Scene());
    const { crate } = cow as unknown as Internals;
    expect(lowestPoint(crate) - GROUND_SURFACE_Y).toBeCloseTo(0, 3);
  });

  test('a sleeping cow lies on the grass rather than hovering over it', () => {
    const cow = new LakesideCow(new THREE.Scene());
    cow.debugPlaceCowAtMeadow();
    run(cow, 0.5, 1);
    const { cow: model } = cow as unknown as Internals;
    expect(lowestPoint(model.group) - GROUND_SURFACE_Y, 'she floats above the meadow').toBeLessThan(0.02);
  });
});
