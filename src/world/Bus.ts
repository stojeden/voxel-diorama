import * as THREE from 'three';
import {
  BUS_ROUTE_CURVE,
  BUS_STOPS,
  COLORS,
  GROUND_SURFACE_Y,
  LEVEL_CROSSING,
  busShelterCenter,
  nearestCurveT,
  type BusStop,
} from './WorldLayout';
import { buildPassenger, easeInOut, type PassengerBuild } from './PassengerCrowd';
import { mergeStaticMeshes } from '../performance/mergeStaticMeshes';
import {
  busShelterColliders,
  BUS_DOOR_APPROACH_DISTANCE,
  busStopWaitingPositions,
  busStopWalkingPath,
  isPointClear,
  polylineLengths,
  samplePolyline,
  type CollisionRect,
} from './BusStopNavigation';

/**
 * City bus circling the avenue loop, with two stops where voxel passengers
 * board and alight. Movement mirrors the train: two virtual axles sample the
 * closed curve so the body corners naturally, speed is critically damped,
 * and a small state machine handles brake → dwell → depart.
 */

const BUS_LENGTH = 8;
const BUS_WIDTH = 2.3;
const BUS_HEIGHT = 2.6;
const AXLE_OFFSET_METERS = 2.6;
const BASE_SPEED = 6.5;
const BRAKING_DISTANCE = 10;
const STOP_SPEED_THRESHOLD = 0.2;
const REARM_DISTANCE = 6;
const WHEEL_RADIUS = 0.45;

const ROUTE_LENGTH = BUS_ROUTE_CURVE.getLength();
/** Route parameter of the railway level crossing — the bus yields to trains. */
const CROSSING_T = nearestCurveT(BUS_ROUTE_CURVE, LEVEL_CROSSING.x, LEVEL_CROSSING.z);

type BusState =
  | { kind: 'cruising' }
  | { kind: 'braking'; stop: BusStop }
  | { kind: 'dwelling'; stop: BusStop; timeLeft: number }
  | { kind: 'leaving'; stop: BusStop; entryT: number };

function wrap01(t: number): number {
  return ((t % 1) + 1) % 1;
}

function forwardDelta(from: number, to: number): number {
  let d = to - from;
  while (d < 0) d += 1;
  while (d >= 1) d -= 1;
  return d;
}

