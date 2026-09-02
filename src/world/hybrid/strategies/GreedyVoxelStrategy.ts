import * as THREE from 'three';
import type { Cluster, MaterialClass, SurfacePrimitive } from '../surface';
import { keyOf, measure, now, type StrategyResult } from './strategy';

export interface GreedyOptions {
  /** Voxel edge in metres. */
  cell: number;
  /** Cells above this count force a coarser cell (spike safety valve). */
  maxCells: number;
}

export const DEFAULT_GREEDY: GreedyOptions = { cell: 0.25, maxCells: 4_000_000 };

/**
 * Strategy B — voxelise the same primitives into a regular grid per material
 * class, then greedy-mesh the exposed faces. Thin elements are dilated to one
 * cell (voxel art draws thin things one voxel thick); the count is reported so
 * the comparison stays honest about what the grid cannot express.
 */
export function buildGreedy(cluster: Cluster, options: GreedyOptions = DEFAULT_GREEDY): StrategyResult {
  const t0 = now();
  const byClass = new Map<MaterialClass, SurfacePrimitive[]>();
  for (const prim of cluster.primitives) {
    const list = byClass.get(prim.cls);
    if (list) list.push(prim);
    else byClass.set(prim.cls, [prim]);
  }
  const geometries = new Map<string, THREE.BufferGeometry>();
  let dilated = 0;
  let cells = 0;
  let cell = options.cell;
  for (const [cls, prims] of byClass) {
    const grid = voxelise(prims, cell, options.maxCells);
    dilated += grid.dilated;
    cells += grid.nx * grid.ny * grid.nz;
    cell = Math.max(cell, grid.cell);
    const buffers = greedyMesh(grid);
    for (const [layer, buffer] of buffers) {
      if (buffer.positions.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer.positions), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buffer.normals), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buffer.uvs), 2));
      geometry.setAttribute('aPalette', new THREE.BufferAttribute(new Float32Array(buffer.palette), 1));
      geometry.setAttribute('aCohort', new THREE.BufferAttribute(new Float32Array(buffer.cohort), 1));
      geometry.setAttribute('aAo', new THREE.BufferAttribute(new Float32Array(buffer.ao), 1));
      geometry.setAttribute('aStyle', new THREE.BufferAttribute(new Float32Array(buffer.style), 1));
      geometry.computeBoundingSphere();
      geometries.set(keyOf(cls, layer as 0 | 1 | 2), geometry);
    }
  }
  return { geometries, stats: measure('greedy', geometries, now() - t0, { cell, cells, dilated, primitives: cluster.primitives.length }) };
}

interface Grid {
  cell: number;
  minX: number; minY: number; minZ: number;
  nx: number; ny: number; nz: number;
  keys: Int32Array;
  dilated: number;
}

const EMPTY = -1;
const packKey = (layer: number, palette: number, cohort: number, style: number) =>
  ((layer & 3) << 20) | ((palette & 63) << 14) | (((cohort + 1) & 15) << 10) | ((style & 15) << 6);
const layerOf = (key: number) => (key >> 20) & 3;
const paletteOf = (key: number) => (key >> 14) & 63;
const cohortOf = (key: number) => ((key >> 10) & 15) - 1;
const styleOf = (key: number) => (key >> 6) & 15;

interface Bounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

function boundsOf(prim: SurfacePrimitive): Bounds {
  if (prim.kind === 'prism') {
    const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < prim.positions.length; i += 3) {
      b.minX = Math.min(b.minX, prim.positions[i]); b.maxX = Math.max(b.maxX, prim.positions[i]);
      b.minY = Math.min(b.minY, prim.positions[i + 1]); b.maxY = Math.max(b.maxY, prim.positions[i + 1]);
      b.minZ = Math.min(b.minZ, prim.positions[i + 2]); b.maxZ = Math.max(b.maxZ, prim.positions[i + 2]);
    }
    return b;
  }
  let r: number;
  if (prim.kind === 'box') r = Math.hypot(prim.w, prim.h, prim.d) / 2;
  else if (prim.kind === 'plane') r = Math.hypot(prim.w, prim.h) / 2;
  else if (prim.kind === 'cylinder') r = Math.hypot(Math.max(prim.rTop, prim.rBottom) * 2, prim.h) / 2;
  else r = prim.radius + prim.tube;
  return { minX: prim.x - r, maxX: prim.x + r, minY: prim.y - r, maxY: prim.y + r, minZ: prim.z - r, maxZ: prim.z + r };
}

