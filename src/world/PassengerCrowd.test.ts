import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { EclipseCrowdProps } from '../effects/EclipseCrowdProps';
import { applyPassengerEclipsePose, buildPassenger } from './PassengerCrowd';

describe('eclipse passenger pose', () => {
  test('looks upward and keeps glasses attached to the head transform', () => {
    const scene = new THREE.Scene();
    const passenger = buildPassenger();
    passenger.group.name = 'station-passenger-Test-0';
    passenger.group.position.set(3, 0.5, -2);
    passenger.group.rotation.y = 0.35;
    for (const material of passenger.materials) material.opacity = 1;
    scene.add(passenger.group);

    applyPassengerEclipsePose(passenger, 'glasses', 1);
    const gaze = new THREE.Vector3(0, 0, 1).applyQuaternion(passenger.head.quaternion);
    expect(gaze.y).toBeGreaterThan(0);

    const props = new EclipseCrowdProps(scene);
    props.update(
      { attention: 1, movementScale: 0.2, eyeProtection: 1, projection: 0, dogAlert: 1 },
      -0.2
    );

    const glasses = scene.getObjectByName('eclipse-crowd-glasses') as THREE.InstancedMesh;
    const actual = new THREE.Matrix4();
    glasses.getMatrixAt(0, actual);
    passenger.head.updateWorldMatrix(true, false);
    const expected = new THREE.Matrix4().multiplyMatrices(
      passenger.head.matrixWorld,
      new THREE.Matrix4().makeTranslation(0, 0, 0.33)
    );
    actual.elements.forEach((value, index) => {
      expect(value).toBeCloseTo(expected.elements[index], 5);
    });

    props.dispose();
    passenger.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    passenger.materials.forEach((material) => material.dispose());
  });
});
