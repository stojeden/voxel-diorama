import * as THREE from 'three';
import { STATION_STOPS, TRAIN_ROUTE_CURVE, type StationStop } from './WorldLayout';
import {
  isPointClear,
  polylineLengths,
  samplePolyline,
  type CollisionRect,
} from './BusStopNavigation';
import { stationColliders, stationPassengerRoutes } from './StationNavigation';
import type { EclipseWorldReactionState } from '../experience/EclipseWorldReaction';
import { fallbackRandom, type RandomSource } from '../core/Random';

const JACKET_COLORS = [0x9c3838, 0x2b5f9a, 0x355d2a, 0xc4a35a, 0x6c4a8a, 0x444444, 0xb87333];
const SKIN_COLORS = [0xe8c39a, 0xd4a173, 0xa57448, 0xfcd7b6];
/**
 * Every figure in the city is built in oversized units and brought down by this.
 *
 * It was 0.78, which made an adult 1.915 m -- a 191 cm person, and it showed. Two things
 * in the world measured it for us: the bus's own doors are 1.86 m, so a passenger could
 * not fit through them, and the shelter roof at 2.28 m left 36 cm of headroom. Against
 * the 2.939 m bus the ratio was 1.53 where a real bus to a real adult is about 1.7.
 *
 * 0.71279 puts the finished figure at 1.75 m. The bus is untouched: it was the right
 * size all along.
 */
export const PASSENGER_SCALE = 0.71279;

type Activity = 'idle' | 'boarding' | 'disembarking';
export type EclipsePassengerPose = 'glasses' | 'projection' | 'watch';

interface Passenger {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  legs: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];

  /** Resting spot on the platform — where they wait between events. */
  platformPos: THREE.Vector3;
  /** Door-side spot (next to the train) — where boarding ends / disembarking begins. */
  boardingPos: THREE.Vector3;
  path: THREE.Vector3[];
  pathLengths: number[];
  pathLength: number;
  /** Walking-surface height for this passenger. */
  baseY: number;
  facingTrack: number;

  activity: Activity;
  progress: number;
  activityDuration: number;
  phase: number;
  currentOpacity: number;
  targetOpacity: number;
  eclipsePose: EclipsePassengerPose;
  /** Heading this figure began its sun turn from; null while the walk loop still owns the feet. */
  turnOrigin: number | null;
}

interface StationCrowd {
  station: StationStop;
  passengers: Passenger[];
  lastDwellSignal: boolean;
  visitCount: number;
  colliders: CollisionRect[];
}

function makeMat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    transparent: true,
    opacity: 0,
    ...opts,
  });
}

export interface PassengerBuild {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  legs: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
}

export function eclipsePassengerPoseFor(index: number): EclipsePassengerPose {
  return index % 3 === 0 ? 'glasses' : index % 3 === 1 ? 'projection' : 'watch';
}

/** Where the sun is, for anything in the world that has to look at it. */
export interface SunGaze {
  /** World bearing of the sun, `atan2(dir.x, dir.z)` — the repo's own "face this" idiom. */
  yaw: number;
  /** Sun elevation above the horizon, radians. */
  elevation: number;
}

/**
 * Read a gaze off the sun direction the sky already computes.
 *
 * `atan2(x, z)` and `asin(y)` and nothing else: the figures and the drawn disc must come
 * from the same vector or one of them is lying about where the eclipse is. The clamp is for
 * a direction that is a hair over unit length after normalisation, which `asin` answers with
 * NaN -- and a NaN yaw would spread silently through every figure's quaternion.
 */
export function sunGazeFrom(direction: THREE.Vector3): SunGaze {
  return {
    yaw: Math.atan2(direction.x, direction.z),
    elevation: Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)),
  };
}

/** One figure's share of that: the sun, plus where this figure stands and how far it has turned. */
export interface PassengerSunGaze extends SunGaze {
  /**
   * The yaw this figure turns FROM — its heading at the frame the turn began.
   *
   * Not the platform facing. It used to be, and the pose wrote `rotation.y = baseFacing + ...`
   * on every frame `attention` was up, AFTER the walk loop had already written
   * `atan2(dirX, dirZ)` from the actual step: a figure crossing the platform was stamped with
   * its static stop facing for the whole of the partial phase, moonwalking sideways down its
   * own path. Feed it `eclipseTurnOrigin`, which holds the figure's own heading from the
   * frame the turn started and hands back the live heading until then.
   */
  baseFacing: number;
  /** 0 while the crowd still walks, exactly 1 once it has frozen. Gates the body turn only. */
  bodyTurn: number;
}

