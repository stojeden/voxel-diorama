import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { CROSSING_BODY_SPAN, CROSSING_HOLD_LINE, createBus } from './Bus';
import {
  BUS_ROUTE_CURVE,
  LEVEL_CROSSING,
  TRACK_HALF_GAUGE,
  TRAIN_ROUTE_CURVE,
  nearestCurveT,
} from './WorldLayout';

/**
 * The bus yields to the train at the level crossing.
 *
 * Fixing `LEVEL_CROSSING` proved that the marker sits on the intersection. It proved
 * nothing about the bus, and the bus is the thing that has to stop -- so this drives it,
 * frame by frame, with a train occupying the crossing or not, and looks at where the
 * *body* ends up rather than at the point the route parameter names.
 *
 * The failure this is built around: the hold used to be recomputed every frame as
 * "further than four metres from the crossing". A bus braking from that mark drifts past
 * it, loses the condition, and accelerates back to cruise speed with its bumper over the
 * rails.
 */

const FRAME = 1 / 60;
const CROSSING_T = nearestCurveT(BUS_ROUTE_CURVE, LEVEL_CROSSING.x, LEVEL_CROSSING.z);
/** Body dimensions, as the mesh is built. */
const BUS_LENGTH = 8;
const BUS_WIDTH = 2.5;

/**
 * The rail centre-line near the crossing, sampled once.
 *
 * `bodyClearance` runs on every simulated frame, for nine points of the bus footprint, and
 * it used to walk all 601 samples of the train curve each time -- with the cheap 20 m
 * rejection AFTER the expensive `getPointAt`, which does an arc-length search per call. The
 * slowest test in the suite spent 6.17 million curve evaluations that way and took 1.6 s
 * locally; on a loaded CI runner it crossed Vitest's 5 s default and failed a release for a
 * reason that had nothing to do with level crossings.
 *
 * The curve is static, so the window is computed once. The same samples survive the same
 * filter and feed the same distance, so every assertion below measures exactly what it
 * measured before.
 */
const RAIL_NEAR_CROSSING: { x: number; z: number }[] = [];
for (let i = 0; i <= 600; i++) {
  const rail = TRAIN_ROUTE_CURVE.getPointAt(i / 600);
  if (Math.abs(rail.x - LEVEL_CROSSING.x) > 20) continue;
  RAIL_NEAR_CROSSING.push({ x: rail.x, z: rail.z });
}

/** How close any part of the bus body comes to the rail centre-line, in metres. */
function bodyClearance(bus: ReturnType<typeof createBus>): number {
  const centre = bus.getPosition(new THREE.Vector3());
  const forward = bus.getDirection(new THREE.Vector3()).setY(0).normalize();
  const side = new THREE.Vector3(-forward.z, 0, forward.x);
  let nearest = Number.POSITIVE_INFINITY;
  // Every corner of the footprint, and the middles of the two ends: the front bumper is
  // what reaches the rails first, and it is four metres from the point the bus is "at".
  for (const along of [-BUS_LENGTH / 2, 0, BUS_LENGTH / 2]) {
    for (const across of [-BUS_WIDTH / 2, 0, BUS_WIDTH / 2]) {
      const corner = centre.clone()
        .addScaledVector(forward, along)
        .addScaledVector(side, across);
      for (const rail of RAIL_NEAR_CROSSING) {
        nearest = Math.min(nearest, Math.hypot(rail.x - corner.x, rail.z - corner.z));
      }
    }
  }
  return nearest;
}

/** Put the bus a given distance short of the crossing, cruising, and settle the mesh. */
function approach(bus: ReturnType<typeof createBus>, metresShort: number): void {
  const routeLength = BUS_ROUTE_CURVE.getLength();
  bus.seekRouteProgress(((CROSSING_T - metresShort / routeLength) % 1 + 1) % 1);
  bus.update(FRAME, 0, false, 0.5);
}

/** Run frames, and report what happened to the body and to the throttle. */
function drive(
  bus: ReturnType<typeof createBus>,
  frames: number,
  blocked: (frame: number) => boolean
): {
  closest: number;
  held: boolean;
  travelled: number;
  /** Slowest the bus went while some part of it was over the rails and a train was due. */
  slowestOnCrossing: number;
  /** Seconds spent with any part of the body over the rails while blocked. */
  secondsOnCrossing: number;
} {
  const start = bus.getRouteProgress();
  let closest = Number.POSITIVE_INFINITY;
  let slowestOnCrossing = Number.POSITIVE_INFINITY;
  let secondsOnCrossing = 0;
  for (let i = 0; i < frames; i++) {
    const isBlocked = blocked(i);
    bus.update(FRAME, 0, isBlocked, 0.5);
    closest = Math.min(closest, bodyClearance(bus));
    const state = bus.getCrossingState();
    if (isBlocked && state.onCrossing) {
      slowestOnCrossing = Math.min(slowestOnCrossing, state.speed);
      secondsOnCrossing += FRAME;
    }
  }
  const routeLength = BUS_ROUTE_CURVE.getLength();
  return {
    closest,
    held: bus.getCrossingState().held,
    travelled: (((bus.getRouteProgress() - start) % 1 + 1) % 1) * routeLength,
    slowestOnCrossing,
    secondsOnCrossing,
  };
}

