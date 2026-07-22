import * as THREE from 'three';
import { COW_MEADOW, GROUND_SURFACE_Y, KIOSK_MAIN, LAKE } from './WorldLayout';
import { buildPassenger, easeInOut, type PassengerBuild } from './PassengerCrowd';
import { fallbackRandom, type RandomSource } from '../core/Random';

/**
 * A voxel cow grazing in the meadow by the lake.
 *
 * Daily routine:
 *  - day: grazes (head down, nibbling), wanders a few metres at a time,
 *  - night: lies down and sleeps…
 *  - …unless it's an ABDUCTION night: a flying saucer glides in, hovers,
 *    pulls the cow up in a light beam and leaves. The NEXT night it returns
 *    the cow the same way. Nights alternate: abduct → return → abduct → …
 *
 * The FARMER from the block next door reacts: the morning after an
 * abduction he walks out, searches the meadow, scratches his head and shakes
 * his fist at the sky. The morning after the cow comes back he walks out
 * again, pats her happily and goes home.
 */

// Meadow just east of the lake shore (anchor shared with the layout tests).
const MEADOW = COW_MEADOW;

/**
 * Keep a ground position OUT of the lake (ellipse + shoreline margin).
 * Pushes the point radially back onto dry land if it falls inside.
 */
function clampOutsideLake(point: THREE.Vector3, margin = 3.5): void {
  const rx = LAKE.radiusX + margin;
  const rz = LAKE.radiusZ + margin;
  const nx = (point.x - LAKE.x) / rx;
  const nz = (point.z - LAKE.z) / rz;
  const d = Math.sqrt(nx * nx + nz * nz);
  if (d >= 1 || d < 1e-6) return;
  point.x = LAKE.x + (nx / d) * rx;
  point.z = LAKE.z + (nz / d) * rz;
}
const HOVER_Y = 20;
const BEAM_TOP_OFFSET = 2.2; // cow disappears this far below the saucer

type CowMode = 'graze' | 'walk' | 'sleep' | 'lifted' | 'absent';
type UfoMode = 'hidden' | 'arriving' | 'beamFadeIn' | 'beaming' | 'beamFadeOut' | 'leaving';
type UfoEvent = 'abduct' | 'return' | 'kioskRaid';

// ── Farmer ──
// Door of the building right next to the meadow (block at x:-14, z:56).
const FARMER_DOOR = new THREE.Vector3(-15.4, 0.5, 58.5);

type FarmerAct = 'walk' | 'look' | 'scratch' | 'fist' | 'pat';

interface FarmerStep {
  act: FarmerAct;
  target?: THREE.Vector3;
  duration?: number;
}

function buildFarmer(random: RandomSource): PassengerBuild {
  const farmer = buildPassenger(random);
  // A straw hat so he reads as "the farmer", not a commuter.
  const hatMat = new THREE.MeshStandardMaterial({ color: 0xc9a14e, roughness: 0.9 });
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.08, 0.85), hatMat);
  brim.position.y = 2.5;
  farmer.group.add(brim);
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.22, 0.45), hatMat);
  crown.position.y = 2.63;
  farmer.group.add(crown);
  farmer.materials.push(hatMat);
  return farmer;
}

interface CowParts {
  group: THREE.Group;
  headGroup: THREE.Group;
  legs: THREE.Mesh[];
  tail: THREE.Mesh;
  body: THREE.Mesh;
}

