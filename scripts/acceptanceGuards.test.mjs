/**
 * The acceptance's own guards, exercised without a renderer.
 *
 * These cover the three ways an acceptance can lie: an exception that quietly widens, a
 * missing report read as "nothing to report", and a stale report from an earlier run of the
 * same revision. None of them needs a browser, and none of them should ever need one --
 * they are decisions about numbers and files.
 */
import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPTED_DEVIATION, classifyLegibility } from './legibilityDeviation.mjs';
import { readDeviationReport, validateDeviationReport } from './acceptanceReport.mjs';

const ACCEPTED_CASE = {
  world: ACCEPTED_DEVIATION.world,
  quality: ACCEPTED_DEVIATION.quality,
  shot: ACCEPTED_DEVIATION.shot,
  group: ACCEPTED_DEVIATION.group,
};

describe('the accepted legibility deviation', () => {
  test('covers only the case the owner accepted, at or above the floor', () => {
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 28.5 })).toBe('DEVIATION');
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 27 })).toBe('DEVIATION');
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 49.9 })).toBe('DEVIATION');
  });

  test('below the floor is a failure, not the deviation', () => {
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 26.9 })).toBe('FAIL');
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 0 })).toBe('FAIL');
  });

  test('meeting the gate is a pass, and the exception never comes into it', () => {
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 50 })).toBe('PASS');
    expect(classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: 92.4 })).toBe('PASS');
  });

  test.each([
    ['another world', { world: 'voxel' }],
    ['another profile', { quality: 'low' }],
    ['the wheels in the same shot', { group: 'wheels' }],
    ['the frame in another shot', { shot: 'postman-three-quarter' }],
    ['the frame in the third shot', { shot: 'postman-in-world' }],
  ])('does not cover %s', (_label, override) => {
    expect(classifyLegibility({ ...ACCEPTED_CASE, ...override, separatedPercent: 28.5 })).toBe('FAIL');
  });

  test('rejects a measurement that is not a number rather than classifying it', () => {
    expect(() => classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: Number.NaN })).toThrow(/not a number/);
    expect(() => classifyLegibility({ ...ACCEPTED_CASE, separatedPercent: undefined })).toThrow(/not a number/);
  });
});

describe('the deviation report a step must produce', () => {
  const expected = { revisionFull: 'a'.repeat(40), builtAt: '2026-09-06T12:00:00.000Z' };
  const good = {
    revisionFull: expected.revisionFull,
    builtAt: expected.builtAt,
    deviations: [{ shot: 'postman-side', group: 'frame', separatedPercent: 28.5, gate: 50, floor: 27 }],
  };

  test('accepts a report from this run and returns its deviations', () => {
    expect(validateDeviationReport(good, expected)).toHaveLength(1);
  });

  test('accepts an empty list only when the report itself is present and current', () => {
    expect(validateDeviationReport({ ...good, deviations: [] }, expected)).toEqual([]);
  });

  test('a missing file is an error, not an empty list', () => {
    const directory = mkdtempSync(join(tmpdir(), 'acceptance-guard-'));
    expect(() => readDeviationReport(join(directory, 'nie-ma.json'), expected)).toThrow(/cannot read/);
  });

  test('a truncated file is an error, not an empty list', () => {
    const directory = mkdtempSync(join(tmpdir(), 'acceptance-guard-'));
    const file = join(directory, 'spike-postman.json');
    writeFileSync(file, '{"revisionFull": "aaa", "deviations": [');
    expect(() => readDeviationReport(file, expected)).toThrow(/not valid JSON/);
  });

  test('a report from another revision is rejected', () => {
    expect(() => validateDeviationReport({ ...good, revisionFull: 'b'.repeat(40) }, expected))
      .toThrow(/but HEAD is/);
  });

  test('a report from an earlier run of the same revision is rejected', () => {
    // Same commit, different build stamp: exactly the stale file the per-run directory is
    // meant to keep out, checked again in case it somehow gets there.
    expect(() => validateDeviationReport({ ...good, builtAt: '2026-09-06T09:00:00.000Z' }, expected))
      .toThrow(/left over from another run/);
  });

  test('a report without a deviations array is rejected', () => {
    expect(() => validateDeviationReport({ ...good, deviations: undefined }, expected))
      .toThrow(/no deviations array/);
    expect(() => validateDeviationReport({ ...good, deviations: 'brak' }, expected))
      .toThrow(/no deviations array/);
  });

  test('a deviation missing the fields the summary prints is rejected', () => {
    expect(() => validateDeviationReport({ ...good, deviations: [{ shot: 'postman-side' }] }, expected))
      .toThrow(/missing group, separatedPercent, gate, floor/);
  });

  test('a deviation with a non-numeric measurement is rejected', () => {
    const deviations = [{ ...good.deviations[0], separatedPercent: 'niski' }];
    expect(() => validateDeviationReport({ ...good, deviations }, expected))
      .toThrow(/non-numeric separatedPercent/);
  });
});
