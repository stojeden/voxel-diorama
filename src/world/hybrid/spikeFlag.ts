import { isOnSidewalk } from '../WorldLayout';

/**
 * Developer flag for the reversible hybrid spike. The default (`voxel`) renders
 * today's city untouched. This module is the only spike file imported statically
 * from the entry code; everything else in `src/world/hybrid/` loads on demand as
 * its own chunk so the entry bundle budget is not spent on an experiment.
 */
export type WorldMode = 'voxel' | 'hybrid-direct';
export type HybridStrategyName = 'direct';

export function parseWorldMode(value: string | null | undefined): WorldMode {
  return value === 'hybrid-direct' ? value : 'voxel';
}

export function strategyOf(mode: WorldMode): HybridStrategyName | null {
  return mode === 'hybrid-direct' ? 'direct' : null;
}

/** Osiedle Centralne: five blocks around the stop plus the pavement between them. */
export const SPIKE_FRAGMENT = {
  blocks: [3, 4, 5, 24, 25],
  ground: { minX: -30, maxX: 12, minZ: 0, maxZ: 40 },
  /** Paved forecourt in front of the corner tenement (block 25). */
  forecourt: { minX: -4, maxX: 5, minZ: 28, maxZ: 31 },
} as const;

export const SPIKE_BLOCK_SET: ReadonlySet<number> = new Set(SPIKE_FRAGMENT.blocks);

/** Gate 4: only explicitly flagged blocks may grow to 1.8× their metre height. */
export const SPIKE_POINT_TOWERS: ReadonlySet<number> = new Set([5]);

const inRect = (r: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) =>
  x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/** Ground cells the hybrid fragment draws instead of the voxel ground: pavement and the forecourt. */
export function isSpikeGroundCell(x: number, z: number): boolean {
  return (inRect(SPIKE_FRAGMENT.ground, x, z) && isOnSidewalk(x, z)) || inRect(SPIKE_FRAGMENT.forecourt, x, z);
}
