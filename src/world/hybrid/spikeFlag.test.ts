import { describe, expect, test } from 'vitest';
import { BLOCK_CONFIGS, isOnRoad, isOnSidewalk } from '../WorldLayout';
import { familyOf } from './families';
import {
  SPIKE_FRAGMENT,
  SPIKE_POINT_TOWERS,
  isSpikeGroundCell,
  parseWorldMode,
  strategyOf,
} from './spikeFlag';

describe('spike flag', () => {
  test('opens the hybrid city by default, and the voxel one only when asked', () => {
    // The direction was accepted, so no parameter means Miasto.
    expect(parseWorldMode(null)).toBe('hybrid-direct');
    expect(parseWorldMode(undefined)).toBe('hybrid-direct');
    expect(parseWorldMode('')).toBe('hybrid-direct');
    expect(parseWorldMode('hybrid-direct')).toBe('hybrid-direct');
    // The voxel city stays reachable on purpose: it is the reference the hybrid was
    // measured against, and a comparison that cannot be re-run is not a comparison.
    expect(parseWorldMode('voxel')).toBe('voxel');
    // Anything unrecognised opens the city rather than failing. The greedy strategy was
    // compared, lost and removed, so an old link naming it lands on the default.
    expect(parseWorldMode('hybrid')).toBe('hybrid-direct');
    expect(parseWorldMode('hybrid-greedy')).toBe('hybrid-direct');
    expect(strategyOf('voxel')).toBeNull();
    expect(strategyOf('hybrid-direct')).toBe('direct');
  });

  test('the fragment is now every plot, and the point towers are flagged explicitly', () => {
    // It was five blocks around Osiedle Centralne while the look was being chosen. The
    // list is derived from the layout, so a new plot joins the city without an edit here.
    expect(SPIKE_FRAGMENT.blocks.length).toBe(BLOCK_CONFIGS.length);
    for (const index of SPIKE_FRAGMENT.blocks) expect(BLOCK_CONFIGS[index]).toBeDefined();
    expect(new Set(SPIKE_FRAGMENT.blocks).size).toBe(BLOCK_CONFIGS.length);
    // Only a flagged block grows to 1.8x, and every flagged one is typed as a tower.
    expect([...SPIKE_POINT_TOWERS].sort((a, b) => a - b)).toEqual([5, 10, 30]);
    for (const index of SPIKE_POINT_TOWERS) expect(familyOf(index)).toBe('tower');
  });

  test('ground exclusion covers pavement everywhere, and only pavement', () => {
    expect(isSpikeGroundCell(-11, 27)).toBe(true); // north pavement by the shelter
    expect(isSpikeGroundCell(-11, 24)).toBe(false); // asphalt stays product
    expect(isOnRoad(-11, 24)).toBe(true);
    // The stop apron is pavement now, so the fragment draws it; the lawn behind it
    // is still the product's grass.
    expect(isSpikeGroundCell(-11, 30)).toBe(true); // widened stop apron
    expect(isSpikeGroundCell(-11, 32)).toBe(false); // grass stays product
    expect(isSpikeGroundCell(0, 29)).toBe(true); // forecourt is drawn by the fragment
    // Pavement far from the old rectangle is drawn by the fragment too, now that the
    // fragment is the city; what is not pavement is still the product's ground.
    expect(isSpikeGroundCell(40, 27)).toBe(isOnSidewalk(40, 27));
    expect(isSpikeGroundCell(-60, -30)).toBe(isOnSidewalk(-60, -30));
  });
});
