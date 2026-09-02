import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Cluster, SurfacePrimitive } from '../surface';
import { attachAttributes, keyOf, measure, now, type StrategyResult } from './strategy';

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const euler = new THREE.Euler();
const scale = new THREE.Vector3(1, 1, 1);
const matrix = new THREE.Matrix4();

/**
 * Strategy A — direct surface generation: every primitive becomes the smallest
 * Three.js geometry that represents it exactly, then everything of one material
 * class and LOD layer is merged into a single non-indexed buffer.
 */
export function buildDirect(cluster: Cluster): StrategyResult {
  const t0 = now();
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  for (const prim of cluster.primitives) {
    const geometry = geometryFor(prim);
    attachAttributes(geometry, prim);
    const key = keyOf(prim.cls, prim.layer);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(geometry);
    else buckets.set(key, [geometry]);
  }
  const geometries = new Map<string, THREE.BufferGeometry>();
  for (const [key, parts] of buckets) {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    geometries.set(key, merged);
  }
  return { geometries, stats: measure('direct', geometries, now() - t0, { primitives: cluster.primitives.length }) };
}

function placed(indexed: THREE.BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number, order: THREE.EulerOrder): THREE.BufferGeometry {
  const geometry = indexed.index ? indexed.toNonIndexed() : indexed;
  if (geometry !== indexed) indexed.dispose();
  euler.set(rx, ry, rz, order);
  quaternion.setFromEuler(euler);
  position.set(x, y, z);
  matrix.compose(position, quaternion, scale);
  geometry.applyMatrix4(matrix);
  return geometry;
}

export function geometryFor(prim: SurfacePrimitive): THREE.BufferGeometry {
  switch (prim.kind) {
    case 'box':
      return placed(new THREE.BoxGeometry(prim.w, prim.h, prim.d), prim.x, prim.y, prim.z, prim.rx, prim.ry, prim.rz, prim.order);
    case 'plane':
      return placed(new THREE.PlaneGeometry(prim.w, prim.h), prim.x, prim.y, prim.z, prim.rx, prim.ry, 0, 'XYZ');
    case 'cylinder':
      return placed(new THREE.CylinderGeometry(prim.rTop, prim.rBottom, prim.h, prim.segments), prim.x, prim.y, prim.z, prim.rx, 0, prim.rz, 'XYZ');
    case 'torus':
      return placed(new THREE.TorusGeometry(prim.radius, prim.tube, 8, 20), prim.x, prim.y, prim.z, prim.rx, prim.ry, 0, prim.order);
    case 'prism': {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(prim.positions), 3));
      geometry.computeVertexNormals();
      return geometry;
    }
  }
}
