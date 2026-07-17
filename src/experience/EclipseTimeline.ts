export const DEFAULT_ECLIPSE_DURATION_SECONDS = 90;

export type EclipsePhase =
  | 'partial-in'
  | 'c2-diamond-ring'
  | 'totality'
  | 'c3-diamond-ring'
  | 'partial-out'
  | 'complete';

export interface EclipseTimelineOptions {
  durationSeconds?: number;
}

export interface EclipseTimelineState {
  phase: EclipsePhase;
  progress: number;
  phaseProgress: number;
  coverage: number;
  separation: number;
  irradiance: number;
  corona: number;
  beads: number;
  stars: number;
  totality: number;
  running: boolean;
}

interface PhaseRange {
  phase: Exclude<EclipsePhase, 'complete'>;
  start: number;
  end: number;
}

const PHASE_RANGES: readonly PhaseRange[] = [
  { phase: 'partial-in', start: 0, end: 0.36 },
  { phase: 'c2-diamond-ring', start: 0.36, end: 0.42 },
  { phase: 'totality', start: 0.42, end: 0.58 },
  { phase: 'c3-diamond-ring', start: 0.58, end: 0.64 },
  { phase: 'partial-out', start: 0.64, end: 1 },
];

const SUN_RADIUS = 1;
const MOON_RADIUS = 1.01875;
const CONTACT_DISTANCE = SUN_RADIUS + MOON_RADIUS;
const TOTALITY_SEPARATION = (MOON_RADIUS - SUN_RADIUS) / CONTACT_DISTANCE;
const PARTIAL_CONTACT_COVERAGE = 0.985;
const MINIMUM_IRRADIANCE = 0.025;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const clampUnit = (value: number): number => Math.min(1, Math.max(-1, value));

const smootherStep = (value: number): number => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const rangeProgress = (progress: number, start: number, end: number): number =>
  clamp01((progress - start) / (end - start));

function phaseRangeAt(progress: number): PhaseRange | undefined {
  return PHASE_RANGES.find(({ end }) => progress < end);
}

export function eclipseCoverageAtSeparation(separation: number): number {
  const distance = Math.abs(separation) * CONTACT_DISTANCE;
  if (distance >= CONTACT_DISTANCE) return 0;
  if (distance <= Math.abs(MOON_RADIUS - SUN_RADIUS)) return 1;

  const sunTerm = Math.acos(
    clampUnit((distance * distance + SUN_RADIUS * SUN_RADIUS - MOON_RADIUS * MOON_RADIUS) /
      (2 * distance * SUN_RADIUS))
  );
  const moonTerm = Math.acos(
    clampUnit((distance * distance + MOON_RADIUS * MOON_RADIUS - SUN_RADIUS * SUN_RADIUS) /
      (2 * distance * MOON_RADIUS))
  );
  const lens = 0.5 * Math.sqrt(
    Math.max(
      0,
      (-distance + SUN_RADIUS + MOON_RADIUS) *
        (distance + SUN_RADIUS - MOON_RADIUS) *
        (distance - SUN_RADIUS + MOON_RADIUS) *
        (distance + SUN_RADIUS + MOON_RADIUS)
    )
  );
  const overlapArea =
    SUN_RADIUS * SUN_RADIUS * sunTerm + MOON_RADIUS * MOON_RADIUS * moonTerm - lens;
  return clamp01(overlapArea / (Math.PI * SUN_RADIUS * SUN_RADIUS));
}

function separationForCoverage(targetCoverage: number): number {
  let low = TOTALITY_SEPARATION;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) * 0.5;
    if (eclipseCoverageAtSeparation(middle) > targetCoverage) low = middle;
    else high = middle;
  }
  return (low + high) * 0.5;
}

const DIAMOND_RING_SEPARATION = separationForCoverage(PARTIAL_CONTACT_COVERAGE);

