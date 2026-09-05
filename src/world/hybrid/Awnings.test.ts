import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { Awnings, CLOSE_AT, OPEN_AT, TRAVEL, awningFold } from './Awnings';
import { buildCityModel } from './CityModel';

/**
 * The shop is open from ten to six, and the awning says so.
 *
 * What matters as much as the hours is that the state is a *function of the clock*. There
 * is no timer waiting for opening time, so there is no history to fall out of step: the
 * same hour gives the same answer whether the city was just loaded at that hour, dragged
 * there forwards, dragged there backwards, restored from a checkpoint, or left and
 * returned to.
 */

const HOUR = 1 / 24;

const mount = () => {
  const scene = new THREE.Scene();
  const awnings = new Awnings(scene, buildCityModel().buildings, new THREE.MeshStandardMaterial());
  const group = scene.getObjectByName('shop-awnings')!;
  return { awnings, group, shop: group.children[0] as THREE.Group };
};

/**
 * A part's box in the shop's own frame, where the facade is z = 0 and the street is +z.
 *
 * Read from the part's own matrix rather than from world space: the shopfronts these hang
 * on face -z, so a world-space box has its minimum where the assembly reaches *furthest
 * out*, and a test written on world coordinates passes no matter what the geometry does.
 */
const localBox = (part: THREE.Object3D): THREE.Box3 => {
  const mesh = part as THREE.Mesh;
  mesh.updateMatrix();
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrix);
};

/** Where a part's far face sits, in the same frame. */
const farFace = (part: THREE.Object3D, local: THREE.Vector3) => {
  part.updateMatrix();
  return local.clone().applyMatrix4(part.matrix);
};

describe('shop awnings', () => {
  test('open at ten, closed at six, folded the rest of the day', () => {
    expect(awningFold(0)).toBe(0);
    expect(awningFold(6 * HOUR)).toBe(0);
    expect(awningFold(OPEN_AT - 0.001)).toBe(0);
    // Fully out through the working day.
    expect(awningFold(12 * HOUR)).toBeCloseTo(1, 5);
    expect(awningFold(15 * HOUR)).toBeCloseTo(1, 5);
    expect(awningFold(CLOSE_AT - 0.001)).toBeCloseTo(1, 3);
    // And away again by the end of the evening.
    expect(awningFold(CLOSE_AT + TRAVEL + 0.001)).toBe(0);
    expect(awningFold(20 * HOUR)).toBe(0);
    expect(awningFold(23.9 * HOUR)).toBe(0);
  });

  test('the movement is short and calm, not a jump', () => {
    const opening = [0, 0.25, 0.5, 0.75, 1].map((k) => awningFold(OPEN_AT + k * TRAVEL));
    for (let i = 1; i < opening.length; i++) expect(opening[i]).toBeGreaterThan(opening[i - 1]);
    expect(opening[0]).toBeCloseTo(0, 5);
    expect(opening[opening.length - 1]).toBeCloseTo(1, 5);
    // Eased at both ends: the first step is smaller than the middle one.
    expect(opening[1] - opening[0]).toBeLessThan(opening[2] - opening[1]);

    const closing = [0, 0.5, 1].map((k) => awningFold(CLOSE_AT + k * TRAVEL));
    expect(closing[0]).toBeCloseTo(1, 3);
    expect(closing[2]).toBeCloseTo(0, 5);
    expect(closing[1]).toBeLessThan(closing[0]);
  });

  test('the same hour gives the same state however it was reached', () => {
    // Arrived at, dragged forwards past, dragged backwards past, and a whole day later.
    const noon = awningFold(0.5);
    expect(awningFold(0.5 + 1)).toBeCloseTo(noon, 10);
    expect(awningFold(0.5 - 1)).toBeCloseTo(noon, 10);
    for (const jump of [0.1, 0.42, 0.6, 0.74, 0.9]) {
      expect(awningFold(jump), `skok do ${jump}`).toBe(awningFold(jump));
      expect(awningFold(jump + 2)).toBeCloseTo(awningFold(jump), 10);
    }
  });

  test('a few shops have one, not the whole estate', () => {
    const { awnings } = mount();
    expect(awnings.count).toBeGreaterThan(0);
    // Small enough to read as a signal. The city has thirty-four blocks.
    expect(awnings.count).toBeLessThanOrEqual(8);
    awnings.dispose();
  });

  test('folded, the whole assembly is put away in its housing', () => {
    const { awnings, shop } = mount();
    awnings.update(3 * HOUR);
    for (const part of shop.children) {
      // The housing is 18 cm deep; nothing may stand out past it when the shop is shut.
      expect(localBox(part).max.z, 'coś wystaje ze zwiniętej markizy').toBeLessThanOrEqual(0.2);
    }
    awnings.dispose();
  });

  test('open, it reaches out, slopes down and stays one piece', () => {
    const { awnings, shop } = mount();
    awnings.update(12 * HOUR);
    const [, fabric, valance, ...arms] = shop.children;

    // Out over the pavement, and the far edge lower than the roller it hangs from.
    const tip = farFace(fabric, new THREE.Vector3(0, 0, 0.5));
    expect(tip.z).toBeGreaterThan(1);
    expect(tip.y).toBeLessThan(-0.2);

    // The skirt hangs off that very edge, and both arms end at it: the covering cannot
    // float off its supports or hang through them.
    expect(farFace(valance, new THREE.Vector3(0, 0.5, 0)).z).toBeCloseTo(tip.z, 6);
    expect(farFace(valance, new THREE.Vector3(0, 0.5, 0)).y).toBeCloseTo(tip.y, 6);
    for (const arm of arms) {
      const end = farFace(arm, new THREE.Vector3(0, 0, 0.5));
      expect(end.z).toBeCloseTo(tip.z, 6);
      expect(end.y).toBeCloseTo(tip.y, 6);
    }
    // And the arms are two members under the sheet, not edging along its rim.
    const xs = arms.map((arm) => arm.position.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThan(0.8);
    awnings.dispose();
  });

  test('the assembly never reaches back into the wall it hangs on', () => {
    const { awnings, shop } = mount();
    for (const t of [OPEN_AT, OPEN_AT + TRAVEL / 2, 0.5, CLOSE_AT, CLOSE_AT + TRAVEL / 2]) {
      awnings.update(t);
      for (const part of shop.children) {
        expect(localBox(part).min.z, `t=${t.toFixed(3)}: element wchodzi w elewację`).toBeGreaterThan(-0.02);
      }
    }
    awnings.dispose();
  });
});
