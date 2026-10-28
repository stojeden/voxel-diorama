import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { ActorLocality, ActorLocalitySlot } from './ActorLocality';
import { PassengerCrowd } from '../world/PassengerCrowd';
import { STATION_STOPS, TRAIN_ROUTE_CURVE } from '../world/WorldLayout';
import { createWorldRandom } from '../core/Random';
import { LakeLife } from '../world/LakeLife';

function cameraAt(x: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
  camera.position.set(x, 70, z + 30);
  camera.lookAt(x, 0, z);
  camera.updateMatrixWorld();
  return camera;
}

describe('actor locality presentation only', () => {
  test('near is full rate; mid is 5 Hz; far is 1 Hz; promotion is immediate', () => {
    const slot = new ActorLocalitySlot();
    expect(slot.due(0, 'far')).toBe(true);
    expect(slot.due(0.01, 'far')).toBe(false);
    expect(slot.due(1, 'far')).toBe(true);
    expect(slot.due(1.01, 'mid')).toBe(true);
    expect(slot.due(1.1, 'mid')).toBe(false);
    expect(slot.due(1.21, 'mid')).toBe(true);
    expect(slot.due(1.22, 'near')).toBe(true);
    expect(slot.due(1.23, 'near')).toBe(true);
  });

  test('each cell has independent budget and camera return does not wait for far cadence', () => {
    const locality = new ActorLocality();
    const near = new THREE.Vector3();
    const far = new THREE.Vector3(1000, 0, 1000);
    const a = new ActorLocalitySlot();
    const b = new ActorLocalitySlot();
    const camera = cameraAt(0, 0);
    for (let frame = 0; frame < 3; frame++) {
      locality.beginFrame(camera, 0.016, near);
      expect(locality.shouldPresent(a, near)).toBe(true);
      expect(locality.shouldPresent(b, far)).toBe(frame === 0);
    }
    const returned = cameraAt(1000, 1000);
    locality.beginFrame(returned, 0.016, far);
    expect(locality.shouldPresent(b, far)).toBe(true);
    expect(b.tier).toBe('near');
  });

  test('quality can cap near poses without delaying return from a far tier', () => {
    const locality = new ActorLocality();
    const position = new THREE.Vector3();
    const slot = new ActorLocalitySlot();
    const camera = cameraAt(0, 0);
    locality.beginFrame(camera, 0.01, position, 20);
    expect(locality.shouldPresent(slot, position)).toBe(true);
    locality.beginFrame(camera, 0.01, position, 20);
    expect(locality.shouldPresent(slot, position)).toBe(false);
    const remote = cameraAt(10000, 10000);
    locality.beginFrame(remote, 0.01, remote.position, 20);
    locality.shouldPresent(slot, position);
    locality.beginFrame(camera, 0.01, position, 20);
    expect(locality.shouldPresent(slot, position)).toBe(true);
  });

  test('station sleep and density do not change dwell semantics, opacity or random stream', () => {
    const fullScene = new THREE.Scene();
    const sparseScene = new THREE.Scene();
    const fullRandom = createWorldRandom(934).stream('crowd');
    const sparseRandom = createWorldRandom(934).stream('crowd');
    let fullDraws = 0;
    let sparseDraws = 0;
    const full = new PassengerCrowd(fullScene, () => { fullDraws++; return fullRandom(); });
    const sparse = new PassengerCrowd(sparseScene, () => { sparseDraws++; return sparseRandom(); });
    sparse.setDensity(0.3);
    const locality = new ActorLocality();
    const remote = cameraAt(10000, 10000);
    const focus = new THREE.Vector3(10000, 0, 10000);
    const boarding = new Set<string>();
    for (let frame = 0; frame < 1500; frame++) {
      boarding.clear();
      STATION_STOPS.forEach((stop, index) => {
        if ((frame + index * 120) % 400 < 220) boarding.add(stop.label);
      });
      locality.beginFrame(remote, 1 / 60, focus);
      full.update(1 / 60, boarding);
      sparse.update(1 / 60, boarding, locality);
      const semantic = (crowd: PassengerCrowd) => crowd.getPassengerDebugState().map(
        ({ station, activity, position, opacity, colliding }) => ({ station, activity, position, opacity, colliding })
      );
      expect(semantic(sparse)).toEqual(semantic(full));
    }
    expect(sparseDraws).toBe(fullDraws);
    sparse.setDensity(1);
    boarding.clear();
    for (const stop of STATION_STOPS) {
      const center = TRAIN_ROUTE_CURVE.getPointAt(stop.centerT);
      locality.beginFrame(cameraAt(center.x, center.z), 1 / 60, center);
      full.update(1 / 60, boarding);
      sparse.update(1 / 60, boarding, locality);
      for (const expected of fullScene.children.filter((object) => object.name.startsWith(`station-passenger-${stop.label}-`))) {
        const actual = sparseScene.getObjectByName(expected.name)!;
        expected.traverse((part) => {
          const counterpart = part === expected ? actual : actual.children[expected.children.indexOf(part)];
          if (!counterpart) return;
          expect(counterpart.position.toArray()).toEqual(part.position.toArray());
          expect(counterpart.rotation.toArray()).toEqual(part.rotation.toArray());
          if (part instanceof THREE.Mesh && counterpart instanceof THREE.Mesh) {
            expect((counterpart.material as THREE.Material).opacity).toBe((part.material as THREE.Material).opacity);
          }
        });
      }
    }
    full.dispose();
    sparse.dispose();
  });

  test('fish jumping, landing, freeze and random draws advance identically off camera', () => {
    const aScene = new THREE.Scene();
    const bScene = new THREE.Scene();
    const aRandom = createWorldRandom(77).stream('fish');
    const bRandom = createWorldRandom(77).stream('fish');
    let aDraws = 0;
    let bDraws = 0;
    const a = new LakeLife(aScene, 4, () => { aDraws++; return aRandom(); });
    const b = new LakeLife(bScene, 4, () => { bDraws++; return bRandom(); });
    const locality = new ActorLocality();
    const remote = cameraAt(10000, 10000);
    for (let frame = 0; frame < 4000; frame++) {
      locality.beginFrame(remote, 1 / 60, remote.position);
      const frozen = frame > 1000 && frame < 1500;
      a.update(1 / 60, frozen);
      b.update(1 / 60, frozen, locality);
      expect(bDraws).toBe(aDraws);
      expect(bScene.children.map((object) => object.visible)).toEqual(aScene.children.map((object) => object.visible));
    }
    // Force full presentation upon return; current arcs and rings must match immediately.
    expect(aDraws).toBeGreaterThan(100);
    expect(aScene.children).toHaveLength(8);
    a.update(1 / 60);
    b.update(1 / 60);
    aScene.children.forEach((object, index) => {
      if (!object.visible) return;
      expect(bScene.children[index].position.toArray()).toEqual(object.position.toArray());
      expect(bScene.children[index].rotation.toArray()).toEqual(object.rotation.toArray());
    });
    a.dispose();
    b.dispose();
  });

  test('eclipse turn origins and current poses survive a remote partial-to-totality cycle', () => {
    const fullScene = new THREE.Scene();
    const sparseScene = new THREE.Scene();
    const full = new PassengerCrowd(fullScene, createWorldRandom(9).stream('eclipse'));
    const sparse = new PassengerCrowd(sparseScene, createWorldRandom(9).stream('eclipse'));
    const locality = new ActorLocality();
    const remote = cameraAt(10000, 10000);
    const boarding = new Set(STATION_STOPS.map((stop) => stop.label));
    for (let frame = 0; frame < 600; frame++) {
      const strength = Math.min(1, frame / 240);
      const reaction = {
        attention: strength,
        movementScale: 1 - strength * 0.96,
        eyeProtection: frame < 350 ? strength : 0,
        projection: frame < 350 ? strength : 0,
        dogAlert: strength,
      };
      const gaze = { yaw: -2.1 + frame * 0.0003, elevation: 0.16 };
      full.setEclipseReaction(reaction);
      sparse.setEclipseReaction(reaction);
      full.setSunGaze(gaze);
      sparse.setSunGaze(gaze);
      locality.beginFrame(remote, 1 / 60, remote.position);
      full.update(1 / 60, boarding);
      sparse.update(1 / 60, boarding, locality);
    }
    for (const stop of STATION_STOPS) {
      const center = TRAIN_ROUTE_CURVE.getPointAt(stop.centerT);
      locality.beginFrame(cameraAt(center.x, center.z), 1 / 60, center);
      full.update(1 / 60, boarding);
      sparse.update(1 / 60, boarding, locality);
      for (const expected of fullScene.children.filter((object) => object.name.startsWith(`station-passenger-${stop.label}-`))) {
        const actual = sparseScene.getObjectByName(expected.name)!;
        expect(actual.rotation.toArray()).toEqual(expected.rotation.toArray());
        expected.children.forEach((part, index) => {
          expect(actual.children[index].rotation.toArray()).toEqual(part.rotation.toArray());
        });
      }
    }
    full.dispose();
    sparse.dispose();
  });
});