function buildBusMesh(): {
  group: THREE.Group;
  wheels: THREE.Mesh[];
  doors: THREE.Mesh[];
  materials: THREE.Material[];
  windowMaterial: THREE.MeshStandardMaterial;
  headLights: THREE.SpotLight[];
  beamMaterials: THREE.MeshBasicMaterial[];
  bodyMaterial: THREE.MeshStandardMaterial;
  roofMaterial: THREE.MeshStandardMaterial;
} {
  const group = new THREE.Group();
  const materials: THREE.Material[] = [];

  const make = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25, ...opts });
    materials.push(m);
    return m;
  };

  const bodyMat = make(0xc8a536, { roughness: 0.42, metalness: 0.3 }) as THREE.MeshStandardMaterial;
  const roofMat = make(0xe8e2cf, { roughness: 0.6 }) as THREE.MeshStandardMaterial;
  const darkMat = make(0x2a2a2a, { roughness: 0.8 });
  const windowMat = make(COLORS.windowLit, {
    roughness: 0.1,
    metalness: 0.5,
    emissive: COLORS.windowLit,
    emissiveIntensity: 0.25,
  }) as THREE.MeshStandardMaterial;
  windowMat.envMapIntensity = 1.6;
  const wheelMat = make(0x141414, { roughness: 0.5, metalness: 0.6 });

  const floorY = WHEEL_RADIUS + 0.35;

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH, BUS_HEIGHT, BUS_LENGTH), bodyMat);
  body.position.y = floorY + BUS_HEIGHT / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Roof cap
  const roof = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH - 0.3, 0.18, BUS_LENGTH - 0.5), roofMat);
  roof.position.y = floorY + BUS_HEIGHT + 0.09;
  roof.castShadow = true;
  group.add(roof);

  // Window band (both sides + windscreen)
  const sideWin = new THREE.BoxGeometry(0.06, 0.85, BUS_LENGTH - 1.6);
  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(sideWin, windowMat);
    win.position.set(side * (BUS_WIDTH / 2 + 0.03), floorY + BUS_HEIGHT * 0.66, 0.1);
    group.add(win);
  }
  const windscreen = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH - 0.4, 1.0, 0.06), windowMat);
  windscreen.position.set(0, floorY + BUS_HEIGHT * 0.62, -BUS_LENGTH / 2 - 0.02);
  group.add(windscreen);

  // Doors — two on the right side (local +x), slide toward the rear.
  const doors: THREE.Mesh[] = [];
  const doorGeo = new THREE.BoxGeometry(0.08, BUS_HEIGHT * 0.8, 1.0);
  for (const zPos of [-1.6, 1.6]) {
    const door = new THREE.Mesh(doorGeo, darkMat);
    door.position.set(BUS_WIDTH / 2 + 0.05, floorY + BUS_HEIGHT * 0.42, zPos);
    group.add(door);
    doors.push(door);
  }

  // Bumper stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH + 0.06, 0.3, BUS_LENGTH - 0.3), darkMat);
  stripe.position.y = floorY + 0.18;
  group.add(stripe);

  // Headlights / taillights
  const headMat = make(0xfff2c0, { emissive: 0xfff2c0, emissiveIntensity: 1.0 });
  const tailMat = make(0xcc2222, { emissive: 0xcc2222, emissiveIntensity: 0.8 });
  const headLights: THREE.SpotLight[] = [];
  const beamMaterials: THREE.MeshBasicMaterial[] = [];
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.1), headMat);
    head.position.set(side * 0.7, floorY + 0.45, -BUS_LENGTH / 2 - 0.04);
    group.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.2, 0.1), tailMat);
    tail.position.set(side * 0.7, floorY + 0.5, BUS_LENGTH / 2 + 0.04);
    group.add(tail);

    // Real spotlights painting the road ahead…
    const lamp = new THREE.SpotLight(0xfff2c0, 0, 30, Math.PI / 6, 0.55, 1.6);
    lamp.position.set(side * 0.7, floorY + 0.45, -BUS_LENGTH / 2 - 0.1);
    lamp.target.position.set(side * 0.7, -1.2, -BUS_LENGTH / 2 - 11);
    group.add(lamp);
    group.add(lamp.target);
    headLights.push(lamp);

    // …plus a softly visible beam cone.
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff2c0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    materials.push(beamMat);
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.1, 8, 12, 1, true), beamMat);
    beam.rotation.x = Math.PI / 2 - 0.1;
    beam.position.set(side * 0.7, floorY + 0.15, -BUS_LENGTH / 2 - 3.8);
    group.add(beam);
    beamMaterials.push(beamMat);
  }

  // Wheels
  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 14);
  for (const zPos of [-AXLE_OFFSET_METERS, AXLE_OFFSET_METERS]) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * (BUS_WIDTH / 2 - 0.15), WHEEL_RADIUS, zPos);
      wheel.castShadow = true;
      group.add(wheel);
      wheels.push(wheel);
    }
  }

  mergeStaticMeshes(group, new Set([...wheels, ...doors]));

  return {
    group, wheels, doors, materials, windowMaterial: windowMat, headLights, beamMaterials,
    bodyMaterial: bodyMat, roofMaterial: roofMat,
  };
}

// ── Bus-stop crowd ──

type Activity = 'idle' | 'boarding' | 'disembarking';

interface BusPassenger {
  build: PassengerBuild;
  waitPos: THREE.Vector3;
  doorPos: THREE.Vector3;
  path: THREE.Vector3[];
  pathLengths: number[];
  pathLength: number;
  facing: number;
  activity: Activity;
  progress: number;
  duration: number;
  phase: number;
  delay: number;
  currentOpacity: number;
  targetOpacity: number;
}

interface StopCrowd {
  stop: BusStop;
  passengers: BusPassenger[];
  wasDwelling: boolean;
  visitCount: number;
  colliders: CollisionRect[];
}

