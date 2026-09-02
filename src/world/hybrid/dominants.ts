import { OVERVIEW_SHOT } from '../../experience/ShotDefinitions';
import {
  BLOCK_CONFIGS,
  LAKE,
  TREE_POSITIONS,
  WORLD_HALF_SIZE,
  distancePointToBlock,
  distanceToAnyRail,
  isOnRoad,
} from '../WorldLayout';
import { GROUND, type DominantSpec } from './CityModel';
import { STYLE } from './HybridMaterial';
import { P } from './palette';
import { Emitter, type Cluster } from './surface';

/**
 * The dominant duet: heat-plant chimney and an original brutalist RTV tower.
 * Both are landmarks for orientation, not monsters; both carry red aviation
 * lights as emissive `glow` primitives (future blink/transmission hooks are
 * data only — nothing animates here).
 */

export function validateDominantSite(x: number, z: number): string[] {
  const reasons: string[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if (isOnRoad(Math.round(x + dx), Math.round(z + dz))) { reasons.push('road'); dx = 4; break; }
  }
  if (BLOCK_CONFIGS.some((block) => distancePointToBlock(x, z, block) < 4)) reasons.push('block');
  if (distanceToAnyRail(x, z) < 8) reasons.push('rail');
  if (TREE_POSITIONS.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 3)) reasons.push('tree');
  if (Math.abs(x) > WORLD_HALF_SIZE - 6 || Math.abs(z) > WORLD_HALF_SIZE - 6) reasons.push('bounds');
  const ex = (x - LAKE.x) / (LAKE.radiusX + 4);
  const ez = (z - LAKE.z) / (LAKE.radiusZ + 4);
  if (ex * ex + ez * ez <= 1) reasons.push('lake');
  return reasons;
}

/** Compass bearing (degrees) of a ground point as seen from the default overview camera. */
export function bearingFromOverview(x: number, z: number): number {
  const [cx, , cz] = OVERVIEW_SHOT.position;
  return (Math.atan2(z - cz, x - cx) * 180) / Math.PI;
}

export function emitDominant(spec: DominantSpec, low: boolean): Cluster {
  const E = new Emitter();
  if (spec.kind === 'chimney') chimney(E, spec, low);
  else rtvTower(E, spec, low);
  return E.cluster(`dominant-${spec.kind}`, [spec.x, GROUND + spec.height / 2, spec.z], spec.height / 2 + 8);
}

function light(E: Emitter, x: number, y: number, z: number, r = 0.22): void {
  E.cylinder(P.aviationRed, x, y, z, r, r, r * 2, 8, { layer: 0, cls: 'glow' });
}

function chimney(E: Emitter, spec: DominantSpec, low: boolean): void {
  const segments = low ? 4 : 8;
  const segH = spec.height / segments;
  for (let k = 0; k < segments; k++) {
    const t0 = k / segments;
    const t1 = (k + 1) / segments;
    const rb = 1.55 + (0.95 - 1.55) * t0;
    const rt = 1.55 + (0.95 - 1.55) * t1;
    const banded = t0 >= 0.5;
    const palette = !banded ? P.concrete : k % 2 === 0 ? P.roofTile : P.trim;
    E.cylinder(palette, spec.x, GROUND + k * segH + segH / 2, spec.z, rt, rb, segH, low ? 12 : 20, { layer: 0 });
  }
  E.cylinder(P.steel, spec.x, GROUND + spec.height + 0.3, spec.z, 1.05, 0.98, 0.6, 16, { layer: 1 });
  E.cylinder(P.concrete, spec.x, GROUND + 0.7, spec.z, 2.3, 2.6, 1.4, 16, { layer: 0 });
  for (const [dx, dz] of [[1.0, 0], [-1.0, 0]]) light(E, spec.x + dx, GROUND + spec.height + 0.9, spec.z + dz);
  // boiler house
  const hx = spec.x + 9.5;
  const hz = spec.z;
  E.box(P.plasterRose, hx, GROUND + 4, hz, 12, 8, 9, { layer: 0 });
  E.box(P.trim, hx, GROUND + 8.2, hz, 12.2, 0.4, 9.2, { layer: 1 });
  if (!low) {
    for (let i = 0; i < 4; i++) for (const yy of [2.6, 5.4]) {
      E.plane(P.glass, hx - 4.5 + i * 3, GROUND + yy, hz + 4.51, 1.6, 1.9, { layer: 1, cls: 'glass', style: STYLE.glass });
      E.plane(P.glass, hx - 4.5 + i * 3, GROUND + yy, hz - 4.51, 1.6, 1.9, { layer: 1, cls: 'glass', style: STYLE.glass, ry: Math.PI });
    }
  }
  E.box(P.plasterRose, hx + 9, GROUND + 2.25, hz, 6, 4.5, 6, { layer: 0 });
  E.box(P.trim, hx + 9, GROUND + 4.6, hz, 6.2, 0.3, 6.2, { layer: 1 });
}

