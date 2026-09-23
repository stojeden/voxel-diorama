import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { Balloon, planBalloonCrossing } from './Balloon';

const EDGE = 115;

/** Downwind unit vectors at 15-degree steps, so no bearing is a special case by accident. */
const BEARINGS = Array.from({ length: 24 }, (_, index) => {
  const angle = (index * Math.PI) / 12;
  return { angle, x: Math.cos(angle), z: Math.sin(angle) };
});

describe('the balloon crosses the world along the wind', () => {
  test('it enters UPWIND of where it leaves, at every bearing', () => {
    // The headline of the change and the sign error most likely to survive review: with the
    // vector pointing the way the wind BLOWS TOWARD, the entry must sit behind the centre
    // along it and the exit ahead. Swap the convention at one end and this flips.
    for (const bearing of BEARINGS) {
      for (const lateral of [-45, -12, 0, 20, 44]) {
        const crossing = planBalloonCrossing(bearing.x, bearing.z, lateral, EDGE);
        const entryAlong = crossing.entryX * bearing.x + crossing.entryZ * bearing.z;
        const exitAlong = crossing.exitX * bearing.x + crossing.exitZ * bearing.z;
        expect(entryAlong).toBeLessThan(0);
        expect(exitAlong).toBeGreaterThan(0);
        expect(exitAlong - entryAlong).toBeCloseTo(crossing.length, 9);
      }
    }
  });

  test('a north wind carries it south', () => {
    // The owner's own example, in world terms. Air arriving from the north travels toward
    // +z, so the balloon must start at negative z and finish at positive z.
    const crossing = planBalloonCrossing(0, 1, 0, EDGE);
    expect(crossing.entryZ).toBeCloseTo(-EDGE, 9);
    expect(crossing.exitZ).toBeCloseTo(EDGE, 9);
  });

  test('both ends sit ON the world boundary, so nothing pops into existence', () => {
    for (const bearing of BEARINGS) {
      for (const lateral of [-45, 0, 33]) {
        const crossing = planBalloonCrossing(bearing.x, bearing.z, lateral, EDGE);
        for (const [x, z] of [[crossing.entryX, crossing.entryZ], [crossing.exitX, crossing.exitZ]]) {
          expect(Math.max(Math.abs(x), Math.abs(z))).toBeCloseTo(EDGE, 6);
        }
      }
    }
  });

  test('the crossing distance follows the bearing rather than being a constant', () => {
    // The profile runs on PROGRESS for this reason: a diagonal pass is half again as long
    // as an axis-aligned one, so `x` stopped being a measure of how far through it is.
    const axis = planBalloonCrossing(1, 0, 0, EDGE);
    const diagonal = planBalloonCrossing(Math.SQRT1_2, Math.SQRT1_2, 0, EDGE);
    expect(axis.length).toBeCloseTo(EDGE * 2, 9);
    expect(diagonal.length).toBeCloseTo(EDGE * 2 * Math.SQRT2, 6);
    expect(diagonal.length).toBeGreaterThan(axis.length * 1.4);
  });

  test('the jet keeps its old west-to-east pass exactly', () => {
    // The space jet flies under power, not with the air, so it is handed (1, 0) rather than
    // the wind. That has to reproduce the track it had before this change, not approximate it.
    for (const lateral of [-45, 0, 45]) {
      const crossing = planBalloonCrossing(1, 0, lateral, EDGE);
      expect(crossing.entryX).toBe(-EDGE);
      expect(crossing.exitX).toBe(EDGE);
      expect(crossing.entryZ).toBe(lateral);
      expect(crossing.exitZ).toBe(lateral);
    }
  });

  test('the crossing reports the direction it was actually laid out along', () => {
    for (const bearing of BEARINGS) {
      const crossing = planBalloonCrossing(bearing.x, bearing.z, 12, EDGE);
      expect(crossing.dirX).toBe(bearing.x);
      expect(crossing.dirZ).toBe(bearing.z);
    }
  });

  test('a direction that is not a direction falls back instead of returning NaN', () => {
    // Both components zero is not an axis-aligned crossing, it is a point. Both axes hit the
    // `d === 0` skip, `enter` stayed -Infinity and `exit` +Infinity, and every returned
    // coordinate was `0 * -Infinity` — NaN, which puts the craft nowhere and removes it from
    // the picture in silence. The old comment claimed this case was handled; it handled the
    // half of it that still has a line.
    for (const lateral of [-45, 0, 33]) {
      const crossing = planBalloonCrossing(0, 0, lateral, EDGE);
      for (const value of Object.values(crossing)) expect(Number.isFinite(value)).toBe(true);
      // The fallback is the west-to-east pass the balloon flew before it had a wind, and the
      // caller is told about it, because it has to fly the line its own entry sits on.
      expect(crossing.dirX).toBe(1);
      expect(crossing.dirZ).toBe(0);
      expect(crossing.entryX).toBe(-EDGE);
      expect(crossing.exitX).toBe(EDGE);
      expect(crossing.length).toBe(EDGE * 2);
    }
  });

  test('a non-finite direction is caught by the same guard', () => {
    // `lengthSquared > 0` is false for NaN, so one guard covers both shapes of nonsense.
    for (const [dx, dz] of [[NaN, 0], [0, NaN], [Infinity, 1], [NaN, NaN]]) {
      const crossing = planBalloonCrossing(dx, dz, 20, EDGE);
      for (const value of Object.values(crossing)) expect(Number.isFinite(value)).toBe(true);
      expect(crossing.dirX).toBe(1);
      expect(crossing.dirZ).toBe(0);
    }
  });

  test('a still-air crossing is still a crossing a viewer sees the end of', () => {
    // The speed law (3 + wind * 3.5) is untouched, and its 3 m/s floor is the reason. The
    // worst case is the longest crossing at the weakest wind; if this ever passes two
    // minutes, the balloon has become something nobody watches.
    const longest = planBalloonCrossing(Math.SQRT1_2, Math.SQRT1_2, 0, EDGE).length;
    expect(longest / (3 + 0 * 3.5)).toBeLessThan(120);
  });
});