function buildStopCrowd(scene: THREE.Scene, stop: BusStop): StopCrowd {
  const lanePoint = BUS_ROUTE_CURVE.getPointAt(stop.atT);
  const tangent = BUS_ROUTE_CURVE.getTangentAt(stop.atT).normalize();
  const c = busShelterCenter(stop);
  const shelterCenter = new THREE.Vector3(c.x, GROUND_SURFACE_Y, c.z);
  const towardShelter = shelterCenter.clone().sub(lanePoint).setY(0).normalize();
  const doorBase = lanePoint.clone().addScaledVector(towardShelter, BUS_DOOR_APPROACH_DISTANCE);
  doorBase.y = 0.5;
  const waitPositions = busStopWaitingPositions(stop);
  const colliders = busShelterColliders(stop);

  const passengers: BusPassenger[] = [];
  for (let i = 0; i < 4; i++) {
    const waitPos = waitPositions[i];
    const doorPos = doorBase.clone().addScaledVector(tangent, (i % 2 === 0 ? -1.6 : 1.6));
    doorPos.y = 0.5;
    const path = busStopWalkingPath(stop, waitPos, doorPos);
    const pathMetrics = polylineLengths(path);

    const build = buildPassenger();
    build.group.name = `bus-passenger-${stop.label}-${i}`;
    build.group.position.copy(waitPos);
    const facing = Math.atan2(doorPos.x - waitPos.x, doorPos.z - waitPos.z);
    build.group.rotation.y = facing;
    scene.add(build.group);

    passengers.push({
      build,
      waitPos,
      doorPos,
      path,
      pathLengths: pathMetrics.segments,
      pathLength: pathMetrics.total,
      facing,
      activity: 'idle',
      progress: 0,
      duration: 2.2 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      delay: 0,
      currentOpacity: 0,
      targetOpacity: 0.92,
    });
  }

  return { stop, passengers, wasDwelling: false, visitCount: 0, colliders };
}

export interface BusHandle {
  update: (delta: number, nightFactor: number, crossingBlocked: boolean) => void;
  getPosition: (target?: THREE.Vector3) => THREE.Vector3;
  getDirection: (target?: THREE.Vector3) => THREE.Vector3;
  getStopState: () => { dwelling: boolean; label: string };
  debugStartDwell: (label: string) => boolean;
  getPassengerDebugState: () => Array<{
    stop: string;
    activity: Activity;
    colliding: boolean;
    position: [number, number, number];
  }>;
  /** 0..1 — cyberpunk look morph (dark hull, neon glow). */
  setCyberLook: (factor: number) => void;
  dispose: () => void;
}

const BUS_BODY_NORMAL = new THREE.Color(0xc8a536);
const BUS_BODY_CYBER = new THREE.Color(0x14181f);
const BUS_ROOF_NORMAL = new THREE.Color(0xe8e2cf);
const BUS_ROOF_CYBER = new THREE.Color(0x20262e);
const BUS_GLASS_NORMAL = new THREE.Color(COLORS.windowLit);
const BUS_GLASS_CYBER = new THREE.Color(0x35e6ff);

