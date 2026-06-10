import * as THREE from 'three';
import { DOG_HOME, MAIL_STOPS, POSTMAN_ROUTE_CURVE } from './WorldLayout';
import { buildPassenger, type PassengerBuild } from './PassengerCrowd';

/**
 * Morning postman: every day at dawn he cycles a loop along the south-road
 * sidewalks, pausing at three mail stops. A small dog has its yard on the
 * route — when the postman passes, it gives chase for a few seconds
 * (hopping and yapping), then trots back home.
 */

const ROUTE_LENGTH = POSTMAN_ROUTE_CURVE.getLength();
const RIDE_SPEED = 6;
const MORNING_START = 0.28;
const MORNING_END = 0.5;
const STOP_DURATION = 2;

const STOP_TS = MAIL_STOPS.map(([x, z]) => {
  let bestT = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= 400; i++) {
    const p = POSTMAN_ROUTE_CURVE.getPointAt(i / 400);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      bestT = i / 400;
    }
  }
  return bestT;
});

function buildBike(): { group: THREE.Group; wheels: THREE.Mesh[]; rider: PassengerBuild; mats: THREE.Material[] } {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xb33a2e, metalness: 0.5, roughness: 0.4, transparent: true });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.7, transparent: true });
  const bagMat = new THREE.MeshStandardMaterial({ color: 0xc9a14e, roughness: 0.85, transparent: true });
  mats.push(frameMat, wheelMat, bagMat);

  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.1, 14);
  for (const z of [-0.65, 0.65]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, 0.42, z);
    group.add(wheel);
    wheels.push(wheel);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.3), frameMat);
  bar.position.set(0, 0.78, 0);
  group.add(bar);
  const seatPost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), frameMat);
  seatPost.position.set(0, 1.0, 0.35);
  group.add(seatPost);
  const handlePost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.08), frameMat);
  handlePost.position.set(0, 1.0, -0.55);
  group.add(handlePost);
  const handles = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.07), frameMat);
  handles.position.set(0, 1.24, -0.55);
  group.add(handles);
  // Mail bag on the rack
  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), bagMat);
  bag.position.set(0, 1.0, 0.85);
  group.add(bag);

  const rider = buildPassenger();
  rider.group.position.set(0, 0.85, 0.3);
  rider.group.scale.setScalar(0.85);
  rider.legs.rotation.x = -0.9;
  group.add(rider.group);

  return { group, wheels, rider, mats };
}

function buildDog(): { group: THREE.Group; tail: THREE.Mesh; mats: THREE.Material[] } {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const furMat = new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x5a4226, roughness: 0.9 });
  mats.push(furMat, darkMat);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.4, 0.85), furMat);
  body.position.y = 0.45;
  group.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.36, 0.36), furMat);
  head.position.set(0, 0.72, -0.5);
  group.add(head);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.08), darkMat);
    ear.position.set(side * 0.14, 0.95, -0.5);
    group.add(ear);
  }
  for (const lz of [-0.28, 0.28]) {
    for (const lx of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.12), darkMat);
      leg.position.set(lx, 0.15, lz);
      group.add(leg);
    }
  }
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.4), darkMat);
  tail.position.set(0, 0.62, 0.6);
  group.add(tail);

  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return { group, tail, mats };
}

type DogMode = 'home' | 'chase' | 'returnHome';

export class Postman {
  private readonly scene: THREE.Scene;
  private readonly bike: ReturnType<typeof buildBike>;
  private readonly dog: ReturnType<typeof buildDog>;
  private readonly dogPos = new THREE.Vector3(DOG_HOME.x, 0, DOG_HOME.z);
  private dogMode: DogMode = 'home';
  private dogChaseTime = 0;

  private active = false;
  private doneToday = false;
  private t = 0;
  private stopTimer = 0;
  private nextStopIndex = 0;
  private opacity = 0;

  private readonly pos = new THREE.Vector3();
  private readonly ahead = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bike = buildBike();
    this.bike.group.visible = false;
    scene.add(this.bike.group);

