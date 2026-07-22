import * as THREE from 'three';
import type CameraControls from 'camera-controls';
import type { TourFrame, TourCameraRig } from '../CinematicTour';
import type { FrameContext } from './FrameContext';
import { TUNNEL_LENGTH, WORLD_HALF_SIZE } from '../world/WorldLayout';
import { FIXED_TOUR_SHOTS } from './ShotDefinitions';

export type CameraMode = 'free' | 'train' | 'bus';
export type CameraAutomation = 'overview' | 'eclipse' | 'tour' | 'train' | 'bus' | null;

export interface CameraSubjects {
  trainPosition: THREE.Vector3;
  trainDirection: THREE.Vector3;
  busPosition: THREE.Vector3;
  busDirection: THREE.Vector3;
}

type CameraControlsPort = Pick<
  CameraControls,
  'enabled' | 'setLookAt' | 'getTarget' | 'getPosition' | 'stop'
>;

export interface CameraDirectorOptions {
  controls: CameraControlsPort;
  inputElement: HTMLElement;
  onInterrupt: (automation: Exclude<CameraAutomation, null>) => void;
  onModeChange: (mode: CameraMode) => void;
}

const FREE_POSITION = new THREE.Vector3(70, 48, 80);
const FREE_TARGET = new THREE.Vector3(0, 6, 0);
/** Sole production owner of CameraControls.setLookAt and automatic framing. */
export class CameraDirector {
  private mode: CameraMode = 'free';
  private automation: CameraAutomation = null;
  private activeTourRig: TourCameraRig | null = null;
  private cameraJustSwitched = false;
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredTarget = new THREE.Vector3();
  private readonly smoothPosition = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private readonly previousVehiclePosition = new THREE.Vector3();
  private readonly interruptInput = () => {
    if (!this.automation) return;
    this.interrupt('user-input');
  };

  constructor(private readonly options: CameraDirectorOptions) {
    options.inputElement.addEventListener('pointerdown', this.interruptInput, { capture: true });
    options.inputElement.addEventListener('wheel', this.interruptInput, { capture: true, passive: true });
  }

  dispose(): void {
    this.options.inputElement.removeEventListener('pointerdown', this.interruptInput, { capture: true });
    this.options.inputElement.removeEventListener('wheel', this.interruptInput, { capture: true });
  }

  getMode(): CameraMode {
    return this.mode;
  }

  getAutomation(): CameraAutomation {
    return this.automation;
  }

  isAutomated(): boolean {
    return this.automation !== null;
  }

  toggleVehicleMode(requested: 'train' | 'bus'): CameraMode {
    this.mode = this.mode === requested ? 'free' : requested;
    this.activeTourRig = null;
    if (this.mode === 'free') {
      this.frameAbsolute(FREE_POSITION, FREE_TARGET, true, 'overview');
    } else {
      this.automation = this.mode;
      this.cameraJustSwitched = true;
      this.options.controls.enabled = false;
    }
    this.options.onModeChange(this.mode);
    return this.mode;
  }

  startTour(frame: TourFrame): void {
    this.mode = 'free';
    this.automation = 'tour';
    this.activeTourRig = null;
    this.cameraJustSwitched = true;
    this.options.controls.enabled = false;
    this.options.onModeChange('free');
    this.applyTour(frame, true);
  }

  stopTour(): void {
    if (this.automation !== 'tour') return;
    this.freezeCurrentPose();
    this.automation = null;
    this.activeTourRig = null;
    this.options.controls.enabled = true;
  }

  focusEclipse(position: THREE.Vector3, target: THREE.Vector3): void {
    this.mode = 'free';
    this.options.onModeChange('free');
    this.frameAbsolute(position, target, true, 'eclipse');
  }

  frameAbsolute(
    position: THREE.Vector3,
    target: THREE.Vector3,
    transition = false,
    owner: Exclude<CameraAutomation, null> = 'overview'
  ): void {
    this.mode = 'free';
    this.options.onModeChange('free');
    this.automation = owner;
    this.options.controls.enabled = false;
    this.writePose(position, target, transition);
  }

  interrupt(_reason: 'user-input' | 'explicit'): void {
    const interrupted = this.automation;
    if (!interrupted) return;
    this.freezeCurrentPose();
    this.mode = 'free';
    this.automation = null;
    this.activeTourRig = null;
    this.options.controls.enabled = true;
    this.options.onModeChange('free');
    this.options.onInterrupt(interrupted);
  }

