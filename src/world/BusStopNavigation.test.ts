import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { BUS_ROUTE_CURVE, BUS_STOPS, busShelterCenter } from './WorldLayout';
import {
  busShelterColliders,
  BUS_DOOR_APPROACH_DISTANCE,
  busStopWaitingPositions,
  busStopWalkingPath,
  isPointClear,
} from './BusStopNavigation';

describe('bus-stop pedestrian navigation', () => {
  test('keeps every waiting passenger outside solid shelter geometry', () => {
    for (const stop of BUS_STOPS) {
      const colliders = busShelterColliders(stop);
      for (const position of busStopWaitingPositions(stop)) {
        expect(isPointClear(position, colliders), `${stop.label}: occupied waiting spot`).toBe(true);
      }
    }
  });

  test('routes passengers around posts, bench and stop sign in both shelter orientations', () => {
    for (const stop of BUS_STOPS) {
      const lane = BUS_ROUTE_CURVE.getPointAt(stop.atT);
      const tangent = BUS_ROUTE_CURVE.getTangentAt(stop.atT).normalize();
      const center = busShelterCenter(stop);
      const towardShelter = new THREE.Vector3(center.x - lane.x, 0, center.z - lane.z).normalize();
      const doorBase = lane.clone().addScaledVector(towardShelter, BUS_DOOR_APPROACH_DISTANCE);
      doorBase.y = 0.5;
      const colliders = busShelterColliders(stop);

      for (const [index, waitPosition] of busStopWaitingPositions(stop).entries()) {
        const doorPosition = doorBase
          .clone()
          .addScaledVector(tangent, index % 2 === 0 ? -1.6 : 1.6);
        const path = busStopWalkingPath(stop, waitPosition, doorPosition);
        for (let segment = 1; segment < path.length; segment++) {
          for (let sample = 0; sample <= 20; sample++) {
            const point = new THREE.Vector3().lerpVectors(
              path[segment - 1],
              path[segment],
              sample / 20
            );
            expect(
              isPointClear(point, colliders),
              `${stop.label}: path intersects shelter collider`
            ).toBe(true);
          }
        }
      }
    }
  });
});