function buildCow(): { parts: CowParts; disposables: Array<{ dispose: () => void }> } {
  const disposables: Array<{ dispose: () => void }> = [];
  const white = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.85 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1f1d1c, roughness: 0.9 });
  const pink = new THREE.MeshStandardMaterial({ color: 0xd99a9a, roughness: 0.8 });
  disposables.push(white, black, pink);

  const group = new THREE.Group();
  const make = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
  };

  // Body (front faces -Z, same convention as the other vehicles)
  const body = make(new THREE.BoxGeometry(1.0, 1.0, 1.8), white);
  body.position.y = 1.0;
  group.add(body);

  // Black patches
  const patch1 = make(new THREE.BoxGeometry(1.04, 0.5, 0.6), black);
  patch1.position.set(0, 1.15, 0.45);
  group.add(patch1);
  const patch2 = make(new THREE.BoxGeometry(0.5, 1.04, 0.55), black);
  patch2.position.set(0.28, 1.0, -0.35);
  group.add(patch2);

  // Head on a small pivot so it can dip to graze
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 1.35, -0.95);
  const head = make(new THREE.BoxGeometry(0.55, 0.55, 0.55), white);
  head.position.set(0, 0, -0.25);
  headGroup.add(head);
  const muzzle = make(new THREE.BoxGeometry(0.4, 0.26, 0.2), pink);
  muzzle.position.set(0, -0.16, -0.58);
  headGroup.add(muzzle);
  for (const side of [-1, 1]) {
    const ear = make(new THREE.BoxGeometry(0.2, 0.1, 0.16), black);
    ear.position.set(side * 0.36, 0.2, -0.2);
    headGroup.add(ear);
  }
  group.add(headGroup);

  // Legs
  const legs: THREE.Mesh[] = [];
  for (const lz of [-0.62, 0.62]) {
    for (const lx of [-0.32, 0.32]) {
      const leg = make(new THREE.BoxGeometry(0.22, 0.7, 0.22), white);
      leg.position.set(lx, 0.35, lz);
      group.add(leg);
      legs.push(leg);
    }
  }

  // Tail + udder
  const tail = make(new THREE.BoxGeometry(0.1, 0.6, 0.1), white);
  tail.position.set(0, 1.25, 0.95);
  group.add(tail);
  const udder = make(new THREE.BoxGeometry(0.45, 0.25, 0.5), pink);
  udder.position.set(0, 0.48, 0.45);
  group.add(udder);

  return { parts: { group, headGroup, legs, tail, body }, disposables };
}

interface UfoParts {
  group: THREE.Group;
  lightRing: THREE.Group;
  beamMaterial: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  glow: THREE.PointLight;
}

function buildUfo(): { parts: UfoParts; disposables: Array<{ dispose: () => void }> } {
  const disposables: Array<{ dispose: () => void }> = [];
  const group = new THREE.Group();

  const hull = new THREE.MeshStandardMaterial({ color: 0x9aa7b5, metalness: 0.9, roughness: 0.25 });
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0x66e0ff,
    metalness: 0.3,
    roughness: 0.1,
    emissive: 0x2299cc,
    emissiveIntensity: 0.5,
  });
  const hubMat = new THREE.MeshStandardMaterial({
    color: 0x7af2ff,
    emissive: 0x7af2ff,
    emissiveIntensity: 1.4,
  });
  disposables.push(hull, domeMat, hubMat);

  const discGeo = new THREE.CylinderGeometry(2.5, 1.7, 0.5, 24);
  disposables.push(discGeo);
  const disc = new THREE.Mesh(discGeo, hull);
  disc.castShadow = true;
  group.add(disc);

  const domeGeo = new THREE.SphereGeometry(1.0, 18, 12);
  disposables.push(domeGeo);
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.scale.set(1, 0.62, 1);
  dome.position.y = 0.42;
  group.add(dome);

  const hubGeo = new THREE.CylinderGeometry(0.7, 0.55, 0.25, 16);
  disposables.push(hubGeo);
  const hub = new THREE.Mesh(hubGeo, hubMat);
  hub.position.y = -0.32;
  group.add(hub);

  // Rotating ring of running lights
  const lightRing = new THREE.Group();
  const bulbGeo = new THREE.SphereGeometry(0.14, 8, 6);
  disposables.push(bulbGeo);
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const bulb = new THREE.Mesh(bulbGeo, hubMat);
    bulb.position.set(Math.cos(angle) * 2.05, -0.12, Math.sin(angle) * 2.05);
    lightRing.add(bulb);
  }
  group.add(lightRing);

  // Tractor beam — cone with the apex up at the hull
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x8ef4ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beamGeo = new THREE.ConeGeometry(2.4, HOVER_Y, 20, 1, true);
  disposables.push(beamMaterial, beamGeo);
  const beam = new THREE.Mesh(beamGeo, beamMaterial);
  beam.position.y = -HOVER_Y / 2 - 0.2;
  group.add(beam);

  const glow = new THREE.PointLight(0x8ef4ff, 0, 30, 1.8);
  glow.position.y = -1;
  group.add(glow);

  group.visible = false;
  return { parts: { group, lightRing, beamMaterial, beam, glow }, disposables };
}

