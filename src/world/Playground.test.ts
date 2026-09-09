import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import {
  PLAYGROUND_DIMENSIONS,
  buildPlayground,
  playgroundLayout,
  playgroundParts,
  slideAngleDegrees,
  slideBedLength,
  swingChainLength,
  swingPeriodSeconds,
} from './Playground';
import { GROUND_SURFACE_Y, PLAYGROUND, STATIC_PROP_FOOTPRINTS } from './WorldLayout';

const plot = STATIC_PROP_FOOTPRINTS.find((footprint) => footprint.id === 'playground')!;

function instanced(group: THREE.Group, name: string): THREE.InstancedMesh {
  const mesh = group.getObjectByName(name);
  if (!(mesh instanceof THREE.InstancedMesh)) throw new Error(`${name} is not instanced`);
  return mesh;
}

/** Where a seat sits right now, read back out of its instance matrix. */
function seatPosition(seats: THREE.InstancedMesh, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  seats.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('playground dimensions', () => {
  test('is built at the sizes a viewer knows by heart', () => {
    // A classic junior slide: platform 1.2-1.5 m, bed at 30-40 degrees.
    expect(PLAYGROUND_DIMENSIONS.slide.platformHeight).toBeGreaterThanOrEqual(1.2);
    expect(slideAngleDegrees()).toBeGreaterThan(30);
    expect(slideAngleDegrees()).toBeLessThan(40);
    expect(slideBedLength()).toBeCloseTo(Math.hypot(1.2, 2.0), 6);
    // A classic swing: beam 2.0-2.4 m, seat about 0.45 m, so the chain follows.
    expect(PLAYGROUND_DIMENSIONS.swing.beamHeight).toBeGreaterThanOrEqual(2);
    expect(PLAYGROUND_DIMENSIONS.swing.beamHeight).toBeLessThanOrEqual(2.4);
    expect(swingChainLength()).toBeCloseTo(1.75, 6);
    // Thin tube means thin: 50 mm frame, thinner chains.
    expect(PLAYGROUND_DIMENSIONS.tubeDiameter).toBeCloseTo(0.05, 6);
    expect(PLAYGROUND_DIMENSIONS.chainDiameter).toBeLessThan(PLAYGROUND_DIMENSIONS.tubeDiameter);
  });

  test('swings at the period its chain gives it, not at a chosen one', () => {
    // Recomputed here rather than imported, so a constant typed over the formula fails.
    const pendulum = 2 * Math.PI * Math.sqrt(swingChainLength() / 9.81);
    expect(swingPeriodSeconds()).toBeCloseTo(pendulum, 9);
    expect(swingPeriodSeconds()).toBeGreaterThan(2.5);
    expect(swingPeriodSeconds()).toBeLessThan(2.8);
  });
});

describe('playground plot', () => {
  test('fits inside the plot the layout already reserves', () => {
    // Not a nicety: `isPlaceableProp` rejects tree candidates within 3.5 m of a reserved
    // plot and the 46 tree positions are generated through it, so a wider plot re-rolls
    // the park. The equipment was sized to the plot instead.
    for (const part of playgroundParts()) {
      expect(part.minX, `${part.id} west`).toBeGreaterThanOrEqual(plot.minX);
      expect(part.maxX, `${part.id} east`).toBeLessThanOrEqual(plot.maxX);
      expect(part.minZ, `${part.id} north`).toBeGreaterThanOrEqual(plot.minZ);
      expect(part.maxZ, `${part.id} south`).toBeLessThanOrEqual(plot.maxZ);
    }
  });

  test('keeps the slide clear of the swings and of their arc', () => {
    const parts = playgroundParts();
    const slide = parts.find((part) => part.id === 'slide')!;
    for (const id of ['swing-frame', 'swing-arc']) {
      const other = parts.find((part) => part.id === id)!;
      const apart =
        slide.maxX < other.minX ||
        slide.minX > other.maxX ||
        slide.maxZ < other.minZ ||
        slide.minZ > other.maxZ;
      expect(apart, `slide overlaps ${id}`).toBe(true);
    }
  });

  test('every solid the builder makes stays inside the declared parts', () => {
    // The footprint and the build read one layout; this proves they still agree.
    const handle = buildPlayground();
    const parts = playgroundParts();
    const bounds = new THREE.Box3();
    for (const child of handle.group.children) {
      const box = new THREE.Box3().setFromObject(child);
      bounds.union(box);
    }
    const hull = {
      minX: Math.min(...parts.map((part) => part.minX)),
      maxX: Math.max(...parts.map((part) => part.maxX)),
      minZ: Math.min(...parts.map((part) => part.minZ)),
      maxZ: Math.max(...parts.map((part) => part.maxZ)),
    };
    // A millimetre of tolerance: instance matrices carry the tube radius as scale.
    expect(bounds.min.x).toBeGreaterThanOrEqual(hull.minX - 0.001);
    expect(bounds.max.x).toBeLessThanOrEqual(hull.maxX + 0.001);
    expect(bounds.min.z).toBeGreaterThanOrEqual(hull.minZ - 0.001);
    expect(bounds.max.z).toBeLessThanOrEqual(hull.maxZ + 0.001);
    handle.dispose();
  });

  test('slopes the bed away from the deck, not towards it', () => {
    // This is here because the tests above all passed while the bed was tilted the wrong
    // way: the far end rose instead of falling, and only the picture showed it. Nothing
    // asserted which end was high, so nothing failed.
    const handle = buildPlayground();
    const layout = playgroundLayout();
    const bed = handle.group.getObjectByName('playground-slide')!;
    bed.updateMatrixWorld(true);
    // The box is a unit cube that the mesh scales to the bed's length, so its own ends
    // are at +/-0.5 and the matrix does the rest.
    const near = new THREE.Vector3(0, 0, -0.5).applyMatrix4(bed.matrixWorld);
    const far = new THREE.Vector3(0, 0, 0.5).applyMatrix4(bed.matrixWorld);
    // The deck is at the low-z end, so the low-z end of the bed is the high one.
    expect(near.z).toBeLessThan(far.z);
    expect(near.y).toBeGreaterThan(far.y);
    // ...and it starts at the deck and finishes on the ground.
    expect(near.y).toBeCloseTo(layout.deckTopY, 1);
    expect(far.y).toBeCloseTo(GROUND_SURFACE_Y, 1);
    expect(near.z).toBeCloseTo(layout.bedStartZ, 2);
    expect(far.z).toBeCloseTo(layout.bedEndZ, 2);
    handle.dispose();
  });

  test('stands on the ground instead of on a plinth', () => {
    // The placeholder's pad sat on a whole voxel, half a metre above the pavement, which
    // is the part that read as an anomaly.
    const handle = buildPlayground();
    const sand = handle.group.getObjectByName('playground-sand')!;
    const box = new THREE.Box3().setFromObject(sand);
    expect(box.min.y).toBeCloseTo(GROUND_SURFACE_Y, 3);
    expect(box.max.y).toBeLessThanOrEqual(GROUND_SURFACE_Y + 0.06);
    handle.dispose();
  });
});

describe('playground swings', () => {
  test('hang still when there is no wind', () => {
    const handle = buildPlayground();
    const seats = instanced(handle.group, 'playground-seats');
    handle.update(0, 0);
    const rest = [seatPosition(seats, 0), seatPosition(seats, 1)];
    for (const elapsed of [0.4, 1.3, 7.9, 214.6]) {
      handle.update(elapsed, 0);
      expect(seatPosition(seats, 0).distanceTo(rest[0])).toBeLessThan(1e-9);
      expect(seatPosition(seats, 1).distanceTo(rest[1])).toBeLessThan(1e-9);
    }
    // ...and they hang directly under the beam, at seat height.
    const layout = playgroundLayout();
    expect(rest[0].y).toBeCloseTo(GROUND_SURFACE_Y + PLAYGROUND_DIMENSIONS.swing.seatHeight, 6);
    expect(rest[0].z).toBeCloseTo(layout.beamZ, 6);
    handle.dispose();
  });

  test('never swings past the arc the plot was measured for', () => {
    const handle = buildPlayground();
    const seats = instanced(handle.group, 'playground-seats');
    const layout = playgroundLayout();
    let furthest = 0;
    // Well past full wind, over several periods, so a clamp that is missing shows up.
    for (let step = 0; step <= 400; step++) {
      handle.update((step / 400) * swingPeriodSeconds() * 3, 9);
      for (const index of [0, 1]) {
        const seat = seatPosition(seats, index);
        furthest = Math.max(furthest, Math.abs(seat.z - layout.beamZ));
        // A seat hangs below its beam whatever the wind does.
        expect(seat.y).toBeLessThan(layout.beamY);
      }
    }
    expect(furthest).toBeLessThanOrEqual(layout.arc + 1e-6);
    // ...and it really does move, or the bound above would be vacuous.
    expect(furthest).toBeGreaterThan(layout.arc * 0.9);
    handle.dispose();
  });

  test('reaches its full lean at the wind the world actually produces', () => {
    // The calibration bug this pins: the amplitude was scaled against a 0..3 wind while
    // `Weather.getWind` returns 0..1, so a rainy day (0.62) leaned the seats 1.2 degrees
    // instead of 3.7 and the swings looked broken rather than calm.
    const handle = buildPlayground();
    const seats = instanced(handle.group, 'playground-seats');
    const layout = playgroundLayout();
    const lean = (wind: number) => {
      let furthest = 0;
      for (let step = 0; step <= 120; step++) {
        handle.update((step / 120) * swingPeriodSeconds(), wind);
        const seat = seatPosition(seats, 0);
        furthest = Math.max(
          furthest,
          (Math.atan2(seat.z - layout.beamZ, layout.beamY - seat.y) * 180) / Math.PI
        );
      }
      return furthest;
    };
    expect(lean(1)).toBeCloseTo(PLAYGROUND_DIMENSIONS.maxSwayDegrees, 1);
    expect(lean(0.5)).toBeCloseTo(PLAYGROUND_DIMENSIONS.maxSwayDegrees / 2, 1);
    // A rainy day in this world: visible, and nothing like a child on the seat.
    expect(lean(0.62)).toBeGreaterThan(3);
    expect(lean(0.62)).toBeLessThan(4.5);
    handle.dispose();
  });

  test('does not move the two seats as one', () => {
    const handle = buildPlayground();
    const seats = instanced(handle.group, 'playground-seats');
    let apart = 0;
    for (let step = 0; step <= 60; step++) {
      handle.update((step / 60) * swingPeriodSeconds(), 3);
      const first = seatPosition(seats, 0).z - playgroundLayout().beamZ;
      const second = seatPosition(seats, 1).z - playgroundLayout().beamZ;
      apart = Math.max(apart, Math.abs(first - second));
    }
    // Same chain, same period: what separates them is phase, and it has to be visible.
    expect(apart).toBeGreaterThan(playgroundLayout().arc * 0.5);
    handle.dispose();
  });
});

describe('playground cost', () => {
  test('draws the whole plot from two geometries', () => {
    // Geometry count is budgeted at 600 and the hybrid city already uses 533.
    const handle = buildPlayground();
    const geometries = new Set<string>();
    for (const child of handle.group.children) {
      if (child instanceof THREE.Mesh) geometries.add(child.geometry.uuid);
    }
    expect(geometries.size).toBe(2);
    expect(handle.group.children.length).toBeLessThanOrEqual(6);
    handle.dispose();
  });

  test('casts no shadow from anything thinner than a shadow texel', () => {
    // The sun's map covers about 0.136 m per texel in a street view, so a 50 mm tube is a
    // third of a texel: the map can only answer with the dashed stair-steps that were
    // reported under the window sills. The deck and the bed are half a metre and do cast.
    const handle = buildPlayground();
    for (const name of ['playground-frame', 'playground-chains', 'playground-seats']) {
      expect(handle.group.getObjectByName(name)!.castShadow, name).toBe(false);
    }
    for (const name of ['playground-deck', 'playground-slide']) {
      expect(handle.group.getObjectByName(name)!.castShadow, name).toBe(true);
    }
    handle.dispose();
  });
});

describe('playground placement', () => {
  test('sits where the layout says the playground is', () => {
    const layout = playgroundLayout();
    expect(layout.beamZ).toBe(PLAYGROUND.z);
    // Swings west of centre, slide east of it, which is what leaves them 1.4 m apart.
    expect(layout.beamCentreX).toBeLessThan(PLAYGROUND.x);
    expect(layout.slideX).toBeGreaterThan(PLAYGROUND.x);
  });
});
