import * as THREE from 'three';
import {
  BLOCK_CONFIGS,
  COLORS,
  LAKE,
  WORLD_HALF_SIZE,
  type BlockConfig,
} from './WorldLayout';
import { mergeStaticMeshes } from '../performance/mergeStaticMeshes';
import { fallbackRandom, type RandomSource } from '../core/Random';
import { advanceFoldedness, applyWingFold, foldednessTarget, wingFoldPose } from './WingFold';
import type { Radians } from '../units';

/**
 * Seagulls with believable flight: they steer smoothly toward wandering
 * targets (with a bias toward the lake), bank into turns, and alternate
 * between flapping bursts and long glides — instead of orbiting on rails
 * with constant wing-flapping.
 */

const GULL_COUNT = 11;

/**
 * A roof a gull can stand on and must fly over, whatever city drew it.
 *
 * Gulls read their roofs from `BLOCK_CONFIGS`, the voxel world's blocks -- while the city that
 * ships is the hybrid one, with other buildings on the same plots: roosting gulls hung up to
 * 3.3 m over walkup and slab roofs, one sat half a metre inside a slab, and the three point
 * towers (27.5 m with a 2.8 m machine room) stood where the gulls' flight floor was 18 m.
 * The city that is drawn hands its roofs over with `Birds.setRoofs`; the voxel blocks are only
 * the default until it does.
 */
export interface GullRoof {
  /** Footprint, world metres. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Height of the surface a gull stands on at a point of the footprint: slope, ridge, deck. */
  surfaceAt(x: number, z: number): number;
  /** The highest solid point, for flight clearance -- a ridge, a machine room. */
  peak: number;
  /** What stands on the roof and must not have a gull inside it: stair houses, machine rooms. */
  obstacles?: readonly { minX: number; maxX: number; minZ: number; maxZ: number }[];
}

/** Clear of every obstacle on the roof, with room for a gull's body round the point. */
function perchIsClear(roof: GullRoof, x: number, z: number): boolean {
  const margin = 0.45;
  for (const box of roof.obstacles ?? []) {
    if (x > box.minX - margin && x < box.maxX + margin && z > box.minZ - margin && z < box.maxZ + margin) {
      return false;
    }
  }
  return true;
}

/**
 * A perch on this roof: the preferred point if it is clear, otherwise one of the roof's clear
 * points picked by the seed -- deterministic, so a gull goes back to the same spot.
 *
 * A grid rather than a run of random tries: a point tower's deck is mostly machine room and
 * stair house, and twelve tries still left one gull in fifty inside a wall.
 */
function perchOn(roof: GullRoof, x: number, z: number, seed: number, out: THREE.Vector3): THREE.Vector3 {
  if (perchIsClear(roof, x, z)) return out.set(x, 0, z);
  const inset = 0.6;
  const cells = 9;
  let clear = 0;
  const pick = (index: number | null): boolean => {
    let n = 0;
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        const px = THREE.MathUtils.lerp(roof.minX + inset, roof.maxX - inset, i / (cells - 1));
        const pz = THREE.MathUtils.lerp(roof.minZ + inset, roof.maxZ - inset, j / (cells - 1));
        if (!perchIsClear(roof, px, pz)) continue;
        if (index === n) {
          out.set(px, 0, pz);
          return true;
        }
        n += 1;
      }
    }
    clear = n;
    return false;
  };
  pick(null);
  if (clear === 0) return out.set(x, 0, z);
  pick(Math.floor(deterministicUnit(seed) * clear));
  return out;
}

/** The voxel world's blocks as roofs: flat, the top of the highest voxel layer. */
export function voxelRoofs(blocks: readonly BlockConfig[] = BLOCK_CONFIGS): GullRoof[] {
  return blocks.map((block) => {
    // Layers 0..h-1 are centred on whole metres, so the top face is at h - 0.5.
    const top = block.h - 0.5;
    return {
      minX: block.x,
      maxX: block.x + block.w - 1,
      minZ: block.z,
      maxZ: block.z + block.d - 1,
      surfaceAt: () => top,
      peak: top,
    };
  });
}