  update(frame: FrameContext, tour: TourFrame | null, subjects: CameraSubjects): void {
    if (this.automation === 'tour' && tour) {
      this.applyTour(tour, false, subjects, frame);
      return;
    }
    if (this.automation === 'train' || this.automation === 'bus') {
      this.updateVehicle(this.automation, subjects, frame.realDelta);
    }
  }

  private applyTour(
    tour: TourFrame,
    force: boolean,
    subjects?: CameraSubjects,
    frame?: FrameContext
  ): void {
    const rig = tour.chapter.cameraRig;
    const entered = force || tour.entered || this.activeTourRig !== rig;
    this.activeTourRig = rig;
    if ((rig === 'train' || rig === 'bus') && subjects && frame) {
      if (entered) this.cameraJustSwitched = true;
      this.updateVehicle(rig, subjects, frame.realDelta);
      this.automation = 'tour';
      return;
    }
    if (rig === 'train' || rig === 'bus') return;
    const shot = FIXED_TOUR_SHOTS[rig];
    this.desiredPosition.fromArray(shot.position);
    this.desiredTarget.fromArray(shot.target);
    const drift = tour.localProgress - 0.5;
    if (rig === 'lake') this.desiredPosition.x += drift * 5;
    else if (rig === 'residents') this.desiredPosition.y += drift * 2.5;
    else if (rig === 'golden-hour') this.desiredPosition.y += drift * 5;
    else if (rig === 'cyberpunk') this.desiredPosition.x += drift * 7;
    if (entered) {
      this.mode = 'free';
      this.options.onModeChange('free');
      this.options.controls.enabled = false;
    }
    this.writePose(this.desiredPosition, this.desiredTarget, false);
  }

  private updateVehicle(mode: 'train' | 'bus', subjects: CameraSubjects, delta: number): void {
    const position = mode === 'train' ? subjects.trainPosition : subjects.busPosition;
    const direction = mode === 'train' ? subjects.trainDirection : subjects.busDirection;
    const behind = mode === 'train' ? 13 : 10.5;
    let height = mode === 'train' ? 7 : 5.5;
    let targetLift = 0;
    if (mode === 'train') {
      const tunnelZoneStart = WORLD_HALF_SIZE - TUNNEL_LENGTH - 18;
      const lift = Math.min(1, Math.max(0, Math.abs(position.x) - tunnelZoneStart) / 12);
      height += lift * 10;
      targetLift = lift * 4;
    } else {
      const lift = Math.max(0, 1 - Math.hypot(position.x - 34, position.z - 9.8) / 24);
      height += lift * 11;
      targetLift = lift * 5;
    }
    this.desiredPosition.copy(position).addScaledVector(direction, -behind);
    this.desiredPosition.y += height;
    this.desiredTarget.copy(position).addScaledVector(direction, 11);
    this.desiredTarget.y += 2.2 + targetLift;

    if (this.cameraJustSwitched || this.previousVehiclePosition.distanceTo(position) > 25) {
      this.smoothPosition.copy(this.desiredPosition);
      this.smoothTarget.copy(this.desiredTarget);
      this.cameraJustSwitched = false;
    } else {
      const blend = 1 - Math.exp(-7 * Math.max(delta, 0.0001));
      this.smoothPosition.lerp(this.desiredPosition, blend);
      this.smoothTarget.lerp(this.desiredTarget, blend);
    }
    void this.options.controls.setLookAt(
      this.smoothPosition.x, this.smoothPosition.y, this.smoothPosition.z,
      this.smoothTarget.x, this.smoothTarget.y, this.smoothTarget.z,
      false
    );
    this.previousVehiclePosition.copy(position);
  }

  private freezeCurrentPose(): void {
    this.options.controls.getPosition(this.smoothPosition, false);
    this.options.controls.getTarget(this.smoothTarget, false);
    this.options.controls.stop();
    this.writePose(this.smoothPosition, this.smoothTarget, false);
  }

  private writePose(position: THREE.Vector3, target: THREE.Vector3, transition: boolean): void {
    void this.options.controls.setLookAt(
      position.x, position.y, position.z,
      target.x, target.y, target.z,
      transition
    );
  }
}
