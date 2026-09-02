import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import {
  BUILDING_ACCESS_CELLS,
  BUS_ROUTE_CURVE,
  BUS_STOPS,
  GROUND_SURFACE_Y,
  POSTMAN_ROUTE_CURVE,
  STATIC_PROP_FOOTPRINTS,
  busShelterCenter,
} from '../WorldLayout';
import {
  BUS_DOOR_APPROACH_DISTANCE,
  PEDESTRIAN_RADIUS,
  busShelterColliders,
  busStopWaitingPositions,
  busStopWalkingPath,
} from '../BusStopNavigation';
import { buildPassenger } from '../PassengerCrowd';
import { KERB_HEIGHT, buildCityModel, type BuildingSpec, type Rect } from './CityModel';
import { emitBuilding } from './architecture';
import { emitDominant } from './dominants';
import { emitStreetscape } from './streetscape';
import { rectsOverlap } from './GroundContact';
import { geometryFor } from './strategies/DirectSurfaceStrategy';
import type { SurfacePrimitive } from './surface';

/**
 * Gate 4, clearance half: the fragment's protruding geometry — balconies, loggias,
 * shop bays, cornices, canopies — must not reach into anything a pedestrian walks
 * through, and must not interpenetrate the street props the spike itself places.
 *
 * Extents are never restated here. Every box comes from `geometryFor`, the same
 * function the direct strategy feeds to the renderer, so the test keeps measuring
 * the real geometry when the architecture changes.
 */

const model = buildCityModel();
const stop = BUS_STOPS.find((candidate) => candidate.label === 'Osiedle Centralne')!;

/** Tallest point of the product's passenger figure above the walking surface. */
const PEDESTRIAN_HEIGHT = new THREE.Box3()
  .setFromObject(buildPassenger().group)
  .max.y;

interface Solid {
  id: string;
  rect: Rect;
  minY: number;
  maxY: number;
}

const box = new THREE.Box3();

function solidsOf(prefix: string, primitives: readonly SurfacePrimitive[]): Solid[] {
  return primitives.map((prim, index) => {
    const geometry = geometryFor(prim);
    geometry.computeBoundingBox();
    box.copy(geometry.boundingBox!);
    geometry.dispose();
    return {
      id: `${prefix}#${index}:L${prim.layer}`,
      rect: { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z },
      minY: box.min.y,
      maxY: box.max.y,
    };
  });
}

/** The building's own plot: the massing box the layout allots it. */
function footprintOf(b: BuildingSpec): Rect {
  return { minX: b.cx - b.w / 2, maxX: b.cx + b.w / 2, minZ: b.cz - b.d / 2, maxZ: b.cz + b.d / 2 };
}

const OUTSIDE_EPSILON = 1e-6;

function overhang(rect: Rect, footprint: Rect): number {
  return Math.max(
    footprint.minX - rect.minX,
    rect.maxX - footprint.maxX,
    footprint.minZ - rect.minZ,
    rect.maxZ - footprint.maxZ
  );
}

/** Every solid of every fragment building that leaves its own plot, with how far. */
const overhangs = model.buildings.flatMap((b) => {
  const footprint = footprintOf(b);
  return solidsOf(`block${b.index}`, emitBuilding(b).primitives)
    .map((solid) => ({ ...solid, block: b.index, out: overhang(solid.rect, footprint) }))
    .filter((solid) => solid.out > OUTSIDE_EPSILON);
});

/**
 * Standing geometry the fragment adds outside the buildings: the street props and
 * both LOD variants of each dominant. Kerb ridges, crosswalk paint and the pavement
 * itself are the walking surface, not obstacles, so anything no taller than a kerb
 * is excluded — a pedestrian steps over it.
 */
const STEP_OVER = KERB_HEIGHT;
const standing = [
  ...solidsOf('streetscape', emitStreetscape(model).primitives),
  ...model.dominants.flatMap((d) =>
    [false, true].flatMap((low) => solidsOf(`${d.kind}-${low ? 'low' : 'high'}`, emitDominant(d, low).primitives))
  ),
].filter((solid) => solid.maxY > GROUND_SURFACE_Y + STEP_OVER + 1e-6);

