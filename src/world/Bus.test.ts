import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { createBus } from './Bus';
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
      waitingPassengers: BUS_STOPS.length * 4,
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
      waitingPassengers: BUS_STOPS.length * 4,
      remainingStops: 0,
    });
    bus.dispose();
  });
});
