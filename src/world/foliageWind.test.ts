import { describe, expect, test } from 'vitest';
import {
  FOLIAGE_FLUTTER_PEAK,
  FOLIAGE_WIND_CHUNK,
  FOLIAGE_WIND_FLUTTER,
  FOLIAGE_WIND_LEAN,
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
      `float windBend = ${FOLIAGE_WIND_LEAN} + ${FOLIAGE_WIND_FLUTTER} * windFlutter;`
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

  test('the peak displacement is the one that ships today', () => {
    // The owner likes the size of the current tree motion and asked for its direction to
    // change, not its amount. 0.6 + 0.625 * 1.6 = 1.6, which is the old peak exactly.
    const peak = Math.max(...sample(0.37).map(Math.abs));
    expect(FOLIAGE_WIND_LEAN + FOLIAGE_WIND_FLUTTER * FOLIAGE_FLUTTER_PEAK)
      .toBeCloseTo(FOLIAGE_FLUTTER_PEAK, 9);
    expect(peak).toBeLessThanOrEqual(FOLIAGE_FLUTTER_PEAK + 1e-9);
    expect(peak).toBeGreaterThan(FOLIAGE_FLUTTER_PEAK * 0.97);
  });

  test('the lean-to-flutter ratio leaves it downwind most of the time', () => {
    // 0.6 : 1.0 at the peak. The trough is -0.4, a quarter of the peak, so the canopy springs
    // back through rest the way a loaded branch does without ever swinging as far upwind as
    // it sits downwind.
    const values = sample(0.37);
    expect(FOLIAGE_WIND_LEAN / (FOLIAGE_WIND_FLUTTER * FOLIAGE_FLUTTER_PEAK)).toBeCloseTo(0.6, 6);
    const trough = Math.min(...values);
    expect(trough).toBeCloseTo(FOLIAGE_WIND_LEAN - FOLIAGE_WIND_FLUTTER * FOLIAGE_FLUTTER_PEAK, 1);
    expect(Math.abs(trough)).toBeLessThan(Math.max(...values) / 2);
    const downwind = values.filter((value) => value > 0).length / values.length;
    expect(downwind).toBeGreaterThan(0.75);
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
