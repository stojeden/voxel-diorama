import { describe, expect, test } from 'vitest';
import { DEFAULT_LOD, LodSelector, pixelsPerMetre, type LodConfig } from './ScreenSpaceLod';

/**
 * Hysteresis, in full: both boundaries in both directions, the band between enter
 * and exit, a shake around each threshold, and the cooldown that limits how often a
 * level may change at all.
 *
 * Every case here is paired with a negative control -- the same input driven through
 * a config whose hysteresis or cooldown has been removed -- so the test proves it can
 * tell a working selector from a broken one instead of only agreeing with the current
 * numbers.
 */
const NO_HYSTERESIS: LodConfig = { enter1: 9, exit1: 9, enter2: 36, exit2: 36, cooldownSeconds: 0.25 };
const NO_COOLDOWN: LodConfig = { ...DEFAULT_LOD, cooldownSeconds: 0 };

/** Drive a sequence of readings and return every level the selector reported. */
function drive(config: LodConfig, readings: readonly number[], dt: number): number[] {
  const lod = new LodSelector(config);
  return readings.map((px) => lod.update(px, dt));
}

function changes(levels: readonly number[]): number {
  let count = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i] !== levels[i - 1]) count++;
  return count;
}

/** `frames` readings alternating either side of `about` by `swing`. */
function shake(about: number, swing: number, frames: number): number[] {
  return Array.from({ length: frames }, (_, i) => about + (i % 2 === 0 ? swing : -swing));
}