const VOXEL_ROOFS = voxelRoofs();

/** The gull body: a sphere of this radius, squashed vertically by this much. */
const GULL_BODY_RADIUS = 0.34;
const GULL_BODY_SCALE_Y = 0.78;
/**
 * How far above the roof a sitting gull's origin is, at unit scale: the underside of its body.
 * It sat at a fixed 0.55 over the top, which was the height a voxel block's `h` put the roof
 * at rather than where the roof is -- a metre in the air over the voxel city.
 */
export const GULL_SEAT = GULL_BODY_RADIUS * GULL_BODY_SCALE_Y;
const MIN_ALTITUDE = 13;
const MAX_ALTITUDE = 27;
const BUILDING_AVOIDANCE_BUFFER = 3;
const MAX_TURN_RATE = 0.65; // rad/s
const CLIMB_RATE = 2.2; // m/s
export const ECLIPSE_ROOST_COVERAGE = 0.85;
export const ECLIPSE_TAKE_OFF_COVERAGE = 0.65;

/**
 * How close to its roost a gull has to be before it lets go of the local ceiling and comes
 * down to the roof's own height.
 *
 * It is *not* when the wings start to fold, though it used to be, on the grounds that these
 * were one event. They are not: the last 6 m are flown, and the rig's own landing law floors
 * at 0.7 m/s, so they take about 4.2 s. A gull with 6 m to go is on final approach, wings
 * out. See `WingFold.foldednessTarget`.
 */
const LANDING_APPROACH_DISTANCE = 6;

/** How far above its roof a gull climbs before it stops taking off and starts flying. */
const TAKE_OFF_CLEARANCE = 5.5;

/** The dihedral a settled gull holds -- a hint of a V -- as the right wing's `rotation.z`. */
export const ROOST_DIHEDRAL = 0.05 as Radians;

type WingMode = 'flap' | 'glide';
type LifeMode = 'fly' | 'toRoost' | 'roost' | 'takeOff';
type RoostReason = 'night' | 'eclipse' | null;
export type EclipseCoverageDirection = 'increasing' | 'decreasing';

/**
 * Eclipse roost hysteresis. A gull commits only on the incoming phase and
 * remains committed through totality until daylight has clearly returned.
 */
export function eclipseRoostRequested(
  wasRequested: boolean,
  coverage: number,
  direction: EclipseCoverageDirection
): boolean {
  if (!Number.isFinite(coverage)) return wasRequested;
  if (direction === 'increasing' && coverage >= ECLIPSE_ROOST_COVERAGE) return true;
  if (direction === 'decreasing' && coverage <= ECLIPSE_TAKE_OFF_COVERAGE) return false;
  return wasRequested;
}

/**
 * Which way the eclipse is going, as the roost latch needs to hear it.
 *
 * An eclipse that is not running is on its way out, whatever its progress reads. Reading the
 * direction off progress alone kept the latch shut after a rewind: starting the tour in the
 * middle of totality seeks the timeline to zero, coverage 0 at progress 0 reads as the
 * *incoming* phase, and every gull stayed on its eclipse roof through the night, the dawn and
 * the days after, until some later eclipse happened to release it.
 */
export function eclipseDirectionFor(active: boolean, progress: number): EclipseCoverageDirection {
  return active && progress < 0.5 ? 'increasing' : 'decreasing';
}

const GULL_GEOMETRIES = {
  body: new THREE.SphereGeometry(GULL_BODY_RADIUS, 8, 6),
  belly: new THREE.SphereGeometry(0.24, 8, 6),
  beak: new THREE.ConeGeometry(0.08, 0.24, 4),
  wing: new THREE.BoxGeometry(0.62, 0.08, 0.2),
};

const GULL_MATERIALS = {
  body: new THREE.MeshStandardMaterial({ color: 0xf2ead5, roughness: 0.68 }),
  belly: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 }),
  wing: new THREE.MeshStandardMaterial({ color: 0xd9d0bb, roughness: 0.76 }),
  beak: new THREE.MeshStandardMaterial({ color: COLORS.carYellow, roughness: 0.65 }),
};

