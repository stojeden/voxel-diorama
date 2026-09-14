import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ECLIPSE_DURATION_SECONDS,
  EclipseTimeline,
  eclipseCoverageAtSeparation,
  eclipseSeparationForCoverage,
  type EclipseTimelineState,
} from './EclipseTimeline';

const expectSignalsInRange = (state: EclipseTimelineState): void => {
  expect(state.progress).toBeGreaterThanOrEqual(0);
  expect(state.progress).toBeLessThanOrEqual(1);
  expect(state.phaseProgress).toBeGreaterThanOrEqual(0);
  expect(state.phaseProgress).toBeLessThanOrEqual(1);
  // Contact to contact. 1 is first contact -- the moment the two discs touch -- and the
  // traverse has no reason to go beyond it: past it there is no eclipse to describe, and the
  // silhouette is gated on coverage, so nothing would be drawn there anyway.
  expect(state.separation).toBeGreaterThanOrEqual(-1);
  expect(state.separation).toBeLessThanOrEqual(1);

  for (const signal of [
    state.coverage,
    state.irradiance,
    state.corona,
    state.beads,
    state.stars,
    state.totality,
  ]) {
    expect(signal).toBeGreaterThanOrEqual(0);
    expect(signal).toBeLessThanOrEqual(1);
  }
};

describe('EclipseTimeline', () => {
  test('derives coverage from the physical overlap of both discs', () => {
    expect(eclipseCoverageAtSeparation(-1)).toBe(0);
    expect(eclipseCoverageAtSeparation(0)).toBe(1);
    expect(eclipseCoverageAtSeparation(1)).toBe(0);
    expect(eclipseCoverageAtSeparation(-0.25)).toBeCloseTo(
      eclipseCoverageAtSeparation(0.25),
      12
    );
  });

  test('uses a deterministic 90 second sequence by default', () => {
    const timeline = new EclipseTimeline();

    expect(timeline.durationSeconds).toBe(DEFAULT_ECLIPSE_DURATION_SECONDS);
    expect(timeline.start()).toMatchObject({
      phase: 'partial-in',
      progress: 0,
      coverage: 0,
      separation: -1,
      irradiance: 1,
      running: true,
    });

    const firstRun = timeline.update(45);
    timeline.start();
    const secondRun = timeline.update(45);
    expect(secondRun).toEqual(firstRun);
  });

  test.each([
    { at: 0.18, phase: 'partial-in' },
    { at: 0.39, phase: 'c2-diamond-ring' },
    { at: 0.5, phase: 'totality' },
    { at: 0.61, phase: 'c3-diamond-ring' },
    { at: 0.82, phase: 'partial-out' },
    { at: 1, phase: 'complete' },
  ] as const)('returns the $phase checkpoint at $at progress', ({ at, phase }) => {
    const timeline = new EclipseTimeline({ durationSeconds: 100 });
    timeline.start();

    const state = timeline.update(at * 100);

    expect(state.phase).toBe(phase);
    expect(state.progress).toBeCloseTo(at, 10);
    expectSignalsInRange(state);
  });

  test('models totality and both diamond-ring contacts', () => {
    const timeline = new EclipseTimeline({ durationSeconds: 100 });

    timeline.start();
    const c2 = timeline.update(39);
    expect(c2).toMatchObject({ phase: 'c2-diamond-ring' });
    expect(c2.beads).toBeCloseTo(1, 10);
    expect(c2.coverage).toBeGreaterThan(0.985);

    timeline.start();
    const totality = timeline.update(50);
    expect(totality).toMatchObject({
      phase: 'totality',
      coverage: 1,
      corona: 1,
      stars: 1,
      separation: 0,
    });
    // 0.0025, not the 0.025 this pinned until 2026-09-13. The old floor dominated the
    // (1 - coverage)^1.3 term long before the moon finished, so irradiance fell only 14 per
    // cent across the whole totality ramp while every additive term gated on `totality` went
    // 0 to 1 -- the frame BRIGHTENED 35 per cent into totality, and second contact was the
    // darkest moment of the eclipse. See the constant's docblock for the two measurements.
    expect(totality.irradiance).toBeCloseTo(0.0025, 10);
    expect(totality.beads).toBe(0);

    timeline.start();
    const c3 = timeline.update(61);
    expect(c3).toMatchObject({ phase: 'c3-diamond-ring' });
    expect(c3.beads).toBeCloseTo(1, 10);
  });

  test('has continuous signals at every phase boundary', () => {
    const boundaries = [0.36, 0.42, 0.58, 0.64, 1];
    const epsilon = 1e-7;

    for (const boundary of boundaries) {
      const before = new EclipseTimeline({ durationSeconds: 1 });
      before.start();
      const beforeState = before.update(Math.max(0, boundary - epsilon));

      const after = new EclipseTimeline({ durationSeconds: 1 });
      after.start();
      const afterState = after.update(Math.min(1, boundary + epsilon));

      for (const key of [
        'coverage',
        'separation',
        'irradiance',
        'corona',
        'beads',
        'stars',
        'totality',
      ] as const) {
        expect(Math.abs(beforeState[key] - afterState[key])).toBeLessThan(0.00001);
      }
    }
  });

  test('stops without advancing and completes without overshooting', () => {
    const timeline = new EclipseTimeline({ durationSeconds: 10 });
    timeline.start();
    const stopped = timeline.update(2.5);
    timeline.stop();

    expect(timeline.update(100)).toMatchObject({
      phase: stopped.phase,
      progress: stopped.progress,
      running: false,
    });

    timeline.start();
    expect(timeline.update(100)).toEqual({
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
    });
  });

  test('seeks to deterministic visual checkpoints', () => {
    const timeline = new EclipseTimeline();
    expect(timeline.seek(0.5)).toMatchObject({
      phase: 'totality',
      progress: 0.5,
      coverage: 1,
      totality: 1,
      running: false,
    });
    expect(timeline.seek(2).phase).toBe('complete');
    expect(() => timeline.seek(Number.NaN)).toThrow(RangeError);
  });

  test('rejects invalid duration and update boundaries', () => {
    expect(() => new EclipseTimeline({ durationSeconds: 0 })).toThrow(RangeError);
    expect(() => new EclipseTimeline({ durationSeconds: Number.POSITIVE_INFINITY })).toThrow(
      RangeError
    );

    const timeline = new EclipseTimeline();
    timeline.start();
    expect(() => timeline.update(-0.001)).toThrow(RangeError);
    expect(() => timeline.update(Number.NaN)).toThrow(RangeError);
  });
});

