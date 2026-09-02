import * as THREE from 'three';
import type { Cluster, Layer, MaterialClass, SurfacePrimitive } from '../surface';

/** Vertex attributes every strategy must emit — the contract of `HybridMaterial`. */
export const ATTRIBUTES = ['position', 'normal', 'uv', 'aPalette', 'aCohort', 'aAo', 'aStyle'] as const;

export type StrategyName = 'direct' | 'greedy';

export interface StrategyStats {
  name: StrategyName;
  generationMs: number;
  /** Triangles per LOD layer over every material class. */
  triangles: [number, number, number];
  vertices: number;
  /** Bytes of vertex attribute storage. */
  bytes: number;
  extra: Record<string, number>;
}

export interface StrategyResult {
  /** Key `${cls}:${layer}` → non-indexed geometry with the shared attributes. */
  geometries: Map<string, THREE.BufferGeometry>;
  stats: StrategyStats;
}

export type GeometryStrategy = (cluster: Cluster) => StrategyResult;

export function keyOf(cls: MaterialClass, layer: Layer): string {
  return `${cls}:${layer}`;
}

export function parseKey(key: string): { cls: MaterialClass; layer: Layer } {
  const [cls, layer] = key.split(':');
  return { cls: cls as MaterialClass, layer: Number(layer) as Layer };
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Fill the per-vertex semantic attributes of `geometry` from one primitive. */
export function attachAttributes(geometry: THREE.BufferGeometry, prim: SurfacePrimitive): void {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('aPalette', new THREE.BufferAttribute(new Float32Array(count).fill(prim.palette), 1));
  geometry.setAttribute('aCohort', new THREE.BufferAttribute(new Float32Array(count).fill(prim.cohort), 1));
  geometry.setAttribute('aAo', new THREE.BufferAttribute(new Float32Array(count).fill(prim.ao), 1));
  geometry.setAttribute('aStyle', new THREE.BufferAttribute(new Float32Array(count).fill(prim.style), 1));
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
}

export function measure(
  name: StrategyName,
  geometries: Map<string, THREE.BufferGeometry>,
  generationMs: number,
  extra: Record<string, number> = {}
): StrategyStats {
  const triangles: [number, number, number] = [0, 0, 0];
  let vertices = 0;
  let bytes = 0;
  for (const [key, geometry] of geometries) {
    const { layer } = parseKey(key);
    const count = geometry.getAttribute('position').count;
    triangles[layer] += count / 3;
    vertices += count;
    for (const attribute of Object.values(geometry.attributes)) {
      bytes += (attribute as THREE.BufferAttribute).array.byteLength;
    }
  }
  return { name, generationMs, triangles, vertices, bytes, extra };
}