    this.dog = buildDog();
    this.dog.group.position.copy(this.dogPos);
    scene.add(this.dog.group);
  }

  update(delta: number, elapsed: number, t01: number): void {
    const isMorning = t01 >= MORNING_START && t01 <= MORNING_END;
    if (!isMorning) this.doneToday = false;

    // Start the round at dawn.
    if (isMorning && !this.active && !this.doneToday) {
      this.active = true;
      this.t = 0;
      this.nextStopIndex = 0;
      this.stopTimer = 0;
      this.bike.group.visible = true;
    }

    if (this.active) {
      this.opacity += (0.95 - this.opacity) * Math.min(1, delta * 2);
      this.updateRide(delta, elapsed);
    } else {
      this.opacity += (0 - this.opacity) * Math.min(1, delta * 2);
      if (this.opacity < 0.03) this.bike.group.visible = false;
    }
    for (const mat of this.bike.rider.materials) mat.opacity = this.opacity;
    for (const mat of this.bike.mats) (mat as THREE.MeshStandardMaterial).opacity = this.opacity;

    this.updateDog(delta, elapsed);
  }

  private updateRide(delta: number, elapsed: number): void {
    if (this.stopTimer > 0) {
      // Delivering — bike stands, rider waves an arm toward the door.
      this.stopTimer -= delta;
      this.bike.rider.rightArm.rotation.x = -1.6 + Math.sin(elapsed * 6) * 0.3;
      return;
    }

    // Sprint a little when the dog is on his heels.
    const dogClose = this.dogMode === 'chase' &&
      this.dog.group.position.distanceTo(this.bike.group.position) < 4.5;
    this.t += ((dogClose ? RIDE_SPEED * 1.45 : RIDE_SPEED) * delta) / ROUTE_LENGTH;
    if (this.t >= 1) {
      // Round finished — go home.
      this.active = false;
      this.doneToday = true;
      return;
    }

    // Pause at the next mail stop when we reach it.
    if (this.nextStopIndex < STOP_TS.length && this.t >= STOP_TS[this.nextStopIndex]) {
      this.stopTimer = STOP_DURATION;
      this.nextStopIndex += 1;
    }

    const p = POSTMAN_ROUTE_CURVE.getPointAt(this.t);
    const tangent = POSTMAN_ROUTE_CURVE.getTangentAt(this.t).normalize();
    this.pos.copy(p);
    this.bike.group.position.set(p.x, 0, p.z);
    this.ahead.copy(this.bike.group.position).sub(tangent); // bike front is -Z
    this.bike.group.lookAt(this.ahead);

    const wheelSpin = (RIDE_SPEED * delta) / 0.42;
    for (const wheel of this.bike.wheels) wheel.rotation.x += wheelSpin;

    // Pedalling legs + gentle lean
    this.bike.rider.legs.rotation.x = -0.9 + Math.sin(elapsed * 9) * 0.35;
    this.bike.group.rotation.z = Math.sin(elapsed * 1.3) * 0.02;
    this.bike.rider.rightArm.rotation.x = -0.4;
    this.bike.rider.leftArm.rotation.x = -0.4;
  }

  private updateDog(delta: number, elapsed: number): void {
    const dogHome = new THREE.Vector3(DOG_HOME.x, 0, DOG_HOME.z);
    const postmanNear =
      this.active &&
      this.stopTimer <= 0 &&
      this.bike.group.position.distanceTo(this.dog.group.position) < 8;

    if (this.dogMode === 'home') {
      // Naps / sniffs around its yard.
      this.dog.group.position.set(
        dogHome.x + Math.sin(elapsed * 0.4) * 0.4,
        0,
        dogHome.z + Math.cos(elapsed * 0.3) * 0.4
      );
      this.dog.tail.rotation.y = Math.sin(elapsed * 3) * 0.3;
      if (postmanNear) {
        this.dogMode = 'chase';
        this.dogChaseTime = 7;
      }
    } else if (this.dogMode === 'chase') {
      this.dogChaseTime -= delta;
      // Run after the bike but ALWAYS keep a respectful gap — it never
      // jumps into the postman's geometry.
      const target = this.bike.group.position;
      const dx = target.x - this.dog.group.position.x;
      const dz = target.z - this.dog.group.position.z;
      const dist = Math.hypot(dx, dz);
      const KEEP_GAP = 3.2;
      if (dist > KEEP_GAP + 0.2) {
        const step = Math.min(dist - KEEP_GAP, 6.6 * delta);
        this.dog.group.position.x += (dx / dist) * step;
        this.dog.group.position.z += (dz / dist) * step;
      }
      if (dist > 1e-3) this.dog.group.rotation.y = Math.atan2(dx, dz) + Math.PI; // head is -Z
      this.dog.group.position.y = Math.abs(Math.sin(elapsed * 11)) * 0.12; // excited hops
      this.dog.tail.rotation.y = Math.sin(elapsed * 14) * 0.6;
      if (this.dogChaseTime <= 0 || !this.active) {
        this.dogMode = 'returnHome';
      }
    } else {
      // Trot back to the yard.
      const dx = dogHome.x - this.dog.group.position.x;
      const dz = dogHome.z - this.dog.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) {
        this.dogMode = 'home';
      } else {
        const step = Math.min(dist, 3 * delta);
        this.dog.group.position.x += (dx / dist) * step;
        this.dog.group.position.z += (dz / dist) * step;
        this.dog.group.rotation.y = Math.atan2(dx, dz) + Math.PI;
        this.dog.group.position.y = Math.abs(Math.sin(elapsed * 7)) * 0.08;
      }
    }
  }

  dispose(): void {
    this.scene.remove(this.bike.group, this.dog.group);
    this.bike.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.dog.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const mat of this.bike.mats) mat.dispose();
    for (const mat of this.bike.rider.materials) mat.dispose();
    for (const mat of this.dog.mats) mat.dispose();
  }
}
