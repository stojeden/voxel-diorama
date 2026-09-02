import { COLORS, type ColorHex } from '../WorldLayout';
import { GROUND, layoutHash01, type BuildingSpec, type Side } from './CityModel';
import { STYLE } from './HybridMaterial';
import { P } from './palette';
import { Emitter, gableRoofPositions, hipRoofPositions, type Cluster, type PrimOptions } from './surface';

/**
 * Building families → surface primitives. Ported from the accepted hero-corner
 * sketch: metre heights from the layout, real floors, glass windows flush with
 * the wall and a baked shadow that reads as a recess, living ground floors.
 *
 * Layers: 0 massing, roofs, plinths · 1 openings, loggias, balconies, shop bays,
 * canopies · 2 frames, mullions, sills, goods, small trim.
 */

const SIDES: Record<Side, { nx: number; nz: number; ry: number }> = {
  '+z': { nx: 0, nz: 1, ry: 0 },
  '-z': { nx: 0, nz: -1, ry: Math.PI },
  '+x': { nx: 1, nz: 0, ry: Math.PI / 2 },
  '-x': { nx: -1, nz: 0, ry: -Math.PI / 2 },
};
const SIDE_INDEX: Record<Side, number> = { '+z': 0, '-z': 1, '+x': 2, '-x': 3 };

interface Frame {
  len: (s: Side) => number;
  pos: (s: Side, along: number, y: number, out: number) => { x: number; y: number; z: number; ry: number };
}

function frame(b: BuildingSpec): Frame {
  return {
    len: (s) => (s === '+z' || s === '-z' ? b.w : b.d),
    pos(s, along, y, out) {
      const k = SIDES[s];
      if (s === '+z' || s === '-z') return { x: b.cx + along, y, z: b.cz + k.nz * (b.d / 2 + out), ry: k.ry };
      return { x: b.cx + k.nx * (b.w / 2 + out), y, z: b.cz + along, ry: k.ry };
    },
  };
}

function sideBox(E: Emitter, palette: number, F: Frame, s: Side, along: number, y: number, out: number, len: number, h: number, depth: number, o: PrimOptions = {}): void {
  const p = F.pos(s, along, y, out);
  E.box(palette, p.x, p.y, p.z, len, h, depth, { ...o, ry: p.ry, rx: o.rx ?? 0 });
}

function sidePlane(E: Emitter, palette: number, F: Frame, s: Side, along: number, y: number, out: number, w: number, h: number, o: PrimOptions = {}): void {
  const p = F.pos(s, along, y, out);
  E.plane(palette, p.x, p.y, p.z, w, h, { ...o, ry: p.ry });
}

function accentPalette(accent: ColorHex): number {
  if (accent === COLORS.accentPink) return P.accentRose;
  if (accent === COLORS.accentBlue) return P.accentBlue;
  return P.accentGold;
}

interface Bay { i: number; along: number }
function facadeGrid(F: Frame, s: Side, bay: number): Bay[] {
  const L = F.len(s);
  const bays = Math.max(1, Math.floor((L - 0.8) / bay));
  const margin = (L - bays * bay) / 2;
  return Array.from({ length: bays }, (_, i) => ({ i, along: -L / 2 + margin + bay * (i + 0.5) }));
}

/** Deterministic window "life": glass tint and night cohort per opening. */
function windowLook(b: BuildingSpec, s: Side, bay: number, floor: number): { palette: number; cohort: number } {
  const r = layoutHash01(b.index, SIDE_INDEX[s] * 100 + bay, floor);
  const cohort = Math.floor(layoutHash01(b.index * 7 + 1, SIDE_INDEX[s], bay * 31 + floor) * 5) % 5;
  const palette = r < 0.14 ? P.glassWarm : r < 0.26 ? P.curtain : P.glass;
  return { palette, cohort };
}

/**
 * Layer 0 keeps a simplified window rhythm: one flat pane per opening, no frame,
 * no sill, no reveal, sized just inside the real opening and set behind it. A
 * cluster at LOD 0 therefore still reads as a building with windows -- and still
 * lights up with its cohort at night -- instead of a blank tinted box, and at
 * LOD 1 the real pane sits 2 cm in front and covers it exactly.
 */
