import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { isPointClear, polylineLengths, samplePolyline } from './BusStopNavigation';
import { PassengerCrowd } from './PassengerCrowd';
import { stationColliders, stationPassengerRoutes } from './StationNavigation';
import { STATION_STOPS, TRAIN_ROUTE_CURVE } from './WorldLayout';

describe('railway-station pedestrian navigation', () => {
  test('keeps every waiting spot and walking segment outside station solids', () => {
    for (const station of STATION_STOPS) {
      const colliders = stationColliders(station);
      const routes = stationPassengerRoutes(station);

      expect(routes).toHaveLength(6);
      for (const route of routes) {
        expect(isPointClear(route.waitPosition, colliders), `${station.label}: occupied waiting spot`).toBe(true);
        expect(isPointClear(route.boardingPosition, colliders), `${station.label}: blocked boarding spot`).toBe(true);
        const lengths = polylineLengths(route.path);
        for (let sample = 0; sample <= 80; sample++) {
          const point = samplePolyline(
            route.path,
            lengths.segments,
            lengths.total,
            sample / 80,
            new THREE.Vector3()
          );
          expect(isPointClear(point, colliders), `${station.label}: route enters station geometry`).toBe(true);
        }
      }
    }
  });

  test('includes the viaduct railing in collision geometry', () => {
    const elevated = STATION_STOPS.find(
      (station) => TRAIN_ROUTE_CURVE.getPointAt(station.centerT).y >= 2.5
    );
    expect(elevated).toBeDefined();
    expect(stationColliders(elevated!).some((collider) => collider.id.startsWith('railing-'))).toBe(true);
  });

  test('never lets animated passengers enter a collider during boarding', () => {
    const scene = new THREE.Scene();
    const crowd = new PassengerCrowd(scene);
    crowd.setDensity(1);

    for (const station of STATION_STOPS) {
      expect(crowd.debugStartDwell(station.label)).toBe(true);
      let sawMovement = false;
      for (let frame = 0; frame < 300; frame++) {
        crowd.update(1 / 60, new Set());
        const passengers = crowd
          .getPassengerDebugState()
          .filter((passenger) => passenger.station === station.label);
        if (passengers.some((passenger) => passenger.activity !== 'idle')) sawMovement = true;
        expect(passengers.some((passenger) => passenger.colliding)).toBe(false);
      }
      expect(sawMovement).toBe(true);
    }

    crowd.dispose();
  });
});
