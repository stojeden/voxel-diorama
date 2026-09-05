import * as THREE from 'three';
import {
  BENCH_DIMENSIONS,
  BUS_ROUTE_CURVE,
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
 * Four deterministic waiting spots in one row under the roof, behind the bench.
 *
 * The spacing comes from the finished bodies, and the count from what those bodies leave
 * room for -- both re-derived after the figures were brought down to a believable height.
 *
 * At 1.915 m an adult was 0.90 m across once turned toward the bus door, and four of them
 * at 0.9 m centres overlapped by 0.002 m, so the row was cut to three. At 1.75 m the same
 * turned figures are 0.72 to 0.83 m across and four fit again, which is what the stop was
 * designed for.
 *
 * Four at 0.95 m centres, 0.25 m in front of the post line. Measured on the finished,
 * rotated bodies at the placement the runtime gives them: gaps of 0.174, 0.179 and
 * 0.125 m against a required 0.05 m, occupying 3.68 m along the row.
 *
 * That row is wider than the 3.20 m between the posts, and deliberately so: the figures
 * stand *in front of* the post line, not between the posts, so the constraint that
 * matters is the three-dimensional one -- no body may intersect a post, the bench or the
 * sign, and every body must be under the roof. `clearance.test.ts` checks exactly that,
 * on the rotated outline. (An earlier version of this comment quoted a 3.84 m "clear
 * span" and treated it as the limit; that number was neither the post gap nor the
 * constraint.)
 */
export function busStopWaitingPositions(stop: BusStop): THREE.Vector3[] {
  return ([-1.425, -0.475, 0.475, 1.425] as const).map((along) => localToWorld(stop, along, -0.25));
}

/** Where a waiting passenger stands, which door it walks to, and which way it looks. */
export interface WaitingPlacement {
  index: number;
  waitPos: THREE.Vector3;
  doorPos: THREE.Vector3;
  facing: number;
}

/** Half the gap between the two door queues, along the lane. */
const DOOR_QUEUE_OFFSET = 1.6;

/**
 * The one placement the crowd is built from -- and therefore the one a test may check.
 *
 * `Bus.ts` used to compute this inline and `clearance.test.ts` computed its own version
 * beside it: one shared door invented from the shelter centre, and one facing formula
 * written twice. They disagreed. The runtime derives the door from the lane curve and
 * gives every other passenger the *other* door, so the four figures do not all face the
 * same way -- which is exactly what a clearance test has to know, because facing decides
 * how deep a turned body is. Runtime and test now call this.
 */
export function busStopWaitingPlacements(stop: BusStop): WaitingPlacement[] {
  const lanePoint = BUS_ROUTE_CURVE.getPointAt(stop.atT);
  const tangent = BUS_ROUTE_CURVE.getTangentAt(stop.atT).normalize();
  const centre = busShelterCenter(stop);
  const towardShelter = new THREE.Vector3(centre.x, GROUND_SURFACE_Y, centre.z)
    .sub(lanePoint)
    .setY(0)
    .normalize();
  const doorBase = lanePoint.clone().addScaledVector(towardShelter, BUS_DOOR_APPROACH_DISTANCE);
  doorBase.y = 0.5;
  return busStopWaitingPositions(stop).map((waitPos, index) => {
    const doorPos = doorBase
      .clone()
      .addScaledVector(tangent, index % 2 === 0 ? -DOOR_QUEUE_OFFSET : DOOR_QUEUE_OFFSET);
    doorPos.y = 0.5;
    return {
      index,
      waitPos,
      doorPos,
      facing: Math.atan2(doorPos.x - waitPos.x, doorPos.z - waitPos.z),
    };
  });
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