const GHOST_OUT = 0.012;
const GLASS_OUT = 0.032;

function windowGhost(
  E: Emitter, b: BuildingSpec, F: Frame, s: Side, bay: number, floor: number,
  along: number, yc: number, ww: number, wh: number,
  /** Pass -1 for glazing that never lights, so both levels agree on the cohort. */
  cohort?: number
): void {
  const look = windowLook(b, s, bay, floor);
  sidePlane(E, look.palette, F, s, along, yc, GHOST_OUT, ww - 0.05, wh - 0.05, {
    layer: 0, cls: 'glass', style: STYLE.glass, cohort: cohort ?? look.cohort,
  });
}

/** Flush glass + baked shadow strips (reads as a recess) + protruding frame + sill. */
function windowAt(E: Emitter, b: BuildingSpec, F: Frame, s: Side, bay: number, floor: number, along: number, yc: number, ww: number, wh: number, lintel: boolean): void {
  const look = windowLook(b, s, bay, floor);
  windowGhost(E, b, F, s, bay, floor, along, yc, ww, wh);
  sidePlane(E, look.palette, F, s, along, yc, GLASS_OUT, ww, wh, { layer: 1, cls: 'glass', style: STYLE.glass, cohort: look.cohort });
  sidePlane(E, P.interior, F, s, along, yc + wh / 2 - 0.09, GLASS_OUT + 0.015, ww, 0.18, { layer: 1, ao: 0.55 });
  sidePlane(E, P.interior, F, s, along - ww / 2 + 0.05, yc, GLASS_OUT + 0.015, 0.1, wh, { layer: 1, ao: 0.6 });
  sideBox(E, P.frame, F, s, along, yc + wh / 2 + 0.035, 0.04, ww + 0.14, 0.07, 0.08, { layer: 2 });
  sideBox(E, P.frame, F, s, along - ww / 2 - 0.035, yc, 0.04, 0.07, wh + 0.07, 0.08, { layer: 2 });
  sideBox(E, P.frame, F, s, along + ww / 2 + 0.035, yc, 0.04, 0.07, wh + 0.07, 0.08, { layer: 2 });
  if (ww >= 0.9) sideBox(E, P.frame, F, s, along, yc, 0.035, 0.045, wh, 0.05, { layer: 2 });
  if (wh >= 1.6) sideBox(E, P.frame, F, s, along, yc + wh * 0.2, 0.035, ww, 0.045, 0.05, { layer: 2 });
  sideBox(E, P.trim, F, s, along, yc - wh / 2 - 0.04, 0.1, ww + 0.28, 0.07, 0.26, { layer: 1 });
  if (lintel) sideBox(E, P.trim, F, s, along, yc + wh / 2 + 0.15, 0.08, ww + 0.36, 0.16, 0.18, { layer: 1 });
}

function doorAt(E: Emitter, F: Frame, s: Side, along: number, y0: number, dw: number, dh: number, canopy: number | null, board: boolean): void {
  sidePlane(E, P.glassWarm, F, s, along, y0 + dh / 2, 0.015, dw, dh, { layer: 1, cls: 'glass', style: STYLE.glass });
  sideBox(E, P.wood, F, s, along, y0 + dh / 2 + 0.3, 0.02, 0.06, dh - 0.6, 0.03, { layer: 2 });
  sideBox(E, P.frame, F, s, along - dw / 2 - 0.04, y0 + dh / 2, 0.04, 0.08, dh, 0.1, { layer: 2 });
  sideBox(E, P.frame, F, s, along + dw / 2 + 0.04, y0 + dh / 2, 0.04, 0.08, dh, 0.1, { layer: 2 });
  sideBox(E, P.frame, F, s, along, y0 + dh + 0.04, 0.04, dw + 0.16, 0.08, 0.1, { layer: 2 });
  if (canopy !== null) sideBox(E, canopy, F, s, along, y0 + dh + 0.32, 0.7, dw + 1.3, 0.14, 1.4, { layer: 1 });
  sideBox(E, P.concrete, F, s, along, y0 + 0.07, 0.35, dw + 0.8, 0.14, 0.7, { layer: 1 });
  sideBox(E, P.concrete, F, s, along, y0 + 0.2, 0.15, dw + 0.8, 0.12, 0.3, { layer: 1 });
  sideBox(E, P.interior, F, s, along, y0 + 0.28, 0.42, dw - 0.3, 0.02, 0.5, { layer: 2, ao: 0.9 });
  if (board) {
    sideBox(E, P.wood, F, s, along + dw / 2 + 0.75, y0 + 1.6, 0.04, 1.0, 0.8, 0.06, { layer: 2 });
    sideBox(E, P.trim, F, s, along + dw / 2 + 0.75, y0 + 1.6, 0.075, 0.88, 0.68, 0.02, { layer: 2 });
  }
}

