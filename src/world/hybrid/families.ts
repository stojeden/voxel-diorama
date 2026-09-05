export type Family = 'slab' | 'tower' | 'tenement' | 'walkup';
export type RoofKind = 'flat' | 'hip' | 'gable';

/**
 * Which family each plot belongs to, as the city's own hierarchy rather than a scatter.
 *
 * The estate is the subject: wielka płyta in the core with its point towers, low pitched
 * roofs out at the edges, and tenements as two deliberate accents instead of a seam of
 * old town running through the middle. Four blocks (6, 23, 26, 27) left the tenement set
 * because they were core and mid-city tissue; block 7 became low because it sits at the
 * eastern edge; block 12 became a slab because it was the one low building in the core;
 * and five outer slabs (8, 17, 22, 32, 33) became low because they are the outskirts.
 *
 * Blocks 3, 4, 5, 24 and 25 are the fragment whose look was accepted, and are untouched.
 * Both remaining tenements are in it, and block 25 has a paved forecourt built for a
 * corner tenement -- the layout itself justifies the accent.
 */
const TOWERS = new Set([5, 10, 30]);
const TENEMENTS = new Set([24, 25]);
const WALKUPS = new Set([0, 2, 7, 8, 9, 16, 17, 21, 22, 28, 32, 33]);

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
    /**
     * Low, and low *relative to the slabs* -- which a fixed four storeys was not.
     *
     * It used to return 11 m whatever the plot said, so a dozen of them would have stood
     * at exactly one height, and with the gable on top they reached 12.9 m: taller than a
     * slab on a 12 m plot, which finishes at 11.2. Deriving from the plot at one storey
     * per 4.4 m, clamped to two or three, gives the outskirts two heights (7.4 m and
     * 10.15 m over the roof) and keeps every one of them under the estate blocks.
     */
    const floorHeight = 2.75;
    const floors = Math.min(3, Math.max(2, Math.round(heightMetres / 4.4)));
    return { floorHeight, groundFloorHeight: floorHeight, floors, bodyHeight: floors * floorHeight, roof: 'gable', roofHeight: 1.9 };
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