const withinBody = (solid: Solid) =>
  solid.maxY > GROUND_SURFACE_Y && solid.minY < GROUND_SURFACE_Y + PEDESTRIAN_HEIGHT;

/** Overhangs a walking figure could actually collide with. */
const atBodyHeight = overhangs.filter(withinBody);

function inflate(rect: Rect, by: number): Rect {
  return { minX: rect.minX - by, maxX: rect.maxX + by, minZ: rect.minZ - by, maxZ: rect.maxZ + by };
}

function pointRect(point: THREE.Vector3): Rect {
  return {
    minX: point.x - PEDESTRIAN_RADIUS,
    maxX: point.x + PEDESTRIAN_RADIUS,
    minZ: point.z - PEDESTRIAN_RADIUS,
    maxZ: point.z + PEDESTRIAN_RADIUS,
  };
}

/** Everything a pedestrian body sweeps through around the stop, as inflated rectangles. */
function pedestrianZones(): Array<Rect & { id: string }> {
  const zones: Array<Rect & { id: string }> = busShelterColliders(stop).map((rect) => ({ ...rect }));
  const lane = BUS_ROUTE_CURVE.getPointAt(stop.atT);
  const tangent = BUS_ROUTE_CURVE.getTangentAt(stop.atT).normalize();
  const center = busShelterCenter(stop);
  const towardShelter = new THREE.Vector3(center.x - lane.x, 0, center.z - lane.z).normalize();
  const doorBase = lane.clone().addScaledVector(towardShelter, BUS_DOOR_APPROACH_DISTANCE);
  doorBase.y = GROUND_SURFACE_Y;

  for (const [index, waitPosition] of busStopWaitingPositions(stop).entries()) {
    zones.push({ id: `wait-${index}`, ...pointRect(waitPosition) });
    const doorPosition = doorBase.clone().addScaledVector(tangent, index % 2 === 0 ? -1.6 : 1.6);
    const path = busStopWalkingPath(stop, waitPosition, doorPosition);
    for (let segment = 1; segment < path.length; segment++) {
      for (let sample = 0; sample <= 40; sample++) {
        const point = new THREE.Vector3().lerpVectors(path[segment - 1], path[segment], sample / 40);
        zones.push({ id: `walk-${index}-${segment}-${sample}`, ...pointRect(point) });
      }
    }
  }
  for (let i = 0; i <= 600; i++) {
    zones.push({ id: `postman-${i}`, ...pointRect(POSTMAN_ROUTE_CURVE.getPointAt(i / 600)) });
  }
  for (const footprint of STATIC_PROP_FOOTPRINTS) {
    zones.push({ id: footprint.id, ...inflate(footprint, PEDESTRIAN_RADIUS) });
  }
  return zones;
}

const zones = pedestrianZones();

