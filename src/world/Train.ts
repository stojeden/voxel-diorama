import * as THREE from 'three';
import {
  COLORS,
  ROUTE_LENGTH,
  STATION_STOPS,
  TRACK_HALF_GAUGE,
  TRAIN_ROUTE_CURVE,
  wrapT,
  type StationStop,
} from './WorldLayout';
import { mergeStaticMeshes } from '../performance/mergeStaticMeshes';

/**
 * Train composition with realistic bogie-based track following.
 *
 * Each car has TWO bogies (trucks). Each bogie samples the route curve at its
 * own arc-length position; the car body interpolates between them. This gives
 * natural cornering — the body's heading is the chord between bogies, not the
 * tangent at a single point — which is how real rolling stock behaves.
 *
 * PORTAL: the route is an open curve whose two ends are buried deep inside
 * the west/east tunnels. Every car's arc-length parameter is wrapped mod 1
 * INDEPENDENTLY, so while the tail cars are still rolling into the east
 * tunnel the head cars are already emerging from the west one — the tunnels
 * behave like a pair of linked portals. A car is hidden only for the single
 * step where its own bogies straddle the seam (fully inside the tunnels).
 */

const BASE_SPEED_METERS_PER_S = 10;
const WHEEL_RADIUS = 0.42;
const RAIL_GAUGE = TRACK_HALF_GAUGE;
const AXLE_SPACING = 1.2;
const SPEED_LERP_RATE = 1.6; // 1/s — how fast actual speed chases target
/** Distance (meters of arc-length) before a station at which braking begins. */
const BRAKING_DISTANCE = 18;
/** Threshold speed (m/s) below which we consider the train "stopped". */
const STOP_SPEED_THRESHOLD = 0.25;
/** Distance after departure before the train re-arms station detection. */
const REARM_DISTANCE = 8;

type TrainState =
  | { kind: 'cruising' }
  | { kind: 'braking'; station: StationStop }
  | { kind: 'dwelling'; station: StationStop; timeLeft: number }
  | { kind: 'leaving'; station: StationStop; entryT: number };

export type TrainStateKind = 'cruising' | 'braking' | 'dwelling' | 'leaving';

export interface TrainPublicState {
  kind: TrainStateKind;
  stationLabel: string;
  dwellRemaining: number;
}

interface BogieRef {
  group: THREE.Group;
  wheelMeshes: THREE.Mesh[];
  /** Arc-length offset from the car centroid (positive = toward front). */
  offset: number;
}

interface CarRef {
  group: THREE.Group;
  bogies: [BogieRef, BogieRef];
  /** Arc-length offset from the leading car centroid (negative = trailing). */
  offset: number;
  length: number;
  doors?: PassengerCarBuild['doors'];
  doorOpenAmount: number;
}

const PASTEL_COLORS = {
  locomotive: 0x1f3a6e,
  locomotiveAccent: 0xcc2222,
  locomotiveDark: 0x14264a,
  passenger: 0xe8d7a5,
  passengerAccent: 0xa33a35,
  passengerDark: 0x6a5a3a,
  underframe: 0x1a1a1a,
  bogie: 0x2a2a2a,
  wheel: 0x141414,
  wheelHub: 0x6a6a6a,
  coupler: 0x383838,
  pantographMetal: 0x808080,
  headlight: 0xfff2c0,
  taillight: 0xcc2222,
} as const;

export type TrainLivery = 'modern' | 'retro' | 'industrial' | 'cyber';

interface LiveryPalette {
  locomotive: number;
  locomotiveAccent: number;
  locomotiveDark: number;
  passenger: number;
  passengerAccent: number;
  passengerDark: number;
}

