import * as THREE from 'three';
import {
  BUS_ROUTE_CURVE,
  BUS_STOPS,
  COLORS,
  GROUND_SURFACE_Y,
  LEVEL_CROSSING,
  nearestCurveT,
  type BusStop,
} from './WorldLayout';
import {
  applyPassengerEclipsePose,
  buildPassenger,
  SHARED_PASSENGER_GEOMETRY,
  eclipsePassengerPoseFor,
  easeInOut,
  type EclipsePassengerPose,
  type PassengerBuild,
} from './PassengerCrowd';
import { mergeStaticMeshes } from '../performance/mergeStaticMeshes';
import { createBusUnderGlow, type BusUnderGlowHandle } from './cyber/busGlow';
import type { EclipseWorldReactionState } from '../experience/EclipseWorldReaction';
import { fallbackRandom, type RandomSource } from '../core/Random';
import {
  MINUTES_PER_DAY,
  busServiceWindowAt,
  type BusServiceWindow,
} from '../environment/CityRhythm';
import {
  busShelterColliders,
  busStopWaitingPlacements,
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
/**
 * Measured, not nominal: with the old floor at WHEEL_RADIUS + 0.35 the finished body
 * stood 3.569 m tall on an 8.18 m chassis -- a height/length ratio of 0.44 where a real
 * bus of this length sits near 0.33. At the street camera that made it 300 px tall while
 * a bicycle 4 m closer was 98 px, which is what read as "giant bus, toy bicycles".
 * Body 2.32 on a 0.45 skirt plus an 0.18 roof cap gives 2.95 m, ratio 0.36.
 */
const BUS_HEIGHT = 2.32;
/** Skirt height: the wheel centre, so the lower half of each tyre reads below the body. */
const BUS_FLOOR_Y = 0.45;
const AXLE_OFFSET_METERS = 2.6;
const BASE_SPEED = 6.5;
const FINAL_LOOP_SPEED = 15;
const MORNING_RELEASE_SPEED = 8.5;
const BRAKING_DISTANCE = 10;
const STOP_SPEED_THRESHOLD = 0.2;
const REARM_DISTANCE = 6;
const WHEEL_RADIUS = 0.45;

const ROUTE_LENGTH = BUS_ROUTE_CURVE.getLength();
/** Route parameter of the railway level crossing — the bus yields to trains. */
const CROSSING_T = nearestCurveT(BUS_ROUTE_CURVE, LEVEL_CROSSING.x, LEVEL_CROSSING.z);

/**
 * Yielding at the level crossing, measured from the bumper rather than from a point.
 *
 * `leadT` is the middle of the body, so a hold line quoted from it says nothing about
 * where the front of the bus ends up: four metres from the centre is the front bumper
 * exactly on the rails. These are the numbers the geometry actually implies.
 */
const BUS_HALF_LENGTH = BUS_LENGTH / 2;
/** Room the bumper leaves in front of the rails. */
const CROSSING_CLEARANCE = 2.5;
/** Where the middle of the bus stands when the bumper is clear of the rails. */
export const CROSSING_HOLD_LINE = BUS_HALF_LENGTH + CROSSING_CLEARANCE;
/** Beyond this the crossing is somebody else's problem. */
const CROSSING_WATCH = 22;
/** Speed decay per second in the throttle model — the stopping distance follows from it. */
const SPEED_LAG = 1.8;
/** Half the body plus the rails: any less and part of the bus is over the track. */
export const CROSSING_BODY_SPAN = BUS_HALF_LENGTH + 1.5;

type BusState =
  | { kind: 'cruising' }
  | { kind: 'braking'; stop: BusStop }
  | { kind: 'dwelling'; stop: BusStop; timeLeft: number }
  | { kind: 'leaving'; stop: BusStop; entryT: number };

type BusServiceMode = 'normal' | 'final-loop' | 'off' | 'morning-release';
type DwellPurpose = 'normal' | 'final-loop' | 'morning-release';

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
  cyberTrim: THREE.Group;
  cyberTrimMaterial: THREE.MeshStandardMaterial;
  underGlow: BusUnderGlowHandle;
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
  // Glass, not a painted panel. The window colour used to be `windowLit` -- the same
  // warm cream as a lit flat -- with a 0.25 emissive on top in broad daylight, so the
  // bus carried four flat bright rectangles that barely differed from its yellow body.
  // Daytime glass is dark and takes its brightness from the sky it reflects; the lit
  // interior is a night state, so the emissive starts at zero and the day look comes
  // from the environment map instead.
  const windowMat = make(BUS_GLASS_NORMAL.getHex(), {
    roughness: 0.16,
    metalness: 0.35,
    emissive: COLORS.windowLit,
    emissiveIntensity: 0,
  }) as THREE.MeshStandardMaterial;
  // A mirror-smooth pane at envMapIntensity 2 washes out to flat white wherever the
  // glass is edge-on to the camera, which on a bus is most of its side. 1.2 keeps the
  // sky in the glass without erasing the pane.
  windowMat.envMapIntensity = 1.2;
  const wheelMat = make(0x141414, { roughness: 0.5, metalness: 0.6 });

  const floorY = BUS_FLOOR_Y;

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH, BUS_HEIGHT, BUS_LENGTH), bodyMat);
  body.position.y = floorY + BUS_HEIGHT / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Roof cap
  /**
   * Cyberpunk trim: two LED strips tucked under the sills, and one line along the flank.
   *
   * Emissive geometry only. No point light per strip -- four more shadowless lights would
   * spend the day-night budget on something nobody can point at, and a light under a bus
   * paints a bright pool on the road that reads as hovering rather than as lit trim. The
   * strips sit inboard of the wheels and above the road, so they light the bus's own
   * underside in the bloom pass and nothing else.
   */
  const cyberTrim = new THREE.Group();
  cyberTrim.name = 'bus-cyber-trim';
  cyberTrim.visible = false;
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x0b1a20,
    emissive: 0x35e6ff,
    emissiveIntensity: 0,
    roughness: 0.3,
  });
  materials.push(trimMat);
  for (const side of [-1, 1]) {
    const underLed = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, BUS_LENGTH - 2.2), trimMat);
    underLed.position.set(side * (BUS_WIDTH / 2 - 0.16), floorY - 0.04, 0);
    cyberTrim.add(underLed);
    const flankLine = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, BUS_LENGTH - 1.4), trimMat);
    flankLine.position.set(side * (BUS_WIDTH / 2 + 0.02), floorY + BUS_HEIGHT * 0.3, 0);
    cyberTrim.add(flankLine);
  }
  // One mesh, not four: the strips share a material and never move independently, and the
  // geometry budget is counted in objects.
  mergeStaticMeshes(cyberTrim);
  group.add(cyberTrim);
  /**
   * What those strips leave on the asphalt, parented to the bus so it follows the route and
   * every turn without a line of update code. The group's own origin already sits on the
   * road surface, so a few centimetres is enough to clear it.
   */
  const underGlow = createBusUnderGlow(BUS_LENGTH, 0.03);
  group.add(underGlow.object);

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

  // Wheel housings, so the tyres read as housed rather than stuck to a flat flank.
  const archGeo = new THREE.BoxGeometry(0.06, 0.5, 1.24);
  for (const zPos of [-AXLE_OFFSET_METERS, AXLE_OFFSET_METERS]) {
    for (const side of [-1, 1]) {
      const arch = new THREE.Mesh(archGeo, darkMat);
      arch.position.set(side * (BUS_WIDTH / 2 + 0.02), floorY + 0.16, zPos);
      group.add(arch);
    }
  }

  // Rear window, so front and back are told apart from any angle.
  const rearWin = new THREE.Mesh(new THREE.BoxGeometry(BUS_WIDTH - 0.6, 0.8, 0.06), windowMat);
  rearWin.position.set(0, floorY + BUS_HEIGHT * 0.62, BUS_LENGTH / 2 + 0.02);
  group.add(rearWin);

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
      side: THREE.FrontSide,
    });
    materials.push(beamMat);
    // A short, rounder glow just ahead of the lamp. The previous cone was 8 m long and
    // 2.2 m wide, additive and double-sided, so it cut a hard twelve-sided translucent
    // wedge across the night street frame. The SpotLight already paints the road.
    const beam = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 20, 1, true), beamMat);
    beam.rotation.x = Math.PI / 2 - 0.1;
    beam.position.set(side * 0.7, floorY + 0.1, -BUS_LENGTH / 2 - 1.15);
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
    bodyMaterial: bodyMat, roofMaterial: roofMat, cyberTrim, cyberTrimMaterial: trimMat, underGlow,
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
  atStop: boolean;
  eclipsePose: EclipsePassengerPose;
}

