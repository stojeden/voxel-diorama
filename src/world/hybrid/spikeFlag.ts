import { BLOCK_CONFIGS, WORLD_HALF_SIZE, isOnSidewalk } from '../WorldLayout';

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

/**
 * The whole city, not the five blocks it started as.
 *
 * This was Osiedle Centralne -- blocks 3, 4, 5, 24, 25 and the pavement between them --
 * because it was a spike. The look was accepted, so the fragment is now every plot and
 * every pavement cell, and the list is derived rather than written out: thirty-four
 * indices as a literal would cost more of the entry budget than the code that computes
 * them, and would need editing every time the layout gains a block.
 */
export const SPIKE_FRAGMENT = {
  blocks: BLOCK_CONFIGS.map((_, index) => index),
  ground: { minX: -WORLD_HALF_SIZE, maxX: WORLD_HALF_SIZE, minZ: -WORLD_HALF_SIZE, maxZ: WORLD_HALF_SIZE },
  /** Paved forecourt in front of the corner tenement (block 25). */
  forecourt: { minX: -4, maxX: 5, minZ: 28, maxZ: 31 },
} as const;

export const SPIKE_BLOCK_SET: ReadonlySet<number> = new Set(SPIKE_FRAGMENT.blocks);

/**
 * Which blocks grow to 1.8x their metre height: the point towers.
 *
 * Only block 5 was flagged while the fragment was five blocks wide. Blocks 10 and 30 were
 * already typed as towers but unflagged, so they rendered at exactly a slab's height and
 * the family meant nothing in the picture. Flagged, the three of them stand at 28 m over
 * an estate of 11.2 to 16.8 m blocks, which is what a punktowiec is for.
 */
export const SPIKE_POINT_TOWERS: ReadonlySet<number> = new Set([5, 10, 30]);

const inRect = (r: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number) =>
  x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/** Ground cells the hybrid draws instead of the voxel ground: all pavement, and the forecourt. */
export function isSpikeGroundCell(x: number, z: number): boolean {
  return isOnSidewalk(x, z) || inRect(SPIKE_FRAGMENT.forecourt, x, z);
}
