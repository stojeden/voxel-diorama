import * as THREE from 'three';

/**
 * Single source of truth for the diorama geometry: world bounds, the train
 * route, the road network, the bus loop, building/tree/lamp placement and
 * the colour palette. Everything here is pure data + pure helpers so it can
 * be unit-tested without a renderer.
 */

export const WORLD_HALF_SIZE = 80;
export const TUNNEL_LENGTH = 11; // tunnels occupy x ∈ [±(80-10), ±80]
export const TUNNEL_WIDTH = 4;
// Tall enough that the locomotive pantograph (~4.8 m) clears the arch (5.5 m).
export const TUNNEL_HEIGHT = 8;
// Deck raised to y=7 so the bus clears the underpass on the east cross street.
export const VIADUCT_RANGE = { minX: -4, maxX: 56, deckY: 7 } as const;

/** Real seconds for one full simulated day at 1× clock speed. */
export const DAY_SECONDS = 240;

/** Lead car stops this many metres past a station marker (≈ half train length). */
export const TRAIN_STOP_OFFSET_METERS = 14;

export const LAKE = { x: -40, z: 62, radiusX: 15, radiusZ: 9 } as const;

export const COLORS = {
  concrete: 0x8a8a8a,
  concreteDark: 0x6a6a6a,
  concreteLight: 0x9e9e9e,
  window: 0x24465f,
  windowLit: 0xffdd88,
  balcony: 0x7a7a7a,
  roof: 0x545454,
  grass: 0x3f7d2c,
  grassDark: 0x2f6020,
  road: 0x2e2e30,
  sidewalk: 0x7a7a6a,
  tree: 0x2e6b1d,
  treeLight: 0x49992f,
  treeTrunk: 0x5a3a1a,
  accent: 0xd4a84e,
  accentPink: 0xe09f9f,
  accentBlue: 0x6fb0cc,
  track: 0x5d6063,
  sleeper: 0x4f3a24,
  tunnelInterior: 0x151515,
  signalRed: 0xcc3333,
  signalGreen: 0x55dd88,
  roadMarking: 0xd8d1a8,
  carBlue: 0x2d5f9a,
  carRed: 0xa33a35,
  carYellow: 0xc8a536,
  kiosk: 0x346d73,
  steel: 0x5d6872,
  water: 0x2380a8,
  waterDeep: 0x14506e,
  reeds: 0x6f7d33,
  bird: 0xe8e2cf,
} as const;

export type ColorHex = (typeof COLORS)[keyof typeof COLORS] | number;

export interface BlockConfig {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  accent: ColorHex;
}

// ─────────────────────────────────────────────────────────────────────────
// Train route
//
// One gentle S-curve from deep inside the WEST tunnel to deep inside the
// EAST tunnel. Both endpoints run parallel to +X at z=0 so the portal wrap
// (east end → west end) is invisible inside the tunnels. The middle of the
// route climbs onto a viaduct and descends again with shallow gradients —
// no kinks, no sudden direction reversals.
// ─────────────────────────────────────────────────────────────────────────

export const TRAIN_ROUTE_POINTS: THREE.Vector3[] = [
  new THREE.Vector3(-79, 0, 0),
  new THREE.Vector3(-71.5, 0, -0.6),
  new THREE.Vector3(-65, 0, -2.5),
  new THREE.Vector3(-57, 0, -5.2),
  new THREE.Vector3(-44, 0, -9.5),
  new THREE.Vector3(-28, 0, -13),
  new THREE.Vector3(-10, 1.6, -11.5),
  new THREE.Vector3(5, 4.6, -5.5),
  new THREE.Vector3(18, 7, 3),
  new THREE.Vector3(32, 7, 9),
  new THREE.Vector3(39, 6.4, 10.8),
  new THREE.Vector3(46, 4.8, 11.1),
  new THREE.Vector3(52.5, 3, 9.5),
  new THREE.Vector3(59, 1.4, 6.7),
  new THREE.Vector3(65, 0.35, 3.3),
  new THREE.Vector3(70.5, 0, 1.3),
  new THREE.Vector3(75, 0, 0.35),
  new THREE.Vector3(79, 0, 0),
];