const LIVERY_PALETTES: Record<TrainLivery, LiveryPalette> = {
  modern: {
    locomotive: 0x1f3a6e,
    locomotiveAccent: 0xcc2222,
    locomotiveDark: 0x14264a,
    passenger: 0xe8d7a5,
    passengerAccent: 0xa33a35,
    passengerDark: 0x6a5a3a,
  },
  retro: {
    locomotive: 0x2c5a2c,
    locomotiveAccent: 0xc4a35a,
    locomotiveDark: 0x1c3a1c,
    passenger: 0x7a6a3a,
    passengerAccent: 0x9c3838,
    passengerDark: 0x4a3a1c,
  },
  industrial: {
    locomotive: 0x444444,
    locomotiveAccent: 0xff7f24,
    locomotiveDark: 0x222222,
    passenger: 0x666666,
    passengerAccent: 0xff7f24,
    passengerDark: 0x333333,
  },
  // Sleek night express for the cyberpunk morph.
  cyber: {
    locomotive: 0x14181f,
    locomotiveAccent: 0x00e5ff,
    locomotiveDark: 0x0a0d12,
    passenger: 0x1b2027,
    passengerAccent: 0xff2da0,
    passengerDark: 0x10141a,
  },
};

type SharedMats = ReturnType<typeof buildSharedMaterials>;

function buildSharedMaterials() {
  const make = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.12, ...opts });

  const windowGlass = new THREE.MeshStandardMaterial({
    color: COLORS.windowLit,
    emissive: COLORS.windowLit,
    emissiveIntensity: 0.4,
    roughness: 0.1,
    metalness: 0.5,
  });
  windowGlass.envMapIntensity = 1.6;

  return {
    locomotive: make(PASTEL_COLORS.locomotive, { roughness: 0.45, metalness: 0.3 }),
    locomotiveAccent: make(PASTEL_COLORS.locomotiveAccent, { roughness: 0.4, metalness: 0.3 }),
    locomotiveDark: make(PASTEL_COLORS.locomotiveDark),
    passenger: make(PASTEL_COLORS.passenger, { roughness: 0.45, metalness: 0.25 }),
    passengerAccent: make(PASTEL_COLORS.passengerAccent, { roughness: 0.4, metalness: 0.3 }),
    passengerDark: make(PASTEL_COLORS.passengerDark),
    underframe: make(PASTEL_COLORS.underframe, { roughness: 0.85 }),
    bogie: make(PASTEL_COLORS.bogie, { roughness: 0.5, metalness: 0.55 }),
    wheel: make(PASTEL_COLORS.wheel, { roughness: 0.45, metalness: 0.7 }),
    wheelHub: make(PASTEL_COLORS.wheelHub, { roughness: 0.35, metalness: 0.85 }),
    coupler: make(PASTEL_COLORS.coupler, { roughness: 0.4, metalness: 0.75 }),
    pantograph: make(PASTEL_COLORS.pantographMetal, { roughness: 0.3, metalness: 0.9 }),
    windowLit: windowGlass,
    headlight: new THREE.MeshStandardMaterial({
      color: PASTEL_COLORS.headlight,
      emissive: PASTEL_COLORS.headlight,
      emissiveIntensity: 1.2,
      roughness: 0.3,
    }),
    taillight: new THREE.MeshStandardMaterial({
      color: PASTEL_COLORS.taillight,
      emissive: PASTEL_COLORS.taillight,
      emissiveIntensity: 0.8,
      roughness: 0.3,
    }),
  };
}

const SHARED_GEOM = {
  wheel: new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.22, 16),
  wheelHub: new THREE.CylinderGeometry(0.14, 0.14, 0.25, 12),
  coupler: new THREE.CylinderGeometry(0.09, 0.09, 0.6, 8),
};