/**
 * THE TRAVERSE, which is what the owner was looking at when he said the moon was an egg.
 *
 * Nothing here pins a value the old timeline would also have satisfied. The old one started
 * the moon AT first contact, so it had nowhere to come from, and moved it with five
 * independent smootherSteps, each of which has zero derivative at both ends -- so the moon
 * came to a dead stop at every join, and spent the first tenth of the eclipse covering a
 * tenth of nothing at all.
 */
describe('the moon crosses the sun instead of being born on it', () => {
  const timeline = new EclipseTimeline();
  const separationAt = (progress: number): number => timeline.seek(progress).separation;

  test('starts and ends at first contact, so every second of it is eclipse', () => {
    expect(separationAt(0)).toBeCloseTo(-1, 12);
    expect(separationAt(1)).toBeCloseTo(1, 12);
    expect(timeline.seek(0).coverage).toBe(0);
    expect(timeline.seek(1).coverage).toBe(0);
    // An approach was tried -- the traverse ran from -1.45 so the moon had somewhere to come
    // from -- and was taken back out when the silhouette was hung on coverage instead. It is
    // time in which nothing can be drawn by construction, so it is time taken from the reveal.
    for (const progress of [0.002, 0.01, 0.05, 0.2, 0.8, 0.95, 0.998]) {
      expect(timeline.seek(progress).coverage).toBeGreaterThan(0);
    }
  });

  test('the bite grows from the very first frame rather than easing out of rest', () => {
    // The old traverse eased every segment with smootherStep, which is stationary at both
    // ends, so the first tenth of the eclipse bought a tenth of nothing. One second in at the
    // shipped ninety -- progress 0.0111 -- the sun is already measurably bitten.
    expect(timeline.seek(1 / 90).coverage).toBeGreaterThan(0.005);
    expect(timeline.seek(5 / 90).coverage).toBeGreaterThan(0.07);
    // ...and the reveal's own landmark, coverage 0.35, lands inside the first fifth.
    const revealDone = (() => {
      for (let p = 0; p <= 1; p += 0.0005) if (timeline.seek(p).coverage >= 0.35) return p;
      return Number.NaN;
    })();
    expect(revealDone).toBeGreaterThan(0.1);
    expect(revealDone).toBeLessThan(0.2);
  });

  test('never stops, never backs up, and never leaves the traverse', () => {
    let previous = separationAt(0);
    let smallestStep = Infinity;
    let largestStep = 0;
    for (let step = 1; step <= 2000; step += 1) {
      const value = separationAt(step / 2000);
      const delta = value - previous;
      // Monotone: a Catmull-Rom through these knots WOULD overshoot and reverse, which is
      // why the tangents are the monotone (Fritsch-Butland) ones.
      expect(delta).toBeGreaterThanOrEqual(0);
      if (delta < smallestStep) smallestStep = delta;
      if (delta > largestStep) largestStep = delta;
      expect(Math.abs(value)).toBeLessThanOrEqual(1 + 1e-12);
      previous = value;
    }
    // THE NUMBER THAT SEPARATES THE TWO TRAVERSES, at this sample count and no other:
    //
    //   old (five smootherSteps)   smallest step 5.6e-9,  largest 0.002541
    //   new (one monotone curve)   smallest step 4.5e-5,  largest 0.001743
    //
    // smootherStep has zero derivative at BOTH ends of every segment, so the old traverse
    // came to a halt at each join and the step across one only survives as the cubic's own
    // third-order term. Four orders of magnitude, and a bound in the middle of them.
    expect(smallestStep).toBeGreaterThan(1e-6);
    // The slowest the moon ever moves is in the middle of totality, where it is crossing the
    // sun's centre and is meant to be nearly still; even there it is moving.
    expect(smallestStep).toBeLessThan(largestStep / 10);
    expect(largestStep).toBeLessThan(0.01);
  });

  test('lands on every authored contact exactly, so the rest of the schedule is untouched', () => {
    // coronaAt and beadsAt switch on these same four numbers. If the traverse drifted off
    // them the diamond rings would fire while the discs were somewhere else.
    const c2 = timeline.seek(0.42);
    const c3 = timeline.seek(0.58);
    expect(c2.coverage).toBe(1);
    expect(c3.coverage).toBe(1);
    expect(timeline.seek(0.36).coverage).toBeCloseTo(0.985, 6);
    expect(timeline.seek(0.64).coverage).toBeCloseTo(0.985, 6);
    // Totality is the whole of [0.42, 0.58] and not a moment more.
    expect(timeline.seek(0.4199).coverage).toBeLessThan(1);
    expect(timeline.seek(0.5801).coverage).toBeLessThan(1);
    for (let p = 0.42; p <= 0.58; p += 0.004) expect(timeline.seek(p).coverage).toBe(1);
  });

  test('is symmetric about mid-totality', () => {
    for (let p = 0; p <= 0.5; p += 0.01) {
      expect(separationAt(p)).toBeCloseTo(-separationAt(1 - p), 12);
    }
  });
});