const inv = new THREE.Matrix4();
const rot = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
const p = new THREE.Vector3();

type Inside = (x: number, y: number, z: number) => boolean;

/** Build an inside test for one primitive; returns how many dimensions had to be dilated. */
function insideTest(prim: SurfacePrimitive, cell: number): { test: Inside; dilated: number } {
  let dilated = 0;
  const dil = (v: number) => { if (v < cell) { dilated++; return cell; } return v; };
  if (prim.kind === 'box') {
    const w = dil(prim.w), h = dil(prim.h), d = dil(prim.d);
    e.set(prim.rx, prim.ry, prim.rz, prim.order);
    q.setFromEuler(e);
    rot.makeRotationFromQuaternion(q);
    inv.copy(rot).invert();
    const m = inv.clone();
    const cx = prim.x, cy = prim.y, cz = prim.z;
    return { dilated, test: (x, y, z) => { p.set(x - cx, y - cy, z - cz).applyMatrix4(m); return Math.abs(p.x) <= w / 2 && Math.abs(p.y) <= h / 2 && Math.abs(p.z) <= d / 2; } };
  }
  if (prim.kind === 'plane') {
    // one-cell slab behind the visible face (normal side flush with the plane)
    e.set(prim.rx, prim.ry, 0, 'XYZ');
    q.setFromEuler(e);
    rot.makeRotationFromQuaternion(q);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix4(rot);
    const cx = prim.x - normal.x * cell / 2, cy = prim.y - normal.y * cell / 2, cz = prim.z - normal.z * cell / 2;
    inv.copy(rot).invert();
    const m = inv.clone();
    const w = dil(prim.w), h = dil(prim.h);
    return { dilated: dilated + 1, test: (x, y, z) => { p.set(x - cx, y - cy, z - cz).applyMatrix4(m); return Math.abs(p.x) <= w / 2 && Math.abs(p.y) <= h / 2 && Math.abs(p.z) <= cell / 2; } };
  }
  if (prim.kind === 'cylinder') {
    e.set(prim.rx, 0, prim.rz, 'XYZ');
    q.setFromEuler(e);
    rot.makeRotationFromQuaternion(q);
    inv.copy(rot).invert();
    const m = inv.clone();
    const rTop = Math.max(prim.rTop, cell / 2), rBottom = Math.max(prim.rBottom, cell / 2);
    if (prim.rTop < cell / 2 || prim.rBottom < cell / 2) dilated++;
    const h = dil(prim.h);
    const cx = prim.x, cy = prim.y, cz = prim.z;
    return { dilated, test: (x, y, z) => {
      p.set(x - cx, y - cy, z - cz).applyMatrix4(m);
      if (Math.abs(p.y) > h / 2) return false;
      const t = (p.y + h / 2) / h;
      const r = rBottom + (rTop - rBottom) * t;
      return p.x * p.x + p.z * p.z <= r * r;
    } };
  }
  if (prim.kind === 'torus') {
    e.set(prim.rx, prim.ry, 0, prim.order);
    q.setFromEuler(e);
    rot.makeRotationFromQuaternion(q);
    inv.copy(rot).invert();
    const m = inv.clone();
    const tube = Math.max(prim.tube, cell / 2);
    if (prim.tube < cell / 2) dilated++;
    const R = prim.radius, cx = prim.x, cy = prim.y, cz = prim.z;
    return { dilated, test: (x, y, z) => {
      p.set(x - cx, y - cy, z - cz).applyMatrix4(m);
      const ring = Math.hypot(p.x, p.y) - R;
      return ring * ring + p.z * p.z <= tube * tube;
    } };
  }
  // convex prism: inside every face plane
  const planes: number[] = [];
  const pos = prim.positions;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 9) {
    a.set(pos[i], pos[i + 1], pos[i + 2]); b.set(pos[i + 3], pos[i + 4], pos[i + 5]); c.set(pos[i + 6], pos[i + 7], pos[i + 8]);
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    planes.push(n.x, n.y, n.z, n.dot(a));
  }
  const eps = cell * 0.35;
  return { dilated, test: (x, y, z) => {
    for (let i = 0; i < planes.length; i += 4) {
      if (planes[i] * x + planes[i + 1] * y + planes[i + 2] * z - planes[i + 3] > eps) return false;
    }
    return true;
  } };
}