function buildBogie(mats: SharedMats): BogieRef {
  const group = new THREE.Group();
  group.name = 'bogie';

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(RAIL_GAUGE * 2 + 0.3, 0.35, AXLE_SPACING + 0.6),
    mats.bogie
  );
  frame.position.y = WHEEL_RADIUS + 0.18;
  frame.castShadow = true;
  group.add(frame);

  for (const side of [-1, 1]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.3, AXLE_SPACING + 0.4), mats.bogie);
    beam.position.set(side * (RAIL_GAUGE - 0.05), WHEEL_RADIUS + 0.05, 0);
    beam.castShadow = true;
    group.add(beam);
  }

  const wheelMeshes: THREE.Mesh[] = [];
  for (const axleZ of [-AXLE_SPACING / 2, AXLE_SPACING / 2]) {
    const axle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, RAIL_GAUGE * 2 + 0.1, 8),
      mats.wheelHub
    );
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, WHEEL_RADIUS, axleZ);
    group.add(axle);

    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(SHARED_GEOM.wheel, mats.wheel);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * RAIL_GAUGE, WHEEL_RADIUS, axleZ);
      wheel.castShadow = true;
      wheelMeshes.push(wheel);
      group.add(wheel);

      const hub = new THREE.Mesh(SHARED_GEOM.wheelHub, mats.wheelHub);
      hub.rotation.z = Math.PI / 2;
      hub.position.set(side * (RAIL_GAUGE - 0.06), WHEEL_RADIUS, axleZ);
      group.add(hub);
    }
  }

  mergeStaticMeshes(group, new Set(wheelMeshes));
  return { group, wheelMeshes, offset: 0 };
}

interface LocomotiveBuild {
  group: THREE.Group;
  headLights: THREE.SpotLight[];
  /** Additive beam cones — opacity follows the night factor. */
  beamMaterials: THREE.MeshBasicMaterial[];
}

function buildLocomotive(mats: SharedMats, length: number): LocomotiveBuild {
  const group = new THREE.Group();
  const halfL = length / 2;
  const width = 2.4;
  const halfW = width / 2;
  const bodyHeight = 2.6;
  const floorY = WHEEL_RADIUS * 2 + 0.4;

  const underframe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.1, 0.25, length - 0.6), mats.underframe);
  underframe.position.set(0, floorY - 0.13, 0);
  underframe.castShadow = true;
  group.add(underframe);

  const cabinLen = length - 2.4;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, cabinLen), mats.locomotive);
  cabin.position.set(0, floorY + bodyHeight / 2, 0.6);
  cabin.castShadow = true;
  cabin.receiveShadow = true;
  group.add(cabin);

  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, cabinLen - 0.4), mats.locomotiveAccent);
    stripe.position.set(side * (halfW + 0.02), floorY + bodyHeight * 0.42, 0.6);
    group.add(stripe);
  }

  const winGeo = new THREE.BoxGeometry(0.06, 0.65, 0.8);
  const winCount = 4;
  for (const side of [-1, 1]) {
    for (let i = 0; i < winCount; i++) {
      const z = -cabinLen / 2 + 0.9 + i * ((cabinLen - 1.8) / (winCount - 1)) + 0.6;
      const win = new THREE.Mesh(winGeo, mats.windowLit);
      win.position.set(side * (halfW + 0.04), floorY + bodyHeight * 0.62, z);
      group.add(win);
    }
  }

  const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.4, 0.25, cabinLen - 1.0), mats.locomotiveDark);
  roof.position.set(0, floorY + bodyHeight + 0.12, 0.6);
  roof.castShadow = true;
  group.add(roof);

  // Pantograph
  const pantBase = new THREE.Mesh(new THREE.BoxGeometry(width - 0.8, 0.08, 0.9), mats.pantograph);
  pantBase.position.set(0, floorY + bodyHeight + 0.3, 0.4);
  group.add(pantBase);

  const armGeo = new THREE.BoxGeometry(0.06, 0.06, 1.1);
  for (const side of [-1, 1]) {
    const lowerArm = new THREE.Mesh(armGeo, mats.pantograph);
    lowerArm.position.set(side * 0.35, floorY + bodyHeight + 0.6, 0.05);
    lowerArm.rotation.x = -0.55;
    group.add(lowerArm);

    const upperArm = new THREE.Mesh(armGeo, mats.pantograph);
    upperArm.position.set(side * 0.35, floorY + bodyHeight + 1.0, 0.55);
    upperArm.rotation.x = 0.55;
    group.add(upperArm);
  }

  const pantHead = new THREE.Mesh(new THREE.BoxGeometry(width - 0.4, 0.05, 0.18), mats.pantograph);
  pantHead.position.set(0, floorY + bodyHeight + 1.32, 0.6);
  group.add(pantHead);

  // Sloped nose (-Z is the front because lookAt points -Z at the target).
  const noseLen = 2.0;
  const noseFrontZ = -halfL;
  const noseSteps = 3;
  for (let i = 0; i < noseSteps; i++) {
    const stepProgress = i / noseSteps;
    const stepHeight = bodyHeight * (1 - stepProgress * 0.55);
    const stepWidth = width * (1 - stepProgress * 0.2);
    const stepLen = noseLen / noseSteps;
    const stepZ = noseFrontZ + 0.6 + stepLen * (i + 0.5);
    const step = new THREE.Mesh(new THREE.BoxGeometry(stepWidth, stepHeight, stepLen), mats.locomotive);
    step.position.set(0, floorY + stepHeight / 2, stepZ);
    step.castShadow = true;
    group.add(step);
  }

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(width - 0.4, 0.9, 0.08), mats.windowLit);
  windshield.position.set(0, floorY + bodyHeight * 0.78, noseFrontZ + 0.85);
  windshield.rotation.x = 0.35;
  group.add(windshield);

  const headLights: THREE.SpotLight[] = [];
  const beamMaterials: THREE.MeshBasicMaterial[] = [];
  for (const side of [-1, 1]) {
    const lampMesh = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.12), mats.headlight);
    lampMesh.position.set(side * 0.6, floorY + 0.5, noseFrontZ + 0.62);
    group.add(lampMesh);

    // Physical-units spotlight that actually paints a pool on the track.
    const lamp = new THREE.SpotLight(PASTEL_COLORS.headlight, 0, 42, Math.PI / 6.5, 0.55, 1.6);
    lamp.position.set(side * 0.6, floorY + 0.5, noseFrontZ + 0.5);
    lamp.target.position.set(side * 0.6, floorY - 1.4, noseFrontZ - 16);
    group.add(lamp);
    group.add(lamp.target);
    headLights.push(lamp);

    // Visible additive beam cone, fading toward its tip.
    const beamMat = new THREE.MeshBasicMaterial({
      color: PASTEL_COLORS.headlight,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beamGeo = new THREE.ConeGeometry(1.5, 11, 14, 1, true);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    // Cone apex at the lamp, opening forward (-Z) and slightly down.
    beam.rotation.x = Math.PI / 2 - 0.08;
    beam.position.set(side * 0.6, floorY + 0.15, noseFrontZ - 5.2);
    group.add(beam);
    beamMaterials.push(beamMat);
  }

  const rearCoupler = new THREE.Mesh(SHARED_GEOM.coupler, mats.coupler);
  rearCoupler.rotation.x = Math.PI / 2;
  rearCoupler.position.set(0, floorY - 0.05, halfL + 0.05);
  group.add(rearCoupler);

  mergeStaticMeshes(group);
  return { group, headLights, beamMaterials };
}

