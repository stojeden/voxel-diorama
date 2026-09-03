import * as THREE from 'three';
import { DOG_HOME, GROUND_SURFACE_Y, MAIL_STOPS, POSTMAN_ROUTE_CURVE } from './WorldLayout';
import { PASSENGER_SCALE, type PassengerBuild } from './PassengerCrowd';
import type { EclipseWorldReactionState } from '../experience/EclipseWorldReaction';

/**
 * Morning postman: every day at dawn he cycles a loop along the south-road
 * sidewalks, pausing at three mail stops. A small dog has its yard on the
 * route — when the postman passes, it gives chase for a few seconds
 * (hopping and yapping), then trots back home.
 */

const ROUTE_LENGTH = POSTMAN_ROUTE_CURVE.getLength();
/**
 * The postman's own bicycle, in the same family of sizes as the street bicycles
 * (0.74 m wheels on a 1.10 m wheelbase) rather than the 0.84 m wheels on a 1.30 m
 * wheelbase it used to carry. Every figure here is measured off the finished meshes
 * by `Postman.test.ts`, not off these constants.
 */
const WHEEL_RADIUS = 0.35;
const WHEELBASE = 1.1;
const SADDLE_Y = 0.92;
const BAR_Y = 1.05;
/** Hip and shoulder heights of the product figure in its own unscaled units. */
const RIDER_HIP_Y = 0.92;
const RIDER_SHOULDER_Y = 1.89;
/**
 * Riding pose. The lean is what puts this figure's hands on the bars -- upright, its
 * 0.67 m arms fall 0.2 m short of them -- but at 0.42 rad the head ended up 0.53 m
 * forward, past the handlebars, and he read as a racing crouch rather than a postman.
 * At 0.26 rad with the bars 0.1 m higher and 0.1 m closer the hands rest on the grips
 * and the head stays behind them. Measured on the finished meshes, not reasoned.
 */
const SADDLE_Z = 0.32;
const BAR_Z = -0.36;
const RIDER_LEAN = 0.26;
const LEG_PEDAL_ANGLE = -0.5;
const ARM_REACH_ANGLE = -1.05;
const RIDE_SPEED = 6;
const MORNING_START = 0.28;
const MORNING_END = 0.5;
const STOP_DURATION = 2;
export const POSTMAN_UNIFORM_COLOR = 0x2368a2;

export const POSTMAN_STOP_TS = MAIL_STOPS.map(([x, z]) => {
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
}).sort((a, b) => a - b);

interface PostmanRider extends PassengerBuild {
  cap: THREE.Group;
  satchel: THREE.Mesh;
}

function opaqueMaterial(parameters: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    roughness: 0.78,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    ...parameters,
  });
}