function voxelise(prims: SurfacePrimitive[], startCell: number, maxCells: number): Grid {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const prim of prims) {
    const pb = boundsOf(prim);
    b.minX = Math.min(b.minX, pb.minX); b.maxX = Math.max(b.maxX, pb.maxX);
    b.minY = Math.min(b.minY, pb.minY); b.maxY = Math.max(b.maxY, pb.maxY);
    b.minZ = Math.min(b.minZ, pb.minZ); b.maxZ = Math.max(b.maxZ, pb.maxZ);
  }
  let cell = startCell;
  let nx = 0, ny = 0, nz = 0;
  for (;;) {
    nx = Math.ceil((b.maxX - b.minX) / cell) + 2;
    ny = Math.ceil((b.maxY - b.minY) / cell) + 2;
    nz = Math.ceil((b.maxZ - b.minZ) / cell) + 2;
    if (nx * ny * nz <= maxCells) break;
    cell *= 2;
  }
  const minX = b.minX - cell, minY = b.minY - cell, minZ = b.minZ - cell;
  const keys = new Int32Array(nx * ny * nz).fill(EMPTY);
  let dilated = 0;
  // Later primitives win ties (openings are emitted after walls) — but a
  // primitive of a higher layer never overwrites a lower layer's massing cell,
  // so LOD layers stay additive.
  for (const prim of prims) {
    const { test, dilated: d } = insideTest(prim, cell);
    dilated += d;
    const pb = boundsOf(prim);
    const key = packKey(prim.layer, prim.palette, prim.cohort, prim.style);
    const ao = Math.round(prim.ao * 255) & 255;
    const packed = key | ao;
    const i0 = Math.max(0, Math.floor((pb.minX - minX) / cell) - 1), i1 = Math.min(nx - 1, Math.ceil((pb.maxX - minX) / cell) + 1);
    const j0 = Math.max(0, Math.floor((pb.minY - minY) / cell) - 1), j1 = Math.min(ny - 1, Math.ceil((pb.maxY - minY) / cell) + 1);
    const k0 = Math.max(0, Math.floor((pb.minZ - minZ) / cell) - 1), k1 = Math.min(nz - 1, Math.ceil((pb.maxZ - minZ) / cell) + 1);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
      const x = minX + (i + 0.5) * cell, y = minY + (j + 0.5) * cell, z = minZ + (k + 0.5) * cell;
      if (!test(x, y, z)) continue;
      const index = (i * ny + j) * nz + k;
      const existing = keys[index];
      if (existing !== EMPTY && layerOf(existing) < prim.layer) continue;
      keys[index] = packed;
    }
  }
  return { cell, minX, minY, minZ, nx, ny, nz, keys, dilated };
}

interface Buffer { positions: number[]; normals: number[]; uvs: number[]; palette: number[]; cohort: number[]; ao: number[]; style: number[] }
const newBuffer = (): Buffer => ({ positions: [], normals: [], uvs: [], palette: [], cohort: [], ao: [], style: [] });

