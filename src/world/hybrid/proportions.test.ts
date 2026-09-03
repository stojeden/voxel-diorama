import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { GROUND_SURFACE_Y, BENCH_DIMENSIONS, ROAD_RECTS } from '../WorldLayout';
import { buildPassenger } from '../PassengerCrowd';
import { createBus } from '../Bus';
import { CROSSWALK, KERB_HEIGHT, buildCityModel } from './CityModel';
import { emitBuilding } from './architecture';
import { emitStreetscape } from './streetscape';
import { geometryFor } from './strategies/DirectSurfaceStrategy';
import { P } from './palette';
import type { SurfacePrimitive } from './surface';

/**
 * One metric system for the whole world. Every number here is measured off the
 * finished geometry — the meshes the renderer receives, after scaling, rotation
 * and placement — never off a constructor argument, because the two disagreed:
 * the bus is built from `BUS_HEIGHT = 2.32` and finishes 2.95 m tall, and used to
 * be built from 2.6 and finish 3.569 m.
 *
 * The ranges are deliberately generous. They exist to catch absurdity, not to
 * enforce a survey: the product's stylised figure is 1.915 m, above a real adult,
 * and everything else is judged in proportion to it rather than to a tape measure.
 */

const model = buildCityModel();
const street = emitStreetscape(model).primitives;

/** World-space AABB of a set of emitted primitives, from the geometry itself. */
function boundsOf(prims: readonly SurfacePrimitive[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const prim of prims) {
    const geometry = geometryFor(prim);
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
    geometry.dispose();
  }
  return box;
}

function sizeOf(box: THREE.Box3): THREE.Vector3 {
  return box.getSize(new THREE.Vector3());
}

/** World-space AABB of a built object graph, optionally skipping decorative volumes. */
function objectBounds(root: THREE.Object3D, skip: (mesh: THREE.Mesh) => boolean = () => false): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || skip(mesh)) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

const PASSENGER_HEIGHT = sizeOf(objectBounds(buildPassenger().group)).y;

const busGroup = (() => {
  const scene = new THREE.Scene();
  createBus(scene);
  return scene.children.find((child) => child.type === 'Group')!;
})();
/** The headlight glow is decoration, not bodywork, and must not count as bus size. */
const isGlow = (mesh: THREE.Mesh) => mesh.geometry.type === 'ConeGeometry';
const BUS = sizeOf(objectBounds(busGroup, isGlow));

/** Everything the fragment draws for one bicycle, excluding the ground under it. */
const GROUNDISH = new Set([P.pavement, P.kerb, P.marking]);
function propNear(x: number, z: number, radius: number): SurfacePrimitive[] {
  return street.filter((prim) => {
    if (GROUNDISH.has(prim.palette)) return false;
    const geometry = geometryFor(prim);
    geometry.computeBoundingBox();
    const centre = geometry.boundingBox!.getCenter(new THREE.Vector3());
    geometry.dispose();
    return Math.hypot(centre.x - x, centre.z - z) < radius;
  });
}
const bikeSpec = model.props.find((prop) => prop.kind === 'bicycle')!;
const BIKE = boundsOf(propNear(bikeSpec.x, bikeSpec.z, 1.1));
const BIKE_SIZE = sizeOf(BIKE);

