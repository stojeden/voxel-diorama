import * as THREE from 'three';
import { STATION_STOPS, TRAIN_ROUTE_CURVE, type StationStop } from './WorldLayout';

const JACKET_COLORS = [0x9c3838, 0x2b5f9a, 0x355d2a, 0xc4a35a, 0x6c4a8a, 0x444444, 0xb87333];
const SKIN_COLORS = [0xe8c39a, 0xd4a173, 0xa57448, 0xfcd7b6];

type Activity = 'idle' | 'boarding' | 'disembarking';

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
  /** Walking-surface height for this passenger. */
  baseY: number;
  facingTrack: number;

  activity: Activity;
  progress: number;
  activityDuration: number;
  phase: number;
  currentOpacity: number;
  targetOpacity: number;
}

interface StationCrowd {
  station: StationStop;
  passengers: Passenger[];
  lastDwellSignal: boolean;
  visitCount: number;
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

/** Voxel-person builder — shared with the bus stop crowds. */
export function buildPassenger(): PassengerBuild {
  const group = new THREE.Group();
  const jacket = JACKET_COLORS[Math.floor(Math.random() * JACKET_COLORS.length)];
  const skin = SKIN_COLORS[Math.floor(Math.random() * SKIN_COLORS.length)];

  const jacketMat = makeMat(jacket);
  const skinMat = makeMat(skin, { roughness: 0.7 });
  const legsMat = makeMat(0x2a2a2a);

  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.9, 0.5), legsMat);
  legs.position.y = 0.45;
  legs.castShadow = true;
  group.add(legs);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.95, 0.5), jacketMat);
  body.position.y = 1.4;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), skinMat);
  head.position.y = 2.18;
  head.castShadow = true;
  group.add(head);

  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.32), jacketMat);
  leftArm.position.set(-0.45, 1.45, 0);
  leftArm.castShadow = true;
  group.add(leftArm);

  const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.32), jacketMat);
  rightArm.position.set(0.45, 1.45, 0);
  rightArm.castShadow = true;
  group.add(rightArm);

  return { group, body, head, legs, leftArm, rightArm, materials: [jacketMat, skinMat, legsMat] };
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class PassengerCrowd {
  private crowds: StationCrowd[] = [];
  private readonly scene: THREE.Scene;
  private clock = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (const station of STATION_STOPS) {
      const platformCenter = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
      const tangent = TRAIN_ROUTE_CURVE.getTangentAt(station.centerT).normalize();
      const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      // Walking surface: top of the platform slab.
      const baseY = Math.round(platformCenter.y) + 0.5;

      const count = 6;
      const passengers: Passenger[] = [];
      const halfLen = station.platformLength / 2 - 3;
      const spacing = (2 * halfLen) / (count + 1);
      const facingTrack = Math.atan2(-normal.x, -normal.z);

      for (let i = 0; i < count; i++) {
        const along = -halfLen + spacing * (i + 1) + (Math.random() - 0.5) * 0.5;
        const platformLateral = 4 + Math.random() * 1.2;
        const boardingLateral = 1.5;

        const platformPos = platformCenter
          .clone()
          .addScaledVector(tangent, along)
          .addScaledVector(normal, platformLateral);
        platformPos.y = baseY;
        const boardingPos = platformCenter
          .clone()
          .addScaledVector(tangent, along)
          .addScaledVector(normal, boardingLateral);
        boardingPos.y = baseY;

        const built = buildPassenger();
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
          baseY,
          facingTrack,
          activity: 'idle',
          progress: 0,
          activityDuration: 3 + Math.random() * 2,
          phase: Math.random() * Math.PI * 2,
          currentOpacity: 0,
          targetOpacity: 0.92,
        });
      }

      this.crowds.push({ station, passengers, lastDwellSignal: false, visitCount: 0 });
    }
  }

  update(delta: number, stationsBoarding: Set<string>): void {
    this.clock += delta;

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

      for (const p of crowd.passengers) this.updatePassenger(p, delta);
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
        p.activityDuration = 2.6 + Math.random() * 0.8;
        p.currentOpacity = 0.92;
        p.targetOpacity = 0.92;
        p.group.position.copy(p.platformPos);
      } else {
        p.activity = 'disembarking';
        p.progress = 0;
        p.activityDuration = 2.6 + Math.random() * 0.8;
        p.currentOpacity = 0;
        p.targetOpacity = 0.92;
        p.group.position.copy(p.boardingPos);
      }
    }
  }

  private updatePassenger(p: Passenger, delta: number): void {
    if (p.activity === 'idle') {
      p.group.position.copy(p.platformPos);
      const sway = Math.sin(this.clock * 1.6 + p.phase) * 0.04;
      p.group.position.x += Math.cos(p.facingTrack) * sway * 0.4;
      p.group.position.z += Math.sin(p.facingTrack) * sway * 0.4;
      p.body.position.y = 1.4 + Math.sin(this.clock * 1.3 + p.phase) * 0.015;
      p.head.position.y = 2.18 + Math.sin(this.clock * 1.3 + p.phase) * 0.015;
      p.head.rotation.y = Math.sin(this.clock * 0.4 + p.phase * 2) * 0.4;
      p.leftArm.rotation.x = Math.sin(this.clock * 0.9 + p.phase) * 0.08;
      p.rightArm.rotation.x = -Math.sin(this.clock * 0.9 + p.phase) * 0.08;
      p.group.rotation.y = p.facingTrack;

      p.targetOpacity = 0.92;
    } else {
      p.progress = Math.min(1, p.progress + delta / p.activityDuration);
      const eased = easeInOut(p.progress);
      const from = p.activity === 'boarding' ? p.platformPos : p.boardingPos;
      const to = p.activity === 'boarding' ? p.boardingPos : p.platformPos;
      p.group.position.lerpVectors(from, to, eased);

      const stepBob = Math.abs(Math.sin(p.progress * Math.PI * 4)) * 0.06;
      p.group.position.y = p.baseY + stepBob;
      p.legs.rotation.x = Math.sin(p.progress * Math.PI * 4) * 0.25;
      p.leftArm.rotation.x = Math.sin(p.progress * Math.PI * 4) * 0.6;
      p.rightArm.rotation.x = -Math.sin(p.progress * Math.PI * 4) * 0.6;
      p.body.position.y = 1.4;
      p.head.position.y = 2.18;
      p.head.rotation.y = 0;

      const dirX = to.x - from.x;
      const dirZ = to.z - from.z;
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
  }

  dispose(): void {
    for (const crowd of this.crowds) {
      for (const p of crowd.passengers) {
        this.scene.remove(p.group);
        p.group.traverse((child) => {
          if (child instanceof THREE.Mesh) child.geometry.dispose();
        });
        for (const mat of p.materials) mat.dispose();
      }
    }
    this.crowds.length = 0;
  }
}