/** Kept for backwards compatibility with tests/tools. */
export const TRAIN_ROUTE_VISIBLE_POINTS = TRAIN_ROUTE_POINTS;

export const TRAIN_ROUTE_CURVE = new THREE.CatmullRomCurve3(
  TRAIN_ROUTE_POINTS,
  false,
  'centripetal',
  0.5
);

export const ROUTE_LENGTH = TRAIN_ROUTE_CURVE.getLength();

/** Wrap an arc-length parameter onto the cyclic (portal) route domain. */
export function wrapT(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** Nearest arc-length parameter on a curve to a ground (x,z) position. */
export function nearestCurveT(
  curve: THREE.Curve<THREE.Vector3>,
  x: number,
  z: number,
  samples = 600
): number {
  let bestT = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = curve.getPointAt(t);
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  return bestT;
}

export interface StationStop {
  /** Arc-length parameter (0..1) of the braking marker (stop point − 14 m). */
  atT: number;
  /** Arc-length parameter of the platform centre (= where the lead car halts). */
  centerT: number;
  /** Polish UI label. */
  label: string;
  /** Seconds the train holds at the platform. */
  dwellSeconds: number;
  /** Platform length in metres. */
  platformLength: number;
}

function makeStation(x: number, z: number, label: string, dwellSeconds: number, platformLength: number): StationStop {
  const centerT = nearestCurveT(TRAIN_ROUTE_CURVE, x, z);
  return {
    centerT,
    atT: wrapT(centerT - TRAIN_STOP_OFFSET_METERS / ROUTE_LENGTH),
    label,
    dwellSeconds,
    platformLength,
  };
}

export const STATION_STOPS: StationStop[] = [
  makeStation(-44, -10, 'Stacja Zachodnia', 5, 34),
  // Short elevated platform — only the flat stretch of the viaduct deck.
  makeStation(25, 6, 'Przystanek Wiadukt', 4, 18),
];

// ─────────────────────────────────────────────────────────────────────────
// Road network
// ─────────────────────────────────────────────────────────────────────────

export interface RoadRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const ROAD_RECTS: RoadRect[] = [
  { minX: -64, maxX: 64, minZ: 22, maxZ: 26 },   // Aleja Południowa (bus, eastbound z=25)
  { minX: -64, maxX: 64, minZ: 46, maxZ: 50 },   // Aleja Parkowa (bus, westbound z=47)
  { minX: -58, maxX: -54, minZ: 22, maxZ: 50 },  // connector west
  { minX: 54, maxX: 58, minZ: 22, maxZ: 50 },    // connector east
  { minX: -70, maxX: 70, minZ: -50, maxZ: -46 }, // south road
  { minX: -36, maxX: -32, minZ: -46, maxZ: 46 }, // west cross street (level crossing, reaches Aleja Parkowa)
  { minX: 32, maxX: 36, minZ: -46, maxZ: 22 },   // east cross street (passes under the viaduct)
  // Corner aprons so the bus loop's rounded corners stay on asphalt:
  { minX: 50, maxX: 58, minZ: 22, maxZ: 30 },
  { minX: 50, maxX: 58, minZ: 42, maxZ: 50 },
  { minX: -58, maxX: -50, minZ: 22, maxZ: 30 },
  { minX: -58, maxX: -50, minZ: 42, maxZ: 50 },
  { minX: 31, maxX: 39, minZ: 20, maxZ: 28 },
  { minX: -39, maxX: -31, minZ: 20, maxZ: 28 },
  { minX: 31, maxX: 39, minZ: -52, maxZ: -44 },
  { minX: -39, maxX: -31, minZ: -52, maxZ: -44 },
  { minX: -42, maxX: -31, minZ: 42, maxZ: 50 }, // west cross street × Aleja Parkowa
];

export function isOnRoad(x: number, z: number): boolean {
  for (const r of ROAD_RECTS) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
  }
  return false;
}