interface Gull {
  group: THREE.Group;
  leftWing: THREE.Group;
  rightWing: THREE.Group;
  position: THREE.Vector3;
  heading: number;
  speed: number;
  target: THREE.Vector3;
  altitudeTarget: number;
  wingMode: WingMode;
  modeTimeLeft: number;
  bank: number;
  phase: number;
  lifeMode: LifeMode;
  roostReason: RoostReason;
  nightRoost: THREE.Vector3;
  activeRoost: THREE.Vector3;
  /** This bird's own `GULL_SEAT`: its scale varies, and so does how high its belly is. */
  seat: number;
  takeOffClearanceY: number;
  /** 0 spread, 1 folded against the flank. Continuous: see `WingFold.ts`. */
  foldedness: number;
}

/**
 * The pose of a settled gull, and the only place it is written.
 *
 * There used to be two copies of this, identical literals in two branches -- and the second
 * was already dead, because the frame that landed a gull went on to overwrite it with the
 * flight pose four lines later. One term now, called from both places, and the caller that
 * used to be clobbered no longer is.
 */
function applyRoostWingPose(gull: Gull): void {
  gull.leftWing.rotation.z = -ROOST_DIHEDRAL;
  gull.rightWing.rotation.z = ROOST_DIHEDRAL;
  applyWingFold(gull.leftWing, gull.rightWing, wingFoldPose(gull.foldedness));
}

/**
 * Leaves a roost for open flight: the one take-off, and the only way into `takeOff`.
 *
 * NOT the only way off a perch, and the difference is worth knowing. A gull that is already
 * roosting can also be sent straight to `toRoost` -- when an eclipse begins while it sleeps,
 * and when night falls on one that roosted for the eclipse. Those are transfers from one roof
 * to another, not take-offs, and they leave the perch with the wings still mostly shut
 * (measured: 0.82 folded on the first frame). That is fine rather than a defect, because
 * `openness` scales thrust and climb: a bird 82 per cent folded pushes off at 18 per cent and
 * is airborne properly by the time it has opened. What it is not is a take-off, and an earlier
 * draft of this comment claimed it could not happen.
 *
 * Both exits used to be written out longhand, except that the dawn one was not written at all
 * -- it set `lifeMode = 'fly'` and let the flight branch have the bird at full cruise speed on
 * the very next frame with its wings still shut. Dawn is the commonest exit by far, so the
 * half of the request that is "rozwijają je do lotu, jak startują" -- they open them for
 * flight, as they take off -- was the half that almost never happened. One function now, so
 * the take-off cannot be missing from a path again: climb to clearance, on a heading straight
 * ahead, and (see `update`) push off only as hard as the wings are open.
 */
function beginTakeOff(gull: Gull): void {
  gull.roostReason = null;
  gull.lifeMode = 'takeOff';
  gull.takeOffClearanceY = Math.max(MIN_ALTITUDE, gull.activeRoost.y + TAKE_OFF_CLEARANCE);
  gull.altitudeTarget = gull.takeOffClearanceY;
  gull.target.set(
    gull.position.x + Math.sin(gull.heading) * 8,
    0,
    gull.position.z + Math.cos(gull.heading) * 8
  );
}

/** A cruising gull predicts its own track 3 m at a time, this many steps: 48 m ahead. */
const LOOKAHEAD_STEP = 3;
const LOOKAHEAD_STEPS = 16;

/**
 * The height a gull must already be at NOW to clear what lies on its way, in time.
 *
 * The floor used to be read only within 6 m of where the gull was, and it climbs at
 * 2.2 m/s: a gull cruising at 20 m towards a 27.5 m point tower learned about it a second
 * and a half before impact and flew in -- about a hundred gull-seconds inside buildings every
 * twenty minutes. A straight line along the heading was not enough either: most of what was
 * left were gulls TURNING onto a tower, which a line pointing the old way never saw.
 *
 * So the track is predicted the way the gull will actually fly it -- turning towards its
 * target at its own turn rate, drifting with the wind -- and at each point the requirement is
 * the roof's clearance less the climb it can still make before getting there. It starts
 * climbing exactly as early as its wings need, and no earlier.
 */
