import { describe, expect, test } from 'vitest';
import { planBalloonCrossing } from './Balloon';

const EDGE = 115;

/** Downwind unit vectors at 15-degree steps, so no bearing is a special case by accident. */
const BEARINGS = Array.from({ length: 24 }, (_, index) => {
  const angle = (index * Math.PI) / 12;
  return { angle, x: Math.cos(angle), z: Math.sin(angle) };
});

describe('the balloon crosses the world along the wind', () => {
  test('it enters UPWIND of where it leaves, at every bearing', () => {
    // The headline of the change and the sign error most likely to survive review: with the
    // vector pointing the way the wind BLOWS TOWARD, the entry must sit behind the centre
    // along it and the exit ahead. Swap the convention at one end and this flips.
    for (const bearing of BEARINGS) {
      for (const lateral of [-45, -12, 0, 20, 44]) {
        const crossing = planBalloonCrossing(bearing.x, bearing.z, lateral, EDGE);
        const entryAlong = crossing.entryX * bearing.x + crossing.entryZ * bearing.z;
        const exitAlong = crossing.exitX * bearing.x + crossing.exitZ * bearing.z;
        expect(entryAlong).toBeLessThan(0);
        expect(exitAlong).toBeGreaterThan(0);
        expect(exitAlong - entryAlong).toBeCloseTo(crossing.length, 9);
      }
    }
  });

  test('a north wind carries it south', () => {
    // The owner's own example, in world terms. Air arriving from the north travels toward
    // +z, so the balloon must start at negative z and finish at positive z.
    const crossing = planBalloonCrossing(0, 1, 0, EDGE);
    expect(crossing.entryZ).toBeCloseTo(-EDGE, 9);
    expect(crossing.exitZ).toBeCloseTo(EDGE, 9);
  });

  test('both ends sit ON the world boundary, so nothing pops into existence', () => {
    for (const bearing of BEARINGS) {
      for (const lateral of [-45, 0, 33]) {
        const crossing = planBalloonCrossing(bearing.x, bearing.z, lateral, EDGE);
        for (const [x, z] of [[crossing.entryX, crossing.entryZ], [crossing.exitX, crossing.exitZ]]) {
          expect(Math.max(Math.abs(x), Math.abs(z))).toBeCloseTo(EDGE, 6);
        }
      }
    }
  });

  test('the crossing distance follows the bearing rather than being a constant', () => {
    // The profile runs on PROGRESS for this reason: a diagonal pass is half again as long
    // as an axis-aligned one, so `x` stopped being a measure of how far through it is.
    const axis = planBalloonCrossing(1, 0, 0, EDGE);
    const diagonal = planBalloonCrossing(Math.SQRT1_2, Math.SQRT1_2, 0, EDGE);
    expect(axis.length).toBeCloseTo(EDGE * 2, 9);
    expect(diagonal.length).toBeCloseTo(EDGE * 2 * Math.SQRT2, 6);
    expect(diagonal.length).toBeGreaterThan(axis.length * 1.4);
  });

  test('the jet keeps its old west-to-east pass exactly', () => {
    // The space jet flies under power, not with the air, so it is handed (1, 0) rather than
    // the wind. That has to reproduce the track it had before this change, not approximate it.
    for (const lateral of [-45, 0, 45]) {
      const crossing = planBalloonCrossing(1, 0, lateral, EDGE);
      expect(crossing.entryX).toBe(-EDGE);
      expect(crossing.exitX).toBe(EDGE);
      expect(crossing.entryZ).toBe(lateral);
      expect(crossing.exitZ).toBe(lateral);
    }
  });

  test('a still-air crossing is still a crossing a viewer sees the end of', () => {
    // The speed law (3 + wind * 3.5) is untouched, and its 3 m/s floor is the reason. The
    // worst case is the longest crossing at the weakest wind; if this ever passes two
    // minutes, the balloon has become something nobody watches.
    const longest = planBalloonCrossing(Math.SQRT1_2, Math.SQRT1_2, 0, EDGE).length;
    expect(longest / (3 + 0 * 3.5)).toBeLessThan(120);
  });
});
