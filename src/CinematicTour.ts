import * as THREE from 'three';
import type CameraControls from 'camera-controls';
import { BLOCK_CONFIGS, DAY_SECONDS } from './world/WorldLayout';

/**
 * Continuous orbital fly-around. Instead of jump-cutting between waypoints
 * we sample a closed Catmull-Rom curve every frame, so the camera makes one
 * smooth lap around the diorama while the day-of-cycle marches from sunrise
 * to sunset.
 *
 * The orbit is held high enough to clear every block (max h=17 → camera
 * minimum 28 m) and stays outside the city footprint (radius ≥ 70 from
 * origin) so it never grazes a building.
 */

const TOUR_DURATION = 56;
const HOLD_FINALE = 8; // extra seconds frozen on the closing sunset shot
const CITY_RADIUS = 102;
const CITY_HEIGHT_MIN = 32;

// Camera waypoints — sampled clockwise around the city.
const CAMERA_POINTS = [
  new THREE.Vector3(CITY_RADIUS, 38, 0),
  new THREE.Vector3(CITY_RADIUS * 0.7, 44, CITY_RADIUS * 0.7),
  new THREE.Vector3(0, 52, CITY_RADIUS),
  new THREE.Vector3(-CITY_RADIUS * 0.7, 46, CITY_RADIUS * 0.7),
  new THREE.Vector3(-CITY_RADIUS, 38, 0),
  new THREE.Vector3(-CITY_RADIUS * 0.7, 34, -CITY_RADIUS * 0.7),
  new THREE.Vector3(0, 42, -CITY_RADIUS),
  new THREE.Vector3(CITY_RADIUS * 0.7, 46, -CITY_RADIUS * 0.7),
];

// Target drifts gently around the city centre so the camera always looks
// at "something interesting" rather than locking on a single point.
const TARGET_POINTS = [
  new THREE.Vector3(10, 8, 0),
  new THREE.Vector3(15, 10, 12),
  new THREE.Vector3(0, 10, 18),
  new THREE.Vector3(-15, 8, 12),
  new THREE.Vector3(-20, 6, 0),
  new THREE.Vector3(-12, 6, -10),
  new THREE.Vector3(0, 8, -15),
  new THREE.Vector3(12, 9, -10),
];

const CAMERA_CURVE = new THREE.CatmullRomCurve3(CAMERA_POINTS, true, 'centripetal', 0.5);
const TARGET_CURVE = new THREE.CatmullRomCurve3(TARGET_POINTS, true, 'centripetal', 0.5);

/**
 * Day-time progression over the tour: sunrise → noon → afternoon → sunset.
 * Values are seconds in the DAY_SECONDS cycle (fractions of the day).
 */
function dayTimeAt(progress: number): number {
  // sunrise glow → mid-morning → late afternoon → sunset → twilight
  const keys: Array<[number, number]> = [
    [0.0, 0.265 * DAY_SECONDS],
    [0.35, 0.42 * DAY_SECONDS],
    [0.65, 0.58 * DAY_SECONDS],
    [0.95, 0.735 * DAY_SECONDS],
    [1.0, 0.77 * DAY_SECONDS],
  ];
  const clamped = Math.max(0, Math.min(1, progress));
  for (let i = 0; i < keys.length - 1; i++) {
    if (clamped >= keys[i][0] && clamped <= keys[i + 1][0]) {
      const span = keys[i + 1][0] - keys[i][0];
      const local = span > 0 ? (clamped - keys[i][0]) / span : 0;
      return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * local;
    }
  }
  return keys[keys.length - 1][1];
}

function validatePath(): void {
  // Sample 240 points around the loop to confirm no block intersection.
  let collisions = 0;
  for (let s = 0; s < 240; s++) {
    const t = s / 240;
    const p = CAMERA_CURVE.getPointAt(t);
    for (const block of BLOCK_CONFIGS) {
      if (
        p.x >= block.x - 0.5 &&
        p.x <= block.x + block.w - 0.5 &&
        p.z >= block.z - 0.5 &&
        p.z <= block.z + block.d - 0.5 &&
        p.y <= block.h
      ) {
        collisions++;
        break;
      }
    }
  }
  if (collisions > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[CinematicTour] orbital path grazes ${collisions} block samples`);
  }
}

/**
 * Continuous orbital tour. start() begins, stop() ends, update(delta)
 * each frame. getDayTimeTarget() returns the dayTime override for the
 * current moment (so the sky animates with the camera).
 */
export class CinematicTour {
  private active = false;
  private elapsed = 0;
  private onFinish?: () => void;

  private readonly camPos = new THREE.Vector3();
  private readonly targetPos = new THREE.Vector3();

  constructor(private readonly controls: CameraControls) {
    validatePath();
  }

  start(onFinish?: () => void): void {
    this.active = true;
    this.elapsed = 0;
    this.onFinish = onFinish;
    this.controls.enabled = false;
    // Snap directly to the start of the orbit (no transition) — feels intentional.
    this.sampleAt(0, this.camPos, this.targetPos);
    this.controls.setLookAt(
      this.camPos.x, this.camPos.y, this.camPos.z,
      this.targetPos.x, this.targetPos.y, this.targetPos.z,
      false
    );
  }

  stop(): void {
    this.active = false;
    this.controls.enabled = true;
  }

  isActive(): boolean {
    return this.active;
  }

  static getDuration(): number {
    return TOUR_DURATION + HOLD_FINALE;
  }

  getDayTimeTarget(): number | null {
    if (!this.active) return null;
    const t = Math.min(1, this.elapsed / TOUR_DURATION);
    return dayTimeAt(t);
  }

  update(delta: number): void {
    if (!this.active) return;
    this.elapsed += delta;

    // First TOUR_DURATION seconds: continuous orbit.
    // Then HOLD_FINALE seconds: camera freezes on the final position so the
    // viewer can drink in the sunset.
    const totalDuration = TOUR_DURATION + HOLD_FINALE;
    if (this.elapsed >= totalDuration) {
      this.stop();
      this.onFinish?.();
      return;
    }

    const orbitT = Math.min(1, this.elapsed / TOUR_DURATION);
    this.sampleAt(orbitT, this.camPos, this.targetPos);

    // No transition — we set the absolute pose each frame for a buttery feel.
    this.controls.setLookAt(
      this.camPos.x, this.camPos.y, this.camPos.z,
      this.targetPos.x, this.targetPos.y, this.targetPos.z,
      false
    );
  }

  /** Sample the orbit at parameter `t` (0..1). */
  private sampleAt(t: number, outCam: THREE.Vector3, outTarget: THREE.Vector3): void {
    // The curve is closed but we only traverse 0..1 (one full orbit).
    const camPt = CAMERA_CURVE.getPointAt(t);
    const tgtPt = TARGET_CURVE.getPointAt(t);
    // Safety clamp: keep the camera at or above CITY_HEIGHT_MIN.
    outCam.set(camPt.x, Math.max(camPt.y, CITY_HEIGHT_MIN), camPt.z);
    outTarget.copy(tgtPt);
  }
}