function clearanceAhead(
  gull: Pick<Gull, 'position' | 'heading' | 'target'>,
  cruise: number,
  drift: number,
  climbRate: number,
  roofs: readonly GullRoof[]
): number {
  if (cruise < 1e-6) return 0;
  let x = gull.position.x;
  let z = gull.position.z;
  let heading = gull.heading;
  const dt = LOOKAHEAD_STEP / cruise;
  let need = 0;
  for (let step = 1; step <= LOOKAHEAD_STEPS; step++) {
    let error = Math.atan2(gull.target.x - x, gull.target.z - z) - heading;
    while (error > Math.PI) error -= Math.PI * 2;
    while (error < -Math.PI) error += Math.PI * 2;
    heading += THREE.MathUtils.clamp(error, -MAX_TURN_RATE * dt, MAX_TURN_RATE * dt);
    x += (Math.sin(heading) * cruise + drift) * dt;
    z += Math.cos(heading) * cruise * dt;
    const climbable = climbRate * dt * step;
    for (const roof of roofs) {
      if (x < roof.minX - 2 || x > roof.maxX + 2 || z < roof.minZ - 2 || z > roof.maxZ + 2) continue;
      need = Math.max(need, roof.peak + BUILDING_AVOIDANCE_BUFFER - climbable);
    }
  }
  return need;
}

function maxBuildingHeightNear(
  x: number,
  z: number,
  radius: number,
  roofs: readonly GullRoof[]
): number {
  let maxH = 0;
  for (const roof of roofs) {
    const dx = Math.max(roof.minX - x, 0, x - roof.maxX);
    const dz = Math.max(roof.minZ - z, 0, z - roof.maxZ);
    if (Math.hypot(dx, dz) < radius && roof.peak > maxH) maxH = roof.peak;
  }
  return maxH;
}

export function createWing(side: -1 | 1): THREE.Group {
  const wing = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const segment = new THREE.Mesh(GULL_GEOMETRIES.wing, GULL_MATERIALS.wing);
    segment.position.set(side * (0.38 + i * 0.46), 0, 0.06 + i * 0.08);
    segment.rotation.z = side * (0.08 + i * 0.1);
    segment.rotation.y = side * 0.14;
    segment.scale.set(1 - i * 0.12, 1, 1);
    wing.add(segment);
  }
  mergeStaticMeshes(wing);
  return wing;
}

function createGullMesh(): { group: THREE.Group; leftWing: THREE.Group; rightWing: THREE.Group } {
  const group = new THREE.Group();
  const body = new THREE.Mesh(GULL_GEOMETRIES.body, GULL_MATERIALS.body);
  body.scale.set(0.95, GULL_BODY_SCALE_Y, 1.08);
  group.add(body);

  const belly = new THREE.Mesh(GULL_GEOMETRIES.belly, GULL_MATERIALS.belly);
  belly.position.set(0, -0.08, -0.05);
  belly.scale.set(0.9, 0.55, 0.72);
  group.add(belly);

  const head = new THREE.Mesh(GULL_GEOMETRIES.body, GULL_MATERIALS.body);
  head.position.set(0, 0.08, -0.42);
  head.scale.setScalar(0.53);
  group.add(head);

  const beak = new THREE.Mesh(GULL_GEOMETRIES.beak, GULL_MATERIALS.beak);
  beak.position.set(0, 0.08, -0.62);
  beak.rotation.x = -Math.PI / 2;
  group.add(beak);

  const leftWing = createWing(-1);
  const rightWing = createWing(1);
  leftWing.position.set(-0.18, 0.02, -0.03);
  rightWing.position.set(0.18, 0.02, -0.03);
  group.add(leftWing, rightWing);
  mergeStaticMeshes(group);

  return { group, leftWing, rightWing };
}

