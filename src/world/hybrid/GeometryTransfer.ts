import * as THREE from 'three';
import type { StrategyResult, StrategyStats } from './strategies/strategy';

export interface PackedGeometry {
  key: string;
  attributes: Array<{ name: string; itemSize: number; array: Float32Array }>;
}
export interface PackedResult { geometries: PackedGeometry[]; stats: StrategyStats }

/** Worker results own their arrays; no Three.js objects cross the message boundary. */
export function packGeometry(result: StrategyResult): PackedResult {
  const geometries: PackedGeometry[] = [];
  for (const [key, geometry] of result.geometries) {
    geometries.push({ key, attributes: Object.entries(geometry.attributes).map(([name, a]) => ({
      name, itemSize: a.itemSize, array: a.array as Float32Array,
    })) });
    geometry.dispose();
  }
  return { geometries, stats: result.stats };
}
export function transferBuffers(result: PackedResult): ArrayBuffer[] {
  return result.geometries.flatMap((g) => g.attributes.map((a) => a.array.buffer as ArrayBuffer));
}
export function unpackGeometry(packed: PackedGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const a of packed.attributes) geometry.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize));
  geometry.computeBoundingSphere();
  return geometry;
}