describe('the bus and the level crossing', () => {
  test('the hold line leaves the bumper clear of the rails', () => {
    // Not a behaviour, a dimension: the number the code holds at has to be further out
    // than half the body, or "stopped at the line" means "stopped on the track".
    expect(CROSSING_HOLD_LINE).toBeGreaterThan(BUS_LENGTH / 2 + 1);
    expect(CROSSING_BODY_SPAN).toBeGreaterThan(BUS_LENGTH / 2);
  });

  test('a train on the crossing stops the bus, and no part of it reaches the rails', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    approach(bus, 20);
    // Blocked for four seconds of frames: long enough to brake and stand still.
    const run = drive(bus, 240, () => true);
    expect(run.held, 'autobus musi trzymać się przed przejazdem').toBe(true);
    expect(run.closest, `najbliższy punkt nadwozia: ${run.closest.toFixed(2)} m`)
      .toBeGreaterThan(TRACK_HALF_GAUGE + 0.5);
    expect(bus.getCrossingState().speed).toBeLessThan(0.4);
    bus.dispose();
  });

  test('the block appearing mid-approach still stops it', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    approach(bus, 22);
    // Clear for the first half-second, then a train arrives.
    const run = drive(bus, 300, (frame) => frame > 30);
    expect(run.held).toBe(true);
    expect(run.closest).toBeGreaterThan(TRACK_HALF_GAUGE + 0.5);
    bus.dispose();
  });

  test('past the commit point it drives across instead of stopping on the rails', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    // Bumper practically at the rails, at cruising speed, when the train appears.
    approach(bus, CROSSING_HOLD_LINE - 1);
    const before = bus.getCrossingState();
    expect(before.toCrossing).toBeLessThan(CROSSING_HOLD_LINE);
    const run = drive(bus, 180, () => true);
    expect(run.held, 'nie zatrzymuj się na torach').toBe(false);
    // It got off the crossing rather than sitting on it.
    expect(bus.getCrossingState().onCrossing).toBe(false);
    expect(run.travelled).toBeGreaterThan(BUS_LENGTH);
    bus.dispose();
  });

  test('inside the commit point it clears the rails without hesitating on them', () => {
    /**
     * The case the old logic got wrong, and the reason a latch is not enough on its own.
     *
     * With the hold recomputed each frame as "further than four metres", a bus seven and
     * a half metres out brakes hard, drifts through that mark at about a metre a second,
     * loses the condition, and opens the throttle again -- so it crawls onto an occupied
     * crossing and then accelerates off it. Committing or not committing has to be decided
     * once, from the room available, not rediscovered every frame from a bare distance.
     */
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    approach(bus, 7.5);
    const run = drive(bus, 240, () => true);
    expect(run.held, 'za blisko, żeby się zatrzymać: nie hamuj').toBe(false);
    expect(
      run.slowestOnCrossing,
      `najniższa prędkość na torach: ${run.slowestOnCrossing.toFixed(2)} m/s`
    ).toBeGreaterThan(3);
    expect(
      run.secondsOnCrossing,
      `czas nadwozia nad torami: ${run.secondsOnCrossing.toFixed(2)} s`
    ).toBeLessThan(2.6);
    bus.dispose();
  });

  test('the hold survives creeping past its own line', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    approach(bus, 20);
    // Stop it, then keep the train there for a long while. The throttle model never
    // reaches exactly zero, so the bus drifts; the latch must not read that drift as
    // "past the line, carry on" and open the throttle again.
    drive(bus, 240, () => true);
    const settled = bus.getCrossingState();
    const long = drive(bus, 900, () => true);
    expect(long.held, 'zatrzask nie może puścić od samego dryfu').toBe(true);
    expect(bus.getCrossingState().speed).toBeLessThan(settled.speed + 0.05);
    expect(long.closest).toBeGreaterThan(TRACK_HALF_GAUGE + 0.5);
    bus.dispose();
  });

  test('releasing the crossing releases the bus', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    approach(bus, 20);
    drive(bus, 240, () => true);
    expect(bus.getCrossingState().held).toBe(true);

    const after = drive(bus, 300, () => false);
    expect(after.held).toBe(false);
    // It moved on, and it went over the crossing.
    expect(after.travelled).toBeGreaterThan(10);
    expect(bus.getCrossingState().speed).toBeGreaterThan(1);
    bus.dispose();
  });

  test('a train really does occupy the crossing before the bus reaches it', () => {
    // The other half of the loop: the signal the bus reads has to be true while a train
    // is actually over the road, which is what the corrected marker buys.
    const scene = new THREE.Scene();
    const rail = TRAIN_ROUTE_CURVE;
    let closestRailToMarker = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 2000; i++) {
      const p = rail.getPointAt(i / 2000);
      closestRailToMarker = Math.min(
        closestRailToMarker,
        Math.hypot(p.x - LEVEL_CROSSING.x, p.z - LEVEL_CROSSING.z)
      );
    }
    // Within the five-metre probe `main.ts` uses, by a wide margin.
    expect(closestRailToMarker).toBeLessThan(1);
    scene.clear();
  });
});
