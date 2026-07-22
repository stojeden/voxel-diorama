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

/**
 * Seagulls with believable flight: they steer smoothly toward wandering
 * targets (with a bias toward the lake), bank into turns, and alternate
 * between flapping bursts and long glides — instead of orbiting on rails
 * with constant wing-flapping.
 */

const GULL_COUNT = 11;
const MIN_ALTITUDE = 13;
const MAX_ALTITUDE = 27;
const BUILDING_AVOIDANCE_BUFFER = 3;
const MAX_TURN_RATE = 0.65; // rad/s
const CLIMB_RATE = 2.2; // m/s
export const ECLIPSE_ROOST_COVERAGE = 0.85;
export const ECLIPSE_TAKE_OFF_COVERAGE = 0.65;

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

const GULL_GEOMETRIES = {
  body: new THREE.SphereGeometry(0.34, 8, 6),
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
  takeOffClearanceY: number;
}

function maxBuildingHeightNear(x: number, z: number, radius: number): number {
  let maxH = 0;
  for (const block of BLOCK_CONFIGS) {
    const minX = block.x;
    const maxX = block.x + block.w - 1;
    const minZ = block.z;
    const maxZ = block.z + block.d - 1;
    const dx = Math.max(minX - x, 0, x - maxX);
    const dz = Math.max(minZ - z, 0, z - maxZ);
    if (Math.hypot(dx, dz) < radius && block.h > maxH) maxH = block.h;
  }
  return maxH;
}

