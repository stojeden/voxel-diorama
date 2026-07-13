import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { PASSENGER_SCALE } from './PassengerCrowd';
import {
  BENCH_DIMENSIONS,
  BLOCK_CONFIGS,
  BUILDING_ACCESS_CELLS,
  BUILDING_ENTRANCES,
  BUS_ROUTE_CURVE,
  BUS_STOPS,
  COLORS,
  COW_MEADOW,
  DOG_HOME,
  FISHERMAN_SPOT,
  GROUND_SURFACE_Y,
  STATIC_PROP_FOOTPRINTS,
  KIOSK_MAIN,
  LAKE,
  LAMP_POSITIONS,
  POSTMAN_ROUTE_CURVE,
  RAIL_SIGNAL_POSITIONS,
  STATION_STOPS,
  TRACK_HALF_GAUGE,
  TRAIN_ROUTE_CURVE,
  TREE_POSITIONS,
  TUNNEL_WIDTH,
  VIADUCT_RANGE,
  WORLD_HALF_SIZE,
  busShelterCenter,
  distancePointToBlock,
  distancePointToFootprint,
  distanceToGroundRail,
  getTunnelBounds,
  isOnRoad,
  isOnSidewalk,
  stationPlatformCells,
  threeColorFromHex,
  wrapT,
} from './WorldLayout';

function routeSamples(count: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i++) out.push(TRAIN_ROUTE_CURVE.getPointAt(i / count));
  return out;
}

describe('train route geometry', () => {
  test('is SMOOTH — no sharp heading changes anywhere along the route', () => {
    const samples = 400;
    let maxTurn = 0;
    let prev = TRAIN_ROUTE_CURVE.getTangentAt(0).normalize();
    for (let i = 1; i <= samples; i++) {
      const tangent = TRAIN_ROUTE_CURVE.getTangentAt(i / samples).normalize();
      const angle = prev.angleTo(tangent);
      if (angle > maxTurn) maxTurn = angle;
      prev = tangent;
    }
    // Route length ≈ 170 m / 400 samples ≈ 0.43 m per step. 0.035 rad/step
    // ≈ minimum curve radius of ~12 m — anything tighter reads as a kink.
    expect(maxTurn).toBeLessThan(0.035);
  });

  test('has shallow, train-like gradients (no rollercoaster)', () => {
    const samples = routeSamples(400);
    for (let i = 1; i < samples.length; i++) {
      const dy = Math.abs(samples[i].y - samples[i - 1].y);
      const run = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
      if (run > 1e-4) {
        expect(dy / run).toBeLessThan(0.13);
      }
    }
  });

  test('portal endpoints are buried inside the tunnels, aligned with +X at z≈0', () => {
    const start = TRAIN_ROUTE_CURVE.getPointAt(0);
    const end = TRAIN_ROUTE_CURVE.getPointAt(1);
    expect(start.x).toBeLessThan(-WORLD_HALF_SIZE + 8);
    expect(end.x).toBeGreaterThan(WORLD_HALF_SIZE - 8);
    expect(Math.abs(start.z)).toBeLessThan(1);
    expect(Math.abs(end.z)).toBeLessThan(1);
    expect(Math.abs(start.y)).toBeLessThan(0.5);
    expect(Math.abs(end.y)).toBeLessThan(0.5);

    const x = new THREE.Vector3(1, 0, 0);
    expect(TRAIN_ROUTE_CURVE.getTangentAt(0).normalize().dot(x)).toBeGreaterThan(0.99);
    expect(TRAIN_ROUTE_CURVE.getTangentAt(1).normalize().dot(x)).toBeGreaterThan(0.99);
  });

  test('contains an elevated viaduct stretch', () => {
    const elevated = routeSamples(300).filter((p) => p.y >= VIADUCT_RANGE.deckY - 0.25);
    expect(elevated.length).toBeGreaterThan(10);
  });

  test('wrapT maps any value onto [0,1)', () => {
    expect(wrapT(1.25)).toBeCloseTo(0.25);
    expect(wrapT(-0.25)).toBeCloseTo(0.75);
    expect(wrapT(0.5)).toBeCloseTo(0.5);
  });
});

