import { describe, expect, test } from 'vitest';
import {
  FOLIAGE_FLUTTER_PEAK,
  FOLIAGE_WIND_CHUNK,
  FOLIAGE_WIND_EXCURSION,
  FOLIAGE_WIND_FLUTTER,
  FOLIAGE_WIND_LEAN,
  glslFloat,
} from './WorldGenerator';

/**
 * The canopy answers to the wind's DIRECTION, not merely to its axis.
 *
 * The displacement the shader applies is `windBend * windAmp * uWindDir`. `windAmp` is a
 * positive scale (strength × height × the 1.14127 length factor) and `uWindDir` is the unit
 * downwind vector, so everything about sign and size lives in `windBend`, and `windBend` is
 * what these tests evaluate. The GLSL is built from the same three exported constants, so
 * there is no second copy of the numbers to drift.
 */
function flutter(time: number, phase: number): number {
  return Math.sin(time * 1.7 + phase) + 0.6 * Math.sin(time * 2.9 + phase * 1.7);
}

function bend(time: number, phase: number): number {
  return FOLIAGE_WIND_LEAN + FOLIAGE_WIND_FLUTTER * flutter(time, phase);
}

/** Dense enough that a peak between samples cannot hide. */
function sample(phase: number): number[] {
  const values: number[] = [];
  for (let time = 0; time < 400; time += 0.005) values.push(bend(time, phase));
  return values;
}

describe('the foliage leans downwind and flutters about the lean', () => {
  test('the shipped GLSL is built from the constants these tests reason about', () => {
    expect(FOLIAGE_WIND_CHUNK).toContain(
      `float windBend = ${glslFloat(FOLIAGE_WIND_LEAN)} + ${glslFloat(FOLIAGE_WIND_FLUTTER)} * windFlutter;`
    );
    expect(FOLIAGE_WIND_CHUNK).toContain('transformed.x += windBend * windAmp * uWindDir.x;');
    expect(FOLIAGE_WIND_CHUNK).toContain('transformed.z += windBend * windAmp * uWindDir.y;');
    // A comment in a shader string is shipped bytes, not stripped ones.
    expect(FOLIAGE_WIND_CHUNK).not.toContain('//');
  });

  test('a bearing and its opposite no longer produce identical motion', () => {
    // The defect, put back: the flutter alone is zero-mean and symmetric about the
    // undisplaced vertex, so theta and theta+pi drew the same canopy and the trees had a
    // line rather than a direction. The mean displacement is what tells them apart.
    const values = sample(0.37);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const flutterOnly = values.map((value) => value - FOLIAGE_WIND_LEAN);
    const flutterMean = flutterOnly.reduce((total, value) => total + value, 0) / flutterOnly.length;

    expect(flutterMean).toBeCloseTo(0, 2);
    expect(mean).toBeCloseTo(FOLIAGE_WIND_LEAN, 2);
    // Under a bearing of theta the mean vertex sits `mean` downwind; under theta+pi it sits
    // `mean` the other way. That difference is the whole finding.
    expect(mean).toBeGreaterThan(0.5);
  });

  test('the EXCURSION is the one that ships today, which is what a viewer sees as motion', () => {
    // The quantity the owner named. What reads as "how much the trees move" is the distance
    // between the extremes of the swing, not the distance from the origin to one of them --
    // and the origin is not on the screen anywhere, so a peak measured from it is not a
    // measurement of motion at all.
    //
    // The branch measured the peak, found it unchanged at 1.6, and claimed the motion was
    // unchanged. It was not: scaling the flutter by 0.625 to hold the peak took the swing
    // from -1.6..+1.6 (span 3.2) to -0.4..+1.6 (span 2.0). A 37.5% cut, reported as no change.
    const values = sample(0.37);
    const excursion = Math.max(...values) - Math.min(...values);
    expect(FOLIAGE_WIND_EXCURSION).toBeCloseTo(2 * FOLIAGE_FLUTTER_PEAK, 9);
    expect(excursion).toBeCloseTo(FOLIAGE_WIND_EXCURSION, 1);
    expect(2 * FOLIAGE_WIND_FLUTTER * FOLIAGE_FLUTTER_PEAK).toBeCloseTo(FOLIAGE_WIND_EXCURSION, 9);
  });

  test('the lean is a bias on that swing, not a slice taken out of it', () => {
    // Both halves at once, which is the whole point: the swing is the size it always was AND
    // the canopy sits downwind of rest. The only thing that moves is the peak -- 1.6 -> 2.2 --
    // which is a leaning tree's top reaching further downwind at the worst of a gust, and is
    // exactly the quantity that must NOT be held fixed if the swing is to be.
    const values = sample(0.37);
    const top = Math.max(...values);
    const trough = Math.min(...values);
    expect(top).toBeCloseTo(FOLIAGE_WIND_LEAN + FOLIAGE_FLUTTER_PEAK, 1);
    expect(trough).toBeCloseTo(FOLIAGE_WIND_LEAN - FOLIAGE_FLUTTER_PEAK, 1);
    // Downwind of rest on the mean, and it still springs back through rest rather than
    // hanging there: a branch under load, not a flag on a pole.
    expect(trough).toBeLessThan(0);
    expect(FOLIAGE_WIND_LEAN).toBeGreaterThan(0);
    const downwind = values.filter((value) => value > 0).length / values.length;
    expect(downwind).toBeGreaterThan(0.6);
  });

  test('every number the GLSL is built from is written as a float', () => {
    // `${1}` is "1", and `1 * windFlutter` is an int times a float -- which GLSL ES refuses to
    // compile, on a code path no unit test and no CI machine with no GPU ever executes. The
    // flutter scale became exactly 1.0 in this change, so this is not hypothetical.
    for (const literal of [FOLIAGE_WIND_LEAN, FOLIAGE_WIND_FLUTTER]) {
      expect(glslFloat(literal)).toMatch(/^-?\d+\.\d+$/);
    }
    expect(FOLIAGE_WIND_CHUNK).not.toMatch(/[^.\d]\d+ \* windFlutter/);
  });

  test('the canopy still ripples rather than moving as one slab', () => {
    // The per-instance phase is untouched: two trees at different origins are at different
    // points of the same flutter at the same instant. A lean applied to all of them equally
    // must not have flattened that.
    let differing = 0;
    for (let time = 0; time < 20; time += 0.05) {
      if (Math.abs(bend(time, 0.37) - bend(time, 2.9)) > 0.1) differing++;
    }
    expect(differing).toBeGreaterThan(300);
  });
});