interface StopCrowd {
  stop: BusStop;
  passengers: BusPassenger[];
  wasDwelling: boolean;
  visitCount: number;
  colliders: CollisionRect[];
}

function buildStopCrowd(scene: THREE.Scene, stop: BusStop, random: RandomSource): StopCrowd {
  const colliders = busShelterColliders(stop);
  const passengers: BusPassenger[] = [];
  // As many as there are waiting spots: the number is decided by what fits under the
  // shelter without the figures intersecting, not by a literal here. Where they stand
  // and which way they look comes from `busStopWaitingPlacements`, which is also what
  // `clearance.test.ts` measures -- one algorithm, not two that drift apart.
  for (const { index: i, waitPos, doorPos, facing } of busStopWaitingPlacements(stop)) {
    const path = busStopWalkingPath(stop, waitPos, doorPos);
    const pathMetrics = polylineLengths(path);

    const build = buildPassenger(random);
    build.group.name = `bus-passenger-${stop.label}-${i}`;
    build.group.position.copy(waitPos);
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
      duration: 2.2 + random() * 0.8,
      phase: random() * Math.PI * 2,
      delay: 0,
      currentOpacity: 0,
      targetOpacity: 0.92,
      atStop: true,
      eclipsePose: eclipsePassengerPoseFor(i),
    });
  }

  return { stop, passengers, wasDwelling: false, visitCount: 0, colliders };
}