export class LakesideCow {
  private readonly random: RandomSource;
  private readonly scene: THREE.Scene;
  private readonly cow: CowParts;
  private readonly ufo: UfoParts;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private cowMode: CowMode = 'graze';
  private cowPresent = true;
  private heading = Math.PI * 0.3;
  private readonly cowPos = new THREE.Vector3(MEADOW.x, GROUND_SURFACE_Y, MEADOW.z);
  private readonly walkTarget = new THREE.Vector3();
  private grazeTimer = 5;

  private ufoMode: UfoMode = 'hidden';
  private ufoTimer = 0;
  private ufoDuration = 1;
  private pendingEvent: UfoEvent | null = null;
  // ── Kiosk raid props ──
  private readonly crate: THREE.Mesh;
  private readonly closedSign: THREE.Group;
  private kioskClosed = false;
  private eventDelay = 0;
  private nightArmed = false;
  private readonly ufoFrom = new THREE.Vector3();
  private readonly ufoHover = new THREE.Vector3(MEADOW.x, HOVER_Y, MEADOW.z);
  private readonly ufoAway = new THREE.Vector3();
  private liftProgress = 0;

  // ── Farmer state ──
  private readonly farmer: PassengerBuild;
  private farmerSteps: FarmerStep[] = [];
  private farmerStepIndex = 0;
  private farmerStepTimer = 0;
  private readonly farmerPos = new THREE.Vector3();
  private farmerHeading = 0;
  private dayArmed = false;
  private cowJustReturned = false;