/** Classic greedy quad merging over each axis and direction (0fps algorithm), with voxel AO per face. */
function greedyMesh(grid: Grid): Map<number, Buffer> {
  const { nx, ny, nz, keys, cell, minX, minY, minZ } = grid;
  const dims = [nx, ny, nz];
  const origin = [minX, minY, minZ];
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? EMPTY : keys[(i * ny + j) * nz + k]);
  const buffers = new Map<number, Buffer>();
  const mask = new Int32Array(Math.max(nx, ny, nz) ** 2);
  const maskAo = new Uint8Array(mask.length);
  const cellPos = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3, v = (d + 2) % 3;
    for (let back = 0; back < 2; back++) {
      const dir = back ? -1 : 1;
      for (let slice = 0; slice < dims[d]; slice++) {
        // build mask
        let n = 0;
        for (let jv = 0; jv < dims[v]; jv++) for (let iu = 0; iu < dims[u]; iu++) {
          cellPos[d] = slice; cellPos[u] = iu; cellPos[v] = jv;
          const here = at(cellPos[0], cellPos[1], cellPos[2]);
          cellPos[d] = slice + dir;
          const neighbour = at(cellPos[0], cellPos[1], cellPos[2]);
          if (here === EMPTY || neighbour !== EMPTY) { mask[n] = EMPTY; maskAo[n] = 0; n++; continue; }
          // voxel AO: occupied cells around the exposed face, in the neighbour slice
          let occluders = 0;
          for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
            if (du === 0 && dv === 0) continue;
            cellPos[d] = slice + dir; cellPos[u] = iu + du; cellPos[v] = jv + dv;
            if (at(cellPos[0], cellPos[1], cellPos[2]) !== EMPTY) occluders++;
          }
          const level = Math.min(3, Math.floor(occluders / 2));
          mask[n] = here & ~255 | ((here & 255) * (1 - level * 0.12)) & 255;
          maskAo[n] = level;
          n++;
        }
        // merge quads
        n = 0;
        for (let jv = 0; jv < dims[v]; jv++) {
          for (let iu = 0; iu < dims[u];) {
            const key = mask[n];
            if (key === EMPTY) { iu++; n++; continue; }
            let w = 1;
            while (iu + w < dims[u] && mask[n + w] === key) w++;
            let h = 1;
            outer: for (; jv + h < dims[v]; h++) {
              for (let k = 0; k < w; k++) if (mask[n + k + h * dims[u]] !== key) break outer;
            }
            emitQuad(buffers, key, d, u, v, dir, slice, iu, jv, w, h, cell, origin);
            for (let hh = 0; hh < h; hh++) for (let ww = 0; ww < w; ww++) mask[n + ww + hh * dims[u]] = EMPTY;
            iu += w; n += w;
          }
        }
      }
    }
  }
  return buffers;
}

function emitQuad(buffers: Map<number, Buffer>, key: number, d: number, u: number, v: number, dir: number, slice: number, iu: number, jv: number, w: number, h: number, cell: number, origin: number[]): void {
  const layer = layerOf(key);
  let buffer = buffers.get(layer);
  if (!buffer) { buffer = newBuffer(); buffers.set(layer, buffer); }
  const base = [0, 0, 0];
  base[d] = origin[d] + (slice + (dir > 0 ? 1 : 0)) * cell;
  base[u] = origin[u] + iu * cell;
  base[v] = origin[v] + jv * cell;
  const du = [0, 0, 0]; du[u] = w * cell;
  const dv = [0, 0, 0]; dv[v] = h * cell;
  const c0 = base;
  const c1 = [base[0] + du[0], base[1] + du[1], base[2] + du[2]];
  const c2 = [base[0] + du[0] + dv[0], base[1] + du[1] + dv[1], base[2] + du[2] + dv[2]];
  const c3 = [base[0] + dv[0], base[1] + dv[1], base[2] + dv[2]];
  const normal = [0, 0, 0]; normal[d] = dir;
  // winding: (u × v) points along +d for even permutations; flip for the back face
  const flip = dir < 0;
  const order = flip ? [c0, c3, c2, c0, c2, c1] : [c0, c1, c2, c0, c2, c3];
  const uvs = flip ? [[0, 0], [0, h], [w, h], [0, 0], [w, h], [w, 0]] : [[0, 0], [w, 0], [w, h], [0, 0], [w, h], [0, h]];
  const ao = (key & 255) / 255;
  for (let i = 0; i < 6; i++) {
    buffer.positions.push(order[i][0], order[i][1], order[i][2]);
    buffer.normals.push(normal[0], normal[1], normal[2]);
    buffer.uvs.push(uvs[i][0], uvs[i][1]);
    buffer.palette.push(paletteOf(key));
    buffer.cohort.push(cohortOf(key));
    buffer.ao.push(ao);
    buffer.style.push(styleOf(key));
  }
}