export function isOnSidewalk(x: number, z: number): boolean {
  if (isOnRoad(x, z)) return false;
  for (const r of ROAD_RECTS) {
    if (x >= r.minX - 1 && x <= r.maxX + 1 && z >= r.minZ - 1 && z <= r.maxZ + 1) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Bus loop — a grand clockwise loop through the WHOLE city: Aleja
// Południowa east, the east cross street under the (raised) viaduct, the
// south road west and the west cross street north over the level crossing.
// ─────────────────────────────────────────────────────────────────────────

export const BUS_ROUTE_POINTS: THREE.Vector3[] = [
  // Aleja Południowa, eastbound
  new THREE.Vector3(-49, 0, 24.5),
  new THREE.Vector3(-30, 0, 24),
  new THREE.Vector3(-10, 0, 24),
  new THREE.Vector3(12, 0, 24),
  new THREE.Vector3(28, 0, 24),
  // east cross street, southbound (under the viaduct)
  new THREE.Vector3(34, 0, 21),
  new THREE.Vector3(35, 0, 12),
  new THREE.Vector3(35, 0, -14),
  new THREE.Vector3(35, 0, -40),
  new THREE.Vector3(34, 0, -45),
  // south road, westbound
  new THREE.Vector3(28, 0, -48),
  new THREE.Vector3(2, 0, -48),
  new THREE.Vector3(-24, 0, -48),
  new THREE.Vector3(-34, 0, -45),
  // west cross street, northbound (over the level crossing) up to Aleja Parkowa
  new THREE.Vector3(-35, 0, -40),
  new THREE.Vector3(-35, 0, -14),
  new THREE.Vector3(-35, 0, 12),
  new THREE.Vector3(-35, 0, 32),
  new THREE.Vector3(-35, 0, 40),
  new THREE.Vector3(-36.5, 0, 44.8),
  // Aleja Parkowa, westbound — past the lakeside stop
  new THREE.Vector3(-41, 0, 47),
  new THREE.Vector3(-46, 0, 47),
  new THREE.Vector3(-51, 0, 46.5),
  // west connector, southbound, back to Aleja Południowa
  new THREE.Vector3(-54.5, 0, 42),
  new THREE.Vector3(-54.5, 0, 36),
  new THREE.Vector3(-54, 0, 29),
  new THREE.Vector3(-52.5, 0, 26),
];

export const BUS_ROUTE_CURVE = new THREE.CatmullRomCurve3(
  BUS_ROUTE_POINTS,
  true,
  'centripetal',
  0.5
);

/** Where the bus loop crosses the railway at grade (the level crossing). */
export const LEVEL_CROSSING = { x: -35, z: -11.6 } as const;

export interface BusStop {
  atT: number;
  label: string;
  dwellSeconds: number;
  /** Shelter anchor (voxel coordinates). */
  shelterX: number;
  shelterZ: number;
  /** Street direction the shelter is built along. */
  axis: 'x' | 'z';
  /** Perpendicular offset direction of the bench (toward the street). */
  benchSign: 1 | -1;
}

export const BUS_STOPS: BusStop[] = [
  {
    atT: nearestCurveT(BUS_ROUTE_CURVE, -10, 24),
    label: 'Osiedle Centralne',
    dwellSeconds: 4,
    shelterX: -13,
    shelterZ: 28,
    axis: 'x',
    benchSign: -1,
  },
  {
    atT: nearestCurveT(BUS_ROUTE_CURVE, -44, 47),
    label: 'Park Nadjeziorny',
    dwellSeconds: 4,
    shelterX: -47,
    shelterZ: 44,
    axis: 'x',
    benchSign: 1,
  },
  {
    atT: nearestCurveT(BUS_ROUTE_CURVE, 35, -18),
    label: 'Pod Wiaduktem',
    dwellSeconds: 4,
    shelterX: 38,
    shelterZ: -20,
    axis: 'z',
    benchSign: -1,
  },
  {
    atT: nearestCurveT(BUS_ROUTE_CURVE, 2, -48),
    label: 'Dworzec Południowy',
    dwellSeconds: 4,
    shelterX: -1,
    shelterZ: -53,
    axis: 'x',
    benchSign: 1,
  },
  {
    atT: nearestCurveT(BUS_ROUTE_CURVE, -35, -32),
    label: 'Przejazd Kolejowy',
    dwellSeconds: 4,
    shelterX: -39,
    shelterZ: -34,
    axis: 'z',
    benchSign: 1,
  },
];

/** Shelter centre in world space (axis-aware — shelters are 5 voxels long). */
export function busShelterCenter(stop: BusStop): { x: number; z: number } {
  return stop.axis === 'x'
    ? { x: stop.shelterX + 2, z: stop.shelterZ }
    : { x: stop.shelterX, z: stop.shelterZ + 2 };
}

// ─────────────────────────────────────────────────────────────────────────
// Buildings — laid out in bands that avoid the rail corridor, every road
// and the lake. Verified by unit tests.
// ─────────────────────────────────────────────────────────────────────────

export const BLOCK_CONFIGS: BlockConfig[] = [
  // mid band — between the rail corridor and Aleja Południowa
  { x: -72, z: 6, w: 8, d: 5, h: 11, accent: COLORS.accent },
  { x: -58, z: 8, w: 9, d: 6, h: 13, accent: COLORS.accentPink },
  { x: -45, z: 4, w: 8, d: 5, h: 10, accent: COLORS.accentBlue },
  { x: -24, z: 2, w: 9, d: 5, h: 15, accent: COLORS.accent },
  { x: -8, z: 4, w: 10, d: 6, h: 12, accent: COLORS.accentPink },
  { x: 8, z: 8, w: 8, d: 5, h: 16, accent: COLORS.accentBlue },
  { x: 22, z: 14, w: 8, d: 5, h: 14, accent: COLORS.accent },
  { x: 58, z: 14, w: 8, d: 5, h: 11, accent: COLORS.accentBlue },
  // south band — between rail corridor and south road
  { x: -66, z: -30, w: 9, d: 5, h: 12, accent: COLORS.accentPink },
  { x: -48, z: -34, w: 8, d: 6, h: 10, accent: COLORS.accent },
  { x: -30, z: -28, w: 10, d: 6, h: 16, accent: COLORS.accentBlue },
  { x: -12, z: -32, w: 8, d: 5, h: 13, accent: COLORS.accentPink },
  { x: 6, z: -28, w: 9, d: 6, h: 11, accent: COLORS.accent },
  { x: 20, z: -34, w: 9, d: 6, h: 15, accent: COLORS.accentBlue },
  { x: 42, z: -28, w: 8, d: 5, h: 12, accent: COLORS.accentPink },
  { x: 60, z: -34, w: 9, d: 5, h: 14, accent: COLORS.accent },
  // deep south band — below the south road
  { x: -68, z: -64, w: 9, d: 6, h: 11, accent: COLORS.accentBlue },
  { x: -46, z: -70, w: 10, d: 6, h: 13, accent: COLORS.accent },
  { x: -22, z: -62, w: 8, d: 5, h: 17, accent: COLORS.accentPink },
  { x: 2, z: -68, w: 9, d: 6, h: 12, accent: COLORS.accentBlue },
  { x: 26, z: -62, w: 10, d: 6, h: 14, accent: COLORS.accent },
  { x: 50, z: -70, w: 9, d: 5, h: 11, accent: COLORS.accentPink },
  { x: 66, z: -60, w: 8, d: 5, h: 12, accent: COLORS.accentBlue },
  // between the avenues
  { x: -48, z: 32, w: 9, d: 6, h: 12, accent: COLORS.accent },
  { x: -26, z: 34, w: 8, d: 5, h: 10, accent: COLORS.accentPink },
  { x: -4, z: 32, w: 10, d: 6, h: 15, accent: COLORS.accentBlue },
  { x: 20, z: 34, w: 9, d: 5, h: 11, accent: COLORS.accent },
  { x: 38, z: 32, w: 8, d: 6, h: 13, accent: COLORS.accentPink },
  // north of Aleja Parkowa (around the lake park)
  { x: -70, z: 58, w: 8, d: 5, h: 10, accent: COLORS.accentBlue },
  { x: -14, z: 56, w: 9, d: 6, h: 12, accent: COLORS.accent },
  { x: 8, z: 60, w: 10, d: 6, h: 15, accent: COLORS.accentPink },
  { x: 30, z: 56, w: 8, d: 5, h: 11, accent: COLORS.accentBlue },
  { x: 48, z: 60, w: 9, d: 6, h: 13, accent: COLORS.accent },
  { x: 64, z: 56, w: 8, d: 5, h: 12, accent: COLORS.accentPink },
];

// ─────────────────────────────────────────────────────────────────────────
// Procedural tree / lamp placement (deterministic, collision-checked)
// ─────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function distancePointToBlock(px: number, pz: number, block: BlockConfig): number {
  const minX = block.x;
  const maxX = block.x + block.w - 1;
  const minZ = block.z;
  const maxZ = block.z + block.d - 1;
  const dx = Math.max(minX - px, 0, px - maxX);
  const dz = Math.max(minZ - pz, 0, pz - maxZ);
  return Math.hypot(dx, dz);
}

const ROUTE_ALL_SAMPLES: THREE.Vector3[] = (() => {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= 400; i++) {
    out.push(TRAIN_ROUTE_CURVE.getPointAt(i / 400));
  }
  return out;
})();

