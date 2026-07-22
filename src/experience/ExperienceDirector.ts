import type { RandomSource } from '../core/Random';
import { fallbackRandom } from '../core/Random';
import { CinematicTour, type TourChapterId, type TourFrame } from '../CinematicTour';
import type { FrameContext } from './FrameContext';

export interface ExperienceFrameState {
  readonly t01: number;
  readonly simTime: number;
  readonly renderTime: number;
  readonly moonPhase: number;
  readonly moonIllumination: number;
  readonly auroraEnabled: boolean;
  readonly tour: TourFrame | null;
}

export interface ExperienceDirectorOptions {
  daySeconds: number;
  initialDayProgress?: number;
  random?: RandomSource;
  onNewDay?: () => void;
}

/** Owns experience time and the declarative tour. It deliberately knows nothing about Three.js. */
export class ExperienceDirector {
  private readonly tour = new CinematicTour();
  private readonly random: RandomSource;
  private readonly daySeconds: number;
  private readonly onNewDay?: () => void;
  private paused = false;
  private checkpointLocked = false;
  private clockLocked = false;
  private timeScale = 1;
  private simTime: number;
  private renderTime: number;
  private moonPhase = 0.35;
  private auroraEnabled: boolean;
  private readonly frameState: ExperienceFrameState;

  constructor(options: ExperienceDirectorOptions) {
    this.daySeconds = options.daySeconds;
    this.random = options.random ?? fallbackRandom('experience');
    this.onNewDay = options.onNewDay;
    this.simTime = (options.initialDayProgress ?? 0.262) * this.daySeconds;
    this.renderTime = this.simTime;
    this.auroraEnabled = this.random() < 0.5;
    this.frameState = {
      t01: this.renderTime / this.daySeconds,
      simTime: this.simTime,
      renderTime: this.renderTime,
      moonPhase: this.moonPhase,
      moonIllumination: this.illumination(),
      auroraEnabled: this.auroraEnabled,
      tour: null,
    };
  }

  update(frame: FrameContext, realTimeCycle: number | null): ExperienceFrameState {
    const tourWasActive = this.tour.isActive();
    const tourFrame = this.tour.update(frame.realDelta);
    if (tourWasActive && !this.tour.isActive()) this.simTime = this.renderTime;
    if (realTimeCycle !== null && !this.checkpointLocked && !this.clockLocked) {
      const target = realTimeCycle * this.daySeconds;
      let diff = target - this.renderTime;
      if (Math.abs(diff) > this.daySeconds / 2) diff -= Math.sign(diff) * this.daySeconds;
      this.renderTime = (this.renderTime + diff * Math.min(1, frame.realDelta * 0.8) + this.daySeconds) % this.daySeconds;
      this.simTime = this.renderTime;
    } else if (!this.checkpointLocked && !this.clockLocked) {
      this.simTime += frame.simulationDelta * this.timeScale;
      while (this.simTime >= this.daySeconds) {
        this.simTime -= this.daySeconds;
        this.moonPhase = (this.moonPhase + 0.125) % 1;
        this.auroraEnabled = this.random() < 0.5;
        this.onNewDay?.();
      }
      const override = tourFrame?.chapter.dayProgress;
      if (override !== undefined) {
        const target = override * this.daySeconds;
        const blend = 1 - Math.exp(-0.6 * Math.max(frame.realDelta, 0.0001));
        this.renderTime += (target - this.renderTime) * blend;
      } else {
        this.renderTime = this.simTime;
      }
    }
    return this.writeFrameState(tourFrame);
  }

  startTour(onFinish?: () => void): TourFrame {
    return this.tour.start(onFinish);
  }

  stopTour(): void {
    if (this.tour.isActive()) this.simTime = this.renderTime;
    this.tour.stop();
  }

  isTourActive(): boolean {
    return this.tour.isActive();
  }

  seekTour(id: TourChapterId, localProgress = 0): TourFrame {
    return this.tour.seek(id, localProgress);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  getTimeScale(): number {
    return this.timeScale;
  }

  setTime(t01: number): void {
    this.simTime = t01 * this.daySeconds;
    this.renderTime = this.simTime;
  }

  setClockLocked(locked: boolean): void {
    this.clockLocked = locked;
  }

  lockCheckpoint(t01: number): void {
    this.setTime(t01);
    this.checkpointLocked = true;
  }

  releaseCheckpoint(): void {
    this.checkpointLocked = false;
  }

  isCheckpointLocked(): boolean {
    return this.checkpointLocked;
  }

  getState(): ExperienceFrameState {
    return this.writeFrameState(this.tour.getCurrentFrame());
  }

  private illumination(): number {
    return 0.5 - 0.5 * Math.cos(this.moonPhase * Math.PI * 2);
  }

  private writeFrameState(tour: TourFrame | null): ExperienceFrameState {
    const mutable = this.frameState as {
      t01: number;
      simTime: number;
      renderTime: number;
      moonPhase: number;
      moonIllumination: number;
      auroraEnabled: boolean;
      tour: TourFrame | null;
    };
    mutable.t01 = ((this.renderTime / this.daySeconds) % 1 + 1) % 1;
    mutable.simTime = this.simTime;
    mutable.renderTime = this.renderTime;
    mutable.moonPhase = this.moonPhase;
    mutable.moonIllumination = this.illumination();
    mutable.auroraEnabled = this.auroraEnabled;
    mutable.tour = tour;
    return this.frameState;
  }
}
