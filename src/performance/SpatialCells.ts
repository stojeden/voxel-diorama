/** Static batches share materials, but not one city-wide visibility bound. */
export const STATIC_CELL_SIZE = 80;

export interface SpatialPosition { position: { x: number; z: number } }

/** Centred cells keep the existing osiedle in four useful visibility regions. */
export function spatialCellKey(x: number, z: number, size = STATIC_CELL_SIZE): string {
  return `${Math.floor(x / size)},${Math.floor(z / size)}`;
}

/** Stable insertion order and exactly one owner, including negative boundaries. */
export function partitionSpatially<T extends SpatialPosition>(items: readonly T[], size = STATIC_CELL_SIZE): Map<string, T[]> {
  const cells = new Map<string, T[]>();
  for (const item of items) {
    const key = spatialCellKey(item.position.x, item.position.z, size);
    const cell = cells.get(key);
    if (cell) cell.push(item);
    else cells.set(key, [item]);
  }
  return cells;
}