  constructor(scene: THREE.Scene, random = fallbackRandom('cow')) {
    this.scene = scene;
    this.random = random;

    const cowBuild = buildCow();
    this.cow = cowBuild.parts;
    this.cow.group.name = 'lakeside-cow';
    this.disposables.push(...cowBuild.disposables);
    this.cow.group.position.copy(this.cowPos);
    this.cow.group.rotation.y = this.heading + Math.PI;
    scene.add(this.cow.group);

    const ufoBuild = buildUfo();
    this.ufo = ufoBuild.parts;
    this.disposables.push(...ufoBuild.disposables);
    scene.add(this.ufo.group);

    this.farmer = buildFarmer(random);
    this.farmer.group.visible = false;
    scene.add(this.farmer.group);

    // ── Kiosk raid props: goods crate + "ZAMKNIĘTE" barrier sign ──
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.9 });
    const crateGeo = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(crateMat, crateGeo);
    this.crate = new THREE.Mesh(crateGeo, crateMat);
    this.crate.castShadow = true;
    this.crate.position.set(KIOSK_MAIN.x - 1.4, 0.5, KIOSK_MAIN.z + 1);
    scene.add(this.crate);

    this.closedSign = new THREE.Group();
    const signRed = new THREE.MeshStandardMaterial({ color: 0xc23a30, roughness: 0.7 });
    const signWhite = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 });
    const stripeGeo = new THREE.BoxGeometry(2.2, 0.22, 0.1);
    const legGeo = new THREE.BoxGeometry(0.1, 1.1, 0.1);
    this.disposables.push(signRed, signWhite, stripeGeo, legGeo);
    const stripeTop = new THREE.Mesh(stripeGeo, signRed);
    stripeTop.position.y = 1.0;
    this.closedSign.add(stripeTop);
    const stripeBottom = new THREE.Mesh(stripeGeo, signWhite);
    stripeBottom.position.y = 0.74;
    this.closedSign.add(stripeBottom);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, signWhite);
      leg.position.set(side * 0.95, 0.55, 0);
      this.closedSign.add(leg);
    }
    // In front of the kiosk window (kiosk faces -z).
    this.closedSign.position.set(KIOSK_MAIN.x + 2, 0, KIOSK_MAIN.z - 1.2);
    this.closedSign.visible = false;
    scene.add(this.closedSign);
  }

  update(delta: number, elapsed: number, night: number): void {
    if (this.suppressed) return;
    this.updateNightSchedule(delta, night);
    this.updateUfo(delta, elapsed);
    this.updateCow(delta, elapsed, night);
    this.updateFarmerSchedule(night);
    this.updateFarmer(delta, elapsed);
  }

  /** Current farmer activity — used by dev tooling/verification. */
  getFarmerPhase(): FarmerAct | 'hidden' {
    if (!this.farmer.group.visible) return 'hidden';
    return this.farmerSteps[this.farmerStepIndex]?.act ?? 'hidden';
  }

  private suppressed = false;

  /** Cyberpunk: no cow, no farmer, no UFO — the whole storyline pauses. */
  setSuppressed(on: boolean): void {
    if (on === this.suppressed) return;
    this.suppressed = on;
    if (on) {
      this.cow.group.visible = false;
      this.farmer.group.visible = false;
      this.ufo.group.visible = false;
      this.ufo.beamMaterial.opacity = 0;
      this.ufo.glow.intensity = 0;
      this.ufoMode = 'hidden';
      this.pendingEvent = null;
      this.crate.visible = false;
      this.closedSign.visible = false;
      if (this.cowMode === 'lifted') this.cowMode = this.cowPresent ? 'graze' : 'absent';
    } else {
      this.cow.group.visible = this.cowPresent;
      this.crate.visible = !this.kioskClosed;
      this.closedSign.visible = this.kioskClosed;
    }
  }

  /** Dev helper: trigger tonight's UFO visit immediately. */
  debugSummonUfo(event?: UfoEvent): void {
    if (this.ufoMode !== 'hidden') return;
    this.pendingEvent = event ?? (this.cowPresent ? 'abduct' : 'return');
    this.eventDelay = 0.01;
    this.nightArmed = true;
  }

  /** Dev helper: deterministic cow placement for lighting and camera tests. */
  debugPlaceCowAtMeadow(): void {
    this.cowPresent = true;
    this.cowMode = 'sleep';
    this.cowPos.set(MEADOW.x, GROUND_SURFACE_Y, MEADOW.z);
    this.cow.group.position.copy(this.cowPos);
    this.cow.group.visible = true;
    this.pendingEvent = null;
    this.eventDelay = 0;
    this.nightArmed = true;
    this.ufoMode = 'hidden';
    this.ufo.group.visible = false;
    this.ufo.beamMaterial.opacity = 0;
    this.ufo.glow.intensity = 0;
    this.liftProgress = 0;
  }

  // ── Night event scheduling: one UFO visit per night. The cow alternates
  // abduct → return; on some "cow" nights the aliens go shopping at the
  // kiosk instead. ──
  private updateNightSchedule(delta: number, night: number): void {
    if (night > 0.7 && !this.nightArmed) {
      this.nightArmed = true;
      if (!this.cowPresent) {
        this.pendingEvent = 'return';
      } else {
        this.pendingEvent = this.random() < 0.3 ? 'kioskRaid' : 'abduct';
      }
      this.eventDelay = 5 + this.random() * 8;
      // A new night: yesterday's raid is over — kiosk restocked & reopened.
      if (this.kioskClosed) {
        this.kioskClosed = false;
        this.closedSign.visible = false;
        this.crate.visible = true;
        this.crate.position.set(KIOSK_MAIN.x - 1.4, 0.5, KIOSK_MAIN.z + 1);
      }
    } else if (night < 0.4 && this.nightArmed) {
      this.nightArmed = false;
      if (this.ufoMode === 'hidden') this.pendingEvent = null;
    }

    if (this.pendingEvent && this.ufoMode === 'hidden') {
      this.eventDelay -= delta;
      if (this.eventDelay <= 0) {
        this.startUfoArrival();
      }
    }
  }

  private startUfoArrival(): void {
    const targetX = this.pendingEvent === 'kioskRaid' ? KIOSK_MAIN.x + 1 : MEADOW.x;
    const targetZ = this.pendingEvent === 'kioskRaid' ? KIOSK_MAIN.z + 1 : MEADOW.z;
    this.ufoHover.set(targetX, HOVER_Y, targetZ);
    this.ufoFrom.set(targetX - 110, HOVER_Y + 38, targetZ + 70);
    this.ufoAway.set(targetX + 90, HOVER_Y + 55, targetZ - 90);
    this.ufo.group.position.copy(this.ufoFrom);
    this.ufo.group.visible = true;
    this.ufoMode = 'arriving';
    this.ufoTimer = 0;
    this.ufoDuration = 5;
  }

  private updateUfo(delta: number, elapsed: number): void {
    if (this.ufoMode === 'hidden') return;

    this.ufoTimer += delta;
    const t = Math.min(1, this.ufoTimer / this.ufoDuration);
    this.ufo.lightRing.rotation.y = elapsed * 2.4;
    this.ufo.group.rotation.y = elapsed * 0.35;

    switch (this.ufoMode) {
      case 'arriving': {
        this.ufo.group.position.lerpVectors(this.ufoFrom, this.ufoHover, easeInOut(t));
        if (t >= 1) {
          this.ufoMode = 'beamFadeIn';
          this.ufoTimer = 0;
          this.ufoDuration = 0.9;
        }
        break;
      }
      case 'beamFadeIn': {
        this.hoverBob(elapsed);
        this.ufo.beamMaterial.opacity = 0.28 * t;
        this.ufo.glow.intensity = 60 * t;
        if (t >= 1) {
          this.ufoMode = 'beaming';
          this.ufoTimer = 0;
          this.ufoDuration = this.pendingEvent === 'kioskRaid' ? 3.2 : 4.5;
          this.liftProgress = 0;
          if (this.pendingEvent === 'abduct') {
            this.cowMode = 'lifted';
          } else if (this.pendingEvent === 'return') {
            // Return: cow re-appears at the top of the beam.
            this.cowPresent = true;
            this.cowMode = 'lifted';
            this.cow.group.visible = true;
          }
        }
        break;
      }
      case 'beaming': {
        this.hoverBob(elapsed);
        if (this.pendingEvent === 'kioskRaid') {
          // The goods crate floats up into the saucer.
          this.liftProgress = t;
          const y = 0.5 + (HOVER_Y - BEAM_TOP_OFFSET) * easeInOut(t);
          this.crate.position.set(this.ufoHover.x, y, this.ufoHover.z);
          this.crate.rotation.y = elapsed * 1.6;
          if (t >= 1) {
            this.crate.visible = false;
            this.kioskClosed = true;
            this.closedSign.visible = true;
            this.ufoMode = 'beamFadeOut';
            this.ufoTimer = 0;
            this.ufoDuration = 0.9;
          }
          break;
        }
        this.liftProgress = this.pendingEvent === 'abduct' ? t : 1 - t;
        if (t >= 1) {
          if (this.pendingEvent === 'abduct') {
            this.cowPresent = false;
            this.cowMode = 'absent';
            this.cow.group.visible = false;
          } else {
            this.cowMode = 'sleep';
            this.cowJustReturned = true;
          }
          this.ufoMode = 'beamFadeOut';
          this.ufoTimer = 0;
          this.ufoDuration = 0.9;
        }
        break;
      }
      case 'beamFadeOut': {
        this.hoverBob(elapsed);
        this.ufo.beamMaterial.opacity = 0.28 * (1 - t);
        this.ufo.glow.intensity = 60 * (1 - t);
        if (t >= 1) {
          this.ufoMode = 'leaving';
          this.ufoTimer = 0;
          this.ufoDuration = 4;
        }
        break;
      }
      case 'leaving': {
        this.ufo.group.position.lerpVectors(this.ufoHover, this.ufoAway, t * t);
        if (t >= 1) {
          this.ufoMode = 'hidden';
          this.ufo.group.visible = false;
          this.pendingEvent = null;
        }
        break;
      }
    }
  }

  private hoverBob(elapsed: number): void {
    this.ufo.group.position.set(
      this.ufoHover.x + Math.sin(elapsed * 0.9) * 0.4,
      this.ufoHover.y + Math.sin(elapsed * 1.7) * 0.3,
      this.ufoHover.z + Math.cos(elapsed * 1.1) * 0.4
    );
  }

  // ── Cow behaviour ──
  private updateCow(delta: number, elapsed: number, night: number): void {
    if (!this.cowPresent && this.cowMode !== 'lifted') return;

    const g = this.cow;

    if (this.cowMode === 'lifted') {
      // Suspended in the tractor beam, slowly spinning.
      const y = 0.5 + (HOVER_Y - BEAM_TOP_OFFSET) * easeInOut(this.liftProgress);
      g.group.position.set(
        MEADOW.x + Math.sin(elapsed * 1.3) * 0.25,
        y,
        MEADOW.z + Math.cos(elapsed * 1.1) * 0.25
      );
      g.group.rotation.y = elapsed * 1.2;
      g.group.rotation.z = Math.sin(elapsed * 0.9) * 0.12;
      for (const leg of g.legs) leg.scale.y = 1;
      g.headGroup.rotation.x = -0.2; // mooo
      return;
    }

    g.group.rotation.z = 0;

    // Wake up / go to sleep (outside of UFO events).
    if (night > 0.65 && (this.cowMode === 'graze' || this.cowMode === 'walk')) {
      this.cowMode = 'sleep';
    } else if (night < 0.4 && this.cowMode === 'sleep') {
      this.cowMode = 'graze';
      this.grazeTimer = 3 + this.random() * 6;
    }

    if (this.cowMode === 'sleep') {
      // Lying down: folded legs, lowered body, slow breathing.
      for (const leg of g.legs) leg.scale.y = 0.25;
      const breathe = 1 + Math.sin(elapsed * 1.4) * 0.015;
      g.group.scale.set(1, breathe, 1);
      g.group.position.set(this.cowPos.x, GROUND_SURFACE_Y + 0.12, this.cowPos.z);
      g.headGroup.rotation.x = 0.35;
      g.tail.rotation.x = 0;
      return;
    }

    g.group.scale.set(1, 1, 1);
    for (const leg of g.legs) leg.scale.y = 1;
    g.tail.rotation.x = Math.sin(elapsed * 1.8) * 0.35;

    if (this.cowMode === 'graze') {
      g.group.position.set(this.cowPos.x, GROUND_SURFACE_Y, this.cowPos.z);
      g.group.rotation.y = this.heading + Math.PI;
      // Head down, nibbling.
      g.headGroup.rotation.x = 0.85 + Math.sin(elapsed * 5.2) * 0.08;
      this.grazeTimer -= delta;
      if (this.grazeTimer <= 0) {
        // Pick a new grazing spot in the meadow (never in the water).
        const angle = this.random() * Math.PI * 2;
        const r = this.random() * MEADOW.wanderRadius;
        this.walkTarget.set(MEADOW.x + Math.cos(angle) * r, 0.5, MEADOW.z + Math.sin(angle) * r);
        clampOutsideLake(this.walkTarget);
        this.cowMode = 'walk';
      }
    } else if (this.cowMode === 'walk') {
      const dx = this.walkTarget.x - this.cowPos.x;
      const dz = this.walkTarget.z - this.cowPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.2) {
        this.cowMode = 'graze';
        this.grazeTimer = 5 + this.random() * 9;
      } else {
        this.heading = Math.atan2(dx, dz);
        const step = Math.min(dist, 0.75 * delta);
        this.cowPos.x += (dx / dist) * step;
        this.cowPos.z += (dz / dist) * step;
        g.group.position.set(
          this.cowPos.x,
          GROUND_SURFACE_Y + Math.abs(Math.sin(elapsed * 4)) * 0.03,
          this.cowPos.z
        );
        g.group.rotation.y = this.heading + Math.PI;
        g.headGroup.rotation.x = 0.15;
        // Leg shuffle
        for (let i = 0; i < g.legs.length; i++) {
          g.legs[i].rotation.x = Math.sin(elapsed * 6 + (i % 2) * Math.PI) * 0.3;
        }
      }
    }
  }

  // ── Farmer ──

  /** Each morning, decide whether the farmer has business in the meadow. */
  private updateFarmerSchedule(night: number): void {
    if (night < 0.35 && !this.dayArmed) {
      this.dayArmed = true;
      if (this.farmer.group.visible) return; // already mid-sequence
      if (!this.cowPresent) {
        this.startFarmerTask('search');
      } else if (this.cowJustReturned) {
        this.cowJustReturned = false;
        this.startFarmerTask('celebrate');
      }
    } else if (night > 0.6) {
      this.dayArmed = false;
    }
  }

  private startFarmerTask(task: 'search' | 'celebrate'): void {
    // Every waypoint is clamped onto dry land — the farmer never wades in.
    const v = (x: number, z: number) => {
      const p = new THREE.Vector3(x, 0.5, z);
      clampOutsideLake(p);
      return p;
    };
    if (task === 'search') {
      this.farmerSteps = [
        { act: 'walk', target: v(MEADOW.x + 4, MEADOW.z + 1) },
        { act: 'look', duration: 2.2 },
        { act: 'walk', target: v(MEADOW.x - 3, MEADOW.z + 3) },
        { act: 'scratch', duration: 2.6 },
        { act: 'walk', target: v(MEADOW.x - 2, MEADOW.z - 3) },
        { act: 'look', duration: 1.6 },
        { act: 'fist', duration: 3.2 },
        { act: 'walk', target: FARMER_DOOR.clone() },
      ];
    } else {
      const side = v(this.cowPos.x + 1.6, this.cowPos.z);
      this.farmerSteps = [
        { act: 'walk', target: side },
        { act: 'pat', duration: 3.4 },
        { act: 'walk', target: FARMER_DOOR.clone() },
      ];
    }
    this.farmerStepIndex = 0;
    this.farmerStepTimer = 0;
    this.farmerPos.copy(FARMER_DOOR);
    this.farmer.group.visible = true;
    for (const mat of this.farmer.materials) mat.opacity = 0.95;
  }

  private resetFarmerPose(): void {
    const f = this.farmer;
    f.leftArm.rotation.set(0, 0, 0);
    f.rightArm.rotation.set(0, 0, 0);
    f.legs.rotation.set(0, 0, 0);
    f.head.rotation.set(0, 0, 0);
  }

  private updateFarmer(delta: number, elapsed: number): void {
    if (!this.farmer.group.visible) return;
    const step = this.farmerSteps[this.farmerStepIndex];
    if (!step) {
      this.farmer.group.visible = false;
      return;
    }

    const f = this.farmer;
    f.group.position.copy(this.farmerPos);

    if (step.act === 'walk' && step.target) {
      const dx = step.target.x - this.farmerPos.x;
      const dz = step.target.z - this.farmerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.25) {
        this.advanceFarmerStep();
        return;
      }
      this.farmerHeading = Math.atan2(dx, dz);
      const stepLen = Math.min(dist, 1.7 * delta);
      this.farmerPos.x += (dx / dist) * stepLen;
      this.farmerPos.z += (dz / dist) * stepLen;
      f.group.position.copy(this.farmerPos);
      f.group.position.y = 0.5 + Math.abs(Math.sin(elapsed * 7)) * 0.05;
      f.group.rotation.y = this.farmerHeading;
      f.legs.rotation.x = Math.sin(elapsed * 7) * 0.3;
      f.leftArm.rotation.x = Math.sin(elapsed * 7) * 0.55;
      f.rightArm.rotation.x = -Math.sin(elapsed * 7) * 0.55;
      f.head.rotation.set(0, 0, 0);
      return;
    }

    // Stationary acts
    this.farmerStepTimer += delta;
    const t = step.duration ? Math.min(1, this.farmerStepTimer / step.duration) : 1;
    this.resetFarmerPose();

    switch (step.act) {
      case 'look':
        // Scanning the horizon for the cow.
        f.head.rotation.y = Math.sin(elapsed * 1.8) * 0.85;
        f.group.rotation.y = this.farmerHeading + Math.sin(elapsed * 0.7) * 0.4;
        break;
      case 'scratch':
        // Hand up to the head, puzzled wiggle.
        f.rightArm.rotation.x = -2.5 + Math.sin(elapsed * 13) * 0.16;
        f.rightArm.rotation.z = -0.35;
        f.head.rotation.z = 0.16;
        f.head.rotation.y = Math.sin(elapsed * 1.2) * 0.3;
        break;
      case 'fist':
        // Glaring up at the sky, shaking a fist at the aliens.
        f.head.rotation.x = -0.55;
        f.rightArm.rotation.x = -2.95 + Math.sin(elapsed * 17) * 0.28;
        f.group.position.y = 0.5 + Math.abs(Math.sin(elapsed * 9)) * 0.045;
        f.group.rotation.y = this.farmerHeading;
        break;
      case 'pat': {
        // Face the cow and pat her back, hopping with joy.
        const toCowX = this.cowPos.x - this.farmerPos.x;
        const toCowZ = this.cowPos.z - this.farmerPos.z;
        f.group.rotation.y = Math.atan2(toCowX, toCowZ);
        f.rightArm.rotation.x = -1.15 + Math.abs(Math.sin(elapsed * 7)) * 0.5;
        f.group.position.y = 0.5 + Math.abs(Math.sin(elapsed * 5)) * easeInOut(Math.min(1, t * 2)) * 0.12;
        break;
      }
    }

    if (t >= 1) this.advanceFarmerStep();
  }

  private advanceFarmerStep(): void {
    this.farmerStepIndex += 1;
    this.farmerStepTimer = 0;
    this.resetFarmerPose();
    if (this.farmerStepIndex >= this.farmerSteps.length) {
      this.farmer.group.visible = false;
    }
  }

  dispose(): void {
    this.scene.remove(this.cow.group, this.ufo.group, this.farmer.group, this.crate, this.closedSign);
    this.farmer.group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    });
    for (const mat of this.farmer.materials) mat.dispose();
    for (const item of this.disposables) item.dispose();
  }
}