function separationAt(progress: number): number {
  if (progress < 0.36) {
    return -lerp(1, DIAMOND_RING_SEPARATION, smootherStep(progress / 0.36));
  }
  if (progress < 0.42) {
    return -lerp(
      DIAMOND_RING_SEPARATION,
      TOTALITY_SEPARATION,
      smootherStep(rangeProgress(progress, 0.36, 0.42))
    );
  }
  if (progress < 0.58) {
    return lerp(
      -TOTALITY_SEPARATION,
      TOTALITY_SEPARATION,
      smootherStep(rangeProgress(progress, 0.42, 0.58))
    );
  }
  if (progress < 0.64) {
    return lerp(
      TOTALITY_SEPARATION,
      DIAMOND_RING_SEPARATION,
      smootherStep(rangeProgress(progress, 0.58, 0.64))
    );
  }
  return lerp(
    DIAMOND_RING_SEPARATION,
    1,
    smootherStep(rangeProgress(progress, 0.64, 1))
  );
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function coronaAt(progress: number): number {
  if (progress < 0.36) return 0;
  if (progress < 0.42) return smootherStep(rangeProgress(progress, 0.36, 0.42));
  if (progress < 0.58) return 1;
  if (progress < 0.64) {
    return 1 - smootherStep(rangeProgress(progress, 0.58, 0.64));
  }
  return 0;
}

function beadsAt(progress: number): number {
  if (progress >= 0.36 && progress < 0.42) {
    const pulse = Math.sin(Math.PI * rangeProgress(progress, 0.36, 0.42));
    return pulse * pulse;
  }
  if (progress >= 0.58 && progress < 0.64) {
    const pulse = Math.sin(Math.PI * rangeProgress(progress, 0.58, 0.64));
    return pulse * pulse;
  }
  return 0;
}

function stateAt(progress: number, running: boolean): EclipseTimelineState {
  const normalizedProgress = clamp01(progress);
  const range = phaseRangeAt(normalizedProgress);
  const rawSeparation = separationAt(normalizedProgress);
  const separation = Math.abs(rawSeparation) < 1e-12 ? 0 : rawSeparation;
  const coverage = eclipseCoverageAtSeparation(separation);
  const corona = clamp01(coronaAt(normalizedProgress));

  if (!range) {
    return {
      phase: 'complete',
      progress: 1,
      phaseProgress: 1,
      coverage: 0,
      separation: 1,
      irradiance: 1,
      corona: 0,
      beads: 0,
      stars: 0,
      totality: 0,
      running: false,
    };
  }

  return {
    phase: range.phase,
    progress: normalizedProgress,
    phaseProgress: rangeProgress(normalizedProgress, range.start, range.end),
    coverage,
    separation,
    irradiance:
      MINIMUM_IRRADIANCE +
      (1 - MINIMUM_IRRADIANCE) * Math.pow(1 - coverage, 1.3),
    corona,
    beads: clamp01(beadsAt(normalizedProgress)),
    stars: smootherStep(corona),
    totality: smootherStep((coverage - PARTIAL_CONTACT_COVERAGE) / (1 - PARTIAL_CONTACT_COVERAGE)),
    running,
  };
}

export class EclipseTimeline {
  readonly durationSeconds: number;

  private elapsedSeconds = 0;
  private running = false;

  constructor(options: EclipseTimelineOptions = {}) {
    const durationSeconds = options.durationSeconds ?? DEFAULT_ECLIPSE_DURATION_SECONDS;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new RangeError('Eclipse duration must be a positive finite number.');
    }
    this.durationSeconds = durationSeconds;
  }

  start(): EclipseTimelineState {
    this.elapsedSeconds = 0;
    this.running = true;
    return this.getState();
  }

  stop(): EclipseTimelineState {
    this.running = false;
    return this.getState();
  }

  seek(progress: number, running = false): EclipseTimelineState {
    if (!Number.isFinite(progress)) {
      throw new RangeError('Eclipse seek progress must be finite.');
    }
    const normalized = clamp01(progress);
    this.elapsedSeconds = normalized * this.durationSeconds;
    this.running = running && normalized < 1;
    return this.getState();
  }

  update(deltaSeconds: number): EclipseTimelineState {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new RangeError('Eclipse update delta must be a non-negative finite number.');
    }

    if (this.running) {
      this.elapsedSeconds = Math.min(
        this.durationSeconds,
        this.elapsedSeconds + deltaSeconds
      );
      if (this.elapsedSeconds === this.durationSeconds) this.running = false;
    }

    return this.getState();
  }

  getState(): EclipseTimelineState {
    return stateAt(this.elapsedSeconds / this.durationSeconds, this.running);
  }
}
