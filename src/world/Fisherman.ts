import * as THREE from 'three';
import { FISHERMAN_HOME, FISHERMAN_SPOT, GROUND_SURFACE_Y, LAKE } from './WorldLayout';
import { buildPassenger, PASSENGER_SCALE, type PassengerBuild } from './PassengerCrowd';

/**
 * The fisherman. Lives in the block just west of the lake: he walks out of
 * his door early in the morning, sits down on his stool right at the water
 * line (cap on, tackle box beside him) and casts. Every few bites he hooks
 * THE fish — as big as himself — which thrashes over his head and escapes.
 * In the evening he walks back home. In winter he moves onto the frozen lake.
 */

type LifeMode = 'home' | 'walkOut' | 'fishing' | 'walkHome';
type FishPhase = 'idle' | 'bite' | 'fight' | 'fishFlight' | 'rest';
type SeatKind = 'shore' | 'ice';

const WATER_Y = -0.45;
const ICE_Y = -0.28;
export const ICE_SURFACE_Y = -0.39;
const SHORE_STOOL_SEAT_CENTER_Y = 0.62;
const SHORE_STOOL_SEAT_HEIGHT = 0.12;
const ICE_STOOL_SEAT_CENTER_Y = 0.68;
const ICE_STOOL_SEAT_HEIGHT = 0.12;
const SHORE_STOOL_TOP_Y =
  GROUND_SURFACE_Y + SHORE_STOOL_SEAT_CENTER_Y + SHORE_STOOL_SEAT_HEIGHT / 2;
const ICE_STOOL_TOP_Y =
  ICE_SURFACE_Y + ICE_STOOL_SEAT_CENTER_Y + ICE_STOOL_SEAT_HEIGHT / 2;
const SEATED_BODY_CLEARANCE = 0.035;
export const FISHERMAN_SEATED_BODY_BOTTOM_OFFSET = (1.4 - 0.95 / 2) * PASSENGER_SCALE;
const SHORE_SEATED_Y =
  SHORE_STOOL_TOP_Y + SEATED_BODY_CLEARANCE - FISHERMAN_SEATED_BODY_BOTTOM_OFFSET;
export const ICE_SEATED_Y =
  ICE_STOOL_TOP_Y + SEATED_BODY_CLEARANCE - FISHERMAN_SEATED_BODY_BOTTOM_OFFSET;
const WALK_SPEED = 1.7;

export class Fisherman {
  private readonly scene: THREE.Scene;
  private readonly figure: PassengerBuild;
  private readonly seatedLegGroup = new THREE.Group();
  private readonly seatedShins: THREE.Mesh[] = [];
  private readonly seatedShoes: THREE.Mesh[] = [];
  private readonly spotGroup = new THREE.Group(); // shore stool + tackle box
  private readonly iceGearGroup = new THREE.Group();
  private readonly rod: THREE.Mesh;
  private readonly line: THREE.Line;
  private readonly linePositions: Float32Array;
  private readonly float: THREE.Mesh;
  private readonly bigFish: THREE.Group;
  private readonly splash: THREE.Mesh;
  private readonly splashMaterial: THREE.MeshBasicMaterial;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private readonly heading: number;
  private readonly shoreSeat = new THREE.Vector3(FISHERMAN_SPOT.x, 0, FISHERMAN_SPOT.z);
  private readonly iceSeat = new THREE.Vector3(LAKE.x + 1, 0, LAKE.z);
  private readonly seatPos = new THREE.Vector3(FISHERMAN_SPOT.x, 0, FISHERMAN_SPOT.z);
  private readonly homePos = new THREE.Vector3(FISHERMAN_HOME.x, 0, FISHERMAN_HOME.z);
  private readonly walkPos = new THREE.Vector3();
  private readonly floatHome = new THREE.Vector3();
  private readonly rodTip = new THREE.Vector3();
  private readonly iceHole: THREE.Mesh;