function loggiaAt(E: Emitter, b: BuildingSpec, F: Frame, s: Side, bay: number, floor: number, along: number, y0: number, floorH: number, bayW: number, accent: number, top: boolean): void {
  const w = bayW - 0.2;
  sideBox(E, P.trim, F, s, along, y0 + 0.08, 0.65, w, 0.16, 1.3, { layer: 1, ao: 0.9 });
  sideBox(E, b.tint, F, s, along - w / 2 + 0.07, y0 + floorH / 2, 0.65, 0.14, floorH, 1.3, { layer: 1, ao: 0.92 });
  sideBox(E, b.tint, F, s, along + w / 2 - 0.07, y0 + floorH / 2, 0.65, 0.14, floorH, 1.3, { layer: 1, ao: 0.92 });
  sideBox(E, accent, F, s, along, y0 + 0.16 + 0.52, 1.26, w - 0.28, 1.04, 0.08, { layer: 1 });
  sideBox(E, P.steel, F, s, along, y0 + 1.24, 1.26, w - 0.28, 0.05, 0.05, { layer: 2 });
  windowGhost(E, b, F, s, bay, floor, along, y0 + 1.15, 1.05, 2.15);
  const look = windowLook(b, s, bay, floor);
  sidePlane(E, look.palette, F, s, along, y0 + 1.15, 0.015, 1.05, 2.15, { layer: 1, cls: 'glass', style: STYLE.glass, cohort: look.cohort });
  if (top) sideBox(E, P.trim, F, s, along, y0 + floorH + 0.08, 0.65, w, 0.16, 1.3, { layer: 1 });
}

function roofFlat(E: Emitter, b: BuildingSpec, H: number, towers: number, mast: boolean): void {
  const y = GROUND + H;
  E.box(P.roofFlat, b.cx, y + 0.05, b.cz, b.w - 0.1, 0.1, b.d - 0.1, { layer: 0 });
  E.box(P.trim, b.cx, y + 0.21, b.cz + b.d / 2, b.w + 0.24, 0.42, 0.24, { layer: 1 });
  E.box(P.trim, b.cx, y + 0.21, b.cz - b.d / 2, b.w + 0.24, 0.42, 0.24, { layer: 1 });
  E.box(P.trim, b.cx + b.w / 2, y + 0.21, b.cz, 0.24, 0.42, b.d + 0.24, { layer: 1 });
  E.box(P.trim, b.cx - b.w / 2, y + 0.21, b.cz, 0.24, 0.42, b.d + 0.24, { layer: 1 });
  for (let i = 0; i < towers; i++) {
    const tx = b.cx + (towers === 1 ? 0 : i === 0 ? -b.w / 4 : b.w / 4);
    const tz = b.cz + (layoutHash01(b.index, 40 + i) - 0.5) * (b.d - 3);
    E.box(b.tint, tx, y + 1.25, tz, 2.4, 2.5, 2.6, { layer: 1, ao: 0.97 });
    E.box(P.trim, tx, y + 2.56, tz, 2.8, 0.12, 3.0, { layer: 1 });
  }
  for (let i = 0; i < 3; i++) {
    E.cylinder(P.steel, b.cx + (layoutHash01(b.index, 50 + i) - 0.5) * (b.w - 2), y + 0.35, b.cz + (layoutHash01(b.index, 60 + i) - 0.5) * (b.d - 2), 0.22, 0.22, 0.7, 10, { layer: 2 });
  }
  if (mast) {
    const mx = b.cx + b.w / 2 - 0.6;
    const mz = b.cz - b.d / 2 + 0.6;
    E.cylinder(P.steel, mx, y + 1.6, mz, 0.04, 0.05, 3.2, 6, { layer: 2 });
    E.box(P.steel, mx, y + 3.0, mz, 0.9, 0.03, 0.03, { layer: 2 });
  }
}

