import type { RandomSource } from '../core/Random';
import { fallbackRandom } from '../core/Random';
import { CinematicTour, type TourChapterId, type TourFrame } from '../CinematicTour';
import { OPENING_SOLAR_PHASE } from './AuthoredMoments';
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
  /**
   * The moment the experience opens on, as a **solar phase** -- not a clock reading.
   *
   * Defaults to {@link OPENING_SOLAR_PHASE}, "just after sunrise". It is resolved through
   * {@link ExperienceDirector.setPhaseToClock}, so it is its own clock time until somebody
   * supplies a season, and is re-seeded the moment one arrives.
   */
  initialDayPhase?: number;
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
  /** The authored opening moment, kept on the phase axis so a season can still resolve it. */
  private readonly openingPhase: number;
  /** True while the clock still holds the unresolved opening phase and nothing else. */
  private openingUnresolved = true;
  private moonPhase = 0.35;
  private auroraEnabled: boolean;
  private readonly frameState: ExperienceFrameState;

  constructor(options: ExperienceDirectorOptions) {
    this.daySeconds = options.daySeconds;
    this.random = options.random ?? fallbackRandom('experience');
    this.onNewDay = options.onNewDay;
    // The opening moment is a solar phase, and nobody owns the sun yet at construction time:
    // seed the clock with the identity mapping and let `setPhaseToClock` re-seed it.
    this.openingPhase = options.initialDayPhase ?? OPENING_SOLAR_PHASE;
    this.simTime = this.openingPhase * this.daySeconds;
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

  /**
   * Authored solar phase to clock time. Identity until someone supplies a season.
   *
   * A tour chapter's `dayProgress` is a claim about the light -- "golden hour", "night" --
   * and the clock hour that satisfies it moves with the season: golden hour is 04:40 in June
   * and 07:30 in October. The director stays ignorant of latitude and declination and simply
   * asks whoever owns the sun.
   */
  private phaseToClock: (phase: number) => number = (phase) => phase;

  /**
   * Supply the mapping from authored solar phase to clock time.
   *
   * This also resolves the opening moment, which the constructor could only seed through the
   * identity mapping -- the season is not known that early. Only while the clock still holds
   * that unresolved seed: a boot checkpoint or an explicit `setTime` has already spoken about
   * which hour the viewer should be looking at, and must not be walked back to dawn.
   */
  setPhaseToClock(map: (phase: number) => number): void {
    this.phaseToClock = map;
    if (this.openingUnresolved) this.setTime(map(this.openingPhase));
  }

  update(frame: FrameContext, realTimeCycle: number | null): ExperienceFrameState {
    // The clock is running on its own now; re-seeding the opening moment would be a jump.
    this.openingUnresolved = false;
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
        const target = this.phaseToClock(override) * this.daySeconds;
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

  /** Set the clock. `t01` is a clock reading; an authored solar phase must be resolved first. */
  setTime(t01: number): void {
    this.openingUnresolved = false;
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
