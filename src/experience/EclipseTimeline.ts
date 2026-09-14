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
/**
 * How much of the sun's light still reaches the observer at totality, as a fraction of the
 * uneclipsed hour.
 *
 * This is the floor on how dark the eclipse can get, and at 0.025 it was the single thing
 * holding the sky bright. Two measurements, both on the built product with the weather pinned:
 *
 *  - Across the ENTIRE totality ramp -- coverage 0.985 to 1.0 -- `irradiance` fell only from
 *    0.02915 to 0.02500, 14 per cent, because this floor dominates the `(1 - coverage)^1.3`
 *    term long before the moon finishes. Meanwhile every additive term gated on `totality`
 *    goes 0 to 1 over exactly that interval. The world therefore BRIGHTENED 35 per cent as the
 *    moon finished covering the sun, and second contact, not totality, was the darkest frame.
 *  - With the billboard hidden, the sky immediately beside the sun still presented at 236 of
 *    255 at totality. Preetham's forward-scattering lobe near a low sun is of order 1000 in
 *    linear radiance, and two and a half per cent of a thousand is still white. That is why
 *    the corona could not be seen: it was not too dim, the sky behind it was too bright.
 *
 * Real totality is 1 to 100 lux against about 100 000 in full sun, i.e. 1e-5 to 1e-3. The
 * value here is deliberately the bright end of that, and above it: legibility on a screen the
 * viewer's eye is not dark-adapted to, and the honest name for the gap is legibility, not
 * physics. What the floor is NOT doing any more is standing in for the umbral sky -- since the
 * dome carries an explicit additive skyglow (`ECLIPSE_UMBRAL_ZENITH` plus the ring), the floor
 * on what the observer can see belongs on THAT term, where it is a colour rather than a
 * multiplier on the whole Preetham lobe.
 *
 * The diffuse fills do not follow this down: `eclipseDiffuseFraction` floors them at 0.13
 * independently, so lowering this darkens the sky and the direct beam -- which at totality is
 * geometrically zero anyway -- and leaves the light the city is modelled by alone.
 */
const MINIMUM_IRRADIANCE = 0.0025;

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

/**
 * The separation at which the discs overlap by `targetCoverage`, by bisection on the coverage
 * law above. Exported because `DayNightCycle.setEclipse` -- the diagnostic that drives the
 * eclipse from a single 0..1 strength -- needs the real inverse and had a straight line
 * instead: `1.25 * (1 - coverage)` reached separation 1, i.e. first contact, at coverage 0.2,
 * so every reading it produced put the moon somewhere the coverage said it was not. That was
 * survivable while the moon was only drawn inside the sun; now that it has a silhouette, the
 * same map draws an opaque disc sitting clear of the sun while the world is a fifth eclipsed.
 */
export function eclipseSeparationForCoverage(targetCoverage: number): number {
  let low = TOTALITY_SEPARATION;
  let high = 1;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) * 0.5;
    if (eclipseCoverageAtSeparation(middle) > targetCoverage) low = middle;
    else high = middle;
  }
  return (low + high) * 0.5;
}

const DIAMOND_RING_SEPARATION = eclipseSeparationForCoverage(PARTIAL_CONTACT_COVERAGE);

/**
 * WHERE THE TRAVERSE BEGINS AND ENDS: at first contact, on both sides.
 *
 * This was 1.45 for one release -- 0.45 contact distances of clear sky before the discs
 * touch -- so the moon had somewhere to come from. It has been taken back out, and the reason
 * is worth keeping because it is the second half of the same brief.
 *
 * The first complaint was that the moon "hatched": with the silhouette clipped to the sun's
 * own circle, the only shape on screen was the intersection of two discs, a vesica in a white
 * glare. The approach was half the answer to that -- the moon arrived instead of appearing.
 * The other half was drawing the silhouette against the sky at all, and TOGETHER they put a
 * complete black ball in an empty sky for nine seconds before anything happened to the sun.
 * That is what the owner asked to remove: the moon should be revealed BY the sun, covering it
 * first and only then showing its full outline.
 *
 * Once the disc's visibility hangs on coverage (see `MOON_REVEAL_COVERAGE` in
 * `EclipseVisual.ts`), the approach is time in which nothing can be seen by construction, so
 * it is time taken away from the reveal. First contact is progress 0 again, which gives the
 * partial phase its full 32 seconds instead of 24.
 *
 * The monotone traverse below is unaffected and stays: it is what stopped the moon halting at
 * every phase join, and it is what makes the bite grow at a readable rate from the first
 * frame rather than easing out of rest.
 */
const FIRST_CONTACT_SEPARATION = 1;

/**
 * The traverse, as six authored moments and one monotone curve through them.
 *
 * Every entry is (progress, separation): the two ends of the traverse and the four contacts
 * between them. The four interior ones are the moments the rest of the timeline is already
 * built around -- `coronaAt` and `beadsAt` switch on the same four numbers -- so they are not
 * a new set of magic constants; they are the SAME schedule, now written once as data instead
 * of five times as `lerp` calls.
 */