/**
 * The strengths a pose is driven by — the same three numbers the props are drawn with.
 *
 * Structurally an `EclipseWorldReactionState`, so both call sites hand the pose the very
 * object `EclipseCrowdProps.update` is given. That identity is the point: the projection
 * cohort's turn-away used to run off `attention`, which is 1 through the whole of totality,
 * while the card it explains was faded out by `projection`, which is 0 there. Nine of
 * thirty-two figures therefore spent totality with their backs to the eclipse holding
 * nothing. One quantity per prop, read by the prop and by the pose, and they cannot part.
 */
export interface EclipsePoseDrive {
  attention: number;
  eyeProtection: number;
  projection: number;
}

/**
 * How far round the feet have come, from the freeze the crowd is already running.
 *
 * A body that turns while it is still walking moonwalks, so the turn has to be the freeze
 * read backwards — but `movementScale` bottoms at 0.04, so a raw `1 - movementScale` tops
 * out at 0.96 and every figure would stop 4% short of the sun and stay there. Dividing by
 * the same 0.96 the freeze is scaled by makes the two one number read twice: identically
 * zero until the crowd stops, exactly 1 once it has.
 */
export function eclipseBodyTurn(movementScale: number): number {
  return THREE.MathUtils.clamp((1 - movementScale) / 0.96, 0, 1);
}

/**
 * The heading a figure turns away from, remembered from the frame its turn began.
 *
 * `bodyTurn` is a ramp, not a switch — it is `freeze`, which climbs over coverage 0.82 to
 * 0.98, about eight seconds of the ninety — so the turn has to interpolate from a fixed
 * origin or it is not an interpolation at all. Reading the figure's live `rotation.y` as
 * that origin every frame would make the turn an exponential chase whose speed depends on
 * the frame rate; reading the stop's platform facing is the defect this replaces. So:
 * capture the heading once, on the frame the turn starts, and hold it until the turn is let
 * go. Null while `bodyTurn` is zero, which is also the signal that the walk loop still owns
 * the feet.
 */
export function eclipseTurnOrigin(
  remembered: number | null,
  bodyTurn: number,
  facingNow: number
): number | null {
  if (bodyTurn <= 0) return null;
  return remembered ?? facingNow;
}

/**
 * Sustained backward head tilt a standing person will actually hold, radians (25 degrees).
 *
 * ISO 11226 puts the acceptable head/neck inclination band at 0-25 degrees and sends
 * anything past it into a holding-time assessment; REBA and RULA both penalise the neck
 * beyond 20 degrees and flag extension as the bad direction. The shipped pose was a flat
 * -0.58 rad -- 33.2 degrees of extension held for the whole ninety seconds, above that
 * ceiling at every sun elevation there is, and at the staged eclipse it aimed the entire
 * crowd at empty sky 24 degrees over the sun's head. The injury has a name: "eclipse neck".
 */
const SUSTAINED_NECK_EXTENSION = 0.4363;

/**
 * How far the trunk leans back once the neck is at that ceiling, radians (25 degrees).
 *
 * Same standard one rung further on: past the neck's band a person leans, sits or reclines
 * rather than craning. It is exactly zero at the staged eclipse -- the sun is 8.8 degrees up
 * -- and exists so the model can never author a posture nobody would hold if the eclipse is
 * ever staged nearer noon, where the required gaze runs past what the neck alone can give.
 */
const SUSTAINED_TRUNK_LEAN = 0.4363;

/**
 * Comfortable axial neck rotation, radians (45 degrees). Past it the feet have to move.
 *
 * This is why a body turn exists at all rather than a neck term alone: at the staged
 * checkpoint the sun's bearing is -117 degrees, and it swings 51.5 degrees between seasons
 * at that same checkpoint, so no neck can reach it and no constant can stand in for it.
 */
const COMFORTABLE_NECK_TWIST = 0.785;

/** Head pitch of someone reading a pinhole image held in front of them, radians. */
const PROJECTION_HEAD_PITCH = 0.42;

