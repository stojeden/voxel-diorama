import * as THREE from 'three';
import {
  BENCH_DIMENSIONS,
  BUS_SHELTER_POST_SIZE,
  BUS_SHELTER_SIGN_SIZE,
  GROUND_SURFACE_Y,
  busShelterCenter,
  type BusStop,
} from './WorldLayout';

export const PEDESTRIAN_RADIUS = 0.32;
/** Bus half-width plus enough room for the passenger centre outside the doors. */
export const BUS_DOOR_APPROACH_DISTANCE = 1.51;

export interface CollisionRect {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function localToWorld(stop: BusStop, along: number, outward: number, y = GROUND_SURFACE_Y): THREE.Vector3 {
  const center = busShelterCenter(stop);
  return stop.axis === 'x'
    ? new THREE.Vector3(center.x + along, y, center.z + outward * stop.benchSign)
    : new THREE.Vector3(center.x + outward * stop.benchSign, y, center.z + along);
}

function localRect(
  stop: BusStop,
  id: string,
  along: number,
  outward: number,
  alongHalfSize: number,
  outwardHalfSize: number,
  clearance: number
): CollisionRect {
  const center = localToWorld(stop, along, outward);
  const halfX = stop.axis === 'x' ? alongHalfSize : outwardHalfSize;
  const halfZ = stop.axis === 'x' ? outwardHalfSize : alongHalfSize;
  return {
    id,
    minX: center.x - halfX - clearance,
    maxX: center.x + halfX + clearance,
    minZ: center.z - halfZ - clearance,
    maxZ: center.z + halfZ + clearance,
  };
}

/** Solid bus-stop geometry inflated by a pedestrian radius. */
export function busShelterColliders(
  stop: BusStop,
  clearance = PEDESTRIAN_RADIUS
): CollisionRect[] {
  // Half the real post, not half a metre: a 0.16 m post used to be a 1.0 m box, which
  // ate 1.7 m of the 4 m between the posts and left the waiting figures nowhere to
  // stand apart from each other.
  const post = BUS_SHELTER_POST_SIZE / 2;
  return [
    localRect(stop, 'left-post', -2, 0, post, post, clearance),
    localRect(stop, 'right-post', 2, 0, post, post, clearance),
    // Advertising lightbox closes the left side; pedestrians use the open
    // right end selected by busStopWalkingPath.
    // The glass end wall is 1.35 m deep now, not 1.75.
    localRect(stop, 'poster-wall', -2, 0.5, 0.1, 0.7, clearance),
    localRect(
      stop,
      'bench',
      0,
      1,
      BENCH_DIMENSIONS.length / 2,
      BENCH_DIMENSIONS.depth / 2,
      clearance
    ),
    localRect(stop, 'stop-sign', -3, 1, BUS_SHELTER_SIGN_SIZE / 2, BUS_SHELTER_SIGN_SIZE / 2, clearance),
  ];
}

export function isPointClear(point: THREE.Vector3, colliders: readonly CollisionRect[]): boolean {
  return !colliders.some(
    (rect) =>
      point.x >= rect.minX &&
      point.x <= rect.maxX &&
      point.z >= rect.minZ &&
      point.z <= rect.maxZ
  );
}

/**
 * Four deterministic waiting spots under the roof, behind the bench.
 *
 * Two loose rows rather than one line. The product's figure is 0.874 m across with its
 * arms, and the space between the shelter posts is 4 m, so four figures in a single
 * row stood 0.67 m apart and their arms passed through each other. Staggered in two
 * rows the nearest pair is 0.84 m apart, which reads as a group waiting rather than a
 * rank, and every body still falls inside the 2 m roof.
 */
export function busStopWaitingPositions(stop: BusStop): THREE.Vector3[] {
  return ([
    [-0.95, -0.05],
    [0.45, -0.05],
    [-0.25, -0.52],
    [1.15, -0.52],
  ] as const).map(([along, outward]) => localToWorld(stop, along, outward));
}

/**
 * Route around the unoccupied end of the shelter. The extra rear waypoint
 * prevents a passenger starting near the right post from cutting its corner.
 */
export function busStopWalkingPath(
  stop: BusStop,
  waitPosition: THREE.Vector3,
  doorPosition: THREE.Vector3
): THREE.Vector3[] {
  const center = busShelterCenter(stop);
  const along = stop.axis === 'x' ? waitPosition.x - center.x : waitPosition.z - center.z;
  return [
    waitPosition.clone(),
    localToWorld(stop, along, -1.15),
    localToWorld(stop, 3.05, -1.15),
    localToWorld(stop, 3.05, 1.75),
    doorPosition.clone(),
  ];
}

export function polylineLengths(points: readonly THREE.Vector3[]): { segments: number[]; total: number } {
  const segments: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += points[i - 1].distanceTo(points[i]);
    segments.push(total);
  }
  return { segments, total };
}

export function samplePolyline(
  points: readonly THREE.Vector3[],
  cumulativeLengths: readonly number[],
  totalLength: number,
  progress: number,
  target: THREE.Vector3
): THREE.Vector3 {
  const distance = THREE.MathUtils.clamp(progress, 0, 1) * totalLength;
  let previousLength = 0;
  for (let i = 0; i < cumulativeLengths.length; i++) {
    const segmentEnd = cumulativeLengths[i];
    if (distance <= segmentEnd || i === cumulativeLengths.length - 1) {
      const segmentLength = Math.max(segmentEnd - previousLength, 1e-6);
      return target.lerpVectors(points[i], points[i + 1], (distance - previousLength) / segmentLength);
    }
    previousLength = segmentEnd;
  }
  return target.copy(points[points.length - 1]);
}
