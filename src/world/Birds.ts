import * as THREE from 'three';
import { BLOCK_CONFIGS, COLORS, LAKE, WORLD_HALF_SIZE } from './WorldLayout';

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

type WingMode = 'flap' | 'glide';
type LifeMode = 'fly' | 'toRoost' | 'roost';

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
  /** Day/night behaviour: gulls sleep on rooftops after dark. */
  lifeMode: LifeMode;
  roost: THREE.Vector3;
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

function createWing(side: -1 | 1, material: THREE.Material): THREE.Group {
  const wing = new THREE.Group();
  const segmentGeometry = new THREE.BoxGeometry(0.62, 0.08, 0.2);
  for (let i = 0; i < 3; i++) {
    const segment = new THREE.Mesh(segmentGeometry, material);
    segment.position.set(side * (0.38 + i * 0.46), 0, 0.06 + i * 0.08);
    segment.rotation.z = side * (0.08 + i * 0.1);
    segment.rotation.y = side * 0.14;
    segment.scale.set(1 - i * 0.12, 1, 1);
    wing.add(segment);
  }
  return wing;
}

function createGullMesh(): { group: THREE.Group; leftWing: THREE.Group; rightWing: THREE.Group } {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xf2ead5, roughness: 0.68 });
  const bellyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 });
  const wingMaterial = new THREE.MeshStandardMaterial({ color: 0xd9d0bb, roughness: 0.76 });
  const beakMaterial = new THREE.MeshStandardMaterial({ color: COLORS.carYellow, roughness: 0.65 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), bodyMaterial);
  body.scale.set(0.95, 0.78, 1.08);
  group.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), bellyMaterial);
  belly.position.set(0, -0.08, -0.05);
  belly.scale.set(0.9, 0.55, 0.72);
  group.add(belly);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), bodyMaterial);
  head.position.set(0, 0.08, -0.42);
  group.add(head);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 4), beakMaterial);
  beak.position.set(0, 0.08, -0.62);
  beak.rotation.x = -Math.PI / 2;
  group.add(beak);

  const leftWing = createWing(-1, wingMaterial);
  const rightWing = createWing(1, wingMaterial);
  leftWing.position.set(-0.18, 0.02, -0.03);
  rightWing.position.set(0.18, 0.02, -0.03);
  group.add(leftWing, rightWing);

  return { group, leftWing, rightWing };
}

