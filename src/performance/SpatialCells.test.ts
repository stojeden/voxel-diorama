import { describe, expect, it } from 'vitest';
import { partitionSpatially, spatialCellKey } from './SpatialCells';

describe('spatial instance ownership', () => {
  it('assigns negative and exact boundaries without gaps or duplicate instances', () => {
    const source = [-80.01, -80, -0.01, 0, 79.99, 80].flatMap((x) =>
      [-80, 0, 80].map((z) => ({ position: { x, z } }))
    );
    const cells = partitionSpatially(source);
    const flattened = [...cells.values()].flat();
    expect(flattened).toHaveLength(source.length);
    expect(new Set(flattened).size).toBe(source.length);
    expect(spatialCellKey(-0.01, 0)).toBe('-1,0');
    expect(spatialCellKey(-80, 80)).toBe('-1,1');
    for (const [key, items] of cells) {
      for (const item of items) expect(spatialCellKey(item.position.x, item.position.z)).toBe(key);
    }
    expect([...cells.keys()]).toEqual([...partitionSpatially(source).keys()]);
  });
});