const ROUTE_GROUND_SAMPLES: THREE.Vector3[] = ROUTE_ALL_SAMPLES.filter((p) => p.y < 2.5);

/** Horizontal distance to the nearest ground-level piece of track. */
export function distanceToGroundRail(x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const p of ROUTE_GROUND_SAMPLES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Horizontal distance to ANY piece of track (including the viaduct) — tall
 * props like trees must respect this one, otherwise their crowns poke into
 * the elevated deck.
 */
export function distanceToAnyRail(x: number, z: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const p of ROUTE_ALL_SAMPLES) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < best) best = d;
  }
  return best;
}

function nearRoad(x: number, z: number, margin: number): boolean {
  for (const r of ROAD_RECTS) {
    if (
      x >= r.minX - margin &&
      x <= r.maxX + margin &&
      z >= r.minZ - margin &&
      z <= r.maxZ + margin
    ) {
      return true;
    }
  }
  return false;
}

function insideLake(x: number, z: number, margin: number): boolean {
  const nx = (x - LAKE.x) / (LAKE.radiusX + margin);
  const nz = (z - LAKE.z) / (LAKE.radiusZ + margin);
  return nx * nx + nz * nz <= 1;
}

function isPlaceableProp(x: number, z: number, railClearance: number): boolean {
  if (Math.abs(x) > WORLD_HALF_SIZE - 3 || Math.abs(z) > WORLD_HALF_SIZE - 3) return false;
  // Tunnel approach corridor (incl. grassy embankment skirts)
  if (Math.abs(z) < TUNNEL_WIDTH + 9 && Math.abs(x) > WORLD_HALF_SIZE - TUNNEL_LENGTH - 4) return false;
  if (nearRoad(x, z, 2)) return false;
  if (insideLake(x, z, 3)) return false;
  // Trees are tall — keep them clear of the ELEVATED track too.
  if (distanceToAnyRail(x, z) < railClearance) return false;
  for (const block of BLOCK_CONFIGS) {
    if (distancePointToBlock(x, z, block) < 3) return false;
  }
  for (const stop of BUS_STOPS) {
    const c = busShelterCenter(stop);
    if (Math.hypot(x - c.x, z - c.z) < 8) return false;
  }
  return true;
}

