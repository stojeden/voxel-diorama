import {
  BLOCK_CONFIGS,
  BUILDING_ENTRANCES,
  GROUND_SURFACE_Y,
  WORLD_LAYOUT_SEED,
  isOnRoad,
  isOnSidewalk,
  type ColorHex,
} from '../WorldLayout';
import { P } from './palette';
import { SPIKE_FRAGMENT, SPIKE_POINT_TOWERS, isSpikeGroundCell } from './spikeFlag';
import { familyOf, floorPlan, type Family, type FloorPlan } from './families';

/**
 * Semantic model of the Osiedle Centralne fragment. Pure data derived from the
 * layout and the layout seed only, so both geometry strategies, the LOD groups
 * and the ground-contact checks read one deterministic truth.
 */
export const GROUND = GROUND_SURFACE_Y;
export const KERB_HEIGHT = 0.12;
export type Side = '+x' | '-x' | '+z' | '-z';

export interface BuildingSpec extends FloorPlan {
  index: number;
  family: Family;
  pointTower: boolean;
  x: number;
  z: number;
  w: number;
  d: number;
  cx: number;
  cz: number;
  heightMetres: number;
  accent: ColorHex;
  /** Palette index of the wall tint. */
  tint: number;
  seed: number;
  entrance: { side: Side; along: number } | null;
  /** Side facing Aleja Południowa (z ≈ 24); tenements put shops and balconies there. */
  avenueSide: Side;
}