interface PassengerCarBuild {
  group: THREE.Group;
  doors: Array<{ mesh: THREE.Mesh; closedZ: number; slideSign: number }>;
}

function buildPassengerCar(mats: SharedMats, length: number, accent: THREE.Material): PassengerCarBuild {
  const group = new THREE.Group();
  const halfL = length / 2;
  const width = 2.4;
  const halfW = width / 2;
  const bodyHeight = 2.5;
  const floorY = WHEEL_RADIUS * 2 + 0.4;

  const underframe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.1, 0.25, length - 0.6), mats.underframe);
  underframe.position.set(0, floorY - 0.13, 0);
  underframe.castShadow = true;
  group.add(underframe);

  const body = new THREE.Mesh(new THREE.BoxGeometry(width, bodyHeight, length - 0.4), mats.passenger);
  body.position.set(0, floorY + bodyHeight / 2, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(width + 0.12, 0.18, length - 0.6), mats.passengerDark);
  roof.position.set(0, floorY + bodyHeight + 0.09, 0);
  roof.castShadow = true;
  group.add(roof);

  for (const side of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, length - 0.8), accent);
    stripe.position.set(side * (halfW + 0.02), floorY + bodyHeight * 0.7, 0);
    group.add(stripe);
  }

  const winCount = 6;
  const winGeo = new THREE.BoxGeometry(0.06, 0.7, 0.85);
  const usableLen = length - 1.4;
  for (const side of [-1, 1]) {
    for (let i = 0; i < winCount; i++) {
      const t = i / (winCount - 1);
      const z = -usableLen / 2 + t * usableLen;
      const win = new THREE.Mesh(winGeo, mats.windowLit);
      win.position.set(side * (halfW + 0.04), floorY + bodyHeight * 0.48, z);
      group.add(win);
    }
  }

  const doorGeo = new THREE.BoxGeometry(0.08, bodyHeight * 0.85, 0.6);
  const doors: PassengerCarBuild['doors'] = [];
  for (const side of [-1, 1]) {
    for (const zSign of [-1, 1]) {
      for (const half of [-1, 1]) {
        const closedZ = zSign * (length / 2 - 1.1) + half * 0.3;
        const door = new THREE.Mesh(doorGeo, mats.passengerDark);
        door.position.set(side * (halfW + 0.04), floorY + bodyHeight * 0.45, closedZ);
        group.add(door);
        doors.push({ mesh: door, closedZ, slideSign: half });
      }
    }
  }

  for (const zSign of [-1, 1]) {
    const coupler = new THREE.Mesh(SHARED_GEOM.coupler, mats.coupler);
    coupler.rotation.x = Math.PI / 2;
    coupler.position.set(0, floorY - 0.05, zSign * (halfL + 0.05));
    group.add(coupler);
  }

  mergeStaticMeshes(group, new Set(doors.map((door) => door.mesh)));
  return { group, doors };
}

