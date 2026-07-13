import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Collapses direct, non-animated mesh children into one mesh per material.
 * Source geometry is cloned before transforms are baked, so shared geometry
 * used by animated parts remains untouched.
 */
export function mergeStaticMeshes(
  group: THREE.Group,
  dynamicMeshes: ReadonlySet<THREE.Mesh> = new Set()
): number {
  const buckets = new Map<string, THREE.Mesh[]>();

  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh) || dynamicMeshes.has(child) || Array.isArray(child.material)) continue;
    const key = `${child.material.uuid}:${child.castShadow ? 1 : 0}:${child.receiveShadow ? 1 : 0}:${child.renderOrder}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(child);
    else buckets.set(key, [child]);
  }

  let removedDrawCalls = 0;
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map((mesh) => {
      mesh.updateMatrix();
      return mesh.geometry.clone().applyMatrix4(mesh.matrix);
    });
    const mergedGeometry = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!mergedGeometry) continue;

    mergedGeometry.computeBoundingBox();
    mergedGeometry.computeBoundingSphere();
    const source = meshes[0];
    const material = source.material as THREE.Material;
    const merged = new THREE.Mesh(mergedGeometry, material);
    merged.name = `batched-${material.name || material.type}`;
    merged.castShadow = source.castShadow;
    merged.receiveShadow = source.receiveShadow;
    merged.renderOrder = source.renderOrder;
    group.add(merged);
    for (const mesh of meshes) group.remove(mesh);
    removedDrawCalls += meshes.length - 1;
  }

  return removedDrawCalls;
}
