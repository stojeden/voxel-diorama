import { describe, expect, test } from 'vitest';
import { GROCERY_SHELL } from './grocery';
import {
  GROCERY_CLOSE_HOUR,
  GROCERY_OPEN_HOUR,
  groceryGlow,
  isGroceryOpen,
} from './shopHours';
import { KIOSK_MAIN, KIOSK_RAID, KIOSK_SPECS } from '../WorldLayout';
import { UFO_BEAM } from '../LakesideCow';

/**
 * The grocery, its hours, and the night raid that has to keep working around it.
 *
 * The shop was rebuilt in the accepted language; the alien visit was written against the
 * voxel box it replaced. Nothing about the raid is allowed to end up inside the new
 * building, and the shop's own hours are not the tenement shops' hours.
 */

const HOUR = 1 / 24;

/** The pavilion's solid footprint in world coordinates. */
const shell = (anchor: { x: number; z: number }) => {
  const cx = anchor.x + 1.5;
  const cz = anchor.z + 1;
  const half = GROCERY_SHELL.width / 2 + GROCERY_SHELL.overhang;
  const front = anchor.z + GROCERY_SHELL.frontZ;
  return {
    minX: cx - half,
    maxX: cx + half,
    // The hood is the furthest thing forward; the parapet the furthest back.
    minZ: front - GROCERY_SHELL.hoodReach,
    maxZ: cz + GROCERY_SHELL.depth / 2 + GROCERY_SHELL.overhang,
    top: GROCERY_SHELL.top,
  };
};

const inside = (box: ReturnType<typeof shell>, x: number, z: number) =>
  x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;

describe('the grocery keeps its own hours', () => {
  test('six in the morning to eleven at night, by the clock', () => {
    expect(isGroceryOpen(5.99 * HOUR)).toBe(false);
    expect(isGroceryOpen(GROCERY_OPEN_HOUR * HOUR)).toBe(true);
    expect(isGroceryOpen(12 * HOUR)).toBe(true);
    expect(isGroceryOpen(22.9 * HOUR)).toBe(true);
    expect(isGroceryOpen(GROCERY_CLOSE_HOUR * HOUR)).toBe(false);
    expect(isGroceryOpen(2 * HOUR)).toBe(false);
    // The tenement shops' ten-to-six is not imposed here: the grocery is open at eight
    // in the morning and at ten at night, when they are shut.
    expect(isGroceryOpen(8 * HOUR)).toBe(true);
    expect(isGroceryOpen(22 * HOUR)).toBe(true);
  });

  test('the light inside is on while it is open, and brighter after dark', () => {
    expect(groceryGlow(3 * HOUR, 1)).toBe(0);
    expect(groceryGlow(23.5 * HOUR, 1)).toBe(0);
    const day = groceryGlow(12 * HOUR, 0);
    const night = groceryGlow(22 * HOUR, 1);
    expect(day).toBeGreaterThan(0);
    expect(night).toBeGreaterThan(day * 2);
  });

  test('the same hour gives the same light however it was reached', () => {
    for (const hour of [1, 6, 12, 22.5]) {
      expect(groceryGlow(hour * HOUR + 1, 0.5)).toBeCloseTo(groceryGlow(hour * HOUR, 0.5), 10);
      expect(groceryGlow(hour * HOUR - 4, 0.5)).toBeCloseTo(groceryGlow(hour * HOUR, 0.5), 10);
    }
  });
});

describe('the night raid and the rebuilt shop', () => {
  test('the crate and the beam come down clear of the building', () => {
    const box = shell(KIOSK_MAIN);
    expect(
      inside(box, KIOSK_RAID.x, KIOSK_RAID.z),
      `skrzynka w (${KIOSK_RAID.x}, ${KIOSK_RAID.z}) jest w bryle sklepu`
    ).toBe(false);
    // And the BEAM clears it, not merely the crate. The cone is 2.4 m across at the
    // ground and still two metres across at roof height, so a margin measured from the
    // crate says nothing: this is measured from the widest part of the beam that is as
    // high as the building.
    const radiusAtRoof = UFO_BEAM.groundRadius * (1 - box.top / UFO_BEAM.height);
    const beamEdge = KIOSK_RAID.z + radiusAtRoof;
    expect(
      beamEdge,
      `krawędź stożka na wysokości dachu: z=${beamEdge.toFixed(2)}, okap sklepu: z=${box.minZ.toFixed(2)}`
    ).toBeLessThan(box.minZ);
  });

  test('the crate stands beside the entrance, not in front of the display', () => {
    // The beam clears the building from dead centre too. That is not enough: for the
    // twenty-three hours a day when nothing is being stolen, a crate parked square in
    // front of the windows is just a crate parked in front of the windows.
    const cx = KIOSK_MAIN.x + 1.5;
    const offset = Math.abs(KIOSK_RAID.x - cx);
    expect(offset, `skrzynka ${offset.toFixed(2)} m od osi witryny`).toBeGreaterThan(GROCERY_SHELL.width / 2);
  });

  test('the lift rises past nothing solid', () => {
    // The crate is raised straight up from where it stands, so if its column is clear of
    // the footprint it is clear of the roof, the parapet and the hood as well.
    const box = shell(KIOSK_MAIN);
    for (let y = 0.5; y <= box.top + 1; y += 0.25) {
      expect(inside(box, KIOSK_RAID.x, KIOSK_RAID.z), `y=${y.toFixed(2)}`).toBe(false);
    }
  });

  test('the "ZAMKNIĘTE" barrier stands in front of the shopfront, not in it', () => {
    const box = shell(KIOSK_MAIN);
    const sign = { x: KIOSK_MAIN.x + 2, z: KIOSK_MAIN.z - 1.2 };
    expect(inside(box, sign.x, sign.z)).toBe(false);
    expect(sign.z).toBeLessThan(KIOSK_MAIN.z + GROCERY_SHELL.frontZ);
  });

  test('the shop sign hangs clear of the fascia it names', () => {
    // The generator hangs the canvas sign 0.72 m in front of the anchor; the fascia
    // stands 0.12 m proud of a front wall 0.5 m in front of it. 15 mm of clearance, which
    // is what it used to have, put the sign inside the new fascia.
    const signZ = -0.72;
    const fasciaOuterZ = GROCERY_SHELL.frontZ - 0.12;
    expect(signZ).toBeLessThan(fasciaOuterZ - 0.05);
  });

  test('both kiosks are the same building, so the raid geometry is not a special case', () => {
    expect(KIOSK_SPECS.length).toBe(2);
    for (const spec of KIOSK_SPECS) {
      const box = shell(spec);
      expect(box.maxX - box.minX).toBeCloseTo(GROCERY_SHELL.width + 2 * GROCERY_SHELL.overhang, 6);
    }
  });
});