interface BuiltCar {
  group: THREE.Group;
  length: number;
  headLights?: THREE.SpotLight[];
  beamMaterials?: THREE.MeshBasicMaterial[];
  doors?: PassengerCarBuild['doors'];
}

interface BuildCarResult {
  car: CarRef;
  headLights?: THREE.SpotLight[];
}

function createCar(scene: THREE.Scene, mats: SharedMats, built: BuiltCar): BuildCarResult {
  const bogieSpacing = built.length * 0.55;
  const bogieFront = buildBogie(mats);
  bogieFront.offset = bogieSpacing / 2;
  const bogieRear = buildBogie(mats);
  bogieRear.offset = -bogieSpacing / 2;

  scene.add(bogieFront.group);
  scene.add(bogieRear.group);
  scene.add(built.group);

  return {
    car: {
      group: built.group,
      bogies: [bogieFront, bogieRear],
      offset: 0,
      length: built.length,
      doors: built.doors,
      doorOpenAmount: 0,
    },
    headLights: built.headLights,
  };
}

function sampleAt(t: number): THREE.Vector3 {
  return TRAIN_ROUTE_CURVE.getPointAt(wrapT(t));
}

const TMP_FORWARD = new THREE.Vector3();
const TMP_AHEAD = new THREE.Vector3();
const TMP_BACK = new THREE.Vector3();
const TMP_MID = new THREE.Vector3();
const TMP_BODY_FORWARD = new THREE.Vector3();

/**
 * Place a car body and its two bogies based on a single arc-length parameter
 * for the centroid. Returns false when the car straddles the portal seam
 * (it should be hidden — it's fully inside the tunnels at that moment).
 */
