export type Family = 'slab' | 'tower' | 'tenement' | 'walkup';
export type RoofKind = 'flat' | 'hip' | 'gable';

const TOWERS = new Set([5, 10, 30]);
const TENEMENTS = new Set([6, 7, 23, 24, 25, 26, 27]);
const WALKUPS = new Set([0, 2, 9, 12, 16, 21, 28]);

/** Composition layer: the family of a BLOCK_CONFIGS entry (deterministic, layout-only). */
export function familyOf(index: number): Family {
  if (TOWERS.has(index)) return 'tower';
  if (TENEMENTS.has(index)) return 'tenement';
  if (WALKUPS.has(index)) return 'walkup';
  return 'slab';
}

export interface FloorPlan {
  floorHeight: number;
  groundFloorHeight: number;
  floors: number;
  bodyHeight: number;
  roof: RoofKind;
  roofHeight: number;
}

/**
 * Gate 4: the metre height from the layout is the truth and floors are derived
 * from it. Only a flagged point tower grows (×1.8). Pitched roofs sit on top of
 * the body height, so they may exceed the envelope by their own height.
 */
export function floorPlan(family: Family, heightMetres: number, pointTower: boolean): FloorPlan {
  if (family === 'tenement') {
    const groundFloorHeight = 3.7;
    const floorHeight = 3.3;
    const upper = Math.max(2, Math.round((heightMetres - groundFloorHeight - 1.2) / floorHeight));
    return {
      floorHeight,
      groundFloorHeight,
      floors: upper + 1,
      bodyHeight: groundFloorHeight + upper * floorHeight,
      roof: 'hip',
      roofHeight: 3.2,
    };
  }
  if (family === 'walkup') {
    return { floorHeight: 2.75, groundFloorHeight: 2.75, floors: 4, bodyHeight: 11, roof: 'gable', roofHeight: 1.9 };
  }
  const floorHeight = 2.8;
  const target = family === 'tower' && pointTower ? heightMetres * 1.8 : heightMetres;
  const floors = Math.max(3, Math.round(target / floorHeight));
  return {
    floorHeight,
    groundFloorHeight: floorHeight,
    floors,
    bodyHeight: floors * floorHeight,
    roof: 'flat',
    roofHeight: 0,
  };
}