describe('hybrid fragment clearance', () => {
  test('the fragment really does protrude, so the checks below are not vacuous', () => {
    // Balconies and loggias reach furthest; shop bays are the ground-floor case.
    expect(atBodyHeight.length).toBeGreaterThan(0);
    const furthest = Math.max(...overhangs.map((solid) => solid.out));
    expect(furthest).toBeGreaterThan(0.8);
    const groundFloor = overhangs.filter((solid) => solid.minY < GROUND_SURFACE_Y + 1);
    expect(groundFloor.length).toBeGreaterThan(0);
    expect(Math.max(...groundFloor.map((solid) => solid.out))).toBeGreaterThan(0.2);
  });

  test('the figure it must clear is a believable human height', () => {
    expect(PEDESTRIAN_HEIGHT).toBeGreaterThan(1.75);
    expect(PEDESTRIAN_HEIGHT).toBeLessThan(2.05);
  });

  test('no overhang at body height reaches a walking path, the shelter, the postman route or a product prop', () => {
    const hits = atBodyHeight.flatMap((solid) =>
      zones.filter((zone) => rectsOverlap(solid.rect, zone)).map((zone) => `${solid.id} vs ${zone.id}`)
    );
    expect(hits).toEqual([]);
  });

  test('nothing the fragment stands on the ground blocks those same routes either', () => {
    const hits = standing
      .filter(withinBody)
      .flatMap((solid) => zones.filter((zone) => rectsOverlap(solid.rect, zone)).map((zone) => `${solid.id} vs ${zone.id}`));
    expect(hits).toEqual([]);
  });

  test('both dominants keep their whole silhouette off the postman route', () => {
    // The route runs x -62..62 at z -46 and z -50; the chimney sits at z -40 and the
    // tower at z -66, so the margin is metres, not centimetres. Prove it.
    const dominants = standing.filter((solid) => !solid.id.startsWith('streetscape'));
    expect(dominants.length).toBeGreaterThan(0);
    let closest = Infinity;
    for (const solid of dominants) {
      for (let i = 0; i <= 600; i++) {
        const point = POSTMAN_ROUTE_CURVE.getPointAt(i / 600);
        const dx = Math.max(solid.rect.minX - point.x, 0, point.x - solid.rect.maxX);
        const dz = Math.max(solid.rect.minZ - point.z, 0, point.z - solid.rect.maxZ);
        closest = Math.min(closest, Math.hypot(dx, dz));
      }
    }
    expect(closest).toBeGreaterThan(PEDESTRIAN_RADIUS);
  });

  test('overhangs above the figure still clear the shelter, so nothing hangs over a waiting passenger', () => {
    const above = overhangs.filter((solid) => solid.minY >= GROUND_SURFACE_Y + PEDESTRIAN_HEIGHT);
    const shelter = busShelterColliders(stop);
    const hits = above.flatMap((solid) =>
      shelter.filter((zone) => rectsOverlap(solid.rect, zone)).map((zone) => `${solid.id} over ${zone.id}`)
    );
    expect(hits).toEqual([]);
  });

  test('the spike street props do not interpenetrate the facades they stand in front of', () => {
    const props = solidsOf('streetscape', emitStreetscape(model).primitives).filter(
      (solid) => solid.maxY > GROUND_SURFACE_Y + 0.02
    );
    const facade = model.buildings.flatMap((b) => solidsOf(`block${b.index}`, emitBuilding(b).primitives));
    const hits: string[] = [];
    for (const prop of props) {
      for (const solid of facade) {
        if (!rectsOverlap(prop.rect, solid.rect)) continue;
        if (prop.maxY <= solid.minY || prop.minY >= solid.maxY) continue;
        hits.push(`${prop.id} into ${solid.id}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('no spike prop stands in a building access corridor', () => {
    // Only the props: the entrance steps and the door canopy belong in the doorway
    // by design, and the layout's access cells are exactly the way in to them.
    const hits: string[] = [];
    for (const prop of model.props) {
      for (const [x, z] of BUILDING_ACCESS_CELLS) {
        const cell = { minX: x - PEDESTRIAN_RADIUS, maxX: x + PEDESTRIAN_RADIUS, minZ: z - PEDESTRIAN_RADIUS, maxZ: z + PEDESTRIAN_RADIUS };
        if (rectsOverlap(prop.footprint, cell)) hits.push(`${prop.id} blocks access cell ${x},${z}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('the postman never enters the fragment, so his route cannot be blocked by it', () => {
    const ground = { minX: -30, maxX: 12, minZ: 0, maxZ: 40 };
    for (let i = 0; i <= 600; i++) {
      const point = POSTMAN_ROUTE_CURVE.getPointAt(i / 600);
      const inside =
        point.x >= ground.minX && point.x <= ground.maxX && point.z >= ground.minZ && point.z <= ground.maxZ;
      expect(inside, `postman enters the fragment at ${point.x.toFixed(1)}, ${point.z.toFixed(1)}`).toBe(false);
    }
  });
});
