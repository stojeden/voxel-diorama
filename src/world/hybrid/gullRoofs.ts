import type { GullMast, GullRoof } from '../Birds';
import { GROUND, layoutHash01, type BuildingSpec, type DominantSpec } from './CityModel';

/**
 * The hybrid city's roofs, for the gulls: every building, from the geometry that draws it.
 *
 * Kept beside `architecture.ts` because it restates three of its facts and must move with
 * them: the pitched roofs are the prisms of `hipRoofPositions` and `gableRoofPositions` (eaves
 * at the body height, 0.4 and 0.45 m of overhang, the ridge along the long side); a flat roof
 * is `roofFlat`'s 0.1 m deck with one or two 2.4 x 2.6 m stair houses on it, capped at 2.62 m;
 * and a point tower adds a 3.6 x 2.6 m machine room 2.8 m tall on the centre.
 *
 * The stair houses and the machine room are layer-1 detail, which the level of detail drops
 * with distance, so a gull never SITS on one -- from across the city it would be hanging 2.5 m
 * over the deck. They are obstacles its perch keeps clear of, and they count for the height
 * it flies at, because flying over something that is not drawn costs nothing. The dominants
 * are left out, as the voxel roofs always left them: a thin stack or mast is not a roost, and
 * at the gulls' 2.2 m/s climb a clearance floor round one would be a lurch, not an avoidance.
 */
const HIP_OVERHANG = 0.4;
const GABLE_OVERHANG = 0.45;
const MACHINE_ROOM = { halfX: 1.8, halfZ: 1.3, height: 2.8 };
const DECK = 0.1;
const STAIR_HOUSE = { halfX: 1.2, halfZ: 1.3, height: 2.62 };

interface Box {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  top: number;
}

/** `roofFlat`'s stair houses, placed exactly as it places them. */
function stairHouses(b: BuildingSpec, deckBase: number): Box[] {
  const count = b.family === 'tower' ? 1 : b.w >= 9 ? 2 : 1;
  const houses: Box[] = [];
  for (let i = 0; i < count; i++) {
    houses.push({
      x: b.cx + (count === 1 ? 0 : i === 0 ? -b.w / 4 : b.w / 4),
      z: b.cz + (layoutHash01(b.index, 40 + i) - 0.5) * (b.d - 3),
      halfX: STAIR_HOUSE.halfX,
      halfZ: STAIR_HOUSE.halfZ,
      top: deckBase + STAIR_HOUSE.height,
    });
  }
  return houses;
}

export function gullRoofsOf(buildings: readonly BuildingSpec[]): GullRoof[] {
  return buildings.map((b) => {
    const eave = GROUND + b.bodyHeight;
    const halfW = b.w / 2;
    const halfD = b.d / 2;
    const long = b.w >= b.d;
    // Along the ridge, and across it, measured from the centre.
    const along = (x: number, z: number) => Math.abs(long ? x - b.cx : z - b.cz);
    const across = (x: number, z: number) => Math.abs(long ? z - b.cz : x - b.cx);
    const halfLong = (long ? b.w : b.d) / 2;
    const halfShort = (long ? b.d : b.w) / 2;

    let surfaceAt: (x: number, z: number) => number;
    let peak = eave;
    let obstacles: GullRoof['obstacles'] = [];
    if (b.roof === 'hip') {
      const W = halfLong + HIP_OVERHANG;
      const D = halfShort + HIP_OVERHANG;
      const r = Math.max(0, halfLong - halfShort);
      // The lower of the long slopes and the hipped ends: the prism is their intersection.
      surfaceAt = (x, z) =>
        eave +
        b.roofHeight *
          Math.max(0, Math.min(1 - across(x, z) / D, (W - along(x, z)) / Math.max(W - r, 1e-6)));
      peak = eave + b.roofHeight;
    } else if (b.roof === 'gable') {
      const D = halfShort + GABLE_OVERHANG;
      surfaceAt = (x, z) => eave + b.roofHeight * Math.max(0, 1 - across(x, z) / D);
      peak = eave + b.roofHeight;
    } else {
      const boxes = stairHouses(b, eave);
      if (b.family === 'tower') {
        boxes.push({ x: b.cx, z: b.cz, ...MACHINE_ROOM, top: eave + MACHINE_ROOM.height });
      }
      const deck = eave + DECK;
      surfaceAt = () => deck;
      peak = Math.max(deck, ...boxes.map((box) => box.top));
      obstacles = boxes.map((box) => ({
        minX: box.x - box.halfX,
        maxX: box.x + box.halfX,
        minZ: box.z - box.halfZ,
        maxZ: box.z + box.halfZ,
      }));
    }
    return {
      minX: b.cx - halfW,
      maxX: b.cx + halfW,
      minZ: b.cz - halfD,
      maxZ: b.cz + halfD,
      surfaceAt,
      peak,
      obstacles,
    };
  });
}

/**
 * The dominants as masts: flown round, never over or onto.
 *
 * From `dominants.ts`: the chimney is 1.55 m in radius at its foot and narrows to 0.95 m at
 * 46 m; the RTV tower's shaft is 2.6 m at the foot and carries a 5.2 m platform at 30.5 m,
 * inside the heights gulls fly, so its widest point is the one kept clear of.
 */
export function gullMastsOf(dominants: readonly DominantSpec[]): GullMast[] {
  return dominants.map((d) =>
    d.kind === 'chimney'
      ? { x: d.x, z: d.z, radius: 1.55, top: GROUND + d.height + 0.6 }
      : { x: d.x, z: d.z, radius: 5.2, top: GROUND + d.height }
  );
}