const wrapPi = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * How much of the turned-away pinhole posture is in force, 0..1 — the card's own strength.
 *
 * A pinhole user stands with their BACK to the sun: the card is held up with the sun behind
 * them, the image falls on a surface in front, and they look DOWN at it
 * (AAS eye-safety/projection). All of which stops being true at second contact. The
 * photosphere is what makes a pinhole image, so with the photosphere gone there is no image
 * on the card and nothing to look down at -- and totality is the one moment in the ninety
 * seconds when it is safe to look straight at the sun with nothing in front of the eyes. So
 * the posture is the card: it leaves exactly as the card fades and returns with it at third
 * contact, which is why this reads `projection` and not `attention`.
 */
function projectionHold(pose: EclipsePassengerPose, drive: EclipsePoseDrive): number {
  return pose === 'projection' ? THREE.MathUtils.clamp(drive.projection, 0, 1) : 0;
}

function applySunGaze(
  passenger: PassengerBuild,
  pose: EclipsePassengerPose,
  drive: EclipsePoseDrive,
  gaze: PassengerSunGaze
): void {
  const attention = drive.attention;
  const hold = projectionHold(pose, drive);
  // One bearing for every cohort, because the only thing that differs is how far round from
  // the sun the figure stands: half a turn with the card up, none at all without it. Two
  // branches writing one rotation is how the projection cohort drifted away from its prop.
  //
  // The wrap is taken on `toSun` alone, which does not sweep -- the clock is locked for the
  // ninety seconds and `baseFacing` is captured when the turn begins -- and the half turn is
  // added outside it. Written the other way round, as `wrapPi(yaw + PI * hold - baseFacing)`,
  // the argument itself swept half a turn as the card left, crossed +/-PI, and `wrapPi` threw
  // it 2PI the other way: `headYaw` flipped sign, and the torso moved 86.56 degrees in a
  // single 16 ms frame for four of the seven stop facings in the fleet -- on the frame of the
  // diamond ring. The endpoint tests never saw it because they sample two static states and
  // assert the face-to-sun angle, which body and head cancel out of.
  const toSun = wrapPi(gaze.yaw - gaze.baseFacing);
  const halfTurn = toSun > 0 ? -Math.PI : Math.PI;
  const delta = toSun + halfTurn * hold;
  // The neck takes what it comfortably can and the feet carry the rest, so the two sum to
  // the sun's own bearing once both terms are full -- not to something near it. A figure
  // reading a card looks straight ahead at it, so its neck gives nothing until the card does.
  const headYaw =
    THREE.MathUtils.clamp(delta, -COMFORTABLE_NECK_TWIST, COMFORTABLE_NECK_TWIST) * (1 - hold);
  if (gaze.bodyTurn > 0) {
    // Guarded, because `rotation.y` belongs to the walk loop until the turn starts: the walk
    // wrote `atan2(dirX, dirZ)` from the figure's actual step a few lines earlier this frame,
    // and an unguarded write here stamped the stop's static facing over it for the whole
    // partial phase -- a figure walking north while facing east.
    passenger.group.rotation.y = gaze.baseFacing + (delta - headYaw) * gaze.bodyTurn;
  }
  passenger.head.rotation.y = THREE.MathUtils.lerp(passenger.head.rotation.y, headYaw, attention);

  const elevation = Math.max(gaze.elevation, 0);
  const skyward = -Math.min(elevation, SUSTAINED_NECK_EXTENSION);
  passenger.head.rotation.x = THREE.MathUtils.lerp(
    0,
    THREE.MathUtils.lerp(skyward, PROJECTION_HEAD_PITCH, hold),
    attention
  );
  // Nobody leans back to read a card in their hands, so the lean fades in with the card's
  // departure exactly as the skyward pitch does.
  passenger.group.rotation.x =
    -Math.min(Math.max(elevation - SUSTAINED_NECK_EXTENSION, 0), SUSTAINED_TRUNK_LEAN) *
    gaze.bodyTurn *
    (1 - hold);
}