const TRAVERSE: readonly (readonly [number, number])[] = [
  [0, -FIRST_CONTACT_SEPARATION],
  [0.36, -DIAMOND_RING_SEPARATION],
  [0.42, -TOTALITY_SEPARATION],
  [0.58, TOTALITY_SEPARATION],
  [0.64, DIAMOND_RING_SEPARATION],
  [1, FIRST_CONTACT_SEPARATION],
];

/**
 * Tangents for a monotone cubic Hermite through {@link TRAVERSE} (Fritsch-Carlson 1980, in
 * Fritsch & Butland's weighted-harmonic form), and the reason the moon does not stop any more.
 *
 * The shipped traverse was five independent `smootherStep` segments, and `smootherStep` has
 * zero derivative at BOTH ends. So the moon decelerated to a dead stop at both ends of every
 * segment: four stalls inside the ninety seconds, at progress 0.36, 0.42, 0.58 and 0.64, and
 * one at each end of the eclipse. The one at progress 0 was the worst of them and the only
 * one anybody could see -- the moon left first contact at a speed of exactly zero, and over
 * the first tenth of the eclipse it covered a tenth of the bite.
 *
 * Sampled at two thousand points, the smallest step the old traverse took was 5.6e-9 against
 * a mean of 1.0e-3; this one takes 4.5e-5 against a mean of 1.45e-3. Four orders of magnitude
 * is the difference between stopping and slowing down. `EclipseTimeline.test.ts` holds the
 * bound between them.
 *
 * A single monotone curve through the same knots fixes that without moving any of them. The
 * knots are interpolated exactly, so second contact still lands at progress 0.42 and third at
 * 0.58 and totality still occupies [0.42, 0.58] to the last bit; what changes is only the
 * rate between them, which is the thing being complained about. The harmonic mean is what
 * makes it monotone: where two neighbouring secants differ by a factor of sixteen -- and the
 * approach's 3.96 against the diamond ring's 0.251 does -- an arithmetic mean would overshoot
 * and the moon would visibly back up before going on.
 *
 * Speed is never zero anywhere in [0, 1) as a result. In separation per unit progress it is
 * 3.960 at the first frame, 5.150 at its fastest (progress 0.120) and 0.090 at its slowest
 * (mid-totality, where the moon is by definition standing still over the sun's centre); on
 * the framing quoted at {@link MOON_APPROACH_SEPARATION} -- 85.9 px per billboard unit, 90 s
 * -- that is 1.83, 2.38 and 0.042 px/s. The ratios are the fact; the pixels depend on the
 * viewport and are given only so the numbers can be checked against a capture.
 */
const TRAVERSE_TANGENTS: readonly number[] = (() => {
  const widths: number[] = [];
  const secants: number[] = [];
  for (let i = 0; i < TRAVERSE.length - 1; i++) {
    widths.push(TRAVERSE[i + 1][0] - TRAVERSE[i][0]);
    secants.push((TRAVERSE[i + 1][1] - TRAVERSE[i][1]) / widths[i]);
  }
  const tangents = [secants[0]];
  for (let i = 1; i < TRAVERSE.length - 1; i++) {
    // A sign change or a flat neighbour means a local extremum: a zero tangent is the only
    // one that cannot overshoot it. This traverse is strictly increasing so it never fires,
    // and it is here because the next person to move a knot should not have to know that.
    if (secants[i - 1] * secants[i] <= 0) {
      tangents.push(0);
      continue;
    }
    tangents.push(
      (3 * (widths[i - 1] + widths[i])) /
        ((2 * widths[i] + widths[i - 1]) / secants[i - 1] +
          (widths[i] + 2 * widths[i - 1]) / secants[i])
    );
  }
  tangents.push(secants[secants.length - 1]);
  return tangents;
})();

/**
 * Where the moon's centre stands at a given progress. Monotone, C1, and never stationary
 * except where the schedule genuinely holds it over the sun's centre.
 */
function separationAt(progress: number): number {
  if (progress <= TRAVERSE[0][0]) return TRAVERSE[0][1];
  const last = TRAVERSE.length - 1;
  if (progress >= TRAVERSE[last][0]) return TRAVERSE[last][1];

  let i = 0;
  while (progress > TRAVERSE[i + 1][0]) i++;
  const [x0, y0] = TRAVERSE[i];
  const [x1, y1] = TRAVERSE[i + 1];
  const width = x1 - x0;
  const t = (progress - x0) / width;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * width * TRAVERSE_TANGENTS[i] +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * width * TRAVERSE_TANGENTS[i + 1]
  );
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
      // Fourth contact, where the traverse leaves it. Coverage is 0 there, and the moon's
      // silhouette is gated on coverage, so nothing is drawn between eclipses.
      separation: FIRST_CONTACT_SEPARATION,
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
