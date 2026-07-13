import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  Fisherman,
  FISHERMAN_SEATED_BODY_BOTTOM_OFFSET,
  ICE_SEATED_Y,
  ICE_SURFACE_Y,
} from './Fisherman';
import { GROUND_SURFACE_Y } from './WorldLayout';

function expectSeatedPose(
  scene: THREE.Scene,
  stoolName: string,
  surfaceY: number,
  stoolDepth: number
): void {
  scene.updateMatrixWorld(true);
  const stool = scene.getObjectByName(stoolName);
  expect(stool).toBeDefined();
  const stoolBounds = new THREE.Box3().setFromObject(stool!);

  for (let index = 0; index < 2; index++) {
    const thigh = scene.getObjectByName(`fisherman-seated-thigh-${index}`);
    const shin = scene.getObjectByName(`fisherman-seated-shin-${index}`);
    const shoe = scene.getObjectByName(`fisherman-seated-shoe-${index}`);
    expect(thigh).toBeDefined();
    expect(shin).toBeDefined();
    expect(shoe).toBeDefined();

    const thighBounds = new THREE.Box3().setFromObject(thigh!);
    const shoeBounds = new THREE.Box3().setFromObject(shoe!);
    expect(thighBounds.min.y).toBeGreaterThanOrEqual(stoolBounds.max.y - 0.002);
    expect((shin as THREE.Mesh).position.z - 0.21 / 2).toBeGreaterThan(stoolDepth / 2);
    expect(shoeBounds.min.y).toBeCloseTo(surfaceY, 3);
  }
}

describe('fisherman seated pose', () => {
  test('uses bent legs and a grounded stool in both seasons', () => {
    const scene = new THREE.Scene();
    const fisherman = new Fisherman(scene);

    fisherman.debugSetWinterFishing();
    fisherman.update(1 / 60, 1, 0.2, 1);

    const state = fisherman.getDebugState();
    const iceGear = scene.getObjectByName('fisherman-ice-gear');
    const stool = scene.getObjectByName('fisherman-ice-stool-seat');
    const tackleBox = scene.getObjectByName('fisherman-ice-tackle-box');
    expect(state).toMatchObject({
      mode: 'fishing',
      seatKind: 'ice',
      iceGearVisible: true,
      shoreGearVisible: false,
      seatedLegsVisible: true,
      standingLegsVisible: false,
    });
    expect(state.figureY).toBeCloseTo(ICE_SEATED_Y, 5);
    expect(iceGear).toBeDefined();
    expect(stool).toBeDefined();
    expect(tackleBox).toBeDefined();

    const gearBounds = new THREE.Box3().setFromObject(iceGear!);
    const stoolBounds = new THREE.Box3().setFromObject(stool!);
    expect(gearBounds.min.y).toBeLessThanOrEqual(ICE_SURFACE_Y + 0.02);
    expect(
      state.figureY + FISHERMAN_SEATED_BODY_BOTTOM_OFFSET - stoolBounds.max.y
    ).toBeCloseTo(0.035, 3);
    expectSeatedPose(scene, 'fisherman-ice-stool-seat', ICE_SURFACE_Y, 0.76);

    fisherman.debugSetShoreFishing();
    fisherman.update(1 / 60, 2, 0.2, 0);
    expect(fisherman.getDebugState()).toMatchObject({
      mode: 'fishing',
      seatKind: 'shore',
      iceGearVisible: false,
      shoreGearVisible: true,
      seatedLegsVisible: true,
      standingLegsVisible: false,
    });
    expectSeatedPose(scene, 'fisherman-shore-stool-seat', GROUND_SURFACE_Y, 0.72);

    fisherman.dispose();
    expect(scene.getObjectByName('fisherman-ice-gear')).toBeUndefined();
  });
});