export function applyPassengerEclipsePose(
  passenger: PassengerBuild,
  pose: EclipsePassengerPose,
  drive: EclipsePoseDrive,
  gaze?: PassengerSunGaze | null
): void {
  const attention = drive.attention;
  if (!gaze) {
    // No sun plumbed through: the shipped constant tilt, unchanged. Optional rather than
    // defaulted, so a caller that forgets the sun keeps the old pose instead of silently
    // gazing at a zero bearing on the horizon.
    passenger.head.rotation.x = THREE.MathUtils.lerp(0, -0.58, attention);
    passenger.group.rotation.x = 0;
  } else if (attention <= 0.001) {
    // Hand the figure back to the walk and idle loops with nothing of ours left on it.
    passenger.head.rotation.x = 0;
    passenger.group.rotation.x = 0;
  } else {
    applySunGaze(passenger, pose, drive, gaze);
  }
  if (attention <= 0.001) return;
  passenger.legs.rotation.x *= 1 - attention;
  // Each arm is driven by the prop it is holding, never by `attention`: a hand still pressing
  // a filter to its face through totality, or still offering a card the shader has faded to
  // nothing, is the same disagreement as the body yaw, one limb further out. Both quantities
  // fall to zero inside totality, which drops the arms and is what a real crowd does the
  // instant the glasses come off.
  if (pose === 'glasses') {
    passenger.rightArm.rotation.x = THREE.MathUtils.lerp(
      passenger.rightArm.rotation.x,
      -1.72,
      THREE.MathUtils.clamp(drive.eyeProtection, 0, 1)
    );
  } else if (pose === 'projection') {
    const hold = projectionHold(pose, drive);
    passenger.leftArm.rotation.x = THREE.MathUtils.lerp(
      passenger.leftArm.rotation.x,
      -1.18,
      hold
    );
    passenger.rightArm.rotation.x = THREE.MathUtils.lerp(
      passenger.rightArm.rotation.x,
      -1.18,
      hold
    );
  }
}

/**
 * The four shapes every voxel figure is made of, built once.
 *
 * There are thirty-four figures in the city -- twelve at the two station stops, twenty
 * across five bus stops at four waiting positions each, the fisherman and the farmer -- and
 * each used to build five fresh `BoxGeometry` of its own. That is 170 geometries drawn from
 * four distinct shapes, against a budget of 600, and the dimensions are literal constants:
 * nothing about a figure varies except its materials, which stay per-figure so the jackets
 * keep their colours. The two arms are the same box, so four shapes cover all five meshes.
 *
 * The same pattern is already used by `SHARED_GEOM` in `Train.ts`, `GULL_GEOMETRIES` in
 * `Birds.ts` and the playground's tubes.
 *
 * `PASSENGER_GEOMETRIES` must be skipped by per-figure teardown, which is what
 * `SHARED_PASSENGER_GEOMETRY` is for: seven places traverse a figure group and dispose
 * every mesh geometry they find, and with sharing the first of them would pull the shapes
 * out from under every figure still standing. `Birds.dispose` guards the same way.
 */
const PASSENGER_GEOMETRIES = {
  legs: new THREE.BoxGeometry(0.55, 0.9, 0.5),
  body: new THREE.BoxGeometry(0.7, 0.95, 0.5),
  head: new THREE.BoxGeometry(0.55, 0.55, 0.55),
  arm: new THREE.BoxGeometry(0.22, 0.85, 0.32),
} as const;

/** The shapes a per-figure teardown must leave alone. */
export const SHARED_PASSENGER_GEOMETRY: ReadonlySet<THREE.BufferGeometry> = new Set(
  Object.values(PASSENGER_GEOMETRIES)
);

