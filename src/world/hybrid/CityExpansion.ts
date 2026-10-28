import * as THREE from 'three';
import { buildCityModel, type CityModel } from './CityModel';
import { COLORS, GROUND_SURFACE_Y, WORLD_HALF_SIZE, isOnRoad, isOnSidewalk } from '../WorldLayout';

/** Explicit scalability preview. Existing actors/events retain their original identities. */
export function fourDistrictModel(): CityModel {
  const base = buildCityModel();
  const span = WORLD_HALF_SIZE * 2 + 1;
  const stride = Math.max(...base.buildings.map(b => b.index)) + 1;
  const buildings = [...base.buildings];
  const pavement = [...base.pavement];
  const kerbs = [...base.kerbs];
  const forecourt = [...base.forecourt];
  for (const [district, dx, dz] of [[1, span, 0], [2, 0, span], [3, span, span]]) {
    for (const building of base.buildings) buildings.push({ ...building,
      index: building.index + stride * district,
      x: building.x + dx, z: building.z + dz, cx: building.cx + dx, cz: building.cz + dz,
      entrance: building.entrance ? { ...building.entrance } : null,
    });
    for (const cell of base.pavement) pavement.push({ x: cell.x + dx, z: cell.z + dz });
    for (const cell of base.forecourt) forecourt.push({ x: cell.x + dx, z: cell.z + dz });
    for (const kerb of base.kerbs) kerbs.push({ ...kerb, x: kerb.x + dx, z: kerb.z + dz });
  }
  return { ...base, buildings, pavement, kerbs, forecourt };
}

/** Cheap context for the preview districts, without multiplying lights or simulations. */
export function addExpansionGround(scene: THREE.Scene): () => void {
  const group = new THREE.Group();
  group.name = 'scalability-preview-ground';
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const span = WORLD_HALF_SIZE * 2 + 1;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (const [dx, dz] of [[span, 0], [0, span], [span, span]]) {
    const mesh = new THREE.InstancedMesh(geometry, material, span * span);
    let i = 0;
    for (let x = -WORLD_HALF_SIZE; x <= WORLD_HALF_SIZE; x++) {
      for (let z = -WORLD_HALF_SIZE; z <= WORLD_HALF_SIZE; z++) {
        matrix.makeTranslation(x + dx, GROUND_SURFACE_Y - 0.001, z + dz);
        mesh.setMatrixAt(i, matrix);
        color.setHex(isOnRoad(x, z) ? COLORS.road : isOnSidewalk(x, z) ? COLORS.sidewalk : COLORS.grass);
        mesh.setColorAt(i++, color);
      }
    }
    mesh.computeBoundingBox(); mesh.computeBoundingSphere();
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  scene.add(group);
  return () => { group.removeFromParent(); group.traverse(o => { if (o instanceof THREE.InstancedMesh) o.dispose(); }); geometry.dispose(); material.dispose(); };
}