function pickTarget(out: THREE.Vector3, random: RandomSource): void {
  // Gulls love the lake — bias targets toward it.
  if (random() < 0.35) {
    out.set(
      LAKE.x + (random() - 0.5) * LAKE.radiusX * 2.4,
      0,
      LAKE.z + (random() - 0.5) * LAKE.radiusZ * 2.4
    );
  } else {
    out.set(
      (random() - 0.5) * 2 * (WORLD_HALF_SIZE - 10),
      0,
      (random() - 0.5) * 2 * (WORLD_HALF_SIZE - 10)
    );
  }
}

function roostSpotFor(index: number, roofs: readonly GullRoof[], seat: number): THREE.Vector3 {
  // Most gulls sleep on rooftops, a couple at the lake shore.
  if (index % 4 === 3) {
    const angle = (index / GULL_COUNT) * Math.PI * 2;
    return new THREE.Vector3(
      LAKE.x + Math.cos(angle) * (LAKE.radiusX + 2),
      0.4,
      LAKE.z + Math.sin(angle) * (LAKE.radiusZ + 2)
    );
  }
  const roof = roofs[(index * 7) % roofs.length];
  const spot = perchOn(
    roof,
    THREE.MathUtils.clamp((roof.minX + roof.maxX) / 2 + (index % 3) - 1, roof.minX, roof.maxX),
    (roof.minZ + roof.maxZ) / 2,
    (index + 1) * 2654435761,
    new THREE.Vector3()
  );
  spot.y = roof.surfaceAt(spot.x, spot.z) + seat;
  return spot;
}

function deterministicUnit(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function roofCoordinate(min: number, max: number, seed: number): number {
  const extent = Math.max(0, max - min);
  const margin = Math.min(1.25, extent * 0.3);
  return min + margin + deterministicUnit(seed) * Math.max(0, extent - margin * 2);
}

/** Selects a stable, spread-out point on the nearest roof for this gull. */
export function nearestEclipseRoost(
  position: Pick<THREE.Vector3, 'x' | 'z'>,
  gullIndex: number,
  roofs: readonly GullRoof[] = VOXEL_ROOFS,
  seat: number = GULL_SEAT
): THREE.Vector3 {
  if (roofs.length === 0) throw new Error('Cannot select an eclipse roost without buildings');

  let nearest = roofs[0];
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let roofIndex = 0; roofIndex < roofs.length; roofIndex++) {
    const roof = roofs[roofIndex];
    const closestX = THREE.MathUtils.clamp(position.x, roof.minX, roof.maxX);
    const closestZ = THREE.MathUtils.clamp(position.z, roof.minZ, roof.maxZ);
    const distance = (closestX - position.x) ** 2 + (closestZ - position.z) ** 2;
    if (distance < nearestDistance) {
      nearest = roof;
      nearestIndex = roofIndex;
      nearestDistance = distance;
    }
  }

  const seed = (gullIndex + 1) * 73856093 ^ (nearestIndex + 1) * 19349663;
  const spot = perchOn(
    nearest,
    roofCoordinate(nearest.minX, nearest.maxX, seed),
    roofCoordinate(nearest.minZ, nearest.maxZ, seed ^ 0x9e3779b9),
    seed,
    new THREE.Vector3()
  );
  spot.y = nearest.surfaceAt(spot.x, spot.z) + seat;
  return spot;
}

export class Birds {
  private readonly random: RandomSource;
  private gulls: Gull[] = [];
  private readonly scene: THREE.Scene;
  private hidden = false;
  /** Voxel blocks until the drawn city hands over its own: see `GullRoof`. */
  private roofs: readonly GullRoof[] = VOXEL_ROOFS;
  private activeCount = GULL_COUNT;
  private eclipseRoostActive = false;

  /**
   * Supplies the physical eclipse state independently from the day/night light.
   * Call on every eclipse frame so threshold crossings remain deterministic.
   */
  setEclipseState(coverage: number, direction: EclipseCoverageDirection): void {
    const normalizedCoverage = Number.isFinite(coverage)
      ? THREE.MathUtils.clamp(coverage, 0, 1)
      : coverage;
    this.eclipseRoostActive = eclipseRoostRequested(
      this.eclipseRoostActive,
      normalizedCoverage,
      direction
    );
  }