export const TREE_POSITIONS: Array<[number, number]> = (() => {
  const rng = mulberry32(20260610);
  const out: Array<[number, number]> = [];
  let attempts = 0;
  while (out.length < 46 && attempts < 4000) {
    attempts++;
    const x = Math.round((rng() * 2 - 1) * (WORLD_HALF_SIZE - 6));
    const z = Math.round((rng() * 2 - 1) * (WORLD_HALF_SIZE - 6));
    if (!isPlaceableProp(x, z, 10)) continue;
    if (out.some(([ox, oz]) => Math.hypot(ox - x, oz - z) < 7)) continue;
    out.push([x, z]);
  }
  return out;
})();

export interface LampSpec {
  x: number;
  z: number;
  /** Direction the lamp arm points (toward the road). */
  dz: number;
}

export const LAMP_SPECS: LampSpec[] = (() => {
  const specs: LampSpec[] = [];
  // Aleja Południowa — lamps on the north sidewalk, arms pointing south (+z)
  for (let x = -56; x <= 60; x += 20) specs.push({ x, z: 20, dz: 1 });
  // Aleja Parkowa — lamps on the north sidewalk, arms pointing south... no:
  // south side, arms pointing north (-z) toward the road.
  for (let x = -46; x <= 50; x += 20) specs.push({ x, z: 52, dz: -1 });
  // South road
  for (let x = -60; x <= 60; x += 24) specs.push({ x, z: -52, dz: 1 });
  // Park / lake promenade
  specs.push({ x: -58, z: 66, dz: 1 }, { x: -22, z: 72, dz: -1 });
  // Station forecourts
  specs.push({ x: -50, z: -3, dz: -1 }, { x: -36, z: -1, dz: -1 });
  return specs.filter((s) => distanceToGroundRail(s.x, s.z) >= 5 && !insideLake(s.x, s.z, 2));
})();

