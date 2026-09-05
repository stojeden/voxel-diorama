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
    const scene = new THREE.Scene();
    const awnings = new Awnings(scene, buildCityModel().buildings);
    expect(awnings.count).toBeGreaterThan(0);
    // Small enough to read as a signal. The city has thirty-four blocks.
    expect(awnings.count).toBeLessThanOrEqual(8);
    awnings.dispose();
  });

  test('folded, it sits against the wall; open, it reaches out and stays whole', () => {
    const scene = new THREE.Scene();
    const awnings = new Awnings(scene, buildCityModel().buildings);
    const group = scene.getObjectByName('shop-awnings')!;

    awnings.update(3 * HOUR);
    expect(group.visible, 'zwinięta markiza nie musi się rysować').toBe(false);

    awnings.update(12 * HOUR);
    expect(group.visible).toBe(true);
    const shop = group.children[0] as THREE.Group;
    const fabric = shop.children[0] as THREE.Mesh;
    const arms = shop.children.slice(1) as THREE.Mesh[];
    // Sheet and arms share one reach and one tilt, so the covering cannot float off its
    // supports or hang through them.
    for (const arm of arms) {
      expect(arm.scale.z).toBeCloseTo(fabric.scale.z, 6);
      expect(arm.rotation.x).toBeCloseTo(fabric.rotation.x, 6);
      expect(arm.position.z).toBeCloseTo(fabric.position.z, 6);
    }
    // Extended away from the facade, and sloping down rather than up.
    expect(fabric.position.z).toBeGreaterThan(0.4);
    expect(fabric.rotation.x).toBeLessThan(0);
    awnings.dispose();
  });

  test('the assembly never reaches back into the wall it hangs on', () => {
    const scene = new THREE.Scene();
    const awnings = new Awnings(scene, buildCityModel().buildings);
    const group = scene.getObjectByName('shop-awnings')!;
    const box = new THREE.Box3();
    for (const t of [OPEN_AT, OPEN_AT + TRAVEL / 2, 0.5, CLOSE_AT, CLOSE_AT + TRAVEL / 2]) {
      awnings.update(t);
      const shop = group.children[0] as THREE.Group;
      shop.updateWorldMatrix(true, true);
      for (const child of shop.children) {
        box.setFromObject(child);
        // In the shop's own frame the facade is at z = 0 and the street is +z.
        const local = shop.worldToLocal(box.min.clone());
        expect(local.z, `t=${t.toFixed(3)}: element wchodzi w elewację`).toBeGreaterThan(-0.2);
      }
    }
    awnings.dispose();
  });
});