describe('the coverage law can be inverted, and the diagnostic path uses the inverse', () => {
  test('round-trips coverage through separation and back', () => {
    for (const coverage of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.985, 0.999]) {
      const separation = eclipseSeparationForCoverage(coverage);
      expect(separation).toBeGreaterThan(0);
      expect(separation).toBeLessThanOrEqual(1);
      expect(eclipseCoverageAtSeparation(separation)).toBeCloseTo(coverage, 6);
    }
  });

  test('the straight line it replaces put the moon where the coverage said it was not', () => {
    // `DayNightCycle.setEclipse` drove the whole eclipse from one 0..1 strength and mapped it
    // to a separation with `1.25 * (1 - coverage)`. That line crosses first contact -- where
    // the discs touch and coverage is exactly 0 -- at coverage 0.2, so for the whole bottom
    // fifth of the range it asked for a covered sun and drew two discs that were not
    // touching. Harmless while the moon was only drawn inside the sun; now that the moon has
    // a silhouette it draws an opaque disc clear of a sun the world says is eclipsed.
    expect(eclipseCoverageAtSeparation(1.25 * (1 - 0.2))).toBe(0);
    expect(eclipseCoverageAtSeparation(eclipseSeparationForCoverage(0.2))).toBeCloseTo(0.2, 6);
    // The endpoint is not on the line either: the line gives the moon 1.25 at zero coverage,
    // where the traverse and the coverage law both say first contact is exactly 1.
    expect(eclipseCoverageAtSeparation(1)).toBe(0);
  });
});