export interface GroundProbe {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type PropKind = 'bikeRack' | 'bicycle' | 'bicycleLeaning' | 'bin' | 'planter' | 'noticeBoard';

export interface PropSpec {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  ry: number;
  /** Points that must lie on the ground within the contact tolerance. */
  probes: GroundProbe[];
  footprint: Rect;
}

export interface CrosswalkSpec extends Rect {
  stripes: number;
}

export interface DominantSpec {
  kind: 'chimney' | 'rtvTower';
  x: number;
  z: number;
  height: number;
}

export interface CityModel {
  buildings: BuildingSpec[];
  pavement: Array<{ x: number; z: number }>;
  kerbs: Array<{ x: number; z: number; side: Side }>;
  forecourt: Array<{ x: number; z: number }>;
  crosswalk: CrosswalkSpec;
  props: PropSpec[];
  dominants: DominantSpec[];
}

export function layoutHash01(...nums: number[]): number {
  let h = (2166136261 ^ WORLD_LAYOUT_SEED) >>> 0;
  for (const n of nums) {
    h ^= Math.floor(n * 1000) | 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

const TINTS: Record<Family, string[]> = {
  slab: ['prefabLight', 'prefabCool', 'plasterGrey'],
  tower: ['towerGrey', 'prefabCool'],
  tenement: ['plasterWarm', 'plasterRose', 'plasterOlive', 'plasterSand'],
  walkup: ['plasterSand', 'plasterWarm'],
};

/** Paved forecourt in front of the corner tenement (block 25); excluded from the voxel ground too. */
export const FORECOURT: Rect = SPIKE_FRAGMENT.forecourt;
/** East of the shelter, clear of the dwelling bus (lead at x ≈ −10, body 8 m behind it). */
export const CROSSWALK: CrosswalkSpec = { minX: -3.2, maxX: -1.8, minZ: 22, maxZ: 26, stripes: 5 };
export const CHIMNEY_SITE = { x: -58, z: -40 } as const;
export const RTV_SITES = {
  recommended: { x: 16, z: -66 },
  alternative: { x: -70, z: 22 },
} as const;

export function buildCityModel(): CityModel {
  const buildings: BuildingSpec[] = SPIKE_FRAGMENT.blocks.map((index) => {
    const block = BLOCK_CONFIGS[index];
    const family = familyOf(index);
    const pointTower = SPIKE_POINT_TOWERS.has(index);
    const plan = floorPlan(family, block.h, pointTower);
    const cx = block.x + block.w / 2 - 0.5;
    const cz = block.z + block.d / 2 - 0.5;
    const entry = BUILDING_ENTRANCES.find((candidate) => candidate.block === block);
    let entrance: BuildingSpec['entrance'] = null;
    if (entry) {
      const dx = entry.outsideX - entry.doorX;
      const dz = entry.outsideZ - entry.doorZ;
      entrance = dz !== 0
        ? { side: dz > 0 ? '+z' : '-z', along: entry.doorX - cx }
        : { side: dx > 0 ? '+x' : '-x', along: entry.doorZ - cz };
    }
    const tints = TINTS[family];
    const tintKey = tints[Math.floor(layoutHash01(index, 3) * tints.length) % tints.length];
    return {
      ...plan,
      index,
      family,
      pointTower,
      x: block.x,
      z: block.z,
      w: block.w,
      d: block.d,
      cx,
      cz,
      heightMetres: block.h,
      accent: block.accent,
      tint: P[tintKey],
      seed: layoutHash01(index, 17),
      entrance,
      avenueSide: cz > 24 ? '-z' : '+z',
    };
  });

  const ground = SPIKE_FRAGMENT.ground;
  const pavement: CityModel['pavement'] = [];
  const kerbs: CityModel['kerbs'] = [];
  for (let x = ground.minX; x <= ground.maxX; x++) {
    for (let z = ground.minZ; z <= ground.maxZ; z++) {
      if (!isSpikeGroundCell(x, z) || !isOnSidewalk(x, z)) continue;
      pavement.push({ x, z });
      if (isOnRoad(x + 1, z)) kerbs.push({ x, z, side: '+x' });
      if (isOnRoad(x - 1, z)) kerbs.push({ x, z, side: '-x' });
      if (isOnRoad(x, z + 1)) kerbs.push({ x, z, side: '+z' });
      if (isOnRoad(x, z - 1)) kerbs.push({ x, z, side: '-z' });
    }
  }
  const paved = new Set(pavement.map((cell) => `${cell.x},${cell.z}`));
  const forecourt: CityModel['forecourt'] = [];
  for (let x = FORECOURT.minX; x <= FORECOURT.maxX; x++) {
    for (let z = FORECOURT.minZ; z <= FORECOURT.maxZ; z++) {
      if (!paved.has(`${x},${z}`)) forecourt.push({ x, z });
    }
  }

  const props: PropSpec[] = [
    prop('rack', 'bikeRack', -2.2, 29.3, 0, rackProbes(-2.2, 29.3), 0.6, 0.4),
    prop('bike-a', 'bicycle', -2.7, 29.3, Math.PI / 2, bicycleProbes(-2.7, 29.3, Math.PI / 2), 0.25, 0.9),
    prop('bike-b', 'bicycle', -1.7, 29.3, Math.PI / 2, bicycleProbes(-1.7, 29.3, Math.PI / 2), 0.25, 0.9),
    prop('bike-lean', 'bicycleLeaning', 4.75, 30.7, 0.15, bicycleProbes(4.75, 30.7, 0.15), 0.9, 0.3),
    prop('bin', 'bin', -3.6, 28.4, 0, [{ x: -3.6, y: GROUND, z: 28.4 }], 0.3, 0.3),
    prop('planter', 'planter', 1.6, 31.1, 0, [{ x: 1.2, y: GROUND, z: 31.1 }, { x: 2.0, y: GROUND, z: 31.1 }], 0.45, 0.25),
    prop('board', 'noticeBoard', 2.4, 31.25, 0, [{ x: 2.4, y: GROUND, z: 31.25 }], 0.5, 0.1),
  ];

  return {
    buildings,
    pavement,
    kerbs,
    forecourt,
    crosswalk: CROSSWALK,
    props,
    dominants: [
      { kind: 'chimney', x: CHIMNEY_SITE.x, z: CHIMNEY_SITE.z, height: 46 },
      { kind: 'rtvTower', x: RTV_SITES.recommended.x, z: RTV_SITES.recommended.z, height: 56 },
    ],
  };
}

function prop(
  id: string,
  kind: PropKind,
  x: number,
  z: number,
  ry: number,
  probes: GroundProbe[],
  halfX: number,
  halfZ: number
): PropSpec {
  return { id, kind, x, z, ry, probes, footprint: { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ } };
}

/** Wheel contact points of a bicycle heading along +x rotated by `ry` about y. */
export function bicycleProbes(x: number, z: number, ry: number): GroundProbe[] {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  return [-0.55, 0.55].map((dx) => ({ x: x + dx * c, y: GROUND, z: z - dx * s }));
}

function rackProbes(x: number, z: number): GroundProbe[] {
  return [
    [-0.5, -0.3],
    [-0.5, 0.3],
    [0.5, -0.3],
    [0.5, 0.3],
  ].map(([dx, dz]) => ({ x: x + dx, y: GROUND, z: z + dz }));
}

/**
 * Flush ground: the spike keeps the product's walking surface so that shelters,
 * lamps, benches and passengers placed by the product stand exactly where they
 * did. Kerbs are ridges along the road edge, not a raised pavement.
 */
export function groundHeightAt(_model: CityModel, _x: number, _z: number): number {
  return GROUND;
}