/** Voxel-person builder — shared with the bus stop crowds. */
export function buildPassenger(random = fallbackRandom('passenger-build')): PassengerBuild {
  const group = new THREE.Group();
  group.scale.setScalar(PASSENGER_SCALE);
  /**
   * Yaw first, then pitch about the figure's own side-to-side axis.
   *
   * Both the head and the body now carry a yaw AND a pitch at once. Under the default 'XYZ'
   * the pitch is applied about the world X axis after the yaw, so a figure turned a quarter
   * turn would ROLL onto its ear instead of looking up. `Postman.ts:213` already sets 'YXZ'
   * for the same reason.
   */
  group.rotation.order = 'YXZ';
  const jacket = JACKET_COLORS[Math.floor(random() * JACKET_COLORS.length)];
  const skin = SKIN_COLORS[Math.floor(random() * SKIN_COLORS.length)];

  const jacketMat = makeMat(jacket);
  const skinMat = makeMat(skin, { roughness: 0.7 });
  const legsMat = makeMat(0x2a2a2a);

  const legs = new THREE.Mesh(PASSENGER_GEOMETRIES.legs, legsMat);
  legs.position.y = 0.45;
  legs.castShadow = false;
  group.add(legs);

  const body = new THREE.Mesh(PASSENGER_GEOMETRIES.body, jacketMat);
  body.position.y = 1.4;
  body.castShadow = false;
  group.add(body);

  const head = new THREE.Mesh(PASSENGER_GEOMETRIES.head, skinMat);
  head.name = 'passenger-head';
  head.rotation.order = 'YXZ';
  head.position.y = 2.18;
  head.castShadow = false;
  group.add(head);

  const leftArm = new THREE.Mesh(PASSENGER_GEOMETRIES.arm, jacketMat);
  leftArm.position.set(-0.45, 1.45, 0);
  leftArm.castShadow = false;
  group.add(leftArm);

  const rightArm = new THREE.Mesh(PASSENGER_GEOMETRIES.arm, jacketMat);
  rightArm.position.set(0.45, 1.45, 0);
  rightArm.castShadow = false;
  group.add(rightArm);

  return { group, body, head, legs, leftArm, rightArm, materials: [jacketMat, skinMat, legsMat] };
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class PassengerCrowd {
  private readonly random: RandomSource;
  private crowds: StationCrowd[] = [];
  private readonly scene: THREE.Scene;
  private clock = 0;
  private density = 1;
  private eclipseReaction: EclipseWorldReactionState = {
    attention: 0,
    movementScale: 1,
    eyeProtection: 0,
    projection: 0,
    dogAlert: 0,
  };
  private sunGaze: SunGaze | null = null;
  /** Refilled per figure per frame: thirty-two objects a frame is thirty-two too many. */
  private readonly gaze: PassengerSunGaze = { yaw: 0, elevation: 0, baseFacing: 0, bodyTurn: 0 };

  constructor(scene: THREE.Scene, random = fallbackRandom('station-crowd')) {
    this.random = random;
    this.scene = scene;
    for (const station of STATION_STOPS) {
      const platformCenter = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
      const tangent = TRAIN_ROUTE_CURVE.getTangentAt(station.centerT).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      // Walking surface: top of the platform slab.
      const baseY = Math.round(platformCenter.y) + 0.5;

      const count = 6;
      const passengers: Passenger[] = [];
      const routes = stationPassengerRoutes(station, count);
      const colliders = stationColliders(station);
      const facingTrack = Math.atan2(-normal.x, -normal.z);

      for (let i = 0; i < count; i++) {
        const route = routes[i];
        const platformPos = route.waitPosition;
        const boardingPos = route.boardingPosition;
        const pathMetrics = polylineLengths(route.path);

        const built = buildPassenger(random);
        const eclipsePose = eclipsePassengerPoseFor(i);
        built.group.name = `station-passenger-${station.label}-${i}`;
        // Stamped here so there is exactly one derivation of who is who. EclipseCrowdProps
        // used to re-derive the cohort as `index % 3 === 1` over its own name-sorted global
        // list while the pose came from this per-stop index: the two agree at the first stop
        // and diverge at every one after it, so cards hovered behind glasses wearers and
        // figures holding both arms up got nothing. One fact, stamped once, read twice.
        built.group.userData.eclipsePose = eclipsePose;
        built.group.position.copy(platformPos);
        built.group.rotation.y = facingTrack;
        scene.add(built.group);

        passengers.push({
          group: built.group,
          body: built.body,
          head: built.head,
          legs: built.legs,
          leftArm: built.leftArm,
          rightArm: built.rightArm,
          materials: built.materials,
          platformPos,
          boardingPos,
          path: route.path,
          pathLengths: pathMetrics.segments,
          pathLength: pathMetrics.total,
          baseY,
          facingTrack,
          activity: 'idle',
          progress: 0,
          activityDuration: 3 + random() * 2,
          phase: random() * Math.PI * 2,
          currentOpacity: 0,
          targetOpacity: 0.92,
          eclipsePose,
          turnOrigin: null,
        });
      }

      this.crowds.push({ station, passengers, lastDwellSignal: false, visitCount: 0, colliders });
    }
  }

  setDensity(density: number): void {
    this.density = THREE.MathUtils.clamp(density, 0, 1);
    for (const crowd of this.crowds) {
      const activeCount = Math.max(2, Math.round(crowd.passengers.length * this.density));
      for (let i = 0; i < crowd.passengers.length; i++) {
        crowd.passengers[i].group.visible = i < activeCount;
      }
    }
  }

  setEclipseReaction(reaction: EclipseWorldReactionState): void {
    this.eclipseReaction = reaction;
  }

  /**
   * Where the sun is, or null when there is no eclipse to watch.
   *
   * A setter rather than two more fields on `EclipseWorldReactionState`: that struct is
   * written out as an inline literal in three subsystems and six tests, and none of them
   * has anything to say about the sun.
   */
  setSunGaze(gaze: SunGaze | null): void {
    this.sunGaze = gaze;
  }

  update(delta: number, stationsBoarding: Set<string>): void {
    const peopleDelta = delta * this.eclipseReaction.movementScale;
    this.clock += peopleDelta;

    for (const crowd of this.crowds) {
      const isDwelling = stationsBoarding.has(crowd.station.label);

      if (isDwelling && !crowd.lastDwellSignal) {
        crowd.visitCount += 1;
        this.startDwellActivity(crowd);
      }
      if (!isDwelling && crowd.lastDwellSignal) {
        for (const p of crowd.passengers) {
          p.activity = 'idle';
          p.progress = 0;
          p.targetOpacity = 0.92;
          p.group.position.copy(p.platformPos);
          p.group.rotation.y = p.facingTrack;
        }
      }
      crowd.lastDwellSignal = isDwelling;

      for (const p of crowd.passengers) {
        if (p.group.visible) this.updatePassenger(p, crowd.colliders, peopleDelta);
      }
    }
  }

  private startDwellActivity(crowd: StationCrowd): void {
    const flipParity = crowd.visitCount % 2 === 0;
    for (let i = 0; i < crowd.passengers.length; i++) {
      const p = crowd.passengers[i];
      const boards = (i % 2 === 0) === flipParity;
      if (boards) {
        p.activity = 'boarding';
        p.progress = 0;
        p.activityDuration = 2.6 + this.random() * 0.8;
        p.currentOpacity = 0.92;
        p.targetOpacity = 0.92;
        p.group.position.copy(p.platformPos);
      } else {
        p.activity = 'disembarking';
        p.progress = 0;
        p.activityDuration = 2.6 + this.random() * 0.8;
        p.currentOpacity = 0;
        p.targetOpacity = 0.92;
        p.group.position.copy(p.boardingPos);
      }
    }
  }

  private updatePassenger(p: Passenger, colliders: readonly CollisionRect[], delta: number): void {
    if (p.activity === 'idle') {
      p.group.position.copy(p.platformPos);
      const sway = Math.sin(this.clock * 1.6 + p.phase) * 0.04;
      p.group.position.x += Math.cos(p.facingTrack) * sway * 0.4;
      p.group.position.z += Math.sin(p.facingTrack) * sway * 0.4;
      if (!isPointClear(p.group.position, colliders)) p.group.position.copy(p.platformPos);
      p.body.position.y = 1.4 + Math.sin(this.clock * 1.3 + p.phase) * 0.015;
      p.head.position.y = 2.18 + Math.sin(this.clock * 1.3 + p.phase) * 0.015;
      p.head.rotation.y = Math.sin(this.clock * 0.4 + p.phase * 2) * 0.4;
      p.leftArm.rotation.x = Math.sin(this.clock * 0.9 + p.phase) * 0.08;
      p.rightArm.rotation.x = -Math.sin(this.clock * 0.9 + p.phase) * 0.08;
      p.group.rotation.y = p.facingTrack;
      p.legs.rotation.x = 0;

      p.targetOpacity = 0.92;
    } else {
      p.progress = Math.min(1, p.progress + delta / p.activityDuration);
      const eased = easeInOut(p.progress);
      const pathProgress = p.activity === 'boarding' ? eased : 1 - eased;
      const previousX = p.group.position.x;
      const previousZ = p.group.position.z;
      samplePolyline(p.path, p.pathLengths, p.pathLength, pathProgress, p.group.position);
      if (!isPointClear(p.group.position, colliders)) {
        p.group.position.x = previousX;
        p.group.position.z = previousZ;
      }

      const stepBob = Math.abs(Math.sin(p.progress * Math.PI * 4)) * 0.06;
      p.group.position.y = p.baseY + stepBob;
      p.legs.rotation.x = Math.sin(p.progress * Math.PI * 4) * 0.25;
      p.leftArm.rotation.x = Math.sin(p.progress * Math.PI * 4) * 0.6;
      p.rightArm.rotation.x = -Math.sin(p.progress * Math.PI * 4) * 0.6;
      p.body.position.y = 1.4;
      p.head.position.y = 2.18;
      p.head.rotation.y = 0;

      const dirX = p.group.position.x - previousX;
      const dirZ = p.group.position.z - previousZ;
      if (dirX !== 0 || dirZ !== 0) {
        p.group.rotation.y = Math.atan2(dirX, dirZ);
      }

      if (p.activity === 'boarding') {
        p.targetOpacity = p.progress < 0.75 ? 0.92 : Math.max(0, 0.92 * (1 - (p.progress - 0.75) / 0.25));
      } else {
        p.targetOpacity = p.progress > 0.25 ? 0.92 : (p.progress / 0.25) * 0.92;
      }

      if (p.progress >= 1) {
        if (p.activity === 'boarding') {
          p.targetOpacity = 0;
        } else {
          p.activity = 'idle';
          p.progress = 0;
          p.group.position.copy(p.platformPos);
        }
      }
    }

    const lerp = 1 - Math.exp(-6 * Math.max(delta, 0.0001));
    p.currentOpacity += (p.targetOpacity - p.currentOpacity) * lerp;
    for (const mat of p.materials) mat.opacity = p.currentOpacity;
    // A figure faded to nothing is still drawn: the fade rides on `material.opacity`, and a
    // transparent mesh at zero opacity costs a colour draw and a normal-pass draw and
    // contributes not one photon. Five meshes per figure, and at a quiet moment most of the
    // twenty bus-stop figures are at zero -- measured at 24 draw calls in the opening
    // overview, against a 1400 budget that the owner's window reaches 1418 of.
    p.group.visible = p.currentOpacity > 0.01;
    let gaze: PassengerSunGaze | null = null;
    if (this.sunGaze) {
      const bodyTurn = eclipseBodyTurn(this.eclipseReaction.movementScale);
      p.turnOrigin = eclipseTurnOrigin(p.turnOrigin, bodyTurn, p.group.rotation.y);
      this.gaze.yaw = this.sunGaze.yaw;
      this.gaze.elevation = this.sunGaze.elevation;
      // The figure's own heading, not the platform's: `facingTrack` is where it rests, and a
      // figure halfway down its boarding path is not resting.
      this.gaze.baseFacing = p.turnOrigin ?? p.group.rotation.y;
      this.gaze.bodyTurn = bodyTurn;
      gaze = this.gaze;
    }
    applyPassengerEclipsePose(p, p.eclipsePose, this.eclipseReaction, gaze);
  }

  debugStartDwell(stationLabel: string): boolean {
    const crowd = this.crowds.find((candidate) => candidate.station.label === stationLabel);
    if (!crowd) return false;
    crowd.visitCount += 1;
    crowd.lastDwellSignal = false;
    this.startDwellActivity(crowd);
    return true;
  }

  getPassengerDebugState(): Array<{
    station: string;
    activity: Activity;
    colliding: boolean;
    position: [number, number, number];
    observingEclipse: boolean;
  }> {
    return this.crowds.flatMap((crowd) =>
      crowd.passengers.map((passenger) => ({
        station: crowd.station.label,
        activity: passenger.activity,
        colliding: !isPointClear(passenger.group.position, crowd.colliders),
        position: passenger.group.position.toArray() as [number, number, number],
        observingEclipse: this.eclipseReaction.attention > 0.5,
      }))
    );
  }

  dispose(): void {
    for (const crowd of this.crowds) {
      for (const p of crowd.passengers) {
        this.scene.remove(p.group);
        p.group.traverse((child) => {
          if (child instanceof THREE.Mesh && !SHARED_PASSENGER_GEOMETRY.has(child.geometry)) {
            child.geometry.dispose();
          }
        });
        for (const mat of p.materials) mat.dispose();
      }
    }
    this.crowds.length = 0;
  }
}
