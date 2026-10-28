import * as THREE from 'three';
import { expect, test } from 'vitest';
import { buildCityModel } from './CityModel';
import { createFarDistricts } from './FarDistricts';

test('per-plot proxies restore original transforms and palettes without shrinking culling bounds', () => {
  const source = buildCityModel().buildings[0];
  const buildings = [
    { ...source, index: 0, cx: 10, cz: 10 },
    { ...source, index: 1, cx: 45, cz: 45, tint: source.tint + 1 },
  ];
  const material = new THREE.MeshBasicMaterial();
  const [district] = createFarDistricts(buildings, material);
  const sphere = district.mesh.boundingSphere!.clone();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  expect(district.mesh.visible).toBe(false);
  district.setBuildingVisible('building-0', true);
  expect(district.visibleBuildings).toBe(1);
  expect(district.mesh.visible).toBe(true);
  district.mesh.getMatrixAt(1, matrix);
  scale.setFromMatrixScale(matrix);
  expect(scale.length()).toBe(0); // The still-cold neighbouring plot does not leak in.
  district.setAllBuildingsVisible(true);
  const original = district.mesh.instanceMatrix.array.slice();
  district.setBuildingVisible('building-0', false);
  expect(district.isBuildingVisible('building-0')).toBe(false);
  expect(district.isBuildingVisible('building-1')).toBe(true);
  expect(district.mesh.visible).toBe(true);
  district.setAllBuildingsVisible(false);
  expect(district.mesh.visible).toBe(false);
  district.setAllBuildingsVisible(true);
  expect(district.mesh.instanceMatrix.array).toEqual(original);
  expect(district.mesh.boundingSphere).toEqual(sphere);
  expect(district.mesh.geometry.getAttribute('aPalette').getX(0)).toBe(buildings[0].tint);
  expect(district.mesh.geometry.getAttribute('aPalette').getX(1)).toBe(buildings[1].tint);
  district.mesh.dispose();
  district.mesh.geometry.dispose();
  material.dispose();
});