function placeCar(car: CarRef, centerT: number, elapsed: number, totalLength: number): boolean {
  const halfBogie = car.bogies[0].offset; // positive
  const dTBogie = halfBogie / totalLength;

  const tFront = wrapT(centerT + dTBogie);
  const tRear = wrapT(centerT - dTBogie);
  // Straddling the seam: front wrapped past 0 while rear is still near 1.
  if (tFront < tRear) return false;

  const frontPos = sampleAt(tFront);
  const rearPos = sampleAt(tRear);

  // Tiny ride-height breathing per bogie — kept very subtle.
  const frontBob = Math.sin(elapsed * 7.8 + tFront * 8) * 0.008;
  const rearBob = Math.sin(elapsed * 7.8 + tRear * 8) * 0.008;

  car.bogies[0].group.position.set(frontPos.x, frontPos.y + frontBob, frontPos.z);
  car.bogies[1].group.position.set(rearPos.x, rearPos.y + rearBob, rearPos.z);

  TMP_FORWARD.copy(TRAIN_ROUTE_CURVE.getTangentAt(tFront)).normalize();
  TMP_AHEAD.copy(car.bogies[0].group.position).addScaledVector(TMP_FORWARD, 1);
  car.bogies[0].group.lookAt(TMP_AHEAD);

  TMP_BACK.copy(TRAIN_ROUTE_CURVE.getTangentAt(tRear)).normalize();
  TMP_AHEAD.copy(car.bogies[1].group.position).addScaledVector(TMP_BACK, 1);
  car.bogies[1].group.lookAt(TMP_AHEAD);

  // Body sits at the midpoint, heading = chord from rear to front bogie.
  TMP_MID.copy(frontPos).add(rearPos).multiplyScalar(0.5);
  const routeMidPoint = sampleAt(centerT);
  const lateralWhip = Math.hypot(TMP_MID.x - routeMidPoint.x, TMP_MID.z - routeMidPoint.z);
  const bankAngle = Math.min(0.05, lateralWhip * 0.05);

  car.group.position.copy(TMP_MID);
  car.group.position.y += 0.02 + Math.sin(elapsed * 4.2 + centerT * 5) * 0.005;

  TMP_BODY_FORWARD.copy(frontPos).sub(rearPos);
  if (TMP_BODY_FORWARD.lengthSq() > 1e-6) {
    // Object3D.lookAt points the +Z axis at the target, but the car models
    // are built with their nose on -Z — so look BACKWARD to face forward.
    TMP_AHEAD.copy(car.group.position).sub(TMP_BODY_FORWARD);
    car.group.lookAt(TMP_AHEAD);
  }

  const rollSign = TMP_MID.x - routeMidPoint.x >= 0 ? 1 : -1;
  car.group.rotateZ(bankAngle * rollSign * -1);
  return true;
}

export interface TrainHandle {
  update: (delta: number, elapsed: number, nightFactor: number, speedMultiplier: number) => void;
  getPosition: (target?: THREE.Vector3) => THREE.Vector3;
  getDirection: (target?: THREE.Vector3) => THREE.Vector3;
  isGroundPointOccupied: (x: number, z: number, clearance?: number) => boolean;
  getSpeedFactor: () => number;
  getRouteProgress: () => number;
  getStationState: () => TrainPublicState;
  setLivery: (livery: TrainLivery) => void;
  dispose: () => void;
}

/** Signed forward arc-distance from `from` to `to` along the cyclic route. */
function shortestForwardDeltaT(from: number, to: number): number {
  let d = to - from;
  while (d < 0) d += 1;
  while (d >= 1) d -= 1;
  return d;
}

/**
 * The PASSENGER WAGONS (not the loco) must line up with the platform, so the
 * lead car overshoots the platform centre by the loco-to-wagon-centroid
 * distance: loco 7.5 m + gaps + 3×9 m wagons → wagon centroid ≈ 18.6 m
 * behind the lead car's centre.
 */
const WAGON_CENTROID_BEHIND_LEAD = 18.6;

/** T value where the leading car should actually stop for this station. */
function stopTForStation(station: StationStop): number {
  return wrapT(station.centerT + WAGON_CENTROID_BEHIND_LEAD / ROUTE_LENGTH);
}

/** Closest upcoming station along the forward direction. */
function pickNextStation(leadT: number): StationStop {
  let best = STATION_STOPS[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const station of STATION_STOPS) {
    const d = shortestForwardDeltaT(leadT, stopTForStation(station));
    if (d < bestDelta) {
      bestDelta = d;
      best = station;
    }
  }
  return best;
}