function createWing(side: -1 | 1): THREE.Group {
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
  body.scale.set(0.95, 0.78, 1.08);
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

function roostSpotFor(index: number): THREE.Vector3 {
  // Most gulls sleep on rooftops, a couple at the lake shore.
  if (index % 4 === 3) {
    const angle = (index / GULL_COUNT) * Math.PI * 2;
    return new THREE.Vector3(
      LAKE.x + Math.cos(angle) * (LAKE.radiusX + 2),
      0.4,
      LAKE.z + Math.sin(angle) * (LAKE.radiusZ + 2)
    );
  }
  const block = BLOCK_CONFIGS[(index * 7) % BLOCK_CONFIGS.length];
  return new THREE.Vector3(
    block.x + block.w / 2 + (index % 3) - 1,
    block.h + 0.55,
    block.z + block.d / 2
  );
}

function deterministicUnit(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function roofCoordinate(origin: number, size: number, seed: number): number {
  const extent = Math.max(0, size - 1);
  const margin = Math.min(1.25, extent * 0.3);
  return origin + margin + deterministicUnit(seed) * Math.max(0, extent - margin * 2);
}

/** Selects a stable, spread-out point on the nearest roof for this gull. */
export function nearestEclipseRoost(
  position: Pick<THREE.Vector3, 'x' | 'z'>,
  gullIndex: number,
  blocks: readonly BlockConfig[] = BLOCK_CONFIGS
): THREE.Vector3 {
  if (blocks.length === 0) throw new Error('Cannot select an eclipse roost without buildings');

  let nearest = blocks[0];
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const block = blocks[blockIndex];
    const closestX = THREE.MathUtils.clamp(position.x, block.x, block.x + block.w - 1);
    const closestZ = THREE.MathUtils.clamp(position.z, block.z, block.z + block.d - 1);
    const distance = (closestX - position.x) ** 2 + (closestZ - position.z) ** 2;
    if (distance < nearestDistance) {
      nearest = block;
      nearestIndex = blockIndex;
      nearestDistance = distance;
    }
  }

  const seed = (gullIndex + 1) * 73856093 ^ (nearestIndex + 1) * 19349663;
  return new THREE.Vector3(
    roofCoordinate(nearest.x, nearest.w, seed),
    nearest.h + 0.55,
    roofCoordinate(nearest.z, nearest.d, seed ^ 0x9e3779b9)
  );
}

export class Birds {
  private readonly random: RandomSource;
  private gulls: Gull[] = [];
  private readonly scene: THREE.Scene;
  private hidden = false;
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

      const target = new THREE.Vector3();
      pickTarget(target, random);

      const nightRoost = roostSpotFor(i);
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
        takeOffClearanceY: MIN_ALTITUDE,
      });
    }
  }

  update(delta: number, elapsed: number, wind: number, night: number): void {
    if (this.hidden) return;
    for (let gullIndex = 0; gullIndex < this.activeCount; gullIndex++) {
      const gull = this.gulls[gullIndex];
      // Explicit eclipse state takes precedence over eclipse-darkened lighting.
      if (this.eclipseRoostActive && gull.roostReason !== 'eclipse') {
        gull.activeRoost.copy(nearestEclipseRoost(gull.position, gullIndex));
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
          gull.roostReason = null;
          gull.lifeMode = 'takeOff';
          gull.takeOffClearanceY = Math.max(MIN_ALTITUDE, gull.activeRoost.y + 5.5);
          gull.altitudeTarget = gull.takeOffClearanceY;
          gull.target.set(
            gull.position.x + Math.sin(gull.heading) * 8,
            0,
            gull.position.z + Math.cos(gull.heading) * 8
          );
        }
      } else if (!this.eclipseRoostActive && night > 0.62 && gull.roostReason !== 'night') {
        gull.activeRoost.copy(gull.nightRoost);
        gull.roostReason = 'night';
        gull.lifeMode = 'toRoost';
        gull.target.set(gull.activeRoost.x, 0, gull.activeRoost.z);
      } else if (night < 0.45 && gull.roostReason === 'night') {
        gull.roostReason = null;
        gull.lifeMode = 'fly';
        pickTarget(gull.target, this.random);
        gull.altitudeTarget = MIN_ALTITUDE + this.random() * (MAX_ALTITUDE - MIN_ALTITUDE);
      }

      if (gull.lifeMode === 'roost') {
        // Asleep: sit still, wings folded, gentle breathing.
        gull.group.position.set(
          gull.activeRoost.x,
          gull.activeRoost.y + Math.sin(elapsed * 1.1 + gull.phase) * 0.02,
          gull.activeRoost.z
        );
        gull.group.rotation.set(0, gull.heading + Math.PI, 0);
        gull.leftWing.rotation.z = -0.05;
        gull.rightWing.rotation.z = 0.05;
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
        maxBuildingHeightNear(gull.position.x, gull.position.z, 6) + BUILDING_AVOIDANCE_BUFFER;
      const landingDistance =
        gull.lifeMode === 'toRoost'
          ? Math.hypot(gull.activeRoost.x - gull.position.x, gull.activeRoost.z - gull.position.z)
          : Number.POSITIVE_INFINITY;
      const avoidanceFloor = landingDistance < 6 ? gull.activeRoost.y : localCeiling;
      const wantY = Math.max(gull.altitudeTarget, avoidanceFloor);
      const dy = THREE.MathUtils.clamp(wantY - gull.position.y, -CLIMB_RATE * delta, CLIMB_RATE * delta);
      gull.position.y += dy;

      // ── Move forward; wind pushes everyone gently downwind (+x) ──
      const speed = gull.speed * (1 + wind * 0.15);
      if (gull.lifeMode === 'toRoost') {
        const distance = Math.max(distToTarget, 1e-6);
        const landingSpeed = Math.min(speed, Math.max(0.7, distToTarget * 0.65));
        const step = Math.min(distance, landingSpeed * delta);
        gull.position.x += (toTargetX / distance) * step;
        gull.position.z += (toTargetZ / distance) * step;
      } else {
        gull.position.x += Math.sin(gull.heading) * speed * delta + wind * 1.6 * delta;
        gull.position.z += Math.cos(gull.heading) * speed * delta;
      }

      if (
        gull.lifeMode === 'toRoost' &&
        gull.position.distanceToSquared(gull.activeRoost) < 1e-8
      ) {
        gull.lifeMode = 'roost';
        gull.leftWing.rotation.z = -0.05;
        gull.rightWing.rotation.z = 0.05;
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

      let wingAngle: number;
      if (gull.wingMode === 'flap') {
        wingAngle = Math.sin(elapsed * 9 + gull.phase) * 0.55;
      } else {
        // Glide: wings held in a shallow V with a tiny tremble.
        wingAngle = -0.12 + Math.sin(elapsed * 1.4 + gull.phase) * 0.04;
      }
      gull.leftWing.rotation.z = -0.18 + wingAngle;
      gull.rightWing.rotation.z = 0.18 - wingAngle;

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