function pickTarget(out: THREE.Vector3): void {
  // Gulls love the lake — bias targets toward it.
  if (Math.random() < 0.35) {
    out.set(
      LAKE.x + (Math.random() - 0.5) * LAKE.radiusX * 2.4,
      0,
      LAKE.z + (Math.random() - 0.5) * LAKE.radiusZ * 2.4
    );
  } else {
    out.set(
      (Math.random() - 0.5) * 2 * (WORLD_HALF_SIZE - 10),
      0,
      (Math.random() - 0.5) * 2 * (WORLD_HALF_SIZE - 10)
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

export class Birds {
  private gulls: Gull[] = [];
  private readonly scene: THREE.Scene;
  private hidden = false;

  /** Cyberpunk: no gulls over the megacity. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const gull of this.gulls) gull.group.visible = !hidden;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    for (let i = 0; i < GULL_COUNT; i++) {
      const mesh = createGullMesh();
      mesh.group.scale.setScalar(0.85 + Math.random() * 0.35);
      scene.add(mesh.group);

      const target = new THREE.Vector3();
      pickTarget(target);

      this.gulls.push({
        group: mesh.group,
        leftWing: mesh.leftWing,
        rightWing: mesh.rightWing,
        position: new THREE.Vector3(
          (Math.random() - 0.5) * 2 * (WORLD_HALF_SIZE - 20),
          MIN_ALTITUDE + Math.random() * (MAX_ALTITUDE - MIN_ALTITUDE),
          (Math.random() - 0.5) * 2 * (WORLD_HALF_SIZE - 20)
        ),
        heading: Math.random() * Math.PI * 2,
        speed: 4.2 + Math.random() * 2.4,
        target,
        altitudeTarget: MIN_ALTITUDE + Math.random() * (MAX_ALTITUDE - MIN_ALTITUDE),
        wingMode: Math.random() > 0.5 ? 'glide' : 'flap',
        modeTimeLeft: 1 + Math.random() * 3,
        bank: 0,
        phase: Math.random() * Math.PI * 2,
        lifeMode: 'fly',
        roost: roostSpotFor(i),
      });
    }
  }

  update(delta: number, elapsed: number, wind: number, night: number): void {
    if (this.hidden) return;
    for (const gull of this.gulls) {
      // ── Day/night life cycle: head to a roost after dark, wake at dawn ──
      if (night > 0.62 && gull.lifeMode === 'fly') {
        gull.lifeMode = 'toRoost';
        gull.target.set(gull.roost.x, 0, gull.roost.z);
      } else if (night < 0.45 && gull.lifeMode !== 'fly') {
        gull.lifeMode = 'fly';
        pickTarget(gull.target);
        gull.altitudeTarget = MIN_ALTITUDE + Math.random() * (MAX_ALTITUDE - MIN_ALTITUDE);
      }

      if (gull.lifeMode === 'roost') {
        // Asleep: sit still, wings folded, gentle breathing.
        gull.group.position.set(
          gull.roost.x,
          gull.roost.y + Math.sin(elapsed * 1.1 + gull.phase) * 0.02,
          gull.roost.z
        );
        gull.group.rotation.set(0, gull.heading + Math.PI, 0);
        gull.leftWing.rotation.z = -0.05;
        gull.rightWing.rotation.z = 0.05;
        continue;
      }

      if (gull.lifeMode === 'toRoost') {
        gull.target.set(gull.roost.x, 0, gull.roost.z);
        const horizontal = Math.hypot(gull.roost.x - gull.position.x, gull.roost.z - gull.position.z);
        // Glide down toward the roost height as the gull approaches.
        gull.altitudeTarget = gull.roost.y + Math.min(horizontal * 0.4, 14);
        if (horizontal < 2.2 && Math.abs(gull.position.y - gull.roost.y) < 3.4) {
          gull.lifeMode = 'roost';
          gull.position.copy(gull.roost);
          continue;
        }
      }
      // ── Steering: turn smoothly toward the current target ──
      const toTargetX = gull.target.x - gull.position.x;
      const toTargetZ = gull.target.z - gull.position.z;
      const distToTarget = Math.hypot(toTargetX, toTargetZ);
      if (distToTarget < 10 && gull.lifeMode === 'fly') {
        pickTarget(gull.target);
        gull.altitudeTarget = MIN_ALTITUDE + Math.random() * (MAX_ALTITUDE - MIN_ALTITUDE);
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
      const wantY = Math.max(gull.altitudeTarget, localCeiling);
      const dy = THREE.MathUtils.clamp(wantY - gull.position.y, -CLIMB_RATE * delta, CLIMB_RATE * delta);
      gull.position.y += dy;

      // ── Move forward; wind pushes everyone gently downwind (+x) ──
      const speed = gull.speed * (1 + wind * 0.15);
      gull.position.x += Math.sin(gull.heading) * speed * delta + wind * 1.6 * delta;
      gull.position.z += Math.cos(gull.heading) * speed * delta;

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
          gull.modeTimeLeft = 0.9 + Math.random() * 1.6 + (climbing ? 1.2 : 0);
        } else {
          gull.wingMode = 'glide';
          gull.modeTimeLeft = 2.2 + Math.random() * 3.5 - (climbing ? 1.5 : 0);
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
    for (const gull of this.gulls) {
      this.scene.remove(gull.group);
      gull.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const material = child.material;
          if (Array.isArray(material)) {
            for (const mat of material) mat.dispose();
          } else {
            material.dispose();
          }
        }
      });
    }
    this.gulls.length = 0;
  }
}
