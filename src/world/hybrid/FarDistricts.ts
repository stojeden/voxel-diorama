import * as THREE from 'three';
import { GROUND, type BuildingSpec } from './CityModel';
import { attachAttributes } from './strategies/strategy';

export const FAR_DISTRICT_ENTER = 260;
export const FAR_DISTRICT_EXIT = 220;
export interface FarDistrict {
  id: string;
  buildings: Set<string>;
  center: THREE.Vector3;
  radius: number;
  mesh: THREE.InstancedMesh;
  far: boolean;
  /** Proxy lifetime is independent of the far-distance hysteresis while buffers reload. */
  setBuildingVisible(id: string, visible: boolean): void;
  setAllBuildingsVisible(visible: boolean): void;
  isBuildingVisible(id: string): boolean;
  readonly visibleBuildings: number;
}

/** Spatial cells, not arbitrary build-order groups; skyline envelopes keep each plot. */
export function createFarDistricts(buildings: readonly BuildingSpec[], material: THREE.Material): FarDistrict[] {
  const cells = new Map<string, BuildingSpec[]>();
  for (const b of buildings) {
    const key = `${Math.floor(b.cx / 100)}:${Math.floor(b.cz / 100)}`;
    const cell = cells.get(key) ?? [];
    cell.push(b);
    cells.set(key, cell);
  }
  const districts: FarDistrict[] = [];
  for (const [id, members] of cells) {
    const indexed = new THREE.BoxGeometry(1, 1, 1);
    const geometry = indexed.toNonIndexed();
    indexed.dispose();
    attachAttributes(geometry, { layer: 0, cls: 'opaque', palette: members[0].tint, cohort: -1, style: 0, ao: 1 });
    // A district shares geometry, not a wall colour. Instanced attributes retain each
    // plot's palette index and still respond to the ordinary theme uniforms.
    geometry.setAttribute('aPalette', new THREE.InstancedBufferAttribute(new Float32Array(members.map((b) => b.tint)), 1));
    const mesh = new THREE.InstancedMesh(geometry, material, members.length);
    mesh.name = `hybrid-far-district-${id}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    const bounds = new THREE.Box3();
    const matrix = new THREE.Matrix4();
    const indices = new Map<string, number>();
    members.forEach((b, i) => {
      const height = b.heightMetres + b.roofHeight;
      matrix.makeScale(b.w, height, b.d);
      matrix.setPosition(b.cx, GROUND + height / 2, b.cz);
      mesh.setMatrixAt(i, matrix);
      indices.set(`building-${b.index}`, i);
      bounds.expandByPoint(new THREE.Vector3(b.cx - b.w / 2, GROUND, b.cz - b.d / 2));
      bounds.expandByPoint(new THREE.Vector3(b.cx + b.w / 2, GROUND + height, b.cz + b.d / 2));
    });
    mesh.computeBoundingSphere();
    // Never shrink this bound when proxy slots are hidden: restoring an instance must not
    // require a new bounds scan, and the original district sphere contains every slot.
    const originalMatrices = mesh.instanceMatrix.array.slice();
    const visible = new Set<string>();
    const zeroScale = new THREE.Vector3(0, 0, 0);
    const setBuildingVisible = (buildingId: string, nextVisible: boolean) => {
      const index = indices.get(buildingId);
      if (index === undefined || visible.has(buildingId) === nextVisible) return;
      matrix.fromArray(originalMatrices, index * 16);
      if (nextVisible) visible.add(buildingId);
      else {
        visible.delete(buildingId);
        matrix.scale(zeroScale);
      }
      mesh.setMatrixAt(index, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = visible.size > 0;
    };
    // Initialise hidden slots as well as the object visibility. A later one-plot restore
    // must not accidentally draw every other plot's still-original instance matrix.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < members.length; i++) mesh.setMatrixAt(i, zero);
    mesh.instanceMatrix.needsUpdate = true;
    districts.push({ id, buildings: new Set(members.map((b) => `building-${b.index}`)),
      center: bounds.getCenter(new THREE.Vector3()), radius: bounds.getSize(new THREE.Vector3()).length() / 2,
      mesh, far: false,
      setBuildingVisible,
      setAllBuildingsVisible(nextVisible) {
        for (const buildingId of indices.keys()) setBuildingVisible(buildingId, nextVisible);
      },
      isBuildingVisible: (buildingId) => visible.has(buildingId),
      get visibleBuildings() { return visible.size; },
    });
  }
  return districts;
}
