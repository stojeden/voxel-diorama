import * as THREE from 'three';
import { LAKE } from './WorldLayout';

/**
 * Little voxel fish that periodically jump out of the lake. Each jump
 * starts with a splash ring on the water, follows a parabolic arc, and ends
 * with another splash.
 */

const LAKE_CENTER = new THREE.Vector3(LAKE.x, -0.5, LAKE.z);
const LAKE_RADIUS_X = LAKE.radiusX - 2;
const LAKE_RADIUS_Z = LAKE.radiusZ - 2;
const WATER_Y = -0.55;

interface Fish {
  group: THREE.Group;
  fishMaterial: THREE.MeshStandardMaterial;
  splashMaterial: THREE.MeshBasicMaterial;
  splashMesh: THREE.Mesh;
  state: 'waiting' | 'jumping';
  waitUntil: number;
  jumpStart: number;
  jumpDuration: number;
  jumpHeight: number;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
}

function buildFish(): { group: THREE.Group; material: THREE.MeshStandardMaterial; splash: THREE.Mesh; splashMat: THREE.MeshBasicMaterial } {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x6a8aa8,
    roughness: 0.55,
    metalness: 0.25,
    emissive: 0x113344,
    emissiveIntensity: 0.18,
  });
  // Body: stretched box
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.22), bodyMat);
  body.castShadow = true;
  group.add(body);
  // Tail
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.32, 0.06), bodyMat);
  tail.position.set(-0.32, 0, 0);
  group.add(tail);

  // Splash ring — sits on water surface, scales up + fades.
  const splashGeo = new THREE.RingGeometry(0.2, 0.7, 16);
  const splashMat = new THREE.MeshBasicMaterial({
    color: 0xc8e0ec,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const splash = new THREE.Mesh(splashGeo, splashMat);
  splash.rotation.x = -Math.PI / 2;
  splash.position.y = WATER_Y + 0.02;

  group.visible = false;
  return { group, material: bodyMat, splash, splashMat };
}

function randomLakePoint(out: THREE.Vector3): void {
  // Rejection sample inside the lake ellipse.
  for (let i = 0; i < 8; i++) {
    const x = (Math.random() * 2 - 1) * LAKE_RADIUS_X;
    const z = (Math.random() * 2 - 1) * LAKE_RADIUS_Z;
    const normalized = (x * x) / (LAKE_RADIUS_X * LAKE_RADIUS_X) + (z * z) / (LAKE_RADIUS_Z * LAKE_RADIUS_Z);
    if (normalized < 0.85) {
      out.set(LAKE_CENTER.x + x, WATER_Y, LAKE_CENTER.z + z);
      return;
    }
  }
  out.copy(LAKE_CENTER);
  out.y = WATER_Y;
}

export class LakeLife {
  private readonly fishes: Fish[] = [];
  private readonly scene: THREE.Scene;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private clock = 0;

  constructor(scene: THREE.Scene, count = 4) {
    this.scene = scene;
    for (let i = 0; i < count; i++) {
      const built = buildFish();
      scene.add(built.group);
      scene.add(built.splash);
      this.disposables.push(built.material, built.splashMat);

      const fish: Fish = {
        group: built.group,
        fishMaterial: built.material,
        splashMaterial: built.splashMat,
        splashMesh: built.splash,
        state: 'waiting',
        waitUntil: 3 + Math.random() * 8 + i * 1.5,
        jumpStart: 0,
        jumpDuration: 1.0 + Math.random() * 0.4,
        jumpHeight: 0.9 + Math.random() * 0.5,
        startPos: new THREE.Vector3(),
        endPos: new THREE.Vector3(),
      };
      this.fishes.push(fish);
    }
  }

  update(delta: number, frozen = false): void {
    this.clock += delta;
    for (const fish of this.fishes) {
      if (fish.state === 'waiting') {
        // No fish jump through the winter ice.
        if (!frozen && this.clock >= fish.waitUntil) {
          this.startJump(fish);
        }
      } else {
        this.advanceJump(fish);
      }
    }
  }

  private startJump(fish: Fish): void {
    randomLakePoint(fish.startPos);
    randomLakePoint(fish.endPos);
    // Keep entry and exit close (gives a believable arc).
    const dir = new THREE.Vector3().subVectors(fish.endPos, fish.startPos).normalize();
    fish.endPos.copy(fish.startPos).addScaledVector(dir, 0.9 + Math.random() * 0.6);

    fish.state = 'jumping';
    fish.jumpStart = this.clock;
    fish.group.visible = true;
    fish.fishMaterial.opacity = 1;

    // Splash starts immediately at the start position.
    fish.splashMesh.position.set(fish.startPos.x, WATER_Y + 0.02, fish.startPos.z);
    fish.splashMaterial.opacity = 0.8;
    fish.splashMesh.scale.set(0.6, 0.6, 0.6);
  }

  private advanceJump(fish: Fish): void {
    const t = (this.clock - fish.jumpStart) / fish.jumpDuration;
    if (t >= 1) {
      fish.group.visible = false;
      fish.state = 'waiting';
      fish.waitUntil = this.clock + 4 + Math.random() * 9;
      // Final splash at landing position.
      fish.splashMesh.position.set(fish.endPos.x, WATER_Y + 0.02, fish.endPos.z);
      fish.splashMaterial.opacity = 0.6;
      fish.splashMesh.scale.set(0.5, 0.5, 0.5);
      return;
    }

    // Parabolic arc — height peaks at t=0.5.
    const lerp = t;
    const arcHeight = fish.jumpHeight * 4 * lerp * (1 - lerp);
    fish.group.position.set(
      fish.startPos.x + (fish.endPos.x - fish.startPos.x) * lerp,
      WATER_Y + arcHeight,
      fish.startPos.z + (fish.endPos.z - fish.startPos.z) * lerp
    );

    // Orient along velocity (slope of parabola).
    const dirX = fish.endPos.x - fish.startPos.x;
    const dirZ = fish.endPos.z - fish.startPos.z;
    const slopeY = fish.jumpHeight * 4 * (1 - 2 * lerp);
    const horizMag = Math.hypot(dirX, dirZ);
    fish.group.rotation.y = Math.atan2(dirX, dirZ);
    fish.group.rotation.z = Math.atan2(slopeY, horizMag) * 0.6;
    // Tail wag
    fish.group.rotation.x = Math.sin(lerp * Math.PI * 6) * 0.2;

    // Splash ring scales up + fades.
    const splashFade = Math.max(0, 1 - t * 1.5);
    fish.splashMaterial.opacity = splashFade * 0.8;
    const splashScale = 0.6 + t * 1.4;
    fish.splashMesh.scale.set(splashScale, splashScale, splashScale);
  }

  dispose(): void {
    for (const fish of this.fishes) {
      this.scene.remove(fish.group);
      this.scene.remove(fish.splashMesh);
      fish.group.traverse((c) => {
        if (c instanceof THREE.Mesh) c.geometry.dispose();
      });
      fish.splashMesh.geometry.dispose();
    }
    for (const d of this.disposables) d.dispose();
    this.fishes.length = 0;
  }
}