function buildPostmanRider(satchelMaterial: THREE.Material): PostmanRider {
  const group = new THREE.Group();
  group.name = 'postman-rider';

  const uniformMaterial = opaqueMaterial({ color: POSTMAN_UNIFORM_COLOR, roughness: 0.72 });
  const skinMaterial = opaqueMaterial({ color: 0xe0b487, roughness: 0.82 });
  const trousersMaterial = opaqueMaterial({ color: 0x18324a, roughness: 0.9 });
  const badgeMaterial = opaqueMaterial({ color: 0xe8e1c5, roughness: 0.66 });
  const materials = [uniformMaterial, skinMaterial, trousersMaterial, badgeMaterial];

  const makePart = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    // The rider is tiny and nested below a rotating bicycle. Keeping these few
    // meshes out of per-object frustum culling avoids isolated parts popping.
    mesh.frustumCulled = false;
    return mesh;
  };

  // Limbs pivot at the joint, not at the centre of their box: with the old centre
  // pivot the pedalling legs swung their feet up as much as forward and the arms
  // could not reach the handlebars at all.
  const legGeometry = new THREE.BoxGeometry(0.58, 0.92, 0.52);
  legGeometry.translate(0, -0.46, 0);
  const legs = makePart('postman-legs', legGeometry, trousersMaterial);
  legs.position.y = RIDER_HIP_Y;
  group.add(legs);

  const body = makePart(
    'postman-uniform',
    new THREE.BoxGeometry(0.74, 0.98, 0.54),
    uniformMaterial
  );
  body.position.y = 1.42;
  group.add(body);

  const head = makePart(
    'postman-head',
    new THREE.BoxGeometry(0.56, 0.56, 0.56),
    skinMaterial
  );
  head.position.y = 2.2;
  group.add(head);

  const armGeometry = new THREE.BoxGeometry(0.23, 0.86, 0.34);
  armGeometry.translate(0, -0.43, 0);
  const leftArm = makePart('postman-left-arm', armGeometry, uniformMaterial);
  leftArm.position.set(-0.47, RIDER_SHOULDER_Y, 0);
  group.add(leftArm);

  const rightArm = makePart('postman-right-arm', armGeometry, uniformMaterial);
  rightArm.position.set(0.47, RIDER_SHOULDER_Y, 0);
  group.add(rightArm);

  const cap = new THREE.Group();
  cap.name = 'postman-cap';
  const capCrown = makePart(
    'postman-cap-crown',
    new THREE.BoxGeometry(0.62, 0.18, 0.6),
    uniformMaterial
  );
  capCrown.position.y = 0.35;
  const capBrim = makePart(
    'postman-cap-brim',
    new THREE.BoxGeometry(0.5, 0.06, 0.24),
    uniformMaterial
  );
  capBrim.position.set(0, 0.28, 0.36);
  cap.add(capCrown, capBrim);
  head.add(cap);

  const badge = makePart(
    'postman-badge',
    new THREE.BoxGeometry(0.24, 0.18, 0.035),
    badgeMaterial
  );
  badge.position.set(0.18, 0.12, 0.29);
  body.add(badge);

  const satchel = makePart(
    'postman-satchel',
    new THREE.BoxGeometry(0.52, 0.48, 0.3),
    satchelMaterial
  );
  satchel.position.set(0.56, 1.18, 0.04);
  group.add(satchel);
  const strap = makePart(
    'postman-satchel-strap',
    new THREE.BoxGeometry(0.08, 1.3, 0.07),
    satchelMaterial
  );
  strap.position.set(0.08, 1.52, 0.29);
  strap.rotation.z = 0.48;
  group.add(strap);

  // The rider is the product's own figure, so he is scaled like the product's
  // figures (PASSENGER_SCALE) rather than 0.85: at 0.85 he stood 2.24 m against
  // everyone else's 1.915 m and his hips sat 0.4 m above the saddle -- he floated
  // over the bicycle instead of sitting on it.
  //
  // The lean is a rotation about the hip, not about the group origin at his feet:
  // rotate first, then place the rotated hip on the saddle. Upright, this figure's
  // arms fall 0.2 m short of the handlebars -- its shoulders are 0.68 m above the
  // bars and its arms are 0.67 m long -- so the lean is what puts his hands on them.
  group.rotation.set(-RIDER_LEAN, Math.PI, 0);
  group.scale.setScalar(PASSENGER_SCALE);
  const hip = new THREE.Vector3(0, RIDER_HIP_Y * PASSENGER_SCALE, 0).applyEuler(group.rotation);
  group.position.set(-hip.x, SADDLE_Y - hip.y, SADDLE_Z - hip.z);
  legs.rotation.x = LEG_PEDAL_ANGLE;
  leftArm.rotation.x = ARM_REACH_ANGLE;
  rightArm.rotation.x = ARM_REACH_ANGLE;

  return {
    group,
    body,
    head,
    legs,
    leftArm,
    rightArm,
    materials,
    cap,
    satchel,
  };
}