export const LAMP_POSITIONS: Array<[number, number]> = LAMP_SPECS.map((s) => [s.x, s.z]);

export const RAIL_SIGNAL_POSITIONS: Array<[number, number, boolean]> = [
  [-56, 2, true],
  [-30, -19, false],
  [62, 12, true],
];

// ─────────────────────────────────────────────────────────────────────────
// Story actors — anchor points exported so the layout tests can verify they
// never collide with roads, rails, buildings or the lake.
// ─────────────────────────────────────────────────────────────────────────

/** Cow meadow just east of the lake shore. */
export const COW_MEADOW = { x: LAKE.x + LAKE.radiusX + 5, z: LAKE.z - 7, wanderRadius: 2.4 } as const;

/** Fisherman's stool — right at the water line on the west shore. */
export const FISHERMAN_SPOT = { x: -55.6, z: 59.6, facingLake: true } as const;

/** Fisherman's flat — door of the block just west of the lake. */
export const FISHERMAN_HOME = { x: -62, z: 60 } as const;

/** The main kiosk — also the target of occasional alien "shopping" raids. */
export const KIOSK_MAIN = { x: -30, z: 16 } as const;

/** Dog's yard — it chases the postman when he cycles past. */
export const DOG_HOME = { x: 24, z: -43 } as const;

/**
 * Postman's morning loop — rides the outer edges of the south road (the
 * 4-voxel-wide asphalt gives the curve room to round the corners without
 * ever leaving the pavement). Parked cars occupy the middle lanes.
 */
export const POSTMAN_ROUTE_POINTS: THREE.Vector3[] = [
  new THREE.Vector3(-58, 0, -46),
  new THREE.Vector3(-20, 0, -46),
  new THREE.Vector3(20, 0, -46),
  new THREE.Vector3(58, 0, -46),
  new THREE.Vector3(62, 0, -48),
  new THREE.Vector3(58, 0, -50),
  new THREE.Vector3(20, 0, -50),
  new THREE.Vector3(-20, 0, -50),
  new THREE.Vector3(-58, 0, -50),
  new THREE.Vector3(-62, 0, -48),
];

export const POSTMAN_ROUTE_CURVE = new THREE.CatmullRomCurve3(
  POSTMAN_ROUTE_POINTS,
  true,
  'centripetal',
  0.5
);

/** Mail stops along the postman loop (he pauses to deliver). */
export const MAIL_STOPS: Array<[number, number]> = [
  [-18, -50],
  [6, -50],
  [30, -50],
];

// ─────────────────────────────────────────────────────────────────────────
// Helpers shared with tests
// ─────────────────────────────────────────────────────────────────────────

export function threeColorFromHex(color: ColorHex): THREE.Color {
  return new THREE.Color(color);
}

export function sampleRoutePoints(points: THREE.Vector3[], sampleCount: number): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    samples.push(curve.getPointAt(i / sampleCount));
  }
  return samples;
}

export function getTunnelBounds(): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  return [
    {
      minX: -WORLD_HALF_SIZE,
      maxX: -WORLD_HALF_SIZE + TUNNEL_LENGTH - 1,
      minZ: -TUNNEL_WIDTH,
      maxZ: TUNNEL_WIDTH,
    },
    {
      minX: WORLD_HALF_SIZE - TUNNEL_LENGTH + 1,
      maxX: WORLD_HALF_SIZE,
      minZ: -TUNNEL_WIDTH,
      maxZ: TUNNEL_WIDTH,
    },
  ];
}
