import { isOnSidewalk } from '../WorldLayout';

/**
 * Developer flag for the reversible hybrid spike. The default (`voxel`) renders
 * today's city untouched. This module is the only spike file imported statically
 * from the entry code; everything else in `src/world/hybrid/` loads on demand as
 * its own chunk so the entry bundle budget is not spent on an experiment.
 */
export type WorldMode = 'voxel' | 'hybrid-direct' | 'hybrid-greedy';
export type HybridStrategyName = 'direct' | 'greedy';

export function parseWorldMode(value: string | null | undefined): WorldMode {
  return value === 'hybrid-direct' || value === 'hybrid-greedy' ? value : 'voxel';
}

export function strategyOf(mode: WorldMode): HybridStrategyName | null {
  if (mode === 'hybrid-direct') return 'direct';
  if (mode === 'hybrid-greedy') return 'greedy';
  return null;
}

/** Osiedle Centralne: five blocks around the stop plus the pavement between them. */
export const SPIKE_FRAGMENT = {
  blocks: [3, 4, 5, 24, 25],
  ground: { minX: -30, maxX: 12, minZ: 0, maxZ: 40 },
} as const;

export const SPIKE_BLOCK_SET: ReadonlySet<number> = new Set(SPIKE_FRAGMENT.blocks);

/** Gate 4: only explicitly flagged blocks may grow to 1.8× their metre height. */
export const SPIKE_POINT_TOWERS: ReadonlySet<number> = new Set([5]);

/** Pavement cells the hybrid fragment draws instead of the voxel ground. */
export function isSpikeGroundCell(x: number, z: number): boolean {
  const g = SPIKE_FRAGMENT.ground;
  return x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ && isOnSidewalk(x, z);
}