function buildBike(): { group: THREE.Group; wheels: THREE.Mesh[]; rider: PostmanRider; mats: THREE.Material[] } {
  const group = new THREE.Group();
  group.name = 'postman-bike';
  group.rotation.order = 'YXZ';
  const mats: THREE.Material[] = [];
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xb33a2e, metalness: 0.5, roughness: 0.4 });
  // The same tyre colour as the fragment's own bicycles (0x3b332c): two bikes in one
  // world had two different blacks, and at 0x202020 his tyres were darker than the
  // asphalt, which in a building's shadow left him riding on nothing.
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x3b332c, roughness: 0.7 });
  const bagMat = new THREE.MeshStandardMaterial({ color: 0xc9a14e, roughness: 0.85 });
  mats.push(frameMat, wheelMat, bagMat);

  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.1, 14);
  for (const z of [-WHEELBASE / 2, WHEELBASE / 2]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    // Hub at exactly the wheel radius, so the tread meets the road the group sits on.
    wheel.position.set(0, WHEEL_RADIUS, z);
    group.add(wheel);
    wheels.push(wheel);
  }
  const member = (w: number, h: number, d: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
    mesh.position.set(0, y, z);
    group.add(mesh);
  };
  member(0.07, 0.07, WHEELBASE, 0.6, 0);            // top tube
  member(0.07, 0.44, 0.07, SADDLE_Y - 0.22, SADDLE_Z);
  // The saddle he actually sits on: without it the seat post ended in mid-air.
  member(0.24, 0.06, 0.16, SADDLE_Y - 0.03, SADDLE_Z);
  member(0.07, 0.44, 0.07, BAR_Y - 0.22, BAR_Z);    // head tube
  // 0.66 m across, so the figure's hands land over the grips rather than outboard of them.
  member(0.66, 0.06, 0.06, BAR_Y, BAR_Z);           // handlebars
  const rider = buildPostmanRider(bagMat);
  group.add(rider.group);

  return { group, wheels, rider, mats };
}

function buildDog(): { group: THREE.Group; head: THREE.Mesh; tail: THREE.Mesh; mats: THREE.Material[] } {
  const group = new THREE.Group();
  group.name = 'postman-dog';
  // Built in the same oversized units as the old rider: 1.04 m at the shoulder and
  // 1.48 m long, a pony beside 1.9 m people. Scaled to a real dog instead.
  group.scale.setScalar(0.62);
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
    if (o instanceof THREE.Mesh) o.castShadow = false;
  });
  return { group, head, tail, mats };
}

type DogMode = 'home' | 'chase' | 'returnHome';

export interface PostmanDebugState {
  active: boolean;
  dogMode: DogMode;
  bikeVisible: boolean;
  riderGroupVisible: boolean;
  riderVisible: boolean;
  riderOpacity: number;
  riderMeshCount: number;
  riderHiddenParts: number;
  riderWorldY: number;
  deliveryStops: number[];
  chaseReaction: number;
  eclipseAlert: number;
}

export class Postman {
  private readonly scene: THREE.Scene;
  private readonly bike: ReturnType<typeof buildBike>;
  private readonly dog: ReturnType<typeof buildDog>;
  private readonly dogHome = new THREE.Vector3(DOG_HOME.x, GROUND_SURFACE_Y, DOG_HOME.z);
  private dogMode: DogMode = 'home';
  private dogChaseTime = 0;
  private chaseReaction = 0;
  private eclipseReaction: EclipseWorldReactionState = {
    attention: 0,
    movementScale: 1,
    eyeProtection: 0,
    projection: 0,
    dogAlert: 0,
  };

  private active = false;
  private doneToday = false;
  private t = 0;
  private stopTimer = 0;
  private nextStopIndex = 0;
  private previousT01: number | null = null;
  private deliveryStops: number[] = [];
  private readonly riderWorldPosition = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bike = buildBike();
    this.setBikeVisible(false);
    scene.add(this.bike.group);

