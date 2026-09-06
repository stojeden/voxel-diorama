import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { BUS_ROUTE_CURVE, BUS_STOPS, isOnRoad, isOnSidewalk } from '../WorldLayout';
import { GLOW_FOOTPRINT } from './busGlow';

/**
 * Does the road mark stay on the carriageway everywhere the bus goes?
 *
 * Its width proves that on a straight and nothing at all on a turn: a rigid rectangle
 * following a curve swings its corners wider than its own half-width, and the bus stops
 * are exactly where the carriageway narrows against a kerb. So this walks the whole route,
 * places the rectangle the way the bus places it -- midpoint of two virtual axles on the
 * curve, oriented by the chord between them -- and asks the world whether each corner is
 * over road.
 *
 * Reproducing the placement with a real `Object3D` and `lookAt` rather than re-deriving the
 * yaw: the transform under test is the app's, and rewriting it here would only prove that
 * two different pieces of trigonometry agree.
 */
const AXLE_OFFSET_METERS = 2.6;
const ROUTE_LENGTH = BUS_ROUTE_CURVE.getLength();
const wrap01 = (value: number) => ((value % 1) + 1) % 1;

function cornersAt(t: number): THREE.Vector3[] {
  const dT = AXLE_OFFSET_METERS / ROUTE_LENGTH;
  const front = BUS_ROUTE_CURVE.getPointAt(wrap01(t + dT));
  const rear = BUS_ROUTE_CURVE.getPointAt(wrap01(t - dT));
  const mid = front.clone().add(rear).multiplyScalar(0.5);
  const forward = front.clone().sub(rear).normalize();

  const carrier = new THREE.Object3D();
  carrier.position.copy(mid);
  // The bus front sits on -Z, so the look target is behind it -- the same inversion the
  // vehicle itself does.
  carrier.lookAt(mid.clone().sub(forward));
  carrier.updateMatrixWorld(true);

  const halfX = GLOW_FOOTPRINT.width / 2;
  const halfZ = GLOW_FOOTPRINT.length / 2;
  return [
    new THREE.Vector3(-halfX, 0, -halfZ),
    new THREE.Vector3(halfX, 0, -halfZ),
    new THREE.Vector3(-halfX, 0, halfZ),
    new THREE.Vector3(halfX, 0, halfZ),
  ].map((corner) => carrier.localToWorld(corner));
}

/**
 * Corners that land on something unpaved, which is the line that matters.
 *
 * Not "off the carriageway": the bus's own body leaves `isOnRoad` at the one place where
 * its route overhangs a kerb, so holding a light mark to a stricter standard than the
 * vehicle casting it would be measuring the wrong thing. Light falling on a paved kerb is
 * what light does. Light lying on grass is not.
 */
function unpavedCorners(samples: number): string[] {
  const bad: string[] = [];
  for (let step = 0; step < samples; step++) {
    const t = step / samples;
    for (const corner of cornersAt(t)) {
      const x = Math.round(corner.x);
      const z = Math.round(corner.z);
      if (isOnRoad(x, z) || isOnSidewalk(x, z)) continue;
      bad.push(`t=${t.toFixed(4)} (${x}, ${z})`);
    }
  }
  return bad;
}

describe('the bus road mark stays on paved ground', () => {
  test('all the way round the route, corners included', () => {
    // 1 600 positions: at 3.6 m by 8.8 m this found three samples on grass beside the
    // heating plant, which is how the footprint came to be 3.4 by 8.4.
    const bad = unpavedCorners(1600);
    expect(bad.length, bad.slice(0, 4).join('; ') || 'wszystkie na utwardzonym').toBe(0);
  });

  test('at every stop, where the carriageway is tightest against the kerb', () => {
    const bad: string[] = [];
    for (const stop of BUS_STOPS) {
      // Either side of the stop as well: the bus brakes into it and pulls out of it.
      for (const offset of [-0.006, -0.003, 0, 0.003, 0.006]) {
        for (const corner of cornersAt(wrap01(stop.atT + offset))) {
          const x = Math.round(corner.x);
          const z = Math.round(corner.z);
          if (isOnRoad(x, z) || isOnSidewalk(x, z)) continue;
          bad.push(`${stop.label} t=${(stop.atT + offset).toFixed(4)} (${x}, ${z})`);
        }
      }
    }
    expect(bad.length, bad.slice(0, 4).join('; ') || 'wszystkie na utwardzonym').toBe(0);
  });

  test('the mark is no wider than the carriageway it is drawn on', () => {
    // The guard against the failure that started this: a 5.2 m mark on a 5 m carriageway,
    // which also made the bus measure 6.2 m wide to `clearance.test.ts`.
    expect(GLOW_FOOTPRINT.width).toBeLessThan(4.0);
    expect(GLOW_FOOTPRINT.length).toBeLessThan(9.0);
  });
});