describe('the balloon travels with the air and does not point into it', () => {
  /** Launch a flight and hand back the group `Balloon` added to the scene. */
  function launch(windDirX: number, windDirZ: number): { craft: THREE.Object3D; balloon: Balloon } {
    const scene = new THREE.Scene();
    const balloon = new Balloon(scene, () => 0.5);
    // Fair weather, day, and enough delta to run the cooldown out: the flight starts.
    balloon.update(20, 0, 0, 0, 0.5, windDirX, windDirZ);
    return { craft: scene.children[0], balloon };
  }

  test('the yaw is a free spin, not a heading lock', () => {
    // A heading lock was tried here and is wrong physics, so this test exists to stop the
    // next reader "fixing" it back. A free balloon travels WITH the air: no airspeed, no
    // relative wind, nothing to weathervane into, and so no heading at all. Real envelopes
    // turn slowly and arbitrarily. What flies with the wind is the TRACK, not the nose.
    const north = launch(0, 1);
    const east = launch(1, 0);
    for (const elapsed of [3, 17, 41]) {
      north.balloon.update(0.016, elapsed, 0, 0, 0.5, 0, 1);
      east.balloon.update(0.016, elapsed, 0, 0, 0.5, 1, 0);
      // Two balloons in winds ninety degrees apart hold the same yaw: it is not a heading.
      expect(north.craft.rotation.y).toBe(east.craft.rotation.y);
      expect(north.craft.rotation.y).toBeCloseTo(elapsed * 0.06, 9);
    }
    north.balloon.dispose();
    east.balloon.dispose();
  });

  test('it stays on the ground in rain, which the owner asked for and already had', () => {
    // "Kiedy pada deszcz, to żeby nie było balonu latającego." Verified, not implemented:
    // the gate is `cloudCover < 0.4` and rain's cover is 0.92, so a balloon has never flown
    // in a shower. This test exists so that the next person to retune rain's cloud cover --
    // the gale above moved its WIND, and cover is the next number anyone reaches for -- finds
    // out here rather than from the owner.
    const scene = new THREE.Scene();
    const balloon = new Balloon(scene, () => 0.5);
    for (let minute = 0; minute < 30; minute++) balloon.update(60, minute * 60, 0, 0.92, 0.82, 1, 0);
    expect(scene.children[0].visible).toBe(false);

    // And it is the cover doing it, not the wind: the same gale in fair weather flies.
    balloon.update(60, 1800, 0, 0.12, 0.82, 1, 0);
    expect(scene.children[0].visible).toBe(true);
    balloon.dispose();
  });

  test('but the TRACK is the wind, which is what the owner asked for', () => {
    const { craft, balloon } = launch(0, 1);
    const entryZ = craft.position.z;
    balloon.update(4, 1, 0, 0, 0.5, 0, 1);
    // Air arriving from the north travels toward +z, and so does the balloon.
    expect(entryZ).toBeLessThan(0);
    expect(craft.position.z).toBeGreaterThan(entryZ);
    balloon.dispose();
  });
});

describe('the jet flies nose first', () => {
  /** Fly until a crossing ends, then until the next one is well under way. */
  const flyOne = (balloon: Balloon, scene: THREE.Scene, start: number): number => {
    let elapsed = start;
    const craft = scene.getObjectByName('balloon-flight')!;
    let wasFlying = craft.visible;
    for (let i = 0; i < 20_000; i++) {
      elapsed += 0.1;
      balloon.update(0.1, elapsed, 0, 0, 0.5, 0.6, 0.8);
      if (wasFlying && !craft.visible) return elapsed;
      wasFlying = craft.visible;
    }
    throw new Error('no crossing ended');
  };

  test('after a balloon flight the jet still points where it is going', () => {
    const scene = new THREE.Scene();
    const balloon = new Balloon(scene, () => 0.5);
    const craft = scene.getObjectByName('balloon-flight')!;

    // One balloon flight, long enough for the free spin to leave the group turned.
    const end = flyOne(balloon, scene, 0);
    expect(Math.abs(craft.rotation.y), 'the balloon never turned, so this proves nothing').toBeGreaterThan(0.3);

    balloon.setCyberMode(true);
    let elapsed = end;
    const before = new THREE.Vector3();
    const nose = new THREE.Vector3();
    for (let i = 0; i < 2_000 && !craft.visible; i++) {
      elapsed += 0.1;
      balloon.update(0.1, elapsed, 0, 0, 0.5, 0.6, 0.8);
    }
    expect(craft.visible, 'the jet never launched').toBe(true);
    before.copy(craft.position);
    for (let i = 0; i < 20; i++) {
      elapsed += 0.1;
      balloon.update(0.1, elapsed, 0, 0, 0.5, 0.6, 0.8);
    }
    const travel = craft.position.clone().sub(before).setY(0).normalize();
    craft.updateMatrixWorld(true);
    nose.set(1, 0, 0).transformDirection(craft.matrixWorld).setY(0).normalize();
    expect(nose.dot(travel), 'the jet is flying sideways or tail-first').toBeGreaterThan(0.95);
  });
});
