import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { EclipseCrowdProps } from '../effects/EclipseCrowdProps';
import { applyPassengerEclipsePose, buildPassenger, SHARED_PASSENGER_GEOMETRY} from './PassengerCrowd';

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

describe('shared figure geometry', () => {
  test('every figure draws the same four shapes, and both arms the same one', () => {
    /**
     * A budget guard, not a style preference. There are thirty-four voxel figures in the
     * city and each one used to build five `BoxGeometry` of its own: 170 geometries out of
     * a budget of 600, from four distinct shapes whose dimensions are literal constants.
     *
     * The count this protects is `renderer.info.memory.geometries`, which rises on a
     * geometry's first bind for rendering and falls only on dispose -- so it is a
     * high-water mark for a session, and 170 of it was being spent on repetition.
     */
    const a = buildPassenger(() => 0.1);
    const b = buildPassenger(() => 0.9);

    for (const part of ['legs', 'body', 'head'] as const) {
      expect(a[part].geometry, `${part} nie jest wspoldzielona miedzy figurkami`).toBe(
        b[part].geometry
      );
    }
    expect(a.leftArm.geometry, 'ramiona jednej figurki nie sa tym samym kształtem').toBe(
      a.rightArm.geometry
    );
    expect(a.leftArm.geometry, 'ramie nie jest wspoldzielone miedzy figurkami').toBe(
      b.rightArm.geometry
    );

    // Cztery kształty na piec meshy, i ani jeden wiecej.
    const kształty = new Set([
      a.legs.geometry, a.body.geometry, a.head.geometry, a.leftArm.geometry, a.rightArm.geometry,
      b.legs.geometry, b.body.geometry, b.head.geometry, b.leftArm.geometry, b.rightArm.geometry,
    ]);
    expect(kształty.size, 'liczba roznych kształtow na dwie figurki').toBe(4);
    for (const g of kształty) expect(SHARED_PASSENGER_GEOMETRY.has(g)).toBe(true);

    // Kolory zostaja per figurka -- wspoldzielenie kształtu nie moze ich zrownac.
    expect(a.materials[0]).not.toBe(b.materials[0]);
  });
});