export interface BusHandle {
  update: (delta: number, nightFactor: number, crossingBlocked: boolean, t01: number) => void;
  getPosition: (target?: THREE.Vector3) => THREE.Vector3;
  getDirection: (target?: THREE.Vector3) => THREE.Vector3;
  getRouteProgress: () => number;
  seekRouteProgress: (progress: number) => void;
  getStopState: () => { dwelling: boolean; label: string };
  /** Level-crossing state, for the behaviour test and for showing the stop in the app. */
  getCrossingState: () => { held: boolean; toCrossing: number; speed: number; onCrossing: boolean };
  debugStartDwell: (label: string) => boolean;
  getPassengerDebugState: () => Array<{
    stop: string;
    activity: Activity;
    atStop: boolean;
    colliding: boolean;
    position: [number, number, number];
    observingEclipse: boolean;
  }>;
  getServiceDebugState: () => {
    mode: BusServiceMode;
    visible: boolean;
    waitingPassengers: number;
    remainingStops: number;
  };
  /** 0..1 — cyberpunk look morph (dark hull, neon glow). */
  setCyberLook: (factor: number) => void;
  /**
   * How wet the road is, 0..1, from the same weather the asphalt's own shine comes from.
   *
   * The under-sill strips mark the asphalt; on a wet road that mark becomes a reflection
   * just outboard of the body. Without this the bus would be the only thing in the city
   * that does not know it is raining.
   */
  setRoadWetness: (wetness: number) => void;
  setEclipseReaction: (reaction: EclipseWorldReactionState) => void;
  setHeadlightsEnabled: (enabled: boolean) => void;
  dispose: () => void;
}

const BUS_BODY_NORMAL = new THREE.Color(0xc8a536);
const BUS_BODY_CYBER = new THREE.Color(0x14181f);
const BUS_ROOF_NORMAL = new THREE.Color(0xe8e2cf);
const BUS_ROOF_CYBER = new THREE.Color(0x20262e);
/** Daylight bus glazing: dark blue-grey, brightened only by what it reflects. */
const BUS_GLASS_NORMAL = new THREE.Color(0x36414c);
/** The lit interior behind that glass, which is a night state. */
const BUS_INTERIOR_LIT = new THREE.Color(COLORS.windowLit);
const BUS_GLASS_CYBER = new THREE.Color(0x35e6ff);