  /** Cyberpunk: no gulls over the megacity. */
  /**
   * The roofs of the city that is actually drawn. Called once the hybrid city has built.
   *
   * Every night roost is re-derived; a gull already on its way to one, or sitting on one,
   * flies to the new spot rather than being put there, because this lands a moment after
   * boot, when the viewer may already be looking.
   */
  setRoofs(roofs: readonly GullRoof[]): void {
    if (roofs.length === 0) return;
    this.roofs = roofs;
    this.gulls.forEach((gull, index) => {
      gull.nightRoost.copy(roostSpotFor(index, roofs, gull.seat));
      if (gull.roostReason === 'night') gull.activeRoost.copy(gull.nightRoost);
      else if (gull.roostReason === 'eclipse') {
        gull.activeRoost.copy(nearestEclipseRoost(gull.position, index, roofs, gull.seat));
      } else return;
      if (gull.lifeMode === 'roost') gull.lifeMode = 'toRoost';
      gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
    });
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.syncVisibility();
  }

  setDensity(density: number): void {
    this.activeCount = Math.max(3, Math.round(GULL_COUNT * THREE.MathUtils.clamp(density, 0, 1)));
    this.syncVisibility();
  }

  private syncVisibility(): void {
    for (let i = 0; i < this.gulls.length; i++) {
      this.gulls[i].group.visible = !this.hidden && i < this.activeCount;
    }
  }

  constructor(scene: THREE.Scene, random = fallbackRandom('birds')) {
    this.scene = scene;
    this.random = random;

    for (let i = 0; i < GULL_COUNT; i++) {
      const mesh = createGullMesh();
      mesh.group.scale.setScalar(0.85 + random() * 0.35);
      scene.add(mesh.group);
      const seat = GULL_SEAT * mesh.group.scale.y;

      const target = new THREE.Vector3();
      pickTarget(target, random);

      const nightRoost = roostSpotFor(i, this.roofs, seat);
      this.gulls.push({
        group: mesh.group,
        leftWing: mesh.leftWing,
        rightWing: mesh.rightWing,
        position: new THREE.Vector3(
          (random() - 0.5) * 2 * (WORLD_HALF_SIZE - 20),
          MIN_ALTITUDE + random() * (MAX_ALTITUDE - MIN_ALTITUDE),
          (random() - 0.5) * 2 * (WORLD_HALF_SIZE - 20)
        ),
        heading: random() * Math.PI * 2,
        speed: 4.2 + random() * 2.4,
        target,
        altitudeTarget: MIN_ALTITUDE + random() * (MAX_ALTITUDE - MIN_ALTITUDE),
        wingMode: random() > 0.5 ? 'glide' : 'flap',
        modeTimeLeft: 1 + random() * 3,
        bank: 0,
        phase: random() * Math.PI * 2,
        lifeMode: 'fly',
        roostReason: null,
        nightRoost,
        activeRoost: nightRoost.clone(),
        seat,
        takeOffClearanceY: MIN_ALTITUDE,
        foldedness: 0,
      });
    }
  }

