import { describe, expect, test } from 'vitest';
import {
  GUST_SLOW_RATE,
  WIND_BASE_BEARING,
  windBearingAt,
  windSeedFrom,
  type WindSeed,
} from './wind';
import { createWorldRandom, DEFAULT_SIMULATION_SEED } from '../core/Random';
import { OPENING_SHOT, OVERVIEW_SHOT, type CameraShot } from '../experience/ShotDefinitions';
import type { Radians } from '../units';

/** A seed whose base sits just short of +π, so an hour of veer walks the bearing across it. */
const ACROSS_PI: WindSeed = {
  base: (Math.PI - 0.05) as Radians,
  veerPhase: 0 as Radians,
  swirlPhase: 0 as Radians,
};

/** The ground bearing a shot looks along, in the wind's own convention (x = cos, z = sin). */
function viewBearing(shot: CameraShot): number {
  return Math.atan2(shot.target[2] - shot.position[2], shot.target[0] - shot.position[0]);
}

/**
 * How far a wind bearing is from a view LINE, 0 (straight down it) to π/2 (across it).
 *
 * A line, not a direction: a balloon flying at the camera and one flying away from it are the
 * same failure, and both are 0 here.
 */
function offViewAxis(bearing: number, view: number): number {
  const between = Math.abs(Math.atan2(Math.sin(bearing - view), Math.cos(bearing - view)));
  return Math.min(between, Math.PI - between);
}

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

describe('the opening shot gets a wind that crosses it', () => {
  const DEG = Math.PI / 180;

  test('the authored base is perpendicular to the cameras the diorama opens on', () => {
    // The reason the base is authored at all. Drawn from the seed it was 242.6 deg, and the
    // seed is FIXED in production, so every single load got a wind 10.7 deg off the opening
    // camera's own view bearing: the balloon entered off-frame and receded down the middle of
    // the picture to a speck instead of crossing it. Perpendicular is the other extreme, and
    // it is the one the shot can show.
    for (const shot of [OPENING_SHOT, OVERVIEW_SHOT]) {
      expect(offViewAxis(WIND_BASE_BEARING, viewBearing(shot)) / DEG).toBeGreaterThan(87);
    }
  });

  // What the PRODUCTION wind is at load is asserted in `Weather.test.ts`, where the draw
  // order that decides this seed's phases actually lives: the weather stream hands the wind
  // its phases last, after every raindrop and cloud puff, so a seed's phases cannot be
  // reproduced by calling `windSeedFrom` on a fresh stream here.

  test('every seed crosses it, because the drawn phases cannot reach the axis', () => {
    // The phases still swing the load bearing by up to 0.55 + 0.18 = 0.73 rad (42 deg), so
    // authoring the base buys the guarantee only if that swing cannot cross the remaining
    // 48 deg. It cannot, and this is the arithmetic that says so rather than a spot check.
    let worst = Math.PI;
    for (let seed = 0; seed < 400; seed++) {
      const drawn = windSeedFrom(createWorldRandom(seed).stream('weather'));
      worst = Math.min(worst, offViewAxis(windBearingAt(0, 1, drawn), viewBearing(OPENING_SHOT)));
    }
    expect(worst / DEG).toBeGreaterThan(45);
  });

  test('the veer still carries it around the compass afterwards', () => {
    // The other half of the bargain: authoring the opening must not have authored the whole
    // flight. Across an hour the wind has to sweep — coming back within 60 deg of the view
    // axis and out past 80 again — or the balloon would cross the same way for ever.
    const seed = windSeedFrom(createWorldRandom(DEFAULT_SIMULATION_SEED).stream('weather'));
    let closest = Math.PI;
    let furthest = 0;
    for (let second = 0; second <= 3600; second += 5) {
      const off = offViewAxis(windBearingAt(second, 0.16, seed), viewBearing(OPENING_SHOT));
      closest = Math.min(closest, off);
      furthest = Math.max(furthest, off);
    }
    expect(closest / DEG).toBeLessThan(60);
    expect(furthest / DEG).toBeGreaterThan(80);
  });
});

describe('the gust veers as it arrives', () => {
  /** Strength is the only thing the gust veer reads, so the difference isolates it exactly. */
  function gustVeer(second: number, seed: WindSeed, strength = 1): number {
    return windBearingAt(second, strength, seed) - windBearingAt(second, 0, seed);
  }

  test('the veer rides the strength gust term, not a phase of its own', () => {
    // It used to ride `seed.veerPhase`, drawn per session: in one session the wind veered as
    // it strengthened, in the next as it eased, and the relation between the two was whatever
    // the draw happened to be. A real gust veers as it arrives, so the two must share one
    // argument. `Weather`'s slowest gust term is 0.25 * sin(elapsed * GUST_SLOW_RATE).
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    for (let second = 0; second <= 60; second += 0.25) {
      const strengthGust = 0.25 * Math.sin(second * GUST_SLOW_RATE);
      const veer = gustVeer(second, seed);
      // Same sign at every sample, and zero where the other is zero: one sine, two readers.
      expect(Math.sign(Number(veer.toFixed(12)))).toBe(Math.sign(Number(strengthGust.toFixed(12))));
    }
  });

  test('the bearing is at the far end of its swing exactly when the gust is hardest', () => {
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    const gustPeak = Math.PI / 2 / GUST_SLOW_RATE;
    let bestSecond = 0;
    let best = -Infinity;
    for (let second = 0; second <= 7; second += 0.001) {
      const veer = gustVeer(second, seed);
      if (veer > best) {
        best = veer;
        bestSecond = second;
      }
    }
    expect(bestSecond).toBeCloseTo(gustPeak, 2);
    // And it is a nudge, not a weathervane: 2 degrees at full strength.
    expect(best).toBeCloseTo(0.035, 6);
  });

  test('a dead calm has no gusts to veer, and half a wind veers half as much', () => {
    const seed = windSeedFrom(createWorldRandom(7).stream('weather'));
    expect(gustVeer(3, seed, 0)).toBe(0);
    expect(gustVeer(3, seed, 0.5)).toBeCloseTo(gustVeer(3, seed, 1) / 2, 12);
  });
});