  private mode: LifeMode = 'home';
  private seatKind: SeatKind = 'shore';
  private phase: FishPhase = 'idle';
  private phaseTimer = 5;
  private fishT = 0;

  // ── Hologram (cyberpunk) ──
  private hologram = false;
  private holoOriginals: Array<{ mat: THREE.MeshStandardMaterial; color: number }> | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.heading = Math.atan2(LAKE.x - FISHERMAN_SPOT.x, LAKE.z - FISHERMAN_SPOT.z);

    // ── Permanent props at the spot: stool + tackle box ──
    this.spotGroup.position.copy(this.seatPos);
    this.spotGroup.position.y = GROUND_SURFACE_Y;
    this.spotGroup.rotation.y = this.heading;
    this.spotGroup.name = 'fisherman-shore-gear';
    scene.add(this.spotGroup);

    const stoolMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.9 });
    const stoolLegMat = new THREE.MeshStandardMaterial({ color: 0x3e2a18, roughness: 0.82 });
    const stoolSeatGeo = new THREE.BoxGeometry(0.84, SHORE_STOOL_SEAT_HEIGHT, 0.72);
    const stoolLegGeo = new THREE.BoxGeometry(0.1, 0.58, 0.1);
    this.disposables.push(stoolMat, stoolLegMat, stoolSeatGeo, stoolLegGeo);
    const stoolSeat = new THREE.Mesh(stoolSeatGeo, stoolMat);
    stoolSeat.name = 'fisherman-shore-stool-seat';
    stoolSeat.position.y = SHORE_STOOL_SEAT_CENTER_Y;
    stoolSeat.castShadow = false;
    this.spotGroup.add(stoolSeat);
    for (const x of [-0.3, 0.3]) {
      for (const z of [-0.23, 0.23]) {
        const leg = new THREE.Mesh(stoolLegGeo, stoolLegMat);
        leg.position.set(x, 0.29, z);
        leg.rotation.z = Math.sign(x) * 0.12;
        leg.rotation.x = -Math.sign(z) * 0.08;
        leg.castShadow = false;
        this.spotGroup.add(leg);
      }
    }

    const boxMat = new THREE.MeshStandardMaterial({ color: 0x2e6b3a, roughness: 0.7 });
    const boxLidMat = new THREE.MeshStandardMaterial({ color: 0x9ecf6a, roughness: 0.6 });
    const boxGeo = new THREE.BoxGeometry(0.9, 0.45, 0.5);
    const lidGeo = new THREE.BoxGeometry(0.92, 0.12, 0.52);
    const handleGeo = new THREE.BoxGeometry(0.3, 0.08, 0.08);
    this.disposables.push(boxMat, boxLidMat, boxGeo, lidGeo, handleGeo);
    const tackleBox = new THREE.Mesh(boxGeo, boxMat);
    tackleBox.position.set(1.1, 0.23, 0.2);
    tackleBox.castShadow = false;
    this.spotGroup.add(tackleBox);
    const lid = new THREE.Mesh(lidGeo, boxLidMat);
    lid.position.set(1.1, 0.5, 0.2);
    this.spotGroup.add(lid);
    const handle = new THREE.Mesh(handleGeo, boxLidMat);
    handle.position.set(1.1, 0.62, 0.2);
    this.spotGroup.add(handle);

    // ── Winter gear: a folding stool and insulated tackle box on the ice ──
    this.iceGearGroup.name = 'fisherman-ice-gear';
    this.iceGearGroup.position.set(this.iceSeat.x, ICE_SURFACE_Y, this.iceSeat.z);
    this.iceGearGroup.rotation.y = this.heading;
    this.iceGearGroup.visible = false;
    scene.add(this.iceGearGroup);

    const iceSeatMat = new THREE.MeshStandardMaterial({ color: 0x315979, roughness: 0.72 });
    const iceLegMat = new THREE.MeshStandardMaterial({ color: 0x5d6872, metalness: 0.55, roughness: 0.42 });
    const iceBoxMat = new THREE.MeshStandardMaterial({ color: 0xd5d9d6, roughness: 0.62 });
    const iceBoxLidMat = new THREE.MeshStandardMaterial({ color: 0x315979, roughness: 0.55 });
    const iceSeatGeo = new THREE.BoxGeometry(0.9, ICE_STOOL_SEAT_HEIGHT, 0.76);
    const iceLegGeo = new THREE.BoxGeometry(0.09, 0.72, 0.09);
    const iceBoxGeo = new THREE.BoxGeometry(0.62, 0.52, 0.62);
    const iceBoxLidGeo = new THREE.BoxGeometry(0.66, 0.1, 0.66);
    this.disposables.push(
      iceSeatMat,
      iceLegMat,
      iceBoxMat,
      iceBoxLidMat,
      iceSeatGeo,
      iceLegGeo,
      iceBoxGeo,
      iceBoxLidGeo
    );

    const iceStoolSeat = new THREE.Mesh(iceSeatGeo, iceSeatMat);
    iceStoolSeat.name = 'fisherman-ice-stool-seat';
    iceStoolSeat.position.y = ICE_STOOL_SEAT_CENTER_Y;
    iceStoolSeat.castShadow = false;
    this.iceGearGroup.add(iceStoolSeat);

    for (const x of [-0.31, 0.31]) {
      for (const z of [-0.24, 0.24]) {
        const leg = new THREE.Mesh(iceLegGeo, iceLegMat);
        leg.position.set(x, 0.32, z);
        leg.rotation.z = Math.sign(x) * 0.23;
        leg.rotation.x = -Math.sign(z) * 0.14;
        leg.castShadow = false;
        this.iceGearGroup.add(leg);
      }
    }

    const iceBox = new THREE.Mesh(iceBoxGeo, iceBoxMat);
    iceBox.name = 'fisherman-ice-tackle-box';
    iceBox.position.set(1.05, 0.27, 0.15);
    iceBox.castShadow = false;
    this.iceGearGroup.add(iceBox);
    const iceBoxLid = new THREE.Mesh(iceBoxLidGeo, iceBoxLidMat);
    iceBoxLid.position.set(1.05, 0.57, 0.15);
    iceBoxLid.castShadow = false;
    this.iceGearGroup.add(iceBoxLid);

    // ── The fisherman himself, with a cap ──
    this.figure = buildPassenger();
    this.figure.group.name = 'fisherman';
    this.seatedLegGroup.name = 'fisherman-seated-legs';
    this.seatedLegGroup.visible = false;
    this.figure.group.add(this.seatedLegGroup);
    const seatedLegMaterial = new THREE.MeshStandardMaterial({
      color: 0x26384a,
      roughness: 0.85,
      transparent: true,
      opacity: 0,
    });
    this.figure.materials.push(seatedLegMaterial);
    const thighGeometry = new THREE.BoxGeometry(0.24, 0.22, 0.74);
    const shinGeometry = new THREE.BoxGeometry(0.21, 1, 0.21);
    const shoeGeometry = new THREE.BoxGeometry(0.25, 0.14, 0.42);
    for (const [index, x] of [-0.19, 0.19].entries()) {
      const thigh = new THREE.Mesh(thighGeometry, seatedLegMaterial);
      thigh.name = `fisherman-seated-thigh-${index}`;
      thigh.position.set(x, 1.01, 0.34);
      thigh.castShadow = false;
      this.seatedLegGroup.add(thigh);

      const shin = new THREE.Mesh(shinGeometry, seatedLegMaterial);
      shin.name = `fisherman-seated-shin-${index}`;
      shin.position.x = x;
      shin.position.z = 0.71;
      shin.castShadow = false;
      this.seatedLegGroup.add(shin);
      this.seatedShins.push(shin);

      const shoe = new THREE.Mesh(shoeGeometry, seatedLegMaterial);
      shoe.name = `fisherman-seated-shoe-${index}`;
      shoe.position.x = x;
      shoe.position.z = 0.83;
      shoe.castShadow = false;
      this.seatedLegGroup.add(shoe);
      this.seatedShoes.push(shoe);
    }
    const capMat = new THREE.MeshStandardMaterial({ color: 0x2b5f9a, roughness: 0.7, transparent: true });
    this.disposables.push(capMat);
    const capTop = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.16, 0.62), capMat);
    capTop.position.y = 2.5;
    this.figure.group.add(capTop);
    const capBrim = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.4), capMat);
    capBrim.position.set(0, 2.42, -0.42); // brim forward (model faces -Z... +Z when rotated)
    this.figure.group.add(capBrim);
    this.figure.materials.push(capMat);
    this.figure.group.visible = false;
    scene.add(this.figure.group);

    // ── Rod (visible only while fishing) — long, held over the water ──
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x3a2a16, roughness: 0.6 });
    const rodGeo = new THREE.BoxGeometry(0.1, 0.1, 3.8);
    this.disposables.push(rodMat, rodGeo);
    this.rod = new THREE.Mesh(rodGeo, rodMat);
    this.rod.castShadow = false;
    this.rod.visible = false;
    scene.add(this.rod);

    // ── Line + float ──
    this.linePositions = new Float32Array(6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xeeeeee, transparent: true, opacity: 0.7 });
    this.disposables.push(lineGeo, lineMat);
    this.line = new THREE.Line(lineGeo, lineMat);
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);

    const floatGeo = new THREE.SphereGeometry(0.15, 8, 6);
    const floatMat = new THREE.MeshStandardMaterial({ color: 0xd03a30, roughness: 0.4 });
    this.disposables.push(floatGeo, floatMat);
    this.float = new THREE.Mesh(floatGeo, floatMat);
    this.floatHome.set(
      FISHERMAN_SPOT.x + Math.sin(this.heading) * 5,
      WATER_Y,
      FISHERMAN_SPOT.z + Math.cos(this.heading) * 5
    );
    this.float.position.copy(this.floatHome);
    this.float.visible = false;
    scene.add(this.float);

    // ── THE fish ──
    this.bigFish = new THREE.Group();
    const fishMat = new THREE.MeshStandardMaterial({ color: 0x7da3b8, metalness: 0.5, roughness: 0.35 });
    const fishBodyGeo = new THREE.BoxGeometry(0.6, 0.7, 2.2);
    const fishTailGeo = new THREE.BoxGeometry(0.12, 0.8, 0.5);
    this.disposables.push(fishMat, fishBodyGeo, fishTailGeo);
    const fishBody = new THREE.Mesh(fishBodyGeo, fishMat);
    this.bigFish.add(fishBody);
    const fishTail = new THREE.Mesh(fishTailGeo, fishMat);
    fishTail.position.z = 1.3;
    this.bigFish.add(fishTail);
    this.bigFish.visible = false;
    scene.add(this.bigFish);

    // ── Ice hole (przerębel) — visible only while ice fishing ──
    const holeGeo = new THREE.CircleGeometry(0.7, 16);
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x10303f, roughness: 0.25, metalness: 0.4 });
    this.disposables.push(holeGeo, holeMat);
    this.iceHole = new THREE.Mesh(holeGeo, holeMat);
    this.iceHole.rotation.x = -Math.PI / 2;
    this.iceHole.visible = false;
    scene.add(this.iceHole);

    // ── Splash ring ──
    const splashGeo = new THREE.RingGeometry(0.3, 1.2, 18);
    this.splashMaterial = new THREE.MeshBasicMaterial({
      color: 0xc8e0ec,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.disposables.push(splashGeo, this.splashMaterial);
    this.splash = new THREE.Mesh(splashGeo, this.splashMaterial);
    this.splash.rotation.x = -Math.PI / 2;
    this.splash.position.set(this.floatHome.x, WATER_Y + 0.03, this.floatHome.z);
    scene.add(this.splash);
  }

  update(delta: number, elapsed: number, night: number, snowCover: number): void {
    // Deep winter: the lake freezes and he fishes through an ice hole
    // in the MIDDLE of the lake instead of from the shore.
    // Leave the ice while it is still visibly solid and enter only after a
    // sustained freeze. The hysteresis avoids a thaw transition through water.
    const frozen = this.seatKind === 'ice' ? snowCover > 0.7 : snowCover > 0.8;
    const wantSeat: SeatKind = frozen ? 'ice' : 'shore';

    // ── Daily routine transitions ──
    if (this.mode === 'home' && night < 0.45) {
      this.mode = 'walkOut';
      this.seatKind = wantSeat;
      this.applySeat();
      this.walkPos.copy(this.homePos);
      this.figure.group.visible = true;
      for (const mat of this.figure.materials) mat.opacity = 0.95;
    } else if (this.mode === 'fishing' && night > 0.55) {
      this.mode = 'walkHome';
      this.walkPos.copy(this.seatPos);
      this.setFishingGear(false);
    } else if (this.mode === 'fishing' && this.seatKind !== wantSeat) {
      // The lake just froze (or thawed) — walk to the other spot.
      this.setFishingGear(false);
      this.walkPos.copy(this.seatPos);
      this.seatKind = wantSeat;
      this.applySeat();
      this.mode = 'walkOut';
    }

    this.updateHologramLook(elapsed);
    if (this.mode === 'home') return;

    const f = this.figure;

    // ── Walking legs (out in the morning / home in the evening) ──
    if (this.mode === 'walkOut' || this.mode === 'walkHome') {
      const target = this.mode === 'walkOut' ? this.seatPos : this.homePos;
      const dx = target.x - this.walkPos.x;
      const dz = target.z - this.walkPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.3) {
        if (this.mode === 'walkOut') {
          this.mode = 'fishing';
          this.setFishingGear(true);
          this.phase = 'idle';
          this.phaseTimer = 4;
        } else {
          this.mode = 'home';
          f.group.visible = false;
        }
        return;
      }
      const step = Math.min(dist, WALK_SPEED * delta);
      this.walkPos.x += (dx / dist) * step;
      this.walkPos.z += (dz / dist) * step;
      f.group.position.set(
        this.walkPos.x,
        this.walkingSurfaceY(this.walkPos.x, this.walkPos.z) + Math.abs(Math.sin(elapsed * 7)) * 0.05,
        this.walkPos.z
      );
      f.group.rotation.y = Math.atan2(dx, dz);
      f.legs.rotation.x = Math.sin(elapsed * 7) * 0.3;
      f.leftArm.rotation.x = Math.sin(elapsed * 7) * 0.5;
      f.rightArm.rotation.x = -Math.sin(elapsed * 7) * 0.5;
      return;
    }

    // ── Fishing (seated) ──
    const seatedY = this.seatKind === 'ice' ? ICE_SEATED_Y : SHORE_SEATED_Y;
    f.group.position.set(this.seatPos.x, seatedY, this.seatPos.z);
    f.group.rotation.y = this.heading;
    this.updateSeatedLegPose(seatedY);
    f.leftArm.rotation.x = -0.6;
    f.rightArm.rotation.x = -0.9; // holds the rod
    f.head.rotation.y = Math.sin(elapsed * 0.5) * 0.2;
    f.body.position.y = 1.4 + Math.sin(elapsed * 1.2) * 0.015;

    // Rod follows the figure. After the yaw, local +Z points toward the
    // lake — that's the TIP end; negative pitch raises it over the water.
    this.rod.position.set(
      this.seatPos.x + Math.sin(this.heading) * 1.1,
      seatedY + 0.85,
      this.seatPos.z + Math.cos(this.heading) * 1.1
    );
    this.rod.rotation.set(0, this.heading, 0);
    this.rod.rotateX(-(0.45 + (this.phase === 'fight' || this.phase === 'fishFlight' ? 0.4 : 0)));

    this.phaseTimer -= delta;
    switch (this.phase) {
      case 'idle':
        this.float.position.y = this.floatHome.y + Math.sin(elapsed * 1.6) * 0.05;
        if (this.phaseTimer <= 0) {
          this.phase = 'bite';
          this.phaseTimer = 1.3;
        }
        break;
      case 'bite':
        this.float.position.y = this.floatHome.y + Math.sin(elapsed * 22) * 0.12 - 0.08;
        if (this.phaseTimer <= 0) {
          if (Math.random() < 0.4) {
            this.phase = 'fishFlight';
            this.fishT = 0;
            this.bigFish.visible = true;
          } else {
            this.phase = 'fight';
            this.phaseTimer = 0.7;
          }
        }
        break;
      case 'fight':
        if (this.phaseTimer <= 0) {
          this.phase = 'rest';
          this.phaseTimer = 1.2;
        }
        break;
      case 'fishFlight': {
        this.fishT = Math.min(1, this.fishT + delta / 1.6);
        const t = this.fishT;
        const arcY = 3.8 * 4 * t * (1 - t);
        this.bigFish.position.set(
          THREE.MathUtils.lerp(this.floatHome.x, this.floatHome.x + 2.5, t),
          this.floatHome.y + arcY,
          THREE.MathUtils.lerp(this.floatHome.z, this.floatHome.z + 3.5, t)
        );
        this.bigFish.rotation.y = elapsed * 2;
        this.bigFish.rotation.z = Math.sin(elapsed * 14) * 0.4;

        const splashAmount = t < 0.18 ? 1 - t / 0.18 : t > 0.85 ? (t - 0.85) / 0.15 : 0;
        this.splashMaterial.opacity = splashAmount * 0.8;
        this.splash.scale.setScalar(0.6 + (1 - splashAmount) * 1.6);

        if (t >= 1) {
          this.bigFish.visible = false;
          this.phase = 'rest';
          this.phaseTimer = 2;
        }
        break;
      }
      case 'rest':
        this.float.position.y = this.floatHome.y;
        this.splashMaterial.opacity = Math.max(0, this.splashMaterial.opacity - delta * 1.2);
        if (this.phaseTimer <= 0) {
          this.phase = 'idle';
          this.phaseTimer = 7 + Math.random() * 9;
        }
        break;
    }

    // Line from the rod TIP (the raised, lake-side end) to the float.
    this.rod.updateMatrixWorld();
    this.rodTip.set(0, 0, 1.9).applyMatrix4(this.rod.matrixWorld);
    const end = this.bigFish.visible ? this.bigFish.position : this.float.position;
    this.linePositions[0] = this.rodTip.x;
    this.linePositions[1] = this.rodTip.y;
    this.linePositions[2] = this.rodTip.z;
    this.linePositions[3] = end.x;
    this.linePositions[4] = end.y;
    this.linePositions[5] = end.z;
    (this.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Point seat-dependent props (float, splash, hole) at the active seat. */
  private applySeat(): void {
    const onIce = this.seatKind === 'ice';
    this.seatPos.copy(onIce ? this.iceSeat : this.shoreSeat);
    const reach = onIce ? 1.7 : 5;
    this.floatHome.set(
      this.seatPos.x + Math.sin(this.heading) * reach,
      onIce ? ICE_Y : WATER_Y,
      this.seatPos.z + Math.cos(this.heading) * reach
    );
    this.float.position.copy(this.floatHome);
    this.splash.position.set(this.floatHome.x, this.floatHome.y + 0.03, this.floatHome.z);
    this.iceHole.position.set(this.floatHome.x, ICE_Y + 0.01, this.floatHome.z);
    this.iceHole.visible = onIce;
    this.spotGroup.visible = !onIce;
    this.iceGearGroup.visible = onIce;
  }

  private walkingSurfaceY(x: number, z: number): number {
    if (this.seatKind !== 'ice') return GROUND_SURFACE_Y;
    const nx = (x - LAKE.x) / LAKE.radiusX;
    const nz = (z - LAKE.z) / LAKE.radiusZ;
    const radial = Math.hypot(nx, nz);
    const shoreBlend = THREE.MathUtils.smoothstep(radial, 0.82, 1.02);
    return THREE.MathUtils.lerp(ICE_SURFACE_Y + 0.02, GROUND_SURFACE_Y, shoreBlend);
  }

  private updateSeatedLegPose(seatedY: number): void {
    const surfaceY = this.seatKind === 'ice' ? ICE_SURFACE_Y : GROUND_SURFACE_Y;
    const localSurfaceY = (surfaceY - seatedY) / PASSENGER_SCALE;
    const shoeCenterY = localSurfaceY + 0.07;
    const shinBottomY = localSurfaceY + 0.14;
    const shinTopY = 0.95;
    const shinLength = Math.max(0.2, shinTopY - shinBottomY);
    for (const shin of this.seatedShins) {
      shin.position.y = (shinTopY + shinBottomY) / 2;
      shin.scale.y = shinLength;
    }
    for (const shoe of this.seatedShoes) shoe.position.y = shoeCenterY;
  }

  debugSetWinterFishing(): void {
    this.seatKind = 'ice';
    this.applySeat();
    this.mode = 'fishing';
    this.figure.group.visible = true;
    for (const material of this.figure.materials) material.opacity = 0.95;
    this.setFishingGear(true);
  }

  debugSetShoreFishing(): void {
    this.seatKind = 'shore';
    this.applySeat();
    this.mode = 'fishing';
    this.figure.group.visible = true;
    for (const material of this.figure.materials) material.opacity = 0.95;
    this.setFishingGear(true);
  }

  getDebugState(): {
    mode: LifeMode;
    seatKind: SeatKind;
    figureY: number;
    iceGearVisible: boolean;
    shoreGearVisible: boolean;
    seatedLegsVisible: boolean;
    standingLegsVisible: boolean;
  } {
    return {
      mode: this.mode,
      seatKind: this.seatKind,
      figureY: this.figure.group.position.y,
      iceGearVisible: this.iceGearGroup.visible,
      shoreGearVisible: this.spotGroup.visible,
      seatedLegsVisible: this.seatedLegGroup.visible,
      standingLegsVisible: this.figure.legs.visible,
    };
  }

  /** Cyberpunk: the fisherman becomes a flickering cyan hologram. */
  setHologram(on: boolean): void {
    if (on === this.hologram) return;
    this.hologram = on;
    if (on && !this.holoOriginals) {
      this.holoOriginals = this.figure.materials.map((mat) => ({ mat, color: mat.color.getHex() }));
    }
    if (!on && this.holoOriginals) {
      for (const { mat, color } of this.holoOriginals) {
        mat.color.setHex(color);
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
        mat.opacity = 0.95;
      }
    }
  }

  private updateHologramLook(elapsed: number): void {
    if (!this.hologram) return;
    const flicker = 0.75 + 0.25 * Math.sin(elapsed * 38) * Math.sin(elapsed * 7.3);
    for (const mat of this.figure.materials) {
      mat.color.setHex(0x0a2a33);
      mat.emissive.setHex(0x16e0ff);
      mat.emissiveIntensity = 0.9 * flicker;
      mat.opacity = 0.42 + 0.1 * flicker;
    }
  }

  private setFishingGear(on: boolean): void {
    this.rod.visible = on;
    this.line.visible = on;
    this.float.visible = on;
    this.figure.legs.visible = !on;
    this.seatedLegGroup.visible = on;
    if (!on) {
      this.bigFish.visible = false;
      this.splashMaterial.opacity = 0;
      const f = this.figure;
      f.legs.rotation.x = 0;
      f.leftArm.rotation.x = 0;
      f.rightArm.rotation.x = 0;
    }
  }

  dispose(): void {
    this.scene.remove(
      this.spotGroup, this.iceGearGroup, this.figure.group, this.rod, this.line, this.float,
      this.bigFish, this.splash, this.iceHole
    );
    this.figure.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const mat of this.figure.materials) mat.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
