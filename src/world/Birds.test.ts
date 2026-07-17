import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { BlockConfig } from './WorldLayout';
import {
  ECLIPSE_ROOST_COVERAGE,
  ECLIPSE_TAKE_OFF_COVERAGE,
  Birds,
  eclipseRoostRequested,
  nearestEclipseRoost,
} from './Birds';

describe('eclipse gull roost hysteresis', () => {
  test('commits only during the incoming phase at 85% coverage', () => {
    expect(eclipseRoostRequested(false, ECLIPSE_ROOST_COVERAGE - 0.001, 'increasing')).toBe(false);
    expect(eclipseRoostRequested(false, ECLIPSE_ROOST_COVERAGE, 'increasing')).toBe(true);
    expect(eclipseRoostRequested(false, 1, 'decreasing')).toBe(false);
  });

  test('stays committed after totality until coverage falls to 65%', () => {
    expect(eclipseRoostRequested(true, 0.9, 'decreasing')).toBe(true);
    expect(eclipseRoostRequested(true, ECLIPSE_TAKE_OFF_COVERAGE + 0.001, 'decreasing')).toBe(true);
    expect(eclipseRoostRequested(true, ECLIPSE_TAKE_OFF_COVERAGE, 'decreasing')).toBe(false);
  });

  test('does not chatter when coverage jitters or an invalid sample arrives', () => {
    let requested = eclipseRoostRequested(false, 0.86, 'increasing');
    requested = eclipseRoostRequested(requested, 0.84, 'increasing');
    requested = eclipseRoostRequested(requested, 0.66, 'decreasing');
    requested = eclipseRoostRequested(requested, Number.NaN, 'decreasing');
    expect(requested).toBe(true);
  });
});

describe('eclipse roof selection', () => {
  const blocks: BlockConfig[] = [
    { x: -20, z: -20, w: 8, d: 5, h: 10, accent: 0 },
    { x: 12, z: 8, w: 9, d: 6, h: 14, accent: 0 },
  ];

  test('selects a deterministic point inside the nearest roof', () => {
    const position = { x: 14, z: 10 };
    const first = nearestEclipseRoost(position, 3, blocks);
    const repeated = nearestEclipseRoost(position, 3, blocks);

    expect(first.equals(repeated)).toBe(true);
    expect(first.x).toBeGreaterThan(12);
    expect(first.x).toBeLessThan(20);
    expect(first.z).toBeGreaterThan(8);
    expect(first.z).toBeLessThan(13);
    expect(first.y).toBe(14.55);
  });

  test('spreads gulls across a selected roof without random calls', () => {
    const position = { x: 14, z: 10 };
    const first = nearestEclipseRoost(position, 1, blocks);
    const second = nearestEclipseRoost(position, 2, blocks);
    expect(first.distanceToSquared(second)).toBeGreaterThan(0.01);
  });
});

describe('eclipse flight lifecycle', () => {
  test('flies continuously to nearby roofs, waits, then climbs away', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);

    try {
      birds.update(0, 0, 0, 0);
      const starts = scene.children.map((gull) => gull.position.clone());
      const roosts = starts.map((position, index) => nearestEclipseRoost(position, index));
      let previous = starts.map((position) => position.clone());
      let largestFrameStep = 0;

      birds.setEclipseState(ECLIPSE_ROOST_COVERAGE, 'increasing');
      const delta = 1 / 30;
      for (let frame = 1; frame <= 30 * 45; frame++) {
        birds.update(delta, frame * delta, 0, 0);
        for (let index = 0; index < scene.children.length; index++) {
          largestFrameStep = Math.max(
            largestFrameStep,
            scene.children[index].position.distanceTo(previous[index])
          );
          previous[index].copy(scene.children[index].position);
        }
      }

      expect(largestFrameStep).toBeLessThan(0.3);
      for (let index = 0; index < scene.children.length; index++) {
        const position = scene.children[index].position;
        expect(position.x).toBeCloseTo(roosts[index].x, 4);
        expect(position.z).toBeCloseTo(roosts[index].z, 4);
        expect(position.y).toBeCloseTo(roosts[index].y, 1);
      }

      const restingHeights = scene.children.map((gull) => gull.position.y);
      birds.setEclipseState(ECLIPSE_TAKE_OFF_COVERAGE, 'decreasing');
      for (let frame = 1; frame <= 30; frame++) {
        birds.update(delta, 45 + frame * delta, 0, 0);
      }
      for (let index = 0; index < scene.children.length; index++) {
        expect(scene.children[index].position.y).toBeGreaterThan(restingHeights[index] + 1.5);
      }
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });
});
