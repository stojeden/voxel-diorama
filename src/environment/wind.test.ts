import { describe, expect, test } from 'vitest';
import { windBearingAt, windSeedFrom, type WindSeed } from './wind';
import { createWorldRandom } from '../core/Random';

/** A seed whose base sits just short of +π, so an hour of veer walks the bearing across it. */
const ACROSS_PI: WindSeed = { base: Math.PI - 0.05, veerPhase: 0, swirlPhase: 0 };

function unitVector(bearing: number): { x: number; z: number } {
  return { x: Math.cos(bearing), z: Math.sin(bearing) };
}

function turnBetween(a: number, b: number): number {
  const first = unitVector(a);
  const second = unitVector(b);
  return Math.acos(Math.min(1, Math.max(-1, first.x * second.x + first.z * second.z)));
}

describe('the world has one wind, and it veers', () => {
  test('the bearing is a pure function of the clock and the seed', () => {
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    for (const second of [0, 12.5, 91, 1234.75]) {
      expect(windBearingAt(second, 0.4, seed)).toBe(windBearingAt(second, 0.4, seed));
    }
  });

  test('two sessions do not get the same wind', () => {
    const first = windSeedFrom(createWorldRandom(7).stream('weather'));
    const second = windSeedFrom(createWorldRandom(8).stream('weather'));
    // Not the same starting bearing, and not merely offset in phase either.
    expect(turnBetween(windBearingAt(0, 0.4, first), windBearingAt(0, 0.4, second))).toBeGreaterThan(0.2);
    expect(turnBetween(windBearingAt(900, 0.4, first), windBearingAt(900, 0.4, second))).toBeGreaterThan(0.05);
  });

  test('it veers slowly enough to read as a settled wind, not a weathervane', () => {
    // Relocated from the plume's own test, which used to own the only direction in the world.
    // A jump here is what a viewer reads as the canopy, the plume and the balloon being
    // yanked at once, so the per-second turn stays under three degrees at FULL strength --
    // the case where the gust's veer contributes the most.
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    let worst = 0;
    for (let second = 0; second < 3600; second++) {
      worst = Math.max(worst, turnBetween(windBearingAt(second, 1, seed), windBearingAt(second + 1, 1, seed)));
    }
    expect(worst).toBeLessThan(0.05);
  });

  test('but it does veer: an hour moves it somewhere else', () => {
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    let furthest = 0;
    for (let second = 0; second <= 3600; second += 30) {
      furthest = Math.max(furthest, turnBetween(windBearingAt(0, 0.4, seed), windBearingAt(second, 0.4, seed)));
    }
    // A quarter of the 1500 s dominant period is enough to reach the swing; anything under
    // ~15 degrees over an hour would be a constant wearing a veer's clothes.
    expect(furthest).toBeGreaterThan(0.26);
  });

  test('the bearing never wraps, so nothing downstream inherits a jump at PI', () => {
    // This codebase has been bitten by exactly this: a `wrapPi` inside a swept quantity
    // produced a 343-degree snap. The bearing is free-running, so crossing PI is not an
    // event -- neither the angle NOR the vector it drives may move by anything but the veer.
    let previous = windBearingAt(0, 1, ACROSS_PI);
    let crossedPi = false;
    let worstStep = 0;
    for (let second = 1; second <= 2400; second++) {
      const bearing = windBearingAt(second, 1, ACROSS_PI);
      if (Math.abs(bearing) > Math.PI) crossedPi = true;
      worstStep = Math.max(worstStep, Math.abs(bearing - previous));
      previous = bearing;
    }
    // worstStep first: a wrap shows up here as a ~2PI step, which is the symptom a reader
    // needs to see. crossedPi guards the test itself -- without it a bearing that simply
    // never reached PI would pass while proving nothing.
    expect(worstStep).toBeLessThan(0.05);
    expect(crossedPi).toBe(true);
  });
});
