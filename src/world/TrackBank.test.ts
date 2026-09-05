import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { generateTrackBank } from './WorldGenerator';
import { GROUND_SURFACE_Y, TRAIN_ROUTE_CURVE, isOnRoad } from './WorldLayout';

/**
 * The track is never left hanging in the air.
 *
 * `generateViaduct` only starts once the route is 1.2 m up, and the ballast bed hangs
 * 0.61 m below the rail head, so every approach has a band where the ballast is above the
 * ground plane with nothing under it. It used to be the strip over the west cross street;
 * putting the rails down on the road moved that band east onto the grass rather than
 * closing it, which is not the same as fixing it.
 */

const BALLAST_UNDERSIDE = 0.61;

describe('the track bank', () => {
  test('fills every stretch where the ballast would otherwise hang', () => {
    const bank = generateTrackBank();
    expect(bank.length).toBeGreaterThan(0);

    /** Bank height at an integer ground cell. */
    const top = new Map<string, number>();
    for (const voxel of bank) {
      const key = `${Math.round(voxel.position.x)},${Math.round(voxel.position.z)}`;
      const height = voxel.scale?.y ?? 1;
      top.set(key, Math.max(top.get(key) ?? -Infinity, voxel.position.y + height / 2));
    }

    const unsupported: string[] = [];
    for (let i = 0; i <= 800; i++) {
      const point = TRAIN_ROUTE_CURVE.getPointAt(i / 800);
      if (point.y >= 1.2) continue;
      const underside = point.y - BALLAST_UNDERSIDE;
      if (underside <= GROUND_SURFACE_Y + 0.05) continue;
      const x = Math.round(point.x);
      const z = Math.round(point.z);
      // The crossing carries itself: there the ballast passes below the asphalt.
      if (isOnRoad(x, z)) continue;
      const supported = top.get(`${x},${z}`);
      if (supported === undefined || supported < underside - 0.2) {
        unsupported.push(`x=${x} z=${z} spód podsypki ${underside.toFixed(2)} nasyp ${supported?.toFixed(2) ?? 'brak'}`);
      }
    }
    expect(unsupported, `tor wisi w ${unsupported.length} miejscach:\n  ${unsupported.slice(0, 8).join('\n  ')}`)
      .toEqual([]);
  });

  test('it is a bank, not a wall: it slopes away either side of the track', () => {
    const bank = generateTrackBank();
    // Group by height so the profile is visible: the tallest cells are the core.
    const heights = bank.map((v) => v.scale?.y ?? 1).sort((a, b) => b - a);
    const tallest = heights[0];
    const shortest = heights[heights.length - 1];
    expect(tallest).toBeGreaterThan(0.2);
    // The outermost cells are a fraction of the core, so the section reads as a slope.
    expect(shortest).toBeLessThan(tallest * 0.5);
  });

  test('it never stands on a road', () => {
    for (const voxel of generateTrackBank()) {
      expect(isOnRoad(Math.round(voxel.position.x), Math.round(voxel.position.z))).toBe(false);
    }
  });

  test('nothing sinks below the ground it stands on', () => {
    for (const voxel of generateTrackBank()) {
      const height = voxel.scale?.y ?? 1;
      expect(voxel.position.y - height / 2).toBeCloseTo(GROUND_SURFACE_Y, 6);
    }
  });
});