    this.dog = buildDog();
    this.dog.group.position.copy(this.dogHome);
    scene.add(this.dog.group);
  }

  update(delta: number, elapsed: number, t01: number): void {
    const isMorning = t01 >= MORNING_START && t01 <= MORNING_END;
    const dayWrapped = this.previousT01 !== null && t01 < this.previousT01 - 0.5;
    if (dayWrapped) this.doneToday = false;
    this.previousT01 = t01;

    // Start the round at dawn.
    if (isMorning && !this.active && !this.doneToday) {
      this.active = true;
      this.t = 0;
      this.nextStopIndex = 0;
      this.stopTimer = 0;
      this.deliveryStops = [];
      this.resetRiderPose();
    }

    const peopleDelta = delta * this.eclipseReaction.movementScale;
    if (this.active) {
      this.updateRide(peopleDelta, elapsed);
    }
    this.setBikeVisible(this.active);

    this.updateDog(delta, elapsed);
  }

  setEclipseReaction(reaction: EclipseWorldReactionState): void {
    this.eclipseReaction = reaction;
  }

  private setBikeVisible(visible: boolean): void {
    this.bike.group.visible = visible;
    this.bike.rider.group.visible = visible;
  }

  private resetRiderPose(): void {
    this.bike.group.rotation.z = 0;
    this.bike.rider.group.rotation.z = 0;
    this.bike.rider.head.rotation.z = 0;
    this.bike.rider.legs.rotation.x = LEG_PEDAL_ANGLE;
    this.bike.rider.leftArm.rotation.x = ARM_REACH_ANGLE;
    this.bike.rider.rightArm.rotation.x = ARM_REACH_ANGLE;
  }

  private updateRide(delta: number, elapsed: number): void {
    if (this.stopTimer > 0) {
      // Delivering — bike stands, rider waves an arm toward the door.
      this.stopTimer -= delta;
      this.chaseReaction += (0 - this.chaseReaction) * Math.min(1, delta * 8);
      this.bike.group.rotation.z = 0;
      this.bike.rider.group.rotation.z = 0;
      this.bike.rider.head.rotation.z = 0;
      this.bike.rider.legs.rotation.x = LEG_PEDAL_ANGLE;
      this.bike.rider.leftArm.rotation.x = ARM_REACH_ANGLE;
      this.bike.rider.rightArm.rotation.x = -1.9 + Math.sin(elapsed * 6) * 0.3;
      return;
    }

    // Sprint a little when the dog is on his heels.
    const dogClose = this.dogMode === 'chase' &&
      this.dog.group.position.distanceTo(this.bike.group.position) < 4.5;
    this.chaseReaction += ((dogClose ? 1 : 0) - this.chaseReaction) * Math.min(1, delta * 7);
    this.t += ((dogClose ? RIDE_SPEED * 1.45 : RIDE_SPEED) * delta) / ROUTE_LENGTH;
    if (this.t >= 1) {
      // Round finished — go home.
      this.active = false;
      this.doneToday = true;
      this.resetRiderPose();
      return;
    }

    // Pause at the next mail stop when we reach it.
    if (this.nextStopIndex < POSTMAN_STOP_TS.length && this.t >= POSTMAN_STOP_TS[this.nextStopIndex]) {
      this.stopTimer = STOP_DURATION;
      this.deliveryStops.push(POSTMAN_STOP_TS[this.nextStopIndex]);
      this.nextStopIndex += 1;
    }

    const p = POSTMAN_ROUTE_CURVE.getPointAt(this.t);
    const tangent = POSTMAN_ROUTE_CURVE.getTangentAt(this.t).normalize();
    // The route is stored at y=0; the road is the ground plane, and the bicycle is
    // modelled with its tread at the group origin.
    this.bike.group.position.set(p.x, GROUND_SURFACE_Y, p.z);

    const wheelSpin = (RIDE_SPEED * delta) / WHEEL_RADIUS;
    for (const wheel of this.bike.wheels) wheel.rotation.x += wheelSpin;

    // Pedalling legs + a controlled wobble when the dog reaches the bicycle.
    const dogWobble = Math.sin(elapsed * 9.5) * 0.075 * this.chaseReaction;
    const yaw = Math.atan2(-tangent.x, -tangent.z); // bicycle front is local -Z
    this.bike.rider.legs.rotation.x = LEG_PEDAL_ANGLE + Math.sin(elapsed * 9) * 0.3;
    this.bike.group.rotation.set(0, yaw, Math.sin(elapsed * 1.3) * 0.02 + dogWobble);
    this.bike.rider.group.rotation.z = -dogWobble * 0.7;
    this.bike.rider.head.rotation.z = dogWobble * 0.45;
    this.bike.rider.rightArm.rotation.x = ARM_REACH_ANGLE;
    this.bike.rider.leftArm.rotation.x = ARM_REACH_ANGLE;
  }

  private updateDog(delta: number, elapsed: number): void {
    const alert = this.eclipseReaction.dogAlert;
    this.dog.head.rotation.x += (-0.62 * alert - this.dog.head.rotation.x) * Math.min(1, delta * 5);
    if (alert > 0.35) {
      if (this.dogMode === 'chase') {
        this.dogChaseTime -= delta;
        if (this.dogChaseTime <= 0 || !this.active) this.dogMode = 'returnHome';
      }
      this.dog.group.position.y = GROUND_SURFACE_Y;
      this.dog.tail.rotation.y = Math.sin(elapsed * 1.8) * 0.12 * (1 - alert);
      return;
    }

    const postmanNear =
      this.active &&
      this.stopTimer <= 0 &&
      this.bike.group.position.distanceTo(this.dog.group.position) < 8;

    if (this.dogMode === 'home') {
      // Naps / sniffs around its yard.
      this.dog.group.position.set(
        this.dogHome.x + Math.sin(elapsed * 0.4) * 0.4,
        GROUND_SURFACE_Y,
        this.dogHome.z + Math.cos(elapsed * 0.3) * 0.4
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
      this.dog.group.position.y = GROUND_SURFACE_Y + Math.abs(Math.sin(elapsed * 11)) * 0.12; // excited hops
      this.dog.tail.rotation.y = Math.sin(elapsed * 14) * 0.6;
      if (this.dogChaseTime <= 0 || !this.active) {
        this.dogMode = 'returnHome';
      }
    } else {
      // Trot back to the yard.
      const dx = this.dogHome.x - this.dog.group.position.x;
      const dz = this.dogHome.z - this.dog.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.4) {
        this.dogMode = 'home';
      } else {
        const step = Math.min(dist, 3 * delta);
        this.dog.group.position.x += (dx / dist) * step;
        this.dog.group.position.z += (dz / dist) * step;
        this.dog.group.rotation.y = Math.atan2(dx, dz) + Math.PI;
        this.dog.group.position.y = GROUND_SURFACE_Y + Math.abs(Math.sin(elapsed * 7)) * 0.08;
      }
    }
  }

  getDebugState(): PostmanDebugState {
    let riderMeshCount = 0;
    let riderHiddenParts = 0;
    this.bike.rider.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      riderMeshCount += 1;
      if (!object.visible) riderHiddenParts += 1;
    });
    this.bike.rider.head.getWorldPosition(this.riderWorldPosition);
    return {
      active: this.active,
      dogMode: this.dogMode,
      bikeVisible: this.bike.group.visible,
      riderGroupVisible: this.bike.rider.group.visible,
      riderVisible: this.bike.group.visible && this.bike.rider.group.visible,
      riderOpacity: Math.min(...this.bike.rider.materials.map((material) => material.opacity)),
      riderMeshCount,
      riderHiddenParts,
      riderWorldY: this.riderWorldPosition.y,
      deliveryStops: [...this.deliveryStops],
      chaseReaction: this.chaseReaction,
      eclipseAlert: this.eclipseReaction.dogAlert,
    };
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
