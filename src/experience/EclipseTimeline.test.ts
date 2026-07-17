import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ECLIPSE_DURATION_SECONDS,
  EclipseTimeline,
  eclipseCoverageAtSeparation,
  type EclipseTimelineState,
} from './EclipseTimeline';

const expectSignalsInRange = (state: EclipseTimelineState): void => {
  expect(state.progress).toBeGreaterThanOrEqual(0);
  expect(state.progress).toBeLessThanOrEqual(1);
  expect(state.phaseProgress).toBeGreaterThanOrEqual(0);
  expect(state.phaseProgress).toBeLessThanOrEqual(1);
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
    expect(totality.irradiance).toBeCloseTo(0.025, 10);
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