function slab(E: Emitter, b: BuildingSpec): void {
  const F = frame(b);
  const H = b.bodyHeight;
  const floorH = b.floorHeight;
  const accent = accentPalette(b.accent);
  E.box(b.tint, b.cx, GROUND + H / 2, b.cz, b.w, H, b.d, { layer: 0, style: STYLE.seams });
  E.box(P.plinth, b.cx, GROUND + 0.275, b.cz, b.w + 0.14, 0.55, b.d + 0.14, { layer: 0, ao: 0.85 });
  const longSides: Side[] = b.w >= b.d ? ['+z', '-z'] : ['+x', '-x'];
  for (const s of ['+z', '-z', '+x', '-x'] as Side[]) {
    const bay = 3.0;
    const isLong = longSides.includes(s);
    for (const { i, along } of facadeGrid(F, s, bay)) {
      const loggia = isLong && i % 3 === 1;
      for (let f = 0; f < b.floors; f++) {
        const y0 = GROUND + f * floorH;
        if (b.entrance && s === b.entrance.side && f === 0 && Math.abs(along - b.entrance.along) < 1.6) continue;
        if (loggia) loggiaAt(E, b, F, s, i, f, along, y0, floorH, bay, accent, f === b.floors - 1);
        else windowAt(E, b, F, s, i, f, along, y0 + 0.95 + 0.7, 1.5, 1.4, false);
      }
    }
  }
  if (b.entrance) doorAt(E, F, b.entrance.side, b.entrance.along, GROUND, 1.3, 2.2, accent, true);
  E.box(accent, b.cx, GROUND + H - 0.28, b.cz, b.w + 0.02, 0.5, b.d + 0.02, { layer: 1 });
  roofFlat(E, b, H, b.w >= 9 ? 2 : 1, true);
}

function tower(E: Emitter, b: BuildingSpec): void {
  const F = frame(b);
  const H = b.bodyHeight;
  const floorH = b.floorHeight;
  const accent = accentPalette(b.accent);
  E.box(b.tint, b.cx, GROUND + H / 2, b.cz, b.w, H, b.d, { layer: 0, style: STYLE.seams });
  E.box(P.plinth, b.cx, GROUND + 0.3, b.cz, b.w + 0.14, 0.6, b.d + 0.14, { layer: 0, ao: 0.85 });
  for (const s of ['+z', '-z', '+x', '-x'] as Side[]) {
    for (const { i, along } of facadeGrid(F, s, 2.8)) {
      for (let f = 0; f < b.floors; f++) {
        const y0 = GROUND + f * floorH;
        if (b.entrance && s === b.entrance.side && f === 0 && Math.abs(along - b.entrance.along) < 1.5) continue;
        if (s === '-x' && Math.abs(along) < 1.0) continue;
        windowAt(E, b, F, s, i, f, along, y0 + 0.9 + 0.65, 1.4, 1.3, false);
      }
    }
  }
  // The stairwell strip is not a dwelling window and carries no cohort.
  windowGhost(E, b, F, '-x', 99, 0, 0, GROUND + H / 2, 1.3, H - 0.6, -1);
  sideBox(E, P.glass, F, '-x', 0, GROUND + H / 2, 0.02, 1.3, H - 0.6, 0.12, { layer: 1, cls: 'glass', style: STYLE.glass });
  sideBox(E, P.frame, F, '-x', -0.72, GROUND + H / 2, 0.04, 0.1, H - 0.6, 0.16, { layer: 2 });
  sideBox(E, P.frame, F, '-x', 0.72, GROUND + H / 2, 0.04, 0.1, H - 0.6, 0.16, { layer: 2 });
  for (const [sx, sz] of [[1, 1], [-1, -1]] as const) {
    for (let f = 1; f < b.floors; f++) {
      const y0 = GROUND + f * floorH;
      const sA: Side = sz > 0 ? '+z' : '-z';
      const sB: Side = sx > 0 ? '+x' : '-x';
      const aA = sx * (b.w / 2 - 1.15);
      const aB = sz * (b.d / 2 - 1.15);
      sideBox(E, P.trim, F, sA, aA, y0 + 0.07, 0.6, 2.3, 0.14, 1.2, { layer: 1, ao: 0.9 });
      sideBox(E, P.trim, F, sB, aB, y0 + 0.07, 0.6, 2.3, 0.14, 1.2, { layer: 1, ao: 0.9 });
      sideBox(E, accent, F, sA, aA, y0 + 0.64, 1.16, 2.3, 1.0, 0.08, { layer: 1 });
      sideBox(E, accent, F, sB, aB, y0 + 0.64, 1.16, 2.3, 1.0, 0.08, { layer: 1 });
    }
  }
  if (b.entrance) doorAt(E, F, b.entrance.side, b.entrance.along, GROUND, 1.3, 2.2, P.roofSheet, true);
  roofFlat(E, b, H, 1, false);
  E.box(b.tint, b.cx, GROUND + H + 1.4, b.cz, 3.6, 2.8, 2.6, { layer: 1, ao: 0.96 });
  E.cylinder(P.steel, b.cx, GROUND + H + 2.8 + 3.5, b.cz, 0.06, 0.09, 7, 8, { layer: 1 });
  E.cylinder(P.aviationRed, b.cx, GROUND + H + 6.45, b.cz, 0.18, 0.18, 0.36, 8, { layer: 0, cls: 'glow' });
}

