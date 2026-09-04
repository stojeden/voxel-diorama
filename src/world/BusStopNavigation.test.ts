import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { BUS_ROUTE_CURVE, BUS_STOPS, busShelterCenter } from './WorldLayout';
import {
  busShelterColliders,
  BUS_DOOR_APPROACH_DISTANCE,
  busStopWaitingPlacements,
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
      const colliders = busShelterColliders(stop);
      // The doors the product walks them to, not doors derived again here. This test
      // used to rebuild `doorBase` from the lane curve and re-apply the +/-1.6 m queue
      // offset itself, which is the same duplication that let the clearance test measure
      // figures facing a direction the runtime never uses.
      for (const { index, waitPos: waitPosition, doorPos: doorPosition } of busStopWaitingPlacements(stop)) {
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