export function createTrain(scene: THREE.Scene): TrainHandle {
  const mats = buildSharedMaterials();

  // ─── Composition ───
  const locoBuild: BuiltCar = (() => {
    const length = 7.5;
    const { group, headLights, beamMaterials } = buildLocomotive(mats, length);
    return { group, length, headLights, beamMaterials };
  })();
  const wagonAccents = [mats.passengerAccent, mats.locomotiveAccent, mats.passengerAccent];
  const wagonBuilds: BuiltCar[] = wagonAccents.map((accent) => {
    const length = 9.0;
    const { group, doors } = buildPassengerCar(mats, length, accent);
    return { group, length, doors };
  });

  const allBuilds: BuiltCar[] = [locoBuild, ...wagonBuilds];

  const COUPLING_GAP = 0.7;
  const carRefs: CarRef[] = [];
  const builds: BuildCarResult[] = [];

  let cursorBehind = 0;
  for (let i = 0; i < allBuilds.length; i++) {
    const built = allBuilds[i];
    const result = createCar(scene, mats, built);
    if (i === 0) {
      result.car.offset = 0;
      cursorBehind = -built.length / 2 - COUPLING_GAP;
    } else {
      const centerOffset = cursorBehind - built.length / 2;
      result.car.offset = centerOffset;
      cursorBehind = centerOffset - built.length / 2 - COUPLING_GAP;
    }
    carRefs.push(result.car);
    builds.push(result);
  }

  const headLights = locoBuild.headLights ?? [];
  const headBeams = locoBuild.beamMaterials ?? [];

  // ─── Simulation state ───
  const totalLength = ROUTE_LENGTH;
  const firstStation = STATION_STOPS[0];
  let leadT = stopTForStation(firstStation);
  let currentSpeed = 0;
  let state: TrainState = {
    kind: 'dwelling',
    station: firstStation,
    timeLeft: firstStation.dwellSeconds,
  };

  return {
    update(delta, elapsed, nightFactor, speedMultiplier) {
      const cruiseTarget = BASE_SPEED_METERS_PER_S * speedMultiplier;

      // 1. Target speed by state.
      let targetSpeed = cruiseTarget;
      let distanceToBrakingTarget = Number.POSITIVE_INFINITY;

      if (state.kind === 'cruising') {
        const nextStation = pickNextStation(leadT);
        distanceToBrakingTarget =
          shortestForwardDeltaT(leadT, stopTForStation(nextStation)) * totalLength;
        // If we appear to be standing right on a station, treat it as a full
        // loop away — otherwise we'd snap to braking and never leave.
        if (distanceToBrakingTarget < 0.5) distanceToBrakingTarget += totalLength;
      } else if (state.kind === 'braking') {
        const remaining = shortestForwardDeltaT(leadT, stopTForStation(state.station)) * totalLength;
        distanceToBrakingTarget = remaining;
        const fraction = Math.min(1, Math.max(0, remaining / BRAKING_DISTANCE));
        targetSpeed = cruiseTarget * fraction * fraction;
      } else if (state.kind === 'dwelling') {
        targetSpeed = 0;
      } else if (state.kind === 'leaving') {
        targetSpeed = cruiseTarget;
      }

      // 2. Smooth speed lerp.
      const k = 1 - Math.exp(-SPEED_LERP_RATE * Math.max(delta, 0.0001));
      currentSpeed += (targetSpeed - currentSpeed) * k;
      if (state.kind === 'dwelling') currentSpeed = 0;

      // 3. Advance the lead position on the cyclic route.
      leadT = wrapT(leadT + (currentSpeed * delta) / totalLength);

      // 4. State transitions.
      if (state.kind === 'cruising' && distanceToBrakingTarget < BRAKING_DISTANCE) {
        state = { kind: 'braking', station: pickNextStation(leadT) };
      } else if (
        state.kind === 'braking' &&
        currentSpeed < STOP_SPEED_THRESHOLD &&
        shortestForwardDeltaT(leadT, stopTForStation(state.station)) * totalLength < 2.5
      ) {
        state = { kind: 'dwelling', station: state.station, timeLeft: state.station.dwellSeconds };
      } else if (state.kind === 'dwelling') {
        state.timeLeft -= delta;
        if (state.timeLeft <= 0) {
          state = { kind: 'leaving', station: state.station, entryT: leadT };
        }
      } else if (state.kind === 'leaving') {
        const movedMeters = shortestForwardDeltaT(state.entryT, leadT) * totalLength;
        if (movedMeters > REARM_DISTANCE) state = { kind: 'cruising' };
      }

      // 5. Place each car with PER-CAR portal wrapping. A car is hidden only
      // while its own bogies straddle the seam (inside the tunnels).
      for (const car of carRefs) {
        const centerT = wrapT(leadT + car.offset / totalLength);
        const placed = placeCar(car, centerT, elapsed, totalLength);
        car.group.visible = placed;
        car.bogies[0].group.visible = placed;
        car.bogies[1].group.visible = placed;
      }

      // 6. Spin wheels: ω = v / r.
      const wheelAngularDelta = (currentSpeed * delta) / WHEEL_RADIUS;
      for (const car of carRefs) {
        for (const bogie of car.bogies) {
          for (const wheel of bogie.wheelMeshes) {
            wheel.rotation.x += wheelAngularDelta;
          }
        }
      }

      // 6b. Doors slide open during dwell.
      const doorTarget = state.kind === 'dwelling' ? 1 : 0;
      const doorLerp = 1 - Math.exp(-3.5 * Math.max(delta, 0.0001));
      for (const car of carRefs) {
        if (!car.doors) continue;
        car.doorOpenAmount += (doorTarget - car.doorOpenAmount) * doorLerp;
        const slide = car.doorOpenAmount * 0.45;
        for (const door of car.doors) {
          door.mesh.position.z = door.closedZ + door.slideSign * slide;
        }
      }

      // 7. Headlights: bright pools on the track at night (physical units),
      // plus a faintly visible beam cone. A small base level keeps the lamps
      // alive at dusk.
      const beamStrength = Math.min(1, nightFactor * 1.4);
      for (const lamp of headLights) {
        lamp.intensity = 6 + beamStrength * 340;
      }
      for (const beamMat of headBeams) {
        beamMat.opacity = beamStrength * 0.16;
      }
    },
    getPosition(target = new THREE.Vector3()) {
      return target.copy(sampleAt(leadT));
    },
    getDirection(target = new THREE.Vector3()) {
      return target.copy(TRAIN_ROUTE_CURVE.getTangentAt(wrapT(leadT))).normalize();
    },
    isGroundPointOccupied(x, z, clearance = 4) {
      return carRefs.some(
        (car) =>
          car.group.visible &&
          car.group.position.y < 2.5 &&
          Math.hypot(car.group.position.x - x, car.group.position.z - z) < car.length / 2 + clearance
      );
    },
    getSpeedFactor() {
      return currentSpeed / BASE_SPEED_METERS_PER_S;
    },
    getRouteProgress() {
      return wrapT(leadT);
    },
    getStationState() {
      const label =
        state.kind === 'cruising' ? pickNextStation(leadT).label : state.station.label;
      return {
        kind: state.kind,
        stationLabel: label,
        dwellRemaining: state.kind === 'dwelling' ? Math.max(0, state.timeLeft) : 0,
      };
    },
    setLivery(livery) {
      const palette = LIVERY_PALETTES[livery];
      mats.locomotive.color.setHex(palette.locomotive);
      mats.locomotiveAccent.color.setHex(palette.locomotiveAccent);
      mats.locomotiveDark.color.setHex(palette.locomotiveDark);
      mats.passenger.color.setHex(palette.passenger);
      mats.passengerAccent.color.setHex(palette.passengerAccent);
      mats.passengerDark.color.setHex(palette.passengerDark);
    },
    dispose() {
      for (const car of carRefs) {
        scene.remove(car.group);
        scene.remove(car.bogies[0].group);
        scene.remove(car.bogies[1].group);
      }
      SHARED_GEOM.wheel.dispose();
      SHARED_GEOM.wheelHub.dispose();
      SHARED_GEOM.coupler.dispose();
      for (const mat of Object.values(mats)) mat.dispose();
    },
  };
}
