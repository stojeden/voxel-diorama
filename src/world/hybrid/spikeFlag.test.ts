import { describe, expect, test } from 'vitest';
import { BLOCK_CONFIGS, isOnRoad } from '../WorldLayout';
import {
  SPIKE_FRAGMENT,
  SPIKE_POINT_TOWERS,
  isSpikeGroundCell,
  parseWorldMode,
  strategyOf,
} from './spikeFlag';

describe('spike flag', () => {
  test('defaults to the voxel city for anything but the two hybrid modes', () => {
    expect(parseWorldMode(null)).toBe('voxel');
    expect(parseWorldMode(undefined)).toBe('voxel');
    expect(parseWorldMode('hybrid')).toBe('voxel');
    expect(parseWorldMode('hybrid-direct')).toBe('hybrid-direct');
    // The greedy strategy was compared, lost and removed; the flag no longer names it,
    // so an old link falls back to the untouched product rather than to a missing world.
    expect(parseWorldMode('hybrid-greedy')).toBe('voxel');
    expect(strategyOf('voxel')).toBeNull();
    expect(strategyOf('hybrid-direct')).toBe('direct');
  });

  test('fragment blocks sit around Osiedle Centralne and the point tower is flagged explicitly', () => {
    expect(SPIKE_FRAGMENT.blocks.length).toBe(5);
    for (const index of SPIKE_FRAGMENT.blocks) {
      const block = BLOCK_CONFIGS[index];
      expect(block).toBeDefined();
      expect(block.x).toBeGreaterThanOrEqual(-30);
      expect(block.x + block.w).toBeLessThanOrEqual(20);
      expect(block.z).toBeGreaterThanOrEqual(0);
      expect(block.z + block.d).toBeLessThanOrEqual(40);
    }
    expect([...SPIKE_POINT_TOWERS]).toEqual([5]);
    expect(SPIKE_FRAGMENT.blocks).toContain(5);
  });

  test('ground exclusion covers pavement inside the rectangle only', () => {
    expect(isSpikeGroundCell(-11, 27)).toBe(true); // north pavement by the shelter
    expect(isSpikeGroundCell(-11, 24)).toBe(false); // asphalt stays product
    expect(isOnRoad(-11, 24)).toBe(true);
    expect(isSpikeGroundCell(-11, 30)).toBe(false); // grass stays product
    expect(isSpikeGroundCell(0, 29)).toBe(true); // forecourt is drawn by the fragment
    expect(isSpikeGroundCell(40, 27)).toBe(false); // outside the rectangle
  });
});