describe('one metric system', () => {
  test('the figure everything else is judged against is human-sized', () => {
    expect(PASSENGER_HEIGHT).toBeGreaterThan(1.6);
    expect(PASSENGER_HEIGHT).toBeLessThan(2.0);
  });

  test('the bus is a bus, not a tower on wheels', () => {
    expect(BUS.z).toBeGreaterThan(7.5);
    expect(BUS.z).toBeLessThan(9.0);
    expect(BUS.x).toBeGreaterThan(2.2);
    expect(BUS.x).toBeLessThan(2.8);
    // The defect this test exists for: 3.569 m of height on 8.18 m of length.
    expect(BUS.y).toBeGreaterThan(2.6);
    expect(BUS.y).toBeLessThan(3.15);
    const slenderness = BUS.y / BUS.z;
    expect(slenderness, `bus height/length ${slenderness.toFixed(3)}`).toBeLessThan(0.40);
    const versusPerson = BUS.y / PASSENGER_HEIGHT;
    expect(versusPerson, `bus/person ${versusPerson.toFixed(2)}`).toBeLessThan(1.75);
    expect(versusPerson).toBeGreaterThan(1.3);
  });

  test('the headlight glow is a glow, not an eight metre wedge', () => {
    const glow = objectBounds(busGroup, (mesh) => !isGlow(mesh));
    const size = sizeOf(glow);
    // Both cones together, so the width spans the pair; the length is the giveaway.
    expect(size.z, `glow length ${size.z.toFixed(2)} m`).toBeLessThan(3.0);
    expect(size.y, `glow height ${size.y.toFixed(2)} m`).toBeLessThan(1.6);
  });

  test('the bicycle is a bicycle, not a toy', () => {
    expect(BIKE_SIZE.z, `length ${BIKE_SIZE.z.toFixed(3)}`).toBeGreaterThan(1.7);
    expect(BIKE_SIZE.z).toBeLessThan(1.95);
    // Height at the bars. The miniature version topped out at 1.00 m.
    expect(BIKE_SIZE.y, `height ${BIKE_SIZE.y.toFixed(3)}`).toBeGreaterThan(1.04);
    expect(BIKE_SIZE.y).toBeLessThan(1.25);

    const tyres = street.filter((prim) => prim.kind === 'torus' && prim.tube > 0.03);
    expect(tyres.length).toBe(6);
    for (const tyre of tyres) {
      if (tyre.kind !== 'torus') continue;
      const diameter = 2 * (tyre.radius + tyre.tube);
      expect(diameter, `wheel ${diameter.toFixed(3)} m`).toBeGreaterThan(0.65);
      expect(diameter).toBeLessThan(0.78);
      // Thin enough to vanish at the street camera is the toy signature.
      expect(tyre.tube, 'tyre section').toBeGreaterThanOrEqual(0.04);
    }
    // Frame tubes have to survive the street camera too.
    const frame = street.filter(
      (prim) => prim.palette === P.accentRose && prim.kind === 'box'
    );
    expect(frame.length).toBeGreaterThan(0);
    for (const tube of frame) {
      if (tube.kind !== 'box') continue;
      const section = Math.max(Math.min(tube.w, tube.h), Math.min(tube.h, tube.d));
      expect(section, 'frame tube section').toBeGreaterThanOrEqual(0.04);
    }
  });

  test('bus, person and bicycle read as one family of sizes', () => {
    const busOverBike = BUS.y / BIKE_SIZE.y;
    expect(busOverBike, `bus/bicycle ${busOverBike.toFixed(2)}`).toBeLessThan(3.0);
    expect(busOverBike).toBeGreaterThan(2.0);
    const personOverBike = PASSENGER_HEIGHT / BIKE_SIZE.y;
    expect(personOverBike, `person/bicycle ${personOverBike.toFixed(2)}`).toBeLessThan(2.0);
    expect(personOverBike).toBeGreaterThan(1.4);
  });

  test('what a person walks past is at a human height', () => {
    const doors = model.buildings.flatMap((b) =>
      emitBuilding(b).primitives.filter((p) => p.cls === 'glass' && p.cohort < 0 && p.kind === 'plane')
    );
    expect(doors.length).toBeGreaterThan(0);
    for (const door of doors) {
      if (door.kind !== 'plane') continue;
      expect(door.h, `door ${door.h}`).toBeGreaterThanOrEqual(2.0);
      expect(door.h).toBeLessThanOrEqual(2.8);
    }
    for (const b of model.buildings) {
      expect(b.groundFloorHeight, `blok ${b.index} parter`).toBeGreaterThanOrEqual(2.7);
      expect(b.groundFloorHeight).toBeLessThanOrEqual(4.0);
      expect(b.floorHeight, `blok ${b.index} pietro`).toBeGreaterThanOrEqual(2.7);
      expect(b.floorHeight).toBeLessThanOrEqual(3.3);
    }
    expect(KERB_HEIGHT).toBeGreaterThanOrEqual(0.10);
    expect(KERB_HEIGHT).toBeLessThanOrEqual(0.16);
    expect(BENCH_DIMENSIONS.seatHeight).toBeGreaterThanOrEqual(0.40);
    expect(BENCH_DIMENSIONS.seatHeight).toBeLessThanOrEqual(0.52);
  });

  test('balustrade posts are the height a balustrade has to be', () => {
    // Measured on the members themselves, not on a search for the slab under them:
    // two earlier versions of this test matched a window sill and a lower rail and
    // reported 0.52 m and 1.56 m for a railing that is 1.00 m.
    let posts = 0;
    for (const b of model.buildings) {
      for (const prim of emitBuilding(b).primitives) {
        if (prim.kind !== 'box' || prim.palette !== P.steel) continue;
        const upright = prim.h > prim.w * 2 && prim.h > prim.d * 2;
        if (!upright || prim.h < 0.3) continue;
        expect(prim.h, `blok ${b.index} slupek balustrady ${prim.h.toFixed(2)} m`).toBeGreaterThan(0.8);
        expect(prim.h, `blok ${b.index} slupek balustrady ${prim.h.toFixed(2)} m`).toBeLessThan(1.35);
        posts++;
      }
    }
    expect(posts, 'zaden slupek balustrady nie zostal zmierzony').toBeGreaterThan(0);
  });

  test('the street a person crosses has believable widths', () => {
    const lane = (ROAD_RECTS[0].maxZ - ROAD_RECTS[0].minZ) / 2;
    expect(lane, `pas ruchu ${lane} m`).toBeGreaterThanOrEqual(1.8);
    const crossing = CROSSWALK.maxX - CROSSWALK.minX;
    expect(crossing, `przejscie ${crossing.toFixed(2)} m`).toBeGreaterThanOrEqual(2.5);
    // Bars across the carriageway, not along it.
    const bars = street.filter((p) => p.palette === P.marking && p.kind === 'box');
    expect(bars.length).toBe(CROSSWALK.stripes);
    for (const bar of bars) if (bar.kind === 'box') expect(bar.d).toBeGreaterThan(bar.w);
  });

  test('nothing floats above the pavement or sinks into it', () => {
    for (const prop of model.props) {
      const prims = propNear(prop.x, prop.z, prop.kind.startsWith('bicycle') ? 1.1 : 0.7);
      if (!prims.length) continue;
      const box = boundsOf(prims);
      const lowest = box.min.y - GROUND_SURFACE_Y;
      // A leaning bicycle dips a tyre edge below the plane by a few millimetres.
      expect(lowest, `${prop.id} spod ${lowest.toFixed(3)} m`).toBeGreaterThan(-0.05);
      expect(lowest, `${prop.id} unosi sie ${lowest.toFixed(3)} m`).toBeLessThan(0.02);
    }
  });
});
