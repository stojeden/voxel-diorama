import * as THREE from 'three';
import {
  TRAIN_ROUTE_CURVE,
  stationPlatformCells,
  type StationStop,
} from './WorldLayout';
import {
  PEDESTRIAN_RADIUS,
  isPointClear,
  type CollisionRect,
} from './BusStopNavigation';

const PLATFORM_GAUGE_OFFSET = 2.5;
const PLATFORM_DEPTH = 3;
const SHELTER_LATERAL = PLATFORM_GAUGE_OFFSET + PLATFORM_DEPTH + 0.5;
const SIGN_LATERAL = PLATFORM_GAUGE_OFFSET + PLATFORM_DEPTH;
const MAST_LATERAL = 4.7;
const WAITING_LATERAL = 3.25;
const INNER_WALKING_LATERAL = 2.65;
const BOARDING_LATERAL = 1.78;
export const STATION_PASSENGER_CLEARANCE = Math.max(PEDESTRIAN_RADIUS, 0.46);

interface StationFrame {
  center: THREE.Vector3;
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  baseY: number;
}

export interface StationPassengerRoute {
  waitPosition: THREE.Vector3;
  boardingPosition: THREE.Vector3;
  path: THREE.Vector3[];
}

function frameFor(station: StationStop): StationFrame {
  const center = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
  const tangent = TRAIN_ROUTE_CURVE.getTangentAt(station.centerT).normalize();
  const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
  return {
    center,
    tangent,
    normal,
    baseY: Math.round(center.y) + 0.5,
  };
}

function stationPoint(
  frame: StationFrame,
  along: number,
  lateral: number
): THREE.Vector3 {
  const point = frame.center
    .clone()
    .addScaledVector(frame.tangent, along)
    .addScaledVector(frame.normal, lateral);
  point.y = frame.baseY;
  return point;
}

function colliderAt(
  id: string,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  clearance: number
): CollisionRect {
  return {
    id,
    minX: x - halfX - clearance,
    maxX: x + halfX + clearance,
    minZ: z - halfZ - clearance,
    maxZ: z + halfZ + clearance,
  };
}

/** Station solids at pedestrian height, inflated by the passenger radius. */
export function stationColliders(
  station: StationStop,
  clearance = STATION_PASSENGER_CLEARANCE
): CollisionRect[] {
  const frame = frameFor(station);
  const colliders: CollisionRect[] = [];

  for (const [index, along] of [-2, 2].entries()) {
    const post = stationPoint(frame, along, SHELTER_LATERAL);
    colliders.push(colliderAt(`shelter-post-${index}`, Math.round(post.x), Math.round(post.z), 0.5, 0.5, clearance));
  }

  const sign = stationPoint(frame, -station.platformLength / 2 + 1, SIGN_LATERAL);
  colliders.push(colliderAt('station-sign', Math.round(sign.x), Math.round(sign.z), 0.5, 0.5, clearance));

  for (const [index, along] of [-6.5, 6.5].entries()) {
    const mast = stationPoint(frame, along, MAST_LATERAL);
    colliders.push(colliderAt(`light-mast-${index}`, mast.x, mast.z, 0.08, 0.08, clearance));
  }

  if (frame.center.y >= 2.5) {
    for (const cell of stationPlatformCells(station)) {
      if (cell.depth !== PLATFORM_DEPTH - 1 || Math.round(cell.along) % 2 !== 0) continue;
      colliders.push(colliderAt(`railing-${cell.x}-${cell.z}`, cell.x, cell.z, 0.5, 0.5, clearance));
    }
  }

  return colliders;
}

export function stationPassengerRoutes(
  station: StationStop,
  count = 6
): StationPassengerRoute[] {
  const frame = frameFor(station);
  const colliders = stationColliders(station);
  const halfLength = station.platformLength / 2 - 3;
  const spacing = (2 * halfLength) / (count + 1);

  return Array.from({ length: count }, (_, index) => {
    const along =
      -halfLength + spacing * (index + 1) + Math.sin((index + 1) * 4.73) * 0.14;
    let waitingLateral = WAITING_LATERAL + (index % 2 === 0 ? -0.08 : 0.08);
    let waitPosition = stationPoint(frame, along, waitingLateral);
    while (!isPointClear(waitPosition, colliders) && waitingLateral > INNER_WALKING_LATERAL) {
      waitingLateral -= 0.12;
      waitPosition = stationPoint(frame, along, waitingLateral);
    }

    const boardingPosition = stationPoint(frame, along, BOARDING_LATERAL);
    const innerWaypoint = stationPoint(frame, along, INNER_WALKING_LATERAL);
    return {
      waitPosition,
      boardingPosition,
      path: [waitPosition.clone(), innerWaypoint, boardingPosition.clone()],
    };
  });
}
