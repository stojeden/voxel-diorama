import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createBus } from './Bus';
import { busStopWaitingPositions } from './BusStopNavigation';
import { BUS_STOPS } from './WorldLayout';

const at = (hours: number, minutes = 0) => (hours * 60 + minutes) / (24 * 60);

describe('bus service clock', () => {
  test('keeps stops empty overnight and starts morning distribution at 04:50', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);

    bus.update(1 / 60, 1, false, at(2, 30));
    expect(bus.getServiceDebugState()).toMatchObject({
      mode: 'off',
      visible: false,
      waitingPassengers: 0,
    });

    bus.update(1 / 60, 1, false, at(4, 50));
    expect(bus.getServiceDebugState()).toMatchObject({
      mode: 'morning-release',
      visible: true,
      waitingPassengers: 0,
      remainingStops: BUS_STOPS.length,
    });
    bus.dispose();
  });

  test('marks every stop for collection when the final loop starts', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);

    bus.update(1 / 60, 1, false, at(23, 30));
    expect(bus.getServiceDebugState()).toMatchObject({
      mode: 'final-loop',
      visible: true,
      waitingPassengers: BUS_STOPS.reduce((total, stop) => total + busStopWaitingPositions(stop).length, 0),
      remainingStops: BUS_STOPS.length,
    });
    bus.dispose();
  });

  test('finishes collection before the 04:50 restart window', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    const start = at(23, 30);
    const frame = 1 / 30;
    const availableSeconds = ((5 * 60 + 20) / (24 * 60)) * 240;

    for (let elapsed = 0; elapsed < availableSeconds; elapsed += frame) {
      const t01 = (start + elapsed / 240) % 1;
      bus.update(frame, 1, false, t01);
      if (bus.getServiceDebugState().mode === 'off') break;
    }

    expect(bus.getServiceDebugState()).toMatchObject({
      mode: 'off',
      visible: false,
      waitingPassengers: 0,
      remainingStops: 0,
    });
    bus.dispose();
  });

  test('releases every passenger during the first morning loop', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    const frame = 1 / 30;
    const start = at(2, 30);
    bus.update(frame, 1, false, start);
    bus.update(frame, 1, false, at(4, 50));

    for (let elapsed = 0; elapsed < 100; elapsed += frame) {
      const t01 = (at(4, 50) + elapsed / 240) % 1;
      bus.update(frame, 1, false, t01);
      if (bus.getServiceDebugState().mode === 'normal') break;
    }

    expect(bus.getServiceDebugState()).toMatchObject({
      mode: 'normal',
      visible: true,
      waitingPassengers: BUS_STOPS.reduce((total, stop) => total + busStopWaitingPositions(stop).length, 0),
      remainingStops: 0,
    });
    bus.dispose();
  });
});

describe('bus glazing', () => {
  const relativeLuminance = (color: THREE.Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

  /**
   * The glazing material, found in the built scene rather than taken from the handle,
   * which does not expose it. It is the only material on the bus that asks for more
   * environment reflection than the default, and the test asserts that it is the only
   * one, so the search cannot silently start matching something else.
   */
  const glazingOf = (scene: THREE.Scene): THREE.MeshStandardMaterial => {
    const found = new Set<THREE.MeshStandardMaterial>();
    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.envMapIntensity > 1 && standard.emissive) found.add(standard);
      }
    });
    expect(found.size, 'exactly one bus material is glazing').toBe(1);
    return [...found][0];
  };

  test('is dark glass by day and a lit interior by night', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);

    // Noon: the pane takes its brightness from the sky it reflects, so its own colour
    // is dark and it emits nothing. It used to be the `windowLit` cream with a 0.25
    // emissive on top, which made four flat bright rectangles on a yellow bus.
    bus.update(1 / 60, 0, false, at(12));
    const day = glazingOf(scene);
    expect(day.emissiveIntensity, 'daylight glazing must not glow').toBeCloseTo(0, 5);
    expect(relativeLuminance(day.color), `daylight glass luminance ${relativeLuminance(day.color).toFixed(3)}`)
      .toBeLessThan(0.2);
    // Glass, not chalk: smooth enough to reflect, and reflecting the environment.
    expect(day.roughness).toBeLessThan(0.3);
    expect(day.envMapIntensity).toBeGreaterThan(1);

    // Night: the interior is lit, and it is lit warm -- the emissive is the interior
    // colour, not the colour of the glass. Lerping it from the glass made the night
    // bus glow dark blue.
    bus.update(1 / 60, 1, false, at(22));
    const night = glazingOf(scene);
    expect(night.emissiveIntensity, 'night glazing must glow').toBeGreaterThan(1);
    expect(night.emissive.r, 'a lit interior is warm').toBeGreaterThan(night.emissive.b);
    expect(relativeLuminance(night.emissive)).toBeGreaterThan(0.5);
  });

  test('keeps the cyberpunk look on the glass without unlighting the interior', () => {
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    bus.setCyberLook(1);
    bus.update(1 / 60, 1, false, at(22));
    const material = glazingOf(scene);
    // Cyan pane, cyan interior: blue above red on both, and the interior still emits.
    expect(material.color.b).toBeGreaterThan(material.color.r);
    expect(material.emissive.b).toBeGreaterThan(material.emissive.r);
    expect(material.emissiveIntensity).toBeGreaterThan(1);

    bus.setCyberLook(0);
    bus.update(1 / 60, 1, false, at(22));
    expect(material.emissive.r, 'back to a warm interior').toBeGreaterThan(material.emissive.b);
  });
});