export function createBus(scene: THREE.Scene, random = fallbackRandom('bus')): BusHandle {
  const {
    group, wheels, doors, materials, windowMaterial, headLights, beamMaterials,
    bodyMaterial, roofMaterial, cyberTrim, cyberTrimMaterial, underGlow,
  } = buildBusMesh();
  /** The two inputs the road mark needs beyond the night factor `update` already carries. */
  let cyberFactor = 0;
  let roadWetness = 0;
  scene.add(group);

  const crowds = BUS_STOPS.map((stop) => buildStopCrowd(scene, stop, random));

  let leadT = wrap01(BUS_STOPS[0].atT + 0.3);
  let currentSpeed = BASE_SPEED;
  let doorOpen = 0;
  let clock = 0;
  let state: BusState = { kind: 'cruising' };
  /** Latched while the bus is waiting out a train; cleared only when the crossing frees. */
  let crossingHeld = false;
  let serviceMode: BusServiceMode = 'normal';
  let headlightsEnabled = true;
  let serviceInitialized = false;
  let previousT01 = 0;
  let previousServiceWindow: BusServiceWindow = 'day';
  let eclipseReaction: EclipseWorldReactionState = {
    attention: 0,
    movementScale: 1,
    eyeProtection: 0,
    projection: 0,
    dogAlert: 0,
  };
  const finalStopsRemaining = new Set<string>();
  const morningStopsRemaining = new Set<string>();

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

  function setAllPassengersAtStop(atStop: boolean): void {
    for (const crowd of crowds) {
      crowd.wasDwelling = false;
      for (const p of crowd.passengers) {
        p.atStop = atStop;
        p.activity = 'idle';
        p.progress = 0;
        p.delay = 0;
        p.currentOpacity = atStop ? 0.92 : 0;
        p.targetOpacity = p.currentOpacity;
        p.build.group.position.copy(atStop ? p.waitPos : p.doorPos);
        for (const material of p.build.materials) material.opacity = p.currentOpacity;
      }
    }
  }

  function enterOffService(): void {
    serviceMode = 'off';
    group.visible = false;
    currentSpeed = 0;
    doorOpen = 0;
    state = { kind: 'cruising' };
    finalStopsRemaining.clear();
    morningStopsRemaining.clear();
    setAllPassengersAtStop(false);
  }

  function beginFinalLoop(): void {
    serviceMode = 'final-loop';
    group.visible = true;
    finalStopsRemaining.clear();
    for (const stop of BUS_STOPS) finalStopsRemaining.add(stop.label);
    morningStopsRemaining.clear();
  }

  function beginMorningRelease(): void {
    serviceMode = 'morning-release';
    group.visible = true;
    leadT = wrap01(BUS_STOPS[0].atT - 0.075);
    currentSpeed = BASE_SPEED * 0.55;
    state = { kind: 'cruising' };
    finalStopsRemaining.clear();
    morningStopsRemaining.clear();
    for (const stop of BUS_STOPS) morningStopsRemaining.add(stop.label);
    setAllPassengersAtStop(false);
  }

  function enterNormalService(restorePassengers = false): void {
    serviceMode = 'normal';
    group.visible = true;
    finalStopsRemaining.clear();
    morningStopsRemaining.clear();
    if (restorePassengers) setAllPassengersAtStop(true);
  }

  function syncServiceSchedule(t01: number): void {
    const serviceWindow = busServiceWindowAt(t01);
    if (!serviceInitialized) {
      if (serviceWindow === 'off') enterOffService();
      else if (serviceWindow === 'final-loop') beginFinalLoop();
      else enterNormalService(true);
      serviceInitialized = true;
      previousT01 = t01;
      previousServiceWindow = serviceWindow;
      return;
    }

    const forwardMinutes = forwardDelta(previousT01, t01) * MINUTES_PER_DAY;
    const timeJumped = forwardMinutes > 30;
    if (timeJumped) {
      if (serviceWindow === 'off') enterOffService();
      else if (serviceWindow === 'final-loop') beginFinalLoop();
      else if (previousServiceWindow === 'off') beginMorningRelease();
      else enterNormalService(true);
    } else if (previousServiceWindow !== serviceWindow) {
      if (serviceWindow === 'final-loop') beginFinalLoop();
      else if (serviceWindow === 'day' && previousServiceWindow === 'off') beginMorningRelease();
      else if (serviceWindow === 'off' && serviceMode !== 'final-loop') enterOffService();
    }

    previousT01 = t01;
    previousServiceWindow = serviceWindow;
  }

  function startDwell(crowd: StopCrowd, purpose: DwellPurpose = 'normal'): void {
    crowd.visitCount += 1;
    const flip = crowd.visitCount % 2 === 0;
    for (let i = 0; i < crowd.passengers.length; i++) {
      const p = crowd.passengers[i];
      const boards = purpose === 'final-loop' ||
        (purpose === 'normal' && p.atStop && (i % 2 === 0) === flip);
      const disembarks = purpose === 'morning-release' ||
        (purpose === 'normal' && !p.atStop);
      p.progress = 0;
      p.duration = 2.0 + random() * 0.8;
      if (boards && p.atStop) {
        p.activity = 'boarding';
        p.delay = 0.9 + i * 0.16;
        p.currentOpacity = 0.92;
        p.targetOpacity = 0.92;
        p.build.group.position.copy(p.waitPos);
      } else if (disembarks && !p.atStop) {
        p.activity = 'disembarking';
        p.delay = (i % 2) * 0.22;
        p.currentOpacity = 0;
        p.targetOpacity = 0.92;
        p.build.group.position.copy(p.doorPos);
      } else {
        p.activity = 'idle';
        p.delay = 0;
        p.targetOpacity = p.atStop ? 0.92 : 0;
      }
    }

    if (purpose === 'final-loop') finalStopsRemaining.delete(crowd.stop.label);
    if (purpose === 'morning-release') morningStopsRemaining.delete(crowd.stop.label);
  }

  function updatePassenger(p: BusPassenger, colliders: readonly CollisionRect[], delta: number): void {
    if (p.activity === 'idle') {
      p.build.group.position.copy(p.atStop ? p.waitPos : p.doorPos);
      if (p.atStop) {
        p.build.body.position.y = 1.4 + Math.sin(clock * 1.3 + p.phase) * 0.015;
        p.build.head.rotation.y = Math.sin(clock * 0.4 + p.phase * 2) * 0.4;
      }
      p.targetOpacity = p.atStop ? 0.92 : 0;
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
          p.activity = 'idle';
          p.atStop = false;
          p.targetOpacity = 0;
        } else {
          p.activity = 'idle';
          p.atStop = true;
          p.progress = 0;
          p.build.group.position.copy(p.waitPos);
          p.build.group.rotation.y = p.facing;
        }
      }
    }

    const lerp = 1 - Math.exp(-6 * Math.max(delta, 0.0001));
    p.currentOpacity += (p.targetOpacity - p.currentOpacity) * lerp;
    for (const mat of p.build.materials) mat.opacity = p.currentOpacity;
    applyPassengerEclipsePose(p.build, p.eclipsePose, eclipseReaction.attention);
  }

  return {
    update(delta, nightFactor, crossingBlocked, t01) {
      clock += delta;
      // Driven from here because this is where the night factor already arrives, every
      // frame, so the mark on the road can never be a frame behind the sky.
      underGlow.set(cyberFactor, nightFactor, roadWetness);
      syncServiceSchedule(t01);

      if (serviceMode === 'off') return;

      // ── Speed by state ──
      const cruiseSpeed =
        serviceMode === 'final-loop'
          ? FINAL_LOOP_SPEED
          : serviceMode === 'morning-release'
            ? MORNING_RELEASE_SPEED
            : BASE_SPEED;
      const brakingDistance = serviceMode === 'final-loop' ? 7 : BRAKING_DISTANCE;
      let targetSpeed = cruiseSpeed;
      let distanceToStop = Number.POSITIVE_INFINITY;

      // ── Level crossing: yield to the train ──
      const toCrossing = forwardDelta(leadT, CROSSING_T) * ROUTE_LENGTH;
      /**
       * The hold is LATCHED, and that is the whole point.
       *
       * It used to be recomputed every frame as `toCrossing > 4`. A bus that started
       * braking and then drifted past that mark lost the condition, went back to cruise
       * speed and accelerated onto an occupied crossing -- the brake switched off in the
       * middle of the stop. Once the bus has committed to waiting it waits until the
       * crossing is clear, wherever it has come to rest.
       *
       * It commits only if there is room to stop. `currentSpeed / SPEED_LAG` is the
       * distance the throttle model needs to bring it down; with less than that in hand
       * the bus is past its commit point and drives across, because stopping on a
       * crossing is worse than crossing it.
       */
      const room = toCrossing - CROSSING_HOLD_LINE;
      if (!crossingBlocked) crossingHeld = false;
      else if (
        !crossingHeld &&
        toCrossing < CROSSING_WATCH &&
        room > currentSpeed / SPEED_LAG + 1
      ) {
        crossingHeld = true;
      }

      if (state.kind === 'cruising') {
        const stop = nextStop(leadT);
        distanceToStop = forwardDelta(leadT, stop.atT) * ROUTE_LENGTH;
        if (distanceToStop < 0.5) distanceToStop += ROUTE_LENGTH;
      } else if (state.kind === 'braking') {
        const remaining = forwardDelta(leadT, state.stop.atT) * ROUTE_LENGTH;
        distanceToStop = remaining;
        const fraction = Math.min(1, Math.max(0, remaining / brakingDistance));
        targetSpeed = cruiseSpeed * fraction * fraction;
      } else if (state.kind === 'dwelling') {
        targetSpeed = 0;
      }
      if (crossingHeld) {
        // Ease down onto the hold line the same way the bus eases into a stop, so it
        // comes to rest beside the rails instead of gliding to a halt fifteen metres
        // short of them.
        const fraction = Math.min(1, Math.max(0, room / brakingDistance));
        targetSpeed = Math.min(targetSpeed, cruiseSpeed * fraction * fraction);
        distanceToStop = Math.min(distanceToStop, Math.max(0, room));
      }

      const k = 1 - Math.exp(-1.8 * Math.max(delta, 0.0001));
      currentSpeed += (targetSpeed - currentSpeed) * k;
      if (state.kind === 'dwelling') currentSpeed = 0;

      const previousLeadT = leadT;
      leadT = wrap01(leadT + (currentSpeed * delta) / ROUTE_LENGTH);

      // ── Transitions ──
      if (state.kind === 'cruising' && distanceToStop < brakingDistance) {
        state = { kind: 'braking', stop: nextStop(leadT) };
      } else if (
        state.kind === 'braking' &&
        (
          (
            forwardDelta(previousLeadT, state.stop.atT) > 0 &&
            forwardDelta(previousLeadT, state.stop.atT) <= forwardDelta(previousLeadT, leadT) + 1e-6
          ) ||
          (
            currentSpeed < STOP_SPEED_THRESHOLD &&
            forwardDelta(leadT, state.stop.atT) * ROUTE_LENGTH < 2
          )
        )
      ) {
        leadT = state.stop.atT;
        currentSpeed = 0;
        state = { kind: 'dwelling', stop: state.stop, timeLeft: state.stop.dwellSeconds };
      } else if (state.kind === 'dwelling') {
        state.timeLeft -= delta;
        if (state.timeLeft <= 0) state = { kind: 'leaving', stop: state.stop, entryT: leadT };
      } else if (state.kind === 'leaving') {
        if (forwardDelta(state.entryT, leadT) * ROUTE_LENGTH > REARM_DISTANCE) {
          state = { kind: 'cruising' };
        }
      }

      if (
        serviceMode === 'final-loop' &&
        finalStopsRemaining.size === 0 &&
        state.kind === 'leaving' &&
        forwardDelta(state.entryT, leadT) * ROUTE_LENGTH > 3
      ) {
        enterOffService();
        return;
      }
      if (
        serviceMode === 'morning-release' &&
        morningStopsRemaining.size === 0 &&
        state.kind === 'leaving'
      ) {
        enterNormalService();
      }

      // ── Place the body on two virtual axles ──
      const dT = AXLE_OFFSET_METERS / ROUTE_LENGTH;
      frontPos.copy(BUS_ROUTE_CURVE.getPointAt(wrap01(leadT + dT)));
      rearPos.copy(BUS_ROUTE_CURVE.getPointAt(wrap01(leadT - dT)));
      mid.copy(frontPos).add(rearPos).multiplyScalar(0.5);
      group.position.copy(mid);
      // The route is stored at y=0 but the road surface is the ground plane at
      // GROUND_SURFACE_Y, and the bus is modelled with its wheel contact at the group
      // origin. Without this the whole bus hovered half a metre over its own asphalt,
      // with a detached shadow -- measured, not guessed: lowest bus vertex +0.011 m
      // against a road raycast of -0.500 m.
      group.position.y += GROUND_SURFACE_Y;
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
      windowMaterial.emissiveIntensity = nightFactor * 1.15;
      const beamStrength = Math.min(1, nightFactor * 1.4);
      for (const lamp of headLights) {
        lamp.visible = headlightsEnabled;
        lamp.intensity = 4 + beamStrength * 240;
      }
      for (const beamMat of beamMaterials) {
        beamMat.opacity = beamStrength * 0.14;
      }

      // ── Crowds ──
      const peopleDelta = delta * eclipseReaction.movementScale;
      for (const crowd of crowds) {
        const dwellHere = state.kind === 'dwelling' && state.stop.label === crowd.stop.label;
        if (dwellHere && !crowd.wasDwelling) {
          startDwell(crowd, serviceMode === 'normal' ? 'normal' : serviceMode);
        }
        crowd.wasDwelling = dwellHere;
        for (const p of crowd.passengers) updatePassenger(p, crowd.colliders, peopleDelta);
      }
    },
    getPosition(target = new THREE.Vector3()) {
      return target.copy(group.position);
    },
    getDirection(target = new THREE.Vector3()) {
      return target.copy(forward);
    },
    getRouteProgress() {
      return leadT;
    },
    seekRouteProgress(progress) {
      leadT = wrap01(progress);
      currentSpeed = BASE_SPEED;
      state = { kind: 'cruising' };
      serviceMode = 'normal';
    },
    getCrossingState() {
      const toCrossing = forwardDelta(leadT, CROSSING_T) * ROUTE_LENGTH;
      return {
        held: crossingHeld,
        toCrossing,
        speed: currentSpeed,
        // Some part of the body is over the rails: measured from the bumpers, not the
        // centre, and true whether the crossing is just ahead or just behind.
        onCrossing:
          toCrossing < CROSSING_BODY_SPAN || toCrossing > ROUTE_LENGTH - CROSSING_BODY_SPAN,
      };
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
          atStop: passenger.atStop,
          colliding: !isPointClear(passenger.build.group.position, crowd.colliders),
          position: passenger.build.group.position.toArray() as [number, number, number],
          observingEclipse: eclipseReaction.attention > 0.5,
        }))
      );
    },
    getServiceDebugState() {
      return {
        mode: serviceMode,
        visible: group.visible,
        waitingPassengers: crowds.reduce(
          (sum, crowd) => sum + crowd.passengers.filter((passenger) => passenger.atStop).length,
          0
        ),
        remainingStops:
          serviceMode === 'final-loop'
            ? finalStopsRemaining.size
            : serviceMode === 'morning-release'
              ? morningStopsRemaining.size
              : 0,
      };
    },
    setCyberLook(factor) {
      cyberTrim.visible = factor > 0.01;
      // Ramped with the morph rather than switched, so the strips come up with the city.
      cyberTrimMaterial.emissiveIntensity = 1.6 * factor;
      cyberFactor = factor;
      bodyMaterial.color.lerpColors(BUS_BODY_NORMAL, BUS_BODY_CYBER, factor);
      roofMaterial.color.lerpColors(BUS_ROOF_NORMAL, BUS_ROOF_CYBER, factor);
      // Two different colours: the pane's own dark glass, and the warm interior that
      // lights up at night. Lerping the emissive from the glass colour made the night
      // bus glow dark blue instead of showing a lit interior.
      windowMaterial.color.lerpColors(BUS_GLASS_NORMAL, BUS_GLASS_CYBER, factor);
      windowMaterial.emissive.lerpColors(BUS_INTERIOR_LIT, BUS_GLASS_CYBER, factor);
    },
    setRoadWetness(wetness) {
      roadWetness = wetness;
    },
    setEclipseReaction(reaction) {
      eclipseReaction = reaction;
    },
    setHeadlightsEnabled(enabled) {
      headlightsEnabled = enabled;
      for (const lamp of headLights) lamp.visible = enabled;
    },
    dispose() {
      // Its own shader material is not in `materials`, so it releases itself.
      underGlow.dispose();
      scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && !SHARED_PASSENGER_GEOMETRY.has(child.geometry)) {
          child.geometry.dispose();
        }
      });
      for (const mat of materials) mat.dispose();
      for (const crowd of crowds) {
        for (const p of crowd.passengers) {
          scene.remove(p.build.group);
          p.build.group.traverse((child) => {
            if (child instanceof THREE.Mesh && !SHARED_PASSENGER_GEOMETRY.has(child.geometry)) {
              child.geometry.dispose();
            }
          });
          for (const mat of p.build.materials) mat.dispose();
        }
      }
    },
  };
}
