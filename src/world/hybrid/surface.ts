/**
 * Semantic surface primitives: the only input both geometry strategies see.
 * Every primitive carries its LOD layer, material class, palette index, window
 * cohort, shader style and a baked ambient-occlusion factor.
 */
export type Layer = 0 | 1 | 2;
export type MaterialClass = 'opaque' | 'glass' | 'glassClear' | 'glow';
export type EulerOrder = 'XYZ' | 'YXZ';

export interface PrimitiveBase {
  layer: Layer;
  cls: MaterialClass;
  palette: number;
  cohort: number;
  style: number;
  ao: number;
}

export interface BoxPrim extends PrimitiveBase {
  kind: 'box';
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  rx: number; ry: number; rz: number;
  order: EulerOrder;
}

export interface PlanePrim extends PrimitiveBase {
  kind: 'plane';
  x: number; y: number; z: number;
  w: number; h: number;
  rx: number; ry: number;
}

/** Convex solid given as an outward-facing triangle soup in world space. */
export interface PrismPrim extends PrimitiveBase {
  kind: 'prism';
  positions: Float32Array;
}

export interface CylinderPrim extends PrimitiveBase {
  kind: 'cylinder';
  x: number; y: number; z: number;
  rTop: number; rBottom: number; h: number; segments: number;
  rx: number; rz: number;
}

export interface TorusPrim extends PrimitiveBase {
  kind: 'torus';
  x: number; y: number; z: number;
  radius: number; tube: number;
  rx: number; ry: number;
  order: EulerOrder;
}

export type SurfacePrimitive = BoxPrim | PlanePrim | PrismPrim | CylinderPrim | TorusPrim;

export interface Cluster {
  id: string;
  center: [number, number, number];
  radius: number;
  primitives: SurfacePrimitive[];
}

export interface PrimOptions {
  layer?: Layer;
  cls?: MaterialClass;
  cohort?: number;
  style?: number;
  ao?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  order?: EulerOrder;
}

function base(o: PrimOptions): PrimitiveBase {
  return { layer: o.layer ?? 0, cls: o.cls ?? 'opaque', palette: 0, cohort: o.cohort ?? -1, style: o.style ?? 0, ao: o.ao ?? 1 };
}

/** Accumulates primitives for one cluster. */
export class Emitter {
  readonly primitives: SurfacePrimitive[] = [];

  box(palette: number, x: number, y: number, z: number, w: number, h: number, d: number, o: PrimOptions = {}): void {
    this.primitives.push({ ...base(o), kind: 'box', palette, x, y, z, w, h, d, rx: o.rx ?? 0, ry: o.ry ?? 0, rz: o.rz ?? 0, order: o.order ?? 'XYZ' });
  }

  plane(palette: number, x: number, y: number, z: number, w: number, h: number, o: PrimOptions = {}): void {
    this.primitives.push({ ...base(o), kind: 'plane', palette, x, y, z, w, h, rx: o.rx ?? 0, ry: o.ry ?? 0 });
  }

  cylinder(palette: number, x: number, y: number, z: number, rTop: number, rBottom: number, h: number, segments: number, o: PrimOptions = {}): void {
    this.primitives.push({ ...base(o), kind: 'cylinder', palette, x, y, z, rTop, rBottom, h, segments, rx: o.rx ?? 0, rz: o.rz ?? 0 });
  }

  torus(palette: number, x: number, y: number, z: number, radius: number, tube: number, o: PrimOptions = {}): void {
    this.primitives.push({ ...base(o), kind: 'torus', palette, x, y, z, radius, tube, rx: o.rx ?? 0, ry: o.ry ?? 0, order: o.order ?? 'XYZ' });
  }

  prism(palette: number, positions: Float32Array, o: PrimOptions = {}): void {
    this.primitives.push({ ...base(o), kind: 'prism', palette, positions });
  }

  cluster(id: string, center: [number, number, number], radius: number): Cluster {
    return { id, center, radius, primitives: this.primitives };
  }
}

type V = [number, number, number];
const quad = (a: V, b: V, c: V, d: V): V[] => [a, b, c, a, c, d];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Orient every triangle outward from `center`, then place the local solid in
 * the world. `rotate` swaps the footprint axes (ridge along z instead of x).
 */
function orient(tris: V[], center: V, cx: number, y: number, cz: number, rotate: boolean): Float32Array {
  const out = new Float32Array(tris.length * 3);
  for (let t = 0; t < tris.length; t += 3) {
    let a = tris[t];
    let b = tris[t + 1];
    let c = tris[t + 2];
    const n = cross(sub(b, a), sub(c, a));
    const mid: V = [(a[0] + b[0] + c[0]) / 3 - center[0], (a[1] + b[1] + c[1]) / 3 - center[1], (a[2] + b[2] + c[2]) / 3 - center[2]];
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0) [b, c] = [c, b];
    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const v = verts[k];
      const px = rotate ? v[2] : v[0];
      const pz = rotate ? -v[0] : v[2];
      out[(t + k) * 3] = cx + px;
      out[(t + k) * 3 + 1] = y + v[1];
      out[(t + k) * 3 + 2] = cz + pz;
    }
  }
  return out;
}

/** Hip roof over a w×d footprint: ridge along x of length `ridge`, eaves overhang `ov`. */
export function hipRoofPositions(cx: number, y: number, cz: number, w: number, d: number, h: number, ridge: number, ov: number, rotate: boolean): Float32Array {
  const W = w / 2 + ov;
  const D = d / 2 + ov;
  const r = Math.max(0, ridge) / 2;
  const A: V = [-W, 0, -D], B: V = [W, 0, -D], C: V = [W, 0, D], Dd: V = [-W, 0, D], R1: V = [-r, h, 0], R2: V = [r, h, 0];
  const tris: V[] = [...quad(Dd, C, R2, R1), ...quad(A, B, R2, R1), B, C, R2, A, Dd, R1, ...quad(A, B, C, Dd)];
  return orient(tris, [0, h * 0.3, 0], cx, y, cz, rotate);
}

/** Gable roof (ridge along x) including its two vertical gable triangles. */
export function gableRoofPositions(cx: number, y: number, cz: number, w: number, d: number, h: number, ov: number, rotate: boolean): Float32Array {
  const W = w / 2 + ov;
  const D = d / 2 + ov;
  const A: V = [-W, 0, -D], B: V = [W, 0, -D], C: V = [W, 0, D], Dd: V = [-W, 0, D], R1: V = [-W, h, 0], R2: V = [W, h, 0];
  const tris: V[] = [...quad(Dd, C, R2, R1), ...quad(A, B, R2, R1), ...quad(A, B, C, Dd), A, Dd, R1, B, C, R2];
  return orient(tris, [0, h * 0.3, 0], cx, y, cz, rotate);
}

/** Count triangles of a cluster for quick budget checks in tests. */
export function estimateTriangles(primitives: SurfacePrimitive[]): number {
  let total = 0;
  for (const p of primitives) {
    if (p.kind === 'box') total += 12;
    else if (p.kind === 'plane') total += 2;
    else if (p.kind === 'prism') total += p.positions.length / 9;
    else if (p.kind === 'cylinder') total += p.segments * 4;
    else total += 8 * 20 * 2;
  }
  return total;
}