describe('LOD hysteresis', () => {
  test('the measure is pixels per metre, independent of viewport and zoom', () => {
    // Halving the distance doubles the reading; a shorter viewport lowers it.
    expect(pixelsPerMetre(900, 50, 50)).toBeCloseTo(pixelsPerMetre(900, 50, 100) * 2, 4);
    expect(pixelsPerMetre(844, 50, 100)).toBeLessThan(pixelsPerMetre(900, 50, 100));
    // A narrower field of view magnifies, so the same object covers more pixels.
    expect(pixelsPerMetre(900, 35, 100)).toBeGreaterThan(pixelsPerMetre(900, 50, 100));
  });

  test('crosses each boundary at its own threshold, in both directions', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    // Rising: nothing happens until the enter threshold is actually reached.
    expect(lod.update(DEFAULT_LOD.enter1 - 0.01, 1)).toBe(0);
    expect(lod.update(DEFAULT_LOD.enter1, 1)).toBe(1);
    expect(lod.update(DEFAULT_LOD.enter2 - 0.01, 1)).toBe(1);
    expect(lod.update(DEFAULT_LOD.enter2, 1)).toBe(2);
    // Falling: the exit thresholds are lower than the enter ones, and each is honoured.
    expect(lod.update(DEFAULT_LOD.exit2, 1)).toBe(2);
    expect(lod.update(DEFAULT_LOD.exit2 - 0.01, 1)).toBe(1);
    expect(lod.update(DEFAULT_LOD.exit1, 1)).toBe(1);
    expect(lod.update(DEFAULT_LOD.exit1 - 0.01, 1)).toBe(0);
  });

  test('a reading that falls back into the band keeps the level it entered with', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    expect(lod.update(10, 1)).toBe(1);
    // 7..9 is the band of level 1: inside it the level neither rises nor falls.
    for (const px of [8.9, 8, 7.5, 7, 8.5]) expect(lod.update(px, 1)).toBe(1);
    expect(lod.update(40, 1)).toBe(2);
    // 30..36 is the band of level 2.
    for (const px of [35.9, 33, 30]) expect(lod.update(px, 1)).toBe(2);
  });

  test('a camera shaking on a threshold does not flap the level', () => {
    // 40 frames at 60 fps is 0.67 s, so a 0.25 s cooldown alone permits at most
    // three changes; hysteresis should permit none, because the shake stays inside
    // one band. Both boundaries are shaken.
    for (const [about, swing] of [[DEFAULT_LOD.enter1, 0.4], [DEFAULT_LOD.enter2, 1.5]] as const) {
      const steady = drive(DEFAULT_LOD, [about + swing, ...shake(about, swing, 40)], 1 / 60);
      expect(changes(steady.slice(1)), `drgania przy ${about}`).toBe(0);

      // Negative control: with enter == exit the same shake crosses the threshold on
      // every other frame, and the only thing left holding the level is the cooldown.
      const flapping = drive(NO_HYSTERESIS, [about + swing, ...shake(about, swing, 40)], 1 / 60);
      expect(changes(flapping.slice(1)), `kontrola: brak histerezy przy ${about}`).toBeGreaterThan(0);
    }
  });

  test('the cooldown holds a level for exactly its own duration', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    lod.update(40, 1);
    expect(lod.level).toBe(2);
    // 0.24 s of frames is not enough, one more frame is.
    let elapsed = 0;
    while (elapsed < 0.24 - 1e-9) {
      lod.update(1, 0.01);
      elapsed += 0.01;
    }
    expect(lod.level, `po ${elapsed.toFixed(2)} s`).toBe(2);
    expect(lod.update(1, 0.02)).toBe(0);

    // Negative control: without a cooldown the drop lands on the first frame.
    const instant = new LodSelector(NO_COOLDOWN);
    instant.update(40, 1);
    expect(instant.update(1, 0.01)).toBe(0);
  });

  test('a sweep in and out of a cluster settles instead of oscillating', () => {
    const sweep = (far: number): number[] => {
      const distances: number[] = [];
      for (let d = far; d >= 6; d -= 2) distances.push(d);
      for (let d = 6; d <= far; d += 2) distances.push(d);
      return drive(DEFAULT_LOD, distances.map((d) => pixelsPerMetre(900, 50, d)), 1 / 30);
    };

    // A dolly from 150 m in to 6 m and back out: four transitions, 0->1->2 going in
    // and 2->1->0 coming out, and nothing else on the way.
    const full = sweep(150);
    expect(changes(full), `przejscia ${full.join('')}`).toBe(4);
    expect(full[0]).toBe(0);
    expect(Math.max(...full)).toBe(2);
    expect(full[full.length - 1]).toBe(0);

    // The same dolly stopping at 120 m ends on level 1, not 0, and that is the point
    // of hysteresis: 120 m is 8.0 px/m, inside the 7..9 band, so the level depends on
    // where the camera came from. Three transitions, and the last level is 1.
    const short = sweep(120);
    expect(pixelsPerMetre(900, 50, 120)).toBeGreaterThan(DEFAULT_LOD.exit1);
    expect(pixelsPerMetre(900, 50, 120)).toBeLessThan(DEFAULT_LOD.enter1);
    expect(changes(short), `przejscia ${short.join('')}`).toBe(3);
    expect(short[0]).toBe(0);
    expect(short[short.length - 1]).toBe(1);

    // Negative control: with enter == exit the band is gone and the level at 120 m no
    // longer remembers the approach, so both sweeps end the same way.
    const naive = (far: number) => {
      const distances: number[] = [];
      for (let d = far; d >= 6; d -= 2) distances.push(d);
      for (let d = 6; d <= far; d += 2) distances.push(d);
      return drive(NO_HYSTERESIS, distances.map((d) => pixelsPerMetre(900, 50, d)), 1 / 30);
    };
    const naiveLevels = naive(120);
    expect(naiveLevels[naiveLevels.length - 1]).toBe(0);
  });

  test('the Low cap is a ceiling, not a shift of the thresholds', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    lod.maxLevel = 1;
    expect(lod.update(200, 1)).toBe(1);
    expect(lod.update(40, 1)).toBe(1);
    expect(lod.update(8, 1)).toBe(1);
    expect(lod.update(6.9, 1)).toBe(0);
    // Raising the cap again lets the level follow the reading it always had.
    lod.maxLevel = 2;
    expect(lod.update(40, 1)).toBe(2);
  });
});