function tenement(E: Emitter, b: BuildingSpec): void {
  const F = frame(b);
  const groundH = b.groundFloorHeight;
  const floorH = b.floorHeight;
  const upper = b.floors - 1;
  const H = b.bodyHeight;
  const accent = accentPalette(b.accent);
  const front = b.avenueSide;
  E.box(b.tint, b.cx, GROUND + H / 2, b.cz, b.w, H, b.d, { layer: 0 });
  E.box(P.plinth, b.cx, GROUND + 0.35, b.cz, b.w + 0.12, 0.7, b.d + 0.12, { layer: 0, ao: 0.85 });
  E.box(P.trim, b.cx, GROUND + groundH, b.cz, b.w + 0.26, 0.14, b.d + 0.26, { layer: 1 });
  E.box(P.trim, b.cx, GROUND + H - 0.5, b.cz, b.w + 0.34, 0.14, b.d + 0.34, { layer: 1 });
  E.box(P.trim, b.cx, GROUND + H - 0.16, b.cz, b.w + 0.62, 0.32, b.d + 0.62, { layer: 1 });
  const roofPalette = b.seed > 0.5 ? P.roofTile : P.roofSheet;
  const long = b.w >= b.d;
  const ridge = Math.max(0, long ? b.w - b.d : b.d - b.w);
  E.prism(roofPalette, hipRoofPositions(b.cx, GROUND + H, b.cz, long ? b.w : b.d, long ? b.d : b.w, b.roofHeight, ridge, 0.4, !long), { layer: 0 });
  for (const k of [-0.5, 0.5]) {
    const off = k * Math.max(ridge - 1, 1.2);
    const cxk = b.cx + (long ? off : 0);
    const czk = b.cz + (long ? 0 : off);
    E.box(b.tint, cxk, GROUND + H + b.roofHeight * 0.7 + 0.4, czk, 0.7, 1.3, 0.7, { layer: 1, ao: 0.85 });
    E.box(P.trim, cxk, GROUND + H + b.roofHeight * 0.7 + 1.1, czk, 0.82, 0.1, 0.82, { layer: 2 });
  }
  const doorAlong = 0.3;
  for (const s of ['+z', '-z', '+x', '-x'] as Side[]) {
    const bay = 2.7;
    for (const { i, along } of facadeGrid(F, s, bay)) {
      if (s === front && Math.abs(along - doorAlong) < 1.4) {
        // stairwell door bay
      } else if (s === front) {
        shopBay(E, b, F, s, i, along, bay);
      } else {
        windowAt(E, b, F, s, i, 0, along, GROUND + 1.0 + 0.9, 1.05, 1.8, true);
      }
      for (let f = 0; f < upper; f++) {
        const y0 = GROUND + groundH + f * floorH;
        const balcony = s === front && i % 2 === 1;
        if (balcony) {
          sideBox(E, P.trim, F, s, along, y0 + 0.06, 0.42, 1.8, 0.12, 0.84, { layer: 1, ao: 0.9 });
          sideBox(E, P.steel, F, s, along, y0 + 0.62, 0.82, 1.8, 0.04, 0.04, { layer: 2 });
          sideBox(E, P.steel, F, s, along, y0 + 1.12, 0.82, 1.8, 0.04, 0.04, { layer: 2 });
          for (const k of [-0.86, -0.29, 0.29, 0.86]) sideBox(E, P.steel, F, s, along + k, y0 + 0.62, 0.82, 0.04, 1.0, 0.04, { layer: 2 });
          windowGhost(E, b, F, s, i, f + 1, along, y0 + 1.15, 1.05, 2.15);
          const look = windowLook(b, s, i, f + 1);
          sidePlane(E, look.palette, F, s, along, y0 + 1.15, 0.015, 1.05, 2.15, { layer: 1, cls: 'glass', style: STYLE.glass, cohort: look.cohort });
          sideBox(E, P.trim, F, s, along, y0 + 2.3, 0.04, 1.35, 0.16, 0.14, { layer: 1 });
        } else {
          windowAt(E, b, F, s, i, f + 1, along, y0 + 0.95 + 0.92, 1.05, 1.85, true);
        }
      }
    }
  }
  doorAt(E, F, front, doorAlong, GROUND, 1.5, 2.7, null, true);
  if (b.entrance && b.entrance.side !== front) doorAt(E, F, b.entrance.side, b.entrance.along, GROUND, 1.3, 2.2, null, false);
  void accent;
}