export function createBus(scene: THREE.Scene): BusHandle {
  const {
    group, wheels, doors, materials, windowMaterial, headLights, beamMaterials,
    bodyMaterial, roofMaterial,
  } = buildBusMesh();
  scene.add(group);

  const crowds = BUS_STOPS.map((stop) => buildStopCrowd(scene, stop));

  let leadT = wrap01(BUS_STOPS[0].atT + 0.3);
  let currentSpeed = BASE_SPEED;
  let doorOpen = 0;
  let clock = 0;
  let state: BusState = { kind: 'cruising' };

  const frontPos = new THREE.Vector3();
  const rearPos = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const forward = new THREE.Vector3(1, 0, 0);

  function nextStop(fromT: number): BusStop {
    let best = BUS_STOPS[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const stop of BUS_STOPS) {
      const d = forwardDelta(fromT, stop.atT);
      if (d < bestDelta) {
        bestDelta = d;
        best = stop;
      }
    }
    return best;
  }

  function startDwell(crowd: StopCrowd): void {
    crowd.visitCount += 1;
    const flip = crowd.visitCount % 2 === 0;
    for (let i = 0; i < crowd.passengers.length; i++) {
      const p = crowd.passengers[i];
      const boards = (i % 2 === 0) === flip;
      p.progress = 0;
      p.duration = 2.0 + Math.random() * 0.8;
      if (boards) {
        p.activity = 'boarding';
        p.delay = 0.9 + i * 0.16;
        p.currentOpacity = 0.92;
        p.targetOpacity = 0.92;
        p.build.group.position.copy(p.waitPos);
      } else {
        p.activity = 'disembarking';
        p.delay = (i % 2) * 0.22;
        p.currentOpacity = 0;
        p.targetOpacity = 0.92;
        p.build.group.position.copy(p.doorPos);
      }
    }
  }

  function updatePassenger(p: BusPassenger, colliders: readonly CollisionRect[], delta: number): void {
    if (p.activity === 'idle') {
      p.build.group.position.copy(p.waitPos);
      p.build.body.position.y = 1.4 + Math.sin(clock * 1.3 + p.phase) * 0.015;
      p.build.head.rotation.y = Math.sin(clock * 0.4 + p.phase * 2) * 0.4;
      p.targetOpacity = 0.92;
    } else {
      if (p.delay > 0) {
        p.delay = Math.max(0, p.delay - delta);
        return;
      }
      p.progress = Math.min(1, p.progress + delta / p.duration);
      const eased = easeInOut(p.progress);
      const pathProgress = p.activity === 'boarding' ? eased : 1 - eased;
      const previousX = p.build.group.position.x;
      const previousZ = p.build.group.position.z;
      samplePolyline(p.path, p.pathLengths, p.pathLength, pathProgress, p.build.group.position);
      if (!isPointClear(p.build.group.position, colliders)) {
        p.build.group.position.x = previousX;
        p.build.group.position.z = previousZ;
      }
      p.build.group.position.y += Math.abs(Math.sin(p.progress * Math.PI * 3)) * 0.06;
      p.build.legs.rotation.x = Math.sin(p.progress * Math.PI * 3) * 0.25;
      p.build.leftArm.rotation.x = Math.sin(p.progress * Math.PI * 3) * 0.55;
      p.build.rightArm.rotation.x = -Math.sin(p.progress * Math.PI * 3) * 0.55;
      const dirX = p.build.group.position.x - previousX;
      const dirZ = p.build.group.position.z - previousZ;
      if (dirX !== 0 || dirZ !== 0) p.build.group.rotation.y = Math.atan2(dirX, dirZ);

      if (p.activity === 'boarding') {
        p.targetOpacity = p.progress < 0.7 ? 0.92 : Math.max(0, 0.92 * (1 - (p.progress - 0.7) / 0.3));
      } else {
        p.targetOpacity = p.progress > 0.3 ? 0.92 : (p.progress / 0.3) * 0.92;
      }

      if (p.progress >= 1) {
        if (p.activity === 'boarding') {
          p.targetOpacity = 0;
        } else {
          p.activity = 'idle';
          p.progress = 0;
          p.build.group.position.copy(p.waitPos);
          p.build.group.rotation.y = p.facing;
        }
      }
    }

    const lerp = 1 - Math.exp(-6 * Math.max(delta, 0.0001));
    p.currentOpacity += (p.targetOpacity - p.currentOpacity) * lerp;
    for (const mat of p.build.materials) mat.opacity = p.currentOpacity;
  }

  return {
    update(delta, nightFactor, crossingBlocked) {
      clock += delta;

      // ── Speed by state ──
      let targetSpeed = BASE_SPEED;
      let distanceToStop = Number.POSITIVE_INFINITY;

      // ── Level crossing: yield to the train ──
      const toCrossing = forwardDelta(leadT, CROSSING_T) * ROUTE_LENGTH;
      const holdForTrain = crossingBlocked && toCrossing < 18 && toCrossing > 0.5;

      if (state.kind === 'cruising') {
        const stop = nextStop(leadT);
        distanceToStop = forwardDelta(leadT, stop.atT) * ROUTE_LENGTH;
        if (distanceToStop < 0.5) distanceToStop += ROUTE_LENGTH;
      } else if (state.kind === 'braking') {
        const remaining = forwardDelta(leadT, state.stop.atT) * ROUTE_LENGTH;
        distanceToStop = remaining;
        const fraction = Math.min(1, Math.max(0, remaining / BRAKING_DISTANCE));
        targetSpeed = BASE_SPEED * fraction * fraction;
      } else if (state.kind === 'dwelling') {
        targetSpeed = 0;
      }
      if (holdForTrain) targetSpeed = 0;

      const k = 1 - Math.exp(-1.8 * Math.max(delta, 0.0001));
      currentSpeed += (targetSpeed - currentSpeed) * k;
      if (state.kind === 'dwelling') currentSpeed = 0;

      leadT = wrap01(leadT + (currentSpeed * delta) / ROUTE_LENGTH);

      // ── Transitions ──
      if (state.kind === 'cruising' && distanceToStop < BRAKING_DISTANCE) {
        state = { kind: 'braking', stop: nextStop(leadT) };
      } else if (
        state.kind === 'braking' &&
        currentSpeed < STOP_SPEED_THRESHOLD &&
        forwardDelta(leadT, state.stop.atT) * ROUTE_LENGTH < 2
      ) {
        state = { kind: 'dwelling', stop: state.stop, timeLeft: state.stop.dwellSeconds };
      } else if (state.kind === 'dwelling') {
        state.timeLeft -= delta;
        if (state.timeLeft <= 0) state = { kind: 'leaving', stop: state.stop, entryT: leadT };
      } else if (state.kind === 'leaving') {
        if (forwardDelta(state.entryT, leadT) * ROUTE_LENGTH > REARM_DISTANCE) {
          state = { kind: 'cruising' };
        }
      }

      // ── Place the body on two virtual axles ──
      const dT = AXLE_OFFSET_METERS / ROUTE_LENGTH;
      frontPos.copy(BUS_ROUTE_CURVE.getPointAt(wrap01(leadT + dT)));
      rearPos.copy(BUS_ROUTE_CURVE.getPointAt(wrap01(leadT - dT)));
      mid.copy(frontPos).add(rearPos).multiplyScalar(0.5);
      group.position.copy(mid);
      forward.copy(frontPos).sub(rearPos).normalize();
      // lookAt points +Z at the target; the bus front (windscreen, lamps)
      // sits on -Z, so aim the look-target BEHIND the bus.
      ahead.copy(group.position).sub(forward);
      group.lookAt(ahead);

      // ── Wheels ──
      const wheelDelta = (currentSpeed * delta) / WHEEL_RADIUS;
      for (const wheel of wheels) wheel.rotation.x += wheelDelta;

      // ── Doors ──
      const doorTarget = state.kind === 'dwelling' ? 1 : 0;
      const doorLerp = 1 - Math.exp(-4 * Math.max(delta, 0.0001));
      doorOpen += (doorTarget - doorOpen) * doorLerp;
      doors[0].position.z = -1.6 - doorOpen * 0.8;
      doors[1].position.z = 1.6 + doorOpen * 0.8;

      // ── Night interior glow + headlights on the road ──
      windowMaterial.emissiveIntensity = 0.25 + nightFactor * 0.9;
      const beamStrength = Math.min(1, nightFactor * 1.4);
      for (const lamp of headLights) {
        lamp.intensity = 4 + beamStrength * 240;
      }
      for (const beamMat of beamMaterials) {
        beamMat.opacity = beamStrength * 0.14;
      }

      // ── Crowds ──
      for (const crowd of crowds) {
        const dwellHere = state.kind === 'dwelling' && state.stop.label === crowd.stop.label;
        if (dwellHere && !crowd.wasDwelling) startDwell(crowd);
        crowd.wasDwelling = dwellHere;
        for (const p of crowd.passengers) updatePassenger(p, crowd.colliders, delta);
      }
    },
    getPosition(target = new THREE.Vector3()) {
      return target.copy(group.position);
    },
    getDirection(target = new THREE.Vector3()) {
      return target.copy(forward);
    },
    getStopState() {
      if (state.kind === 'dwelling') return { dwelling: true, label: state.stop.label };
      return { dwelling: false, label: '' };
    },
    debugStartDwell(label) {
      const crowd = crowds.find((entry) => entry.stop.label === label);
      if (!crowd) return false;
      startDwell(crowd);
      return true;
    },
    getPassengerDebugState() {
      return crowds.flatMap((crowd) =>
        crowd.passengers.map((passenger) => ({
          stop: crowd.stop.label,
          activity: passenger.activity,
          colliding: !isPointClear(passenger.build.group.position, crowd.colliders),
          position: passenger.build.group.position.toArray() as [number, number, number],
        }))
      );
    },
    setCyberLook(factor) {
      bodyMaterial.color.lerpColors(BUS_BODY_NORMAL, BUS_BODY_CYBER, factor);
      roofMaterial.color.lerpColors(BUS_ROOF_NORMAL, BUS_ROOF_CYBER, factor);
      windowMaterial.color.lerpColors(BUS_GLASS_NORMAL, BUS_GLASS_CYBER, factor);
      windowMaterial.emissive.lerpColors(BUS_GLASS_NORMAL, BUS_GLASS_CYBER, factor);
    },
    dispose() {
      scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      });
      for (const mat of materials) mat.dispose();
      for (const crowd of crowds) {
        for (const p of crowd.passengers) {
          scene.remove(p.build.group);
          p.build.group.traverse((child) => {
            if (child instanceof THREE.Mesh) child.geometry.dispose();
          });
          for (const mat of p.build.materials) mat.dispose();
        }
      }
    },
  };
}
