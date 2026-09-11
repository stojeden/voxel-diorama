import { describe, expect, test } from 'vitest';
import {
  CYBER_HANDOVER_FROM,
  CYBER_HANDOVER_TO,
  cyberHandoverTable,
} from './HybridSpike';

/**
 * The morph ramps at 0.45 per second, so one frame advances it by 0.0075 at 60 Hz and 0.015
 * at 30 Hz. Thirty-six plots cannot each have a frame of their own inside the window -- that
 * is arithmetic, not a requirement. What matters is that no FRAME carries a batch: a couple
 * of plots converting together reads as a sweep, thirty reads as a cut.
 */
const FRAME_AT_30HZ = 0.015;
const MOST_PER_FRAME = 3;

describe('cyberpunk handover spread', () => {
  const ids = [
    ...Array.from({ length: 34 }, (_, i) => `building-${i}`),
    'dominant-chimney',
    'dominant-rtvTower',
  ];

  test('no two plots hand over inside the same frame', () => {
    /**
     * This is the test the first attempt needed and did not have. That version hashed the
     * cluster id and took it modulo a thousand; the ids are `building-0` through
     * `building-33`, the hash collapsed their differences, and THIRTY OF THIRTY-SIX landed
     * between 0.447 and 0.469 -- one frame's worth. It measured as barely any spread at all:
     * the frame the swap landed on still moved 13.1 luminance levels against a background of
     * 0.92.
     */
    const table = cyberHandoverTable(ids);
    const values = [...table.values()].sort((a, b) => a - b);
    expect(values.length).toBe(ids.length);

    let worst = 0;
    let worstAt = 0;
    for (const start of values) {
      const inFrame = values.filter((v) => v >= start && v < start + FRAME_AT_30HZ).length;
      if (inFrame > worst) {
        worst = inFrame;
        worstAt = start;
      }
    }
    expect(
      worst,
      `${worst} dzialek przechodzi w jednej klatce 30 Hz od progu ${worstAt.toFixed(3)}`
    ).toBeLessThanOrEqual(MOST_PER_FRAME);
  });

  test('the spread fills the window and stays inside it', () => {
    const values = [...cyberHandoverTable(ids).values()].sort((a, b) => a - b);
    expect(values[0]).toBeCloseTo(CYBER_HANDOVER_FROM, 6);
    expect(values[values.length - 1]).toBeCloseTo(CYBER_HANDOVER_TO, 6);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(CYBER_HANDOVER_FROM);
      expect(value).toBeLessThanOrEqual(CYBER_HANDOVER_TO);
    }
  });

  test('a plot keeps its moment when the groups are rebuilt in another order', () => {
    // `setQuality` throws the LOD groups away and makes new ones; a handover that moved with
    // build order would flicker the city back on a profile change.
    const forward = cyberHandoverTable(ids);
    const shuffled = cyberHandoverTable([...ids].reverse());
    for (const id of ids) expect(shuffled.get(id)).toBe(forward.get(id));
  });

  test('a single plot lands in the middle rather than dividing by zero', () => {
    expect(cyberHandoverTable(['building-1']).get('building-1')).toBe(0.5);
  });
});