/** Shop display bay protruding from the wall, with visible interior and goods. */
function shopBay(E: Emitter, b: BuildingSpec, F: Frame, s: Side, i: number, along: number, bay: number): void {
  const signs = [P.accentRose, P.accentBlue, P.accentGold, P.goodsB, P.roofSheet];
  const sign = signs[(b.index + i) % signs.length];
  const gw = bay - 0.55;
  const gh = 2.3;
  const gy = GROUND + 0.5 + gh / 2;
  const out = 0.26;
  sideBox(E, P.interior, F, s, along, gy, 0.02, gw, gh, 0.03, { layer: 1, ao: 0.85 });
  const goods = [P.goodsA, P.goodsB, P.accentRose];
  for (let g = 0; g < 3; g++) {
    const gx = along - gw / 2 + 0.35 + (g * (gw - 0.7)) / 2;
    const gh2 = 0.42 + layoutHash01(b.index, i, g) * 0.3;
    sideBox(E, goods[(g + i) % goods.length], F, s, gx, GROUND + 0.95 + layoutHash01(b.index, i + 9, g) * 0.6, 0.12, 0.42, gh2, 0.16, { layer: 2 });
  }
  sideBox(E, b.tint, F, s, along, GROUND + 0.35, out / 2, gw + 0.16, 0.7, out, { layer: 1, ao: 0.72 });
  sideBox(E, b.tint, F, s, along - gw / 2 - 0.04, gy, out / 2, 0.08, gh, out, { layer: 1, ao: 0.8 });
  sideBox(E, b.tint, F, s, along + gw / 2 + 0.04, gy, out / 2, 0.08, gh, out, { layer: 1, ao: 0.8 });
  sideBox(E, b.tint, F, s, along, gy + gh / 2 + 0.04, out / 2, gw + 0.16, 0.08, out, { layer: 1, ao: 0.7 });
  // A shop window is not a dwelling: the display glass carries no cohort, so its
  // layer 0 stand-in must not carry one either.
  windowGhost(E, b, F, s, i, 0, along, gy, gw, gh, -1);
  sideBox(E, P.glass, F, s, along, gy, out - 0.02, gw, gh, 0.03, { layer: 1, cls: 'glassClear', style: STYLE.glass });
  sideBox(E, P.frame, F, s, along - gw / 2 - 0.04, gy, out, 0.08, gh, 0.06, { layer: 2 });
  sideBox(E, P.frame, F, s, along + gw / 2 + 0.04, gy, out, 0.08, gh, 0.06, { layer: 2 });
  sideBox(E, sign, F, s, along, GROUND + 3.05, 0.05, bay - 0.3, 0.55, 0.1, { layer: 1 });
  sideBox(E, P.trim, F, s, along, GROUND + 3.05, 0.11, bay - 1.3, 0.16, 0.02, { layer: 2 });
  sideBox(E, sign, F, s, along + (bay - 0.3) / 2 - 0.05, GROUND + 2.55, 0.42, 0.06, 0.42, 0.7, { layer: 2 });
  if (i % 2 === 0) sideBox(E, sign, F, s, along, GROUND + 2.72, 0.5, bay - 0.5, 0.05, 1.0, { layer: 1, rx: 0.36 });
}