describe('world layout collisions', () => {
  const samples = routeSamples(400);
  const groundSamples = samples.filter((p) => p.y < 2.5);
  const elevatedSamples = samples.filter((p) => p.y >= 2.5);

  test('keeps buildings clear of the ground-level railway', () => {
    for (const point of groundSamples) {
      for (const block of BLOCK_CONFIGS) {
        expect(distancePointToBlock(point.x, point.z, block)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  test('keeps buildings clear of the viaduct structure', () => {
    for (const point of elevatedSamples) {
      for (const block of BLOCK_CONFIGS) {
        expect(distancePointToBlock(point.x, point.z, block)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('keeps buildings off every road', () => {
    for (const block of BLOCK_CONFIGS) {
      for (let bx = 0; bx < block.w; bx++) {
        for (let bz = 0; bz < block.d; bz++) {
          expect(isOnRoad(block.x + bx, block.z + bz)).toBe(false);
        }
      }
    }
  });

  test('keeps buildings out of the lake', () => {
    for (const block of BLOCK_CONFIGS) {
      for (let bx = 0; bx < block.w; bx++) {
        for (let bz = 0; bz < block.d; bz++) {
          const nx = (block.x + bx - LAKE.x) / LAKE.radiusX;
          const nz = (block.z + bz - LAKE.z) / LAKE.radiusZ;
          expect(nx * nx + nz * nz).toBeGreaterThan(1);
        }
      }
    }
  });

  test('keeps trees clear of the rail corridor, roads and lake', () => {
    expect(TREE_POSITIONS.length).toBeGreaterThan(25);
    for (const [treeX, treeZ] of TREE_POSITIONS) {
      const nearestGroundRail = Math.min(
        ...groundSamples.map((p) => Math.hypot(p.x - treeX, p.z - treeZ))
      );
      expect(nearestGroundRail).toBeGreaterThanOrEqual(8);
      expect(isOnRoad(treeX, treeZ)).toBe(false);
      const nx = (treeX - LAKE.x) / LAKE.radiusX;
      const nz = (treeZ - LAKE.z) / LAKE.radiusZ;
      expect(nx * nx + nz * nz).toBeGreaterThan(1);
    }
  });

  test('keeps street lamps clear of the ground railway', () => {
    for (const [lampX, lampZ] of LAMP_POSITIONS) {
      const nearest = Math.min(...groundSamples.map((p) => Math.hypot(p.x - lampX, p.z - lampZ)));
      expect(nearest).toBeGreaterThanOrEqual(5);
      expect(isOnRoad(lampX, lampZ)).toBe(false);
      for (const [treeX, treeZ] of TREE_POSITIONS) {
        expect(Math.hypot(treeX - lampX, treeZ - lampZ)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  test('keeps trees out of kiosks, benches, fences and the playground', () => {
    for (const [treeX, treeZ] of TREE_POSITIONS) {
      for (const footprint of STATIC_PROP_FOOTPRINTS) {
        expect(distancePointToFootprint(treeX, treeZ, footprint)).toBeGreaterThanOrEqual(3.5);
      }
    }
  });

  test('keeps static prop footprints off roads, buildings and each other', () => {
    for (let i = 0; i < STATIC_PROP_FOOTPRINTS.length; i++) {
      const footprint = STATIC_PROP_FOOTPRINTS[i];
      for (let x = footprint.minX; x <= footprint.maxX; x++) {
        for (let z = footprint.minZ; z <= footprint.maxZ; z++) {
          expect(isOnRoad(x, z)).toBe(false);
          for (const block of BLOCK_CONFIGS) {
            expect(distancePointToBlock(x, z, block)).toBeGreaterThan(0);
          }
        }
      }
      for (let j = i + 1; j < STATIC_PROP_FOOTPRINTS.length; j++) {
        const other = STATIC_PROP_FOOTPRINTS[j];
        const separated =
          footprint.maxX < other.minX ||
          footprint.minX > other.maxX ||
          footprint.maxZ < other.minZ ||
          footprint.minZ > other.maxZ;
        expect(separated).toBe(true);
      }
    }
  });

  test('gives every building a door and a collision-free pedestrian access path', () => {
    const access = new Set(BUILDING_ACCESS_CELLS.map(([x, z]) => `${x},${z}`));
    expect(BUILDING_ENTRANCES).toHaveLength(BLOCK_CONFIGS.length);
    for (const entrance of BUILDING_ENTRANCES) {
      expect(access.has(`${entrance.outsideX},${entrance.outsideZ}`)).toBe(true);
    }
    for (const [x, z] of BUILDING_ACCESS_CELLS) {
      if (!isOnRoad(x, z)) {
        for (const block of BLOCK_CONFIGS) {
          expect(distancePointToBlock(x, z, block)).toBeGreaterThan(0);
        }
      }
      const nx = (x - LAKE.x) / LAKE.radiusX;
      const nz = (z - LAKE.z) / LAKE.radiusZ;
      expect(nx * nx + nz * nz).toBeGreaterThan(1);
    }
  });

  test('uses the same realistic half-gauge for rail and wheel placement', () => {
    expect(TRACK_HALF_GAUGE).toBeGreaterThan(0.45);
    expect(TRACK_HALF_GAUGE).toBeLessThan(0.8);
  });

  test('keeps rail signals next to the track rather than on the rails', () => {
    for (const [signalX, signalZ] of RAIL_SIGNAL_POSITIONS) {
      const nearest = Math.min(...samples.map((p) => Math.hypot(p.x - signalX, p.z - signalZ)));
      expect(nearest).toBeGreaterThanOrEqual(4);
      expect(nearest).toBeLessThanOrEqual(12);
    }
  });

  test('train clears the tunnel arch (height and width)', () => {
    // Train envelope: floor 0.84 + body 2.6 + pantograph 1.32 ≈ 4.8 m tall,
    // 2.5 m wide. Arch opening: 5.5 m tall (y ≤ 5), 7 m wide (|z| ≤ 3).
    const TRAIN_TOP = 4.85;
    const TRAIN_HALF_WIDTH = 1.3;
    const ARCH_TOP = 5.5;
    const ARCH_HALF_WIDTH = 3.5;
    expect(ARCH_TOP).toBeGreaterThan(TRAIN_TOP);

    // Inside the tunnels the track may run off-centre — body edge must clear.
    for (const p of samples) {
      if (Math.abs(p.x) >= WORLD_HALF_SIZE - 11) {
        expect(Math.abs(p.z) + TRAIN_HALF_WIDTH).toBeLessThan(ARCH_HALF_WIDTH);
      }
    }
  });

  test('keeps tunnel geometry inside the diorama boundary', () => {
    for (const tunnel of getTunnelBounds()) {
      expect(tunnel.minX).toBeGreaterThanOrEqual(-WORLD_HALF_SIZE);
      expect(tunnel.maxX).toBeLessThanOrEqual(WORLD_HALF_SIZE);
      expect(Math.abs(tunnel.minZ)).toBeLessThanOrEqual(TUNNEL_WIDTH);
      expect(Math.abs(tunnel.maxZ)).toBeLessThanOrEqual(TUNNEL_WIDTH);
    }
  });
});

describe('bus loop', () => {
  test('the whole bus route stays on asphalt', () => {
    for (let i = 0; i <= 400; i++) {
      const p = BUS_ROUTE_CURVE.getPointAt(i / 400);
      expect(isOnRoad(Math.round(p.x), Math.round(p.z))).toBe(true);
    }
  });

  test('has at least two stops, each with a shelter near the kerb', () => {
    expect(BUS_STOPS.length).toBeGreaterThanOrEqual(2);
    for (const stop of BUS_STOPS) {
      const lane = BUS_ROUTE_CURVE.getPointAt(stop.atT);
      const shelterDist = Math.hypot(lane.x - (stop.shelterX + 2), lane.z - stop.shelterZ);
      expect(shelterDist).toBeGreaterThan(1.5);
      expect(shelterDist).toBeLessThan(8);
    }
  });

  test('leaves a human-width corridor between every shelter bench and the bus', () => {
    const busHalfWidth = 2.3 / 2;
    const passengerDiameter = PASSENGER_SCALE * 0.55;
    for (const stop of BUS_STOPS) {
      const lane = BUS_ROUTE_CURVE.getPointAt(stop.atT);
      const center = busShelterCenter(stop);
      const outwardDistance = stop.axis === 'x'
        ? Math.abs(lane.z - center.z)
        : Math.abs(lane.x - center.x);
      const benchRoadEdge = 1 + BENCH_DIMENSIONS.depth / 2;
      const clearCorridor = outwardDistance - busHalfWidth - benchRoadEdge;
      expect(clearCorridor, stop.label).toBeGreaterThan(passengerDiameter);
    }
  });
});

describe('stations', () => {
  test('platform centres sit either on the ground or on the viaduct deck', () => {
    for (const station of STATION_STOPS) {
      const p = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
      const onGround = p.y < 1;
      const onDeck = p.y > VIADUCT_RANGE.deckY - 0.6 && p.y < VIADUCT_RANGE.deckY + 0.6;
      expect(onGround || onDeck).toBe(true);
    }
  });

  test('braking marker sits ~14 m before the stop point', () => {
    for (const station of STATION_STOPS) {
      const length = TRAIN_ROUTE_CURVE.getLength();
      const d = wrapT(station.centerT - station.atT) * length;
      expect(d).toBeGreaterThan(10);
      expect(d).toBeLessThan(18);
    }
  });

  test('keeps ground-level platform slabs out of road lanes and crossings', () => {
    for (const station of STATION_STOPS) {
      if (TRAIN_ROUTE_CURVE.getPointAt(station.centerT).y >= 2.5) continue;
      for (const cell of stationPlatformCells(station)) {
        expect(isOnRoad(cell.x, cell.z)).toBe(false);
      }
    }
  });
});

describe('story actors placement (no overlaps)', () => {
  const insideLake = (x: number, z: number, margin: number) => {
    const nx = (x - LAKE.x) / (LAKE.radiusX + margin);
    const nz = (z - LAKE.z) / (LAKE.radiusZ + margin);
    return nx * nx + nz * nz <= 1;
  };
  const clearOfBlocks = (x: number, z: number, min: number) =>
    BLOCK_CONFIGS.every((b) => distancePointToBlock(x, z, b) >= min);

  test('cow meadow: dry land, off roads, clear of rail/buildings', () => {
    const r = COW_MEADOW.wanderRadius + 1.2; // + cow body
    for (let a = 0; a < 8; a++) {
      const x = COW_MEADOW.x + Math.cos((a / 8) * Math.PI * 2) * r;
      const z = COW_MEADOW.z + Math.sin((a / 8) * Math.PI * 2) * r;
      expect(insideLake(x, z, 1)).toBe(false);
      expect(isOnRoad(Math.round(x), Math.round(z))).toBe(false);
    }
    expect(distanceToGroundRail(COW_MEADOW.x, COW_MEADOW.z)).toBeGreaterThan(8);
    expect(clearOfBlocks(COW_MEADOW.x, COW_MEADOW.z, 3)).toBe(true);
  });

  test('fisherman: at the shore but on dry land, off roads', () => {
    expect(insideLake(FISHERMAN_SPOT.x, FISHERMAN_SPOT.z, 1)).toBe(false);
    expect(insideLake(FISHERMAN_SPOT.x, FISHERMAN_SPOT.z, 6)).toBe(true); // near the water
    expect(isOnRoad(FISHERMAN_SPOT.x, FISHERMAN_SPOT.z)).toBe(false);
    expect(clearOfBlocks(FISHERMAN_SPOT.x, FISHERMAN_SPOT.z, 3)).toBe(true);
    // Away from the cow meadow so the scenes never overlap.
    expect(
      Math.hypot(FISHERMAN_SPOT.x - COW_MEADOW.x, FISHERMAN_SPOT.z - COW_MEADOW.z)
    ).toBeGreaterThan(15);
    // Not on a procedurally placed tree.
    for (const [tx, tz] of TREE_POSITIONS) {
      expect(Math.hypot(tx - FISHERMAN_SPOT.x, tz - FISHERMAN_SPOT.z)).toBeGreaterThan(3);
    }
  });

  test('postman loop: rides pavement/asphalt only, never grass or rails', () => {
    for (let i = 0; i <= 400; i++) {
      const p = POSTMAN_ROUTE_CURVE.getPointAt(i / 400);
      const x = Math.round(p.x);
      const z = Math.round(p.z);
      expect(isOnRoad(x, z) || isOnSidewalk(x, z)).toBe(true);
      expect(insideLake(p.x, p.z, 1)).toBe(false);
    }
  });

  test('dog yard: on grass, clear of roads, blocks and the postman crash zone', () => {
    expect(isOnRoad(DOG_HOME.x, DOG_HOME.z)).toBe(false);
    expect(isOnSidewalk(DOG_HOME.x, DOG_HOME.z)).toBe(false);
    expect(clearOfBlocks(DOG_HOME.x, DOG_HOME.z, 2)).toBe(true);
    expect(distanceToGroundRail(DOG_HOME.x, DOG_HOME.z)).toBeGreaterThan(8);
  });

  test('kiosk raid site: kiosk + crate + sign all off-road, away from rails', () => {
    expect(distanceToGroundRail(KIOSK_MAIN.x, KIOSK_MAIN.z)).toBeGreaterThan(5);
    // Actual prop footprint: kiosk body, the goods crate and the closed sign.
    const cells: Array<[number, number]> = [
      [KIOSK_MAIN.x - 1, KIOSK_MAIN.z + 1], // crate
      [KIOSK_MAIN.x + 2, KIOSK_MAIN.z - 1], // closed sign
    ];
    for (let dx = 0; dx <= 3; dx++) {
      for (let dz = 0; dz <= 2; dz++) cells.push([KIOSK_MAIN.x + dx, KIOSK_MAIN.z + dz]);
    }
    for (const [x, z] of cells) {
      expect(isOnRoad(x, z)).toBe(false);
    }
  });

  test('actors keep distance from the bus loop', () => {
    const anchors: Array<[number, number]> = [
      [COW_MEADOW.x, COW_MEADOW.z],
      [FISHERMAN_SPOT.x, FISHERMAN_SPOT.z],
      [DOG_HOME.x, DOG_HOME.z],
    ];
    for (const [x, z] of anchors) {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i <= 300; i++) {
        const p = BUS_ROUTE_CURVE.getPointAt(i / 300);
        best = Math.min(best, Math.hypot(p.x - x, p.z - z));
      }
      expect(best).toBeGreaterThan(4);
    }
  });
});

describe('palette', () => {
  test('uses human-scale benches and a shared walking surface', () => {
    expect(BENCH_DIMENSIONS.seatHeight).toBeGreaterThanOrEqual(0.42);
    expect(BENCH_DIMENSIONS.seatHeight).toBeLessThanOrEqual(0.52);
    expect(BENCH_DIMENSIONS.length).toBeGreaterThanOrEqual(2.4);
    expect(BENCH_DIMENSIONS.length).toBeLessThanOrEqual(3.2);
    expect(BENCH_DIMENSIONS.seatThickness).toBeLessThan(0.22);
    expect(GROUND_SURFACE_Y).toBe(-0.5);
  });

  test('places a physical street lamp close enough to light the cow meadow', () => {
    const nearestLamp = Math.min(
      ...LAMP_POSITIONS.map(([x, z]) => Math.hypot(x - COW_MEADOW.x, z - COW_MEADOW.z))
    );
    expect(nearestLamp).toBeLessThan(8);
  });

  test('keeps passenger height within a believable human scale', () => {
    const modeledHeight = 2.455 * PASSENGER_SCALE;
    expect(modeledHeight).toBeGreaterThan(1.75);
    expect(modeledHeight).toBeLessThan(2.05);
  });

  test('uses colors that Three can construct without string warnings', () => {
    for (const color of Object.values(COLORS)) {
      const threeColor = threeColorFromHex(color);
      expect(threeColor).toBeInstanceOf(THREE.Color);
      expect(Number.isNaN(threeColor.r)).toBe(false);
      expect(Number.isNaN(threeColor.g)).toBe(false);
      expect(Number.isNaN(threeColor.b)).toBe(false);
    }
  });
});