/**
 * Slender brutalist RTV tower: tapered concrete shaft with four vertical fins,
 * a technical platform with railing, equipment and two dishes, a small upper
 * platform and a lattice mast. Total 62 m at the recommended site.
 */
function rtvTower(E: Emitter, spec: DominantSpec, low: boolean): void {
  const shaftH = 44;
  const mastTop = spec.height;
  const y0 = GROUND;
  E.cylinder(P.concrete, spec.x, y0 + shaftH / 2, spec.z, 1.5, 2.6, shaftH, low ? 8 : 12, { layer: 0, style: STYLE.seams });
  E.cylinder(P.plinth, spec.x, y0 + 1.5, spec.z, 3.2, 3.6, 3.0, low ? 8 : 12, { layer: 0, ao: 0.9 });
  if (!low) {
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const rr = 2.0;
      E.box(P.concrete, spec.x + Math.cos(a) * rr, y0 + shaftH * 0.48, spec.z + Math.sin(a) * rr, 0.35, shaftH * 0.92, 0.5, { layer: 1, ry: -a, ao: 0.95 });
    }
  }
  // technical platform
  const platY = y0 + 34;
  E.cylinder(P.concrete, spec.x, platY, spec.z, 5.2, 5.2, 0.8, 8, { layer: 0, ao: 0.9 });
  E.cylinder(P.plinth, spec.x, platY - 0.7, spec.z, 2.2, 4.6, 0.6, 8, { layer: 1, ao: 0.75 });
  if (!low) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI * 2) / 16;
      E.box(P.steel, spec.x + Math.cos(a) * 5.0, platY + 0.95, spec.z + Math.sin(a) * 5.0, 0.06, 1.1, 0.06, { layer: 1 });
    }
    E.torus(P.steel, spec.x, platY + 1.5, spec.z, 5.0, 0.04, { layer: 1, rx: Math.PI / 2 });
    for (const [dx, dz, w, d] of [[1.8, 1.2, 1.4, 1.2], [-2.0, 0.6, 1.2, 1.0], [0.4, -2.4, 1.6, 1.1]]) {
      E.box(P.roofSheet, spec.x + dx, platY + 0.4 + 0.5, spec.z + dz, w, 1.0, d, { layer: 1 });
    }
    for (const [a, tilt] of [[0.6, -0.55], [3.9, -0.7]]) {
      const rr = 4.2;
      E.cylinder(P.trim, spec.x + Math.cos(a) * rr, platY + 1.9, spec.z + Math.sin(a) * rr, 1.1, 1.1, 0.12, 16, { layer: 1, rx: Math.PI / 2 + tilt, rz: -a });
      E.box(P.steel, spec.x + Math.cos(a) * rr, platY + 1.2, spec.z + Math.sin(a) * rr, 0.12, 1.6, 0.12, { layer: 1 });
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    light(E, spec.x + Math.cos(a) * 5.0, platY + 1.9, spec.z + Math.sin(a) * 5.0);
  }
  // upper platform
  const upY = y0 + 41;
  E.cylinder(P.concrete, spec.x, upY, spec.z, 3.2, 3.2, 0.5, 8, { layer: 0, ao: 0.92 });
  if (!low) {
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + 0.4;
      E.cylinder(P.steel, spec.x + Math.cos(a) * 2.6, upY + 1.6, spec.z + Math.sin(a) * 2.6, 0.08, 0.08, 3.2, 6, { layer: 1 });
    }
  }
  // mast
  const mastBase = y0 + shaftH;
  const mastH = mastTop - shaftH;
  if (low) {
    E.cylinder(P.steel, spec.x, mastBase + mastH / 2, spec.z, 0.18, 0.4, mastH, 8, { layer: 0 });
  } else {
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      const rb = 1.0;
      const rt = 0.35;
      const cx = spec.x + Math.cos(a) * ((rb + rt) / 2);
      const cz = spec.z + Math.sin(a) * ((rb + rt) / 2);
      const dr = rb - rt;
      const tilt = Math.atan2(dr, mastH);
      E.cylinder(P.steel, cx, mastBase + mastH / 2, cz, 0.07, 0.09, Math.hypot(mastH, dr), 6, {
        layer: 0,
        rx: -Math.sin(a) * tilt,
        rz: Math.cos(a) * tilt,
      });
    }
    for (let level = 1; level <= 5; level++) {
      const t = level / 6;
      const rr = 1.0 + (0.35 - 1.0) * t;
      const yy = mastBase + mastH * t;
      E.box(P.steel, spec.x, yy, spec.z, rr * 2.1, 0.05, 0.05, { layer: 1 });
      E.box(P.steel, spec.x, yy, spec.z, 0.05, 0.05, rr * 2.1, { layer: 1 });
    }
  }
  light(E, spec.x, mastBase + mastH * 0.5, spec.z + 0.9, 0.18);
  light(E, spec.x, mastBase + mastH * 0.5, spec.z - 0.9, 0.18);
  light(E, spec.x, mastTop + 0.3, spec.z, 0.26);
}