function walkup(E: Emitter, b: BuildingSpec): void {
  const F = frame(b);
  const H = b.bodyHeight;
  const floorH = b.floorHeight;
  const accent = accentPalette(b.accent);
  const long = b.w >= b.d;
  const stairSide: Side = long ? (b.cz > 0 ? '-z' : '+z') : b.cx > 0 ? '-x' : '+x';
  E.box(b.tint, b.cx, GROUND + H / 2, b.cz, b.w, H, b.d, { layer: 0 });
  E.box(P.plinth, b.cx, GROUND + 0.25, b.cz, b.w + 0.12, 0.5, b.d + 0.12, { layer: 0, ao: 0.85 });
  const L = F.len(stairSide);
  const stairAlongs = [-L / 4, L / 4];
  for (const s of ['+z', '-z', '+x', '-x'] as Side[]) {
    for (const { i, along } of facadeGrid(F, s, 3.2)) {
      if (s === stairSide && stairAlongs.some((a) => Math.abs(a - along) < 1.6)) continue;
      for (let f = 0; f < b.floors; f++) windowAt(E, b, F, s, i, f, along, GROUND + f * floorH + 0.9 + 0.68, 1.25, 1.35, false);
    }
  }
  for (const a of stairAlongs) {
    doorAt(E, F, stairSide, a, GROUND, 1.1, 2.1, accent, false);
    for (let f = 0; f < b.floors - 1; f++) {
      const yc = GROUND + (f + 1) * floorH + 0.2;
      sidePlane(E, P.glass, F, stairSide, a, yc, 0.015, 0.8, 1.1, { layer: 1, cls: 'glass', style: STYLE.glass });
      sideBox(E, P.trim, F, stairSide, a, yc - 0.6, 0.05, 1.0, 0.07, 0.16, { layer: 2 });
    }
  }
  E.prism(P.roofSheet, gableRoofPositions(b.cx, GROUND + H, b.cz, long ? b.w : b.d, long ? b.d : b.w, b.roofHeight, 0.45, !long), { layer: 0 });
  for (const k of [-0.3, 0.3]) {
    const off = k * (long ? b.w : b.d);
    E.box(b.tint, b.cx + (long ? off : 0), GROUND + H + b.roofHeight * 0.6 + 0.4, b.cz + (long ? 0 : off), 0.55, 1.1, 0.55, { layer: 1, ao: 0.85 });
  }
}

export function emitBuilding(b: BuildingSpec): Cluster {
  const E = new Emitter();
  if (b.family === 'tower') tower(E, b);
  else if (b.family === 'tenement') tenement(E, b);
  else if (b.family === 'walkup') walkup(E, b);
  else slab(E, b);
  const height = b.bodyHeight + b.roofHeight;
  return E.cluster(`building-${b.index}`, [b.cx, GROUND + height / 2, b.cz], Math.hypot(b.w, b.d, height) / 2);
}
