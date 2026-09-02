import { describe, expect, test } from 'vitest';
import { DEFAULT_LOD, LodSelector, pixelsPerMetre } from './ScreenSpaceLod';

describe('screen-space LOD', () => {
  test('pixels per metre follow the pinhole model', () => {
    expect(pixelsPerMetre(900, 50, 100)).toBeCloseTo(9.65, 1);
    expect(pixelsPerMetre(844, 50, 100)).toBeCloseTo(9.05, 1);
    expect(pixelsPerMetre(900, 50, 25)).toBeCloseTo(38.6, 1);
  });

  test('enters and leaves levels with hysteresis', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    expect(lod.update(8, 1)).toBe(0);
    expect(lod.update(9.5, 1)).toBe(1);
    expect(lod.update(8, 1)).toBe(1);
    expect(lod.update(6.9, 1)).toBe(0);
    expect(lod.update(40, 1)).toBe(2);
    expect(lod.update(31, 1)).toBe(2);
    expect(lod.update(29, 1)).toBe(1);
  });

  test('respects the cooldown and the Low cap', () => {
    const lod = new LodSelector(DEFAULT_LOD);
    lod.update(40, 1);
    expect(lod.update(5, 0.1)).toBe(2);
    expect(lod.update(5, 0.3)).toBe(0);
    lod.maxLevel = 1;
    expect(lod.update(40, 1)).toBe(1);
  });
});