  update(delta: number, elapsed: number, wind: number, night: number): void {
    if (this.hidden) return;
    for (let gullIndex = 0; gullIndex < this.activeCount; gullIndex++) {
      const gull = this.gulls[gullIndex];
      // Explicit eclipse state takes precedence over eclipse-darkened lighting.
      if (this.eclipseRoostActive && gull.roostReason !== 'eclipse') {
        gull.activeRoost.copy(nearestEclipseRoost(gull.position, gullIndex, this.roofs, gull.seat));
        gull.roostReason = 'eclipse';
        gull.lifeMode = 'toRoost';
        gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
      } else if (!this.eclipseRoostActive && gull.roostReason === 'eclipse') {
        if (night > 0.62) {
          gull.activeRoost.copy(gull.nightRoost);
          gull.roostReason = 'night';
          gull.lifeMode = 'toRoost';
          gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
        } else {
          beginTakeOff(gull);
        }
      } else if (!this.eclipseRoostActive && night > 0.62 && gull.roostReason !== 'night') {
        gull.activeRoost.copy(gull.nightRoost);
        gull.roostReason = 'night';
        gull.lifeMode = 'toRoost';
        gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
      } else if (night < 0.45 && gull.roostReason === 'night') {
        // Dawn is a take-off, exactly like the end of an eclipse. It used to go straight to
        // `fly`, which is how the unfold came to be the half of the request that never ran.
        beginTakeOff(gull);
      }

      // ── Wings: one continuous term, driven by the life mode ──
      // Out for everything but sitting on the roof: a gull on final approach is flying, and
      // it opens them again the moment it means to leave.
      gull.foldedness = advanceFoldedness(gull.foldedness, foldednessTarget(gull.lifeMode), delta);
      // How much of a wing there is to fly on, 0 shut to 1 spread. A gull whose wings are
      // still closed has no thrust and no lift, which is what makes the unfold *be* the
      // take-off rather than something that happens while the bird is already leaving.
      const openness = 1 - gull.foldedness;

      if (gull.lifeMode === 'roost') {
        // Asleep: sit still, wings folded, gentle breathing.
        gull.group.position.set(
          gull.activeRoost.x,
          gull.activeRoost.y + Math.sin(elapsed * 1.1 + gull.phase) * 0.02,
          gull.activeRoost.z
        );
        gull.group.rotation.set(0, gull.heading + Math.PI, 0);
        applyRoostWingPose(gull);
        continue;
      }

      if (gull.lifeMode === 'toRoost') {
        gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
        const horizontal = Math.hypot(
          gull.activeRoost.x - gull.position.x,
          gull.activeRoost.z - gull.position.z
        );
        // Glide down toward the roost height as the gull approaches.
        gull.altitudeTarget = gull.activeRoost.y + Math.min(horizontal * 0.4, 14);
      } else if (gull.lifeMode === 'takeOff' && gull.position.y >= gull.takeOffClearanceY - 0.1) {
        gull.lifeMode = 'fly';
        pickTarget(gull.target, this.random);
        gull.altitudeTarget = MIN_ALTITUDE + this.random() * (MAX_ALTITUDE - MIN_ALTITUDE);
      }
      // ── Steering: turn smoothly toward the current target ──
      const toTargetX = gull.target.x - gull.position.x;
      const toTargetZ = gull.target.z - gull.position.z;
      const distToTarget = Math.hypot(toTargetX, toTargetZ);
      if (distToTarget < 10 && gull.lifeMode === 'fly') {
        pickTarget(gull.target, this.random);
        gull.altitudeTarget = MIN_ALTITUDE + this.random() * (MAX_ALTITUDE - MIN_ALTITUDE);
      }

      const desiredHeading = Math.atan2(toTargetX, toTargetZ);
      let headingError = desiredHeading - gull.heading;
      while (headingError > Math.PI) headingError -= Math.PI * 2;
      while (headingError < -Math.PI) headingError += Math.PI * 2;
      const turn = THREE.MathUtils.clamp(headingError, -MAX_TURN_RATE * delta, MAX_TURN_RATE * delta);
      gull.heading += turn;

      // ── Altitude: stay above the buildings beneath, ease toward target ──
      const localCeiling =
        maxBuildingHeightNear(gull.position.x, gull.position.z, 6, this.roofs) +
        BUILDING_AVOIDANCE_BUFFER;
      const landingDistance =
        gull.lifeMode === 'toRoost'
          ? Math.hypot(gull.activeRoost.x - gull.position.x, gull.activeRoost.z - gull.position.z)
          : Number.POSITIVE_INFINITY;
      const climbRate = CLIMB_RATE * openness;
      // Cruising only: a gull gliding in to a roost is meant to come down onto a roof.
      const ahead =
        gull.lifeMode === 'fly'
          ? clearanceAhead(
              gull,
              gull.speed * (1 + wind * 0.15) * openness,
              wind * 1.6 * openness,
              climbRate,
              this.roofs
            )
          : 0;
      const avoidanceFloor =
        landingDistance < LANDING_APPROACH_DISTANCE
          ? gull.activeRoost.y
          : Math.max(localCeiling, ahead);
      const wantY = Math.max(gull.altitudeTarget, avoidanceFloor);
      const dy = THREE.MathUtils.clamp(wantY - gull.position.y, -climbRate * delta, climbRate * delta);
      gull.position.y += dy;

      // ── Move forward; wind pushes everyone gently downwind (+x) ──
      // Both scaled by `openness`, so a gull that is still opening up is still on its roof.
      // In level flight it is exactly 1 and these are the same numbers as before, bit for bit.
      const speed = gull.speed * (1 + wind * 0.15) * openness;
      if (gull.lifeMode === 'toRoost') {
        const distance = Math.max(distToTarget, 1e-6);
        const landingSpeed = Math.min(speed, Math.max(0.7, distToTarget * 0.65));
        const step = Math.min(distance, landingSpeed * delta);
        gull.position.x += (toTargetX / distance) * step;
        gull.position.z += (toTargetZ / distance) * step;
      } else {
        gull.position.x += Math.sin(gull.heading) * speed * delta + wind * 1.6 * openness * delta;
        gull.position.z += Math.cos(gull.heading) * speed * delta;
      }

      if (
        gull.lifeMode === 'toRoost' &&
        gull.position.distanceToSquared(gull.activeRoost) < 1e-8
      ) {
        gull.lifeMode = 'roost';
        applyRoostWingPose(gull);
      }

      // Soft world bounds — steer back inside.
      if (Math.abs(gull.position.x) > WORLD_HALF_SIZE + 14 || Math.abs(gull.position.z) > WORLD_HALF_SIZE + 14) {
        gull.target.set(0, 0, 0);
      }

      // ── Wing mode machine: flap bursts ↔ long glides ──
      gull.modeTimeLeft -= delta;
      const climbing = dy > 0.2 * delta * CLIMB_RATE;
      if (gull.modeTimeLeft <= 0) {
        if (gull.wingMode === 'glide') {
          gull.wingMode = 'flap';
          gull.modeTimeLeft = 0.9 + this.random() * 1.6 + (climbing ? 1.2 : 0);
        } else {
          gull.wingMode = 'glide';
          gull.modeTimeLeft = 2.2 + this.random() * 3.5 - (climbing ? 1.5 : 0);
        }
      }

      // A gull that landed on this very frame already holds the roost pose; the flight pose
      // used to overwrite it here, which is what made the second copy of it dead code.
      if (gull.lifeMode !== 'roost') {
        let wingAngle: number;
        if (gull.wingMode === 'flap') {
          wingAngle = Math.sin(elapsed * 9 + gull.phase) * 0.55;
        } else {
          // Glide: wings held in a shallow V with a tiny tremble.
          wingAngle = -0.12 + Math.sin(elapsed * 1.4 + gull.phase) * 0.04;
        }
        gull.leftWing.rotation.z = -0.18 + wingAngle;
        gull.rightWing.rotation.z = 0.18 - wingAngle;
        // Spread (foldedness 0) leaves those two writes bit-identical; see `applyWingFold`.
        applyWingFold(gull.leftWing, gull.rightWing, wingFoldPose(gull.foldedness));
      }

      // ── Bank into the turn ──
      const targetBank = -THREE.MathUtils.clamp(headingError, -1, 1) * 0.45;
      gull.bank += (targetBank - gull.bank) * Math.min(1, delta * 3);

      // ── Apply transform (lookAt convention: -Z forward → rotate y by atan2) ──
      gull.group.position.copy(gull.position);
      gull.group.rotation.set(0, gull.heading + Math.PI, 0); // model faces -Z
      gull.group.rotateZ(gull.bank);
      gull.group.rotateX(THREE.MathUtils.clamp(-dy / Math.max(delta, 1e-4) / CLIMB_RATE, -1, 1) * 0.18);
    }
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>(Object.values(GULL_GEOMETRIES));
    for (const gull of this.gulls) {
      this.scene.remove(gull.group);
      gull.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          geometries.add(child.geometry);
        }
      });
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of Object.values(GULL_MATERIALS)) material.dispose();
    this.gulls.length = 0;
  }
}
