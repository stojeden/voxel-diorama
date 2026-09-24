import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { BlockConfig } from './WorldLayout';
import {
  ECLIPSE_ROOST_COVERAGE,
  ECLIPSE_TAKE_OFF_COVERAGE,
  Birds,
  ROOST_DIHEDRAL,
  eclipseDirectionFor,
  GULL_SEAT,
  eclipseRoostRequested,
  nearestEclipseRoost,
  voxelRoofs,
} from './Birds';
import { FOLDED_SPAN_SCALE, FOLDED_SWEEP_DEG, UNFOLD_SECONDS } from './WingFold';

describe('a rewound eclipse lets the gulls go', () => {
  test('rewinding mid-totality releases the roost instead of holding it for days', () => {
    // Totality: roosted, and the latch holds through it.
    let roosting = eclipseRoostRequested(false, 1, eclipseDirectionFor(true, 0.4));
    expect(roosting).toBe(true);
    // The tour starts: the timeline is seeked to zero and is no longer running.
    roosting = eclipseRoostRequested(roosting, 0, eclipseDirectionFor(false, 0));
    expect(roosting, 'coverage 0 at progress 0 read as the incoming phase').toBe(false);
  });

  test('a running eclipse still commits on the way in and holds through totality', () => {
    expect(eclipseDirectionFor(true, 0.2)).toBe('increasing');
    expect(eclipseDirectionFor(true, 0.7)).toBe('decreasing');
  });
});

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
  const roofs = voxelRoofs(blocks);

  test('selects a deterministic point inside the nearest roof', () => {
    const position = { x: 14, z: 10 };
    const first = nearestEclipseRoost(position, 3, roofs);
    const repeated = nearestEclipseRoost(position, 3, roofs);

    expect(first.equals(repeated)).toBe(true);
    expect(first.x).toBeGreaterThan(12);
    expect(first.x).toBeLessThan(20);
    expect(first.z).toBeGreaterThan(8);
    expect(first.z).toBeLessThan(13);
    // Sitting on the roof, as height over it: the top voxel layer of an h = 14 block is at 13.5,
    // and the gull's origin is its own seat above that. This pinned 14.55 once -- a metre up.
    expect(first.y - 13.5).toBeCloseTo(GULL_SEAT, 9);
  });

  test('spreads gulls across a selected roof without random calls', () => {
    const position = { x: 14, z: 10 };
    const first = nearestEclipseRoost(position, 1, roofs);
    const second = nearestEclipseRoost(position, 2, roofs);
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
      // Each gull sits on its own belly, and its scale sets how high that is.
      const roosts = starts.map((position, index) =>
        nearestEclipseRoost(position, index, undefined, GULL_SEAT * scene.children[index].scale.y)
      );
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

/** The two wing groups of a gull, which survive `mergeStaticMeshes` because they are Groups. */
function wingsOf(gull: THREE.Object3D): { left: THREE.Object3D; right: THREE.Object3D } {
  const wings = gull.children.filter((child) => (child as THREE.Group).isGroup);
  expect(wings).toHaveLength(2);
  const [left, right] = wings.sort((a, b) => a.position.x - b.position.x);
  return { left, right };
}

/**
 * A gull is spread if its wings are exactly as flight wrote them. `scale.x` is the fold's
 * own term and flight never touches it, so `=== 1` is the whole test: not "nearly 1".
 */
function isSpread(gull: THREE.Object3D): boolean {
  const { left, right } = wingsOf(gull);
  return left.scale.x === 1 && right.scale.x === 1;
}

describe('a gull flies its final approach with its wings out', () => {
  /**
   * The assertion whose absence let the fold ship.
   *
   * The first cut folded on a 6 m horizontal gate, rate-limited by 0.45 s -- but the last
   * 6 m are not 0.45 s long. The rig's own landing law,
   * `min(speed, max(0.7, distance * 0.65))`, decays exponentially and then floors at
   * 0.7 m/s, so the last 6 m take about 4.2 s at every speed in the rig. Before the fix this
   * test counted 244 frames of the first gull beating folded stumps on its way down, and the
   * worst eclipse gull was folded 10.2 m above its roof and 5.9 m short of it. On the eclipse
   * path it is worse than on the night one, because the gate is
   * horizontal and the roof is chosen by horizontal distance, so a gull opens the gate with
   * most of its altitude still to lose.
   *
   * So this simulates the landing the rig actually flies, frame by frame, and asks on every
   * frame of every gull: does this bird still have anywhere to go? Then it may not be folded.
   */
  test('no gull folds while it still has distance or altitude between it and its roof', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);
    const delta = 1 / 60;

    try {
      birds.update(0, 0, 0, 0);
      const roosts = scene.children.map((gull, index) =>
        nearestEclipseRoost(gull.position, index, undefined, GULL_SEAT * gull.scale.y)
      );
      birds.setEclipseState(ECLIPSE_ROOST_COVERAGE, 'increasing');

      // The worst violation, kept rather than the first, so the failure says how bad it is.
      let worst: {
        frame: number;
        gull: number;
        metresAboveRoof: number;
        metresFromRoof: number;
        spanScale: number;
      } | null = null;

      for (let frame = 1; frame <= 60 * 45; frame++) {
        birds.update(delta, frame * delta, 0, 0);
        for (let index = 0; index < scene.children.length; index++) {
          const gull = scene.children[index];
          const roost = roosts[index];
          const metresFromRoof = Math.hypot(gull.position.x - roost.x, gull.position.z - roost.z);
          const metresAboveRoof = gull.position.y - roost.y;
          // 0.05 is the roosting breathing amplitude (0.02) with room to spare: below it the
          // gull is sitting on the roof, and sitting is when it is allowed to fold.
          const airborne = metresFromRoof > 0.05 || metresAboveRoof > 0.05;
          if (!airborne || isSpread(gull)) continue;
          if (worst === null || metresAboveRoof > worst.metresAboveRoof) {
            worst = {
              frame,
              gull: index,
              metresAboveRoof,
              metresFromRoof,
              spanScale: wingsOf(gull).right.scale.x,
            };
          }
        }
      }

      expect(worst).toBeNull();
      // …and the fold does still happen, once they are down.
      for (const gull of scene.children) {
        expect(wingsOf(gull).right.scale.x).toBe(FOLDED_SPAN_SCALE);
      }
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });

  /** The same question on the night path, where the roost is wherever the gull settled. */
  test('the night landing is flown spread too, right down to the roof', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);
    const delta = 1 / 60;

    try {
      const track: { position: THREE.Vector3; spread: boolean }[][] = scene.children.map(() => []);
      for (let frame = 1; frame <= 60 * 90; frame++) {
        birds.update(delta, frame * delta, 0, 1);
        for (let index = 0; index < scene.children.length; index++) {
          track[index].push({
            position: scene.children[index].position.clone(),
            spread: isSpread(scene.children[index]),
          });
        }
      }

      for (let index = 0; index < scene.children.length; index++) {
        const roost = scene.children[index].position;
        expect(wingsOf(scene.children[index]).right.scale.x).toBe(FOLDED_SPAN_SCALE);
        const foldedAirborne = track[index].filter(
          (sample) =>
            !sample.spread &&
            (Math.hypot(sample.position.x - roost.x, sample.position.z - roost.z) > 0.05 ||
              sample.position.y - roost.y > 0.05)
        );
        expect({ gull: index, framesFoldedInFlight: foldedAirborne.length }).toEqual({
          gull: index,
          framesFoldedInFlight: 0,
        });
      }
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });
});

describe('gulls fold their wings to roost and spread them to fly', () => {
  test('a flying gull is exactly spread, a settled one is folded and swept', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);
    const delta = 1 / 60;

    try {
      birds.update(delta, delta, 0, 0);
      for (const gull of scene.children) {
        const { left, right } = wingsOf(gull);
        // Flight is untouched by the fold: not 0.9999, not -0, exactly what flight wrote.
        expect(left.scale.x).toBe(1);
        expect(right.scale.x).toBe(1);
        expect(left.rotation.y).toBe(0);
        expect(right.rotation.y).toBe(0);
      }

      birds.setEclipseState(ECLIPSE_ROOST_COVERAGE, 'increasing');
      for (let frame = 1; frame <= 60 * 45; frame++) birds.update(delta, frame * delta, 0, 0);

      for (const gull of scene.children) {
        const { left, right } = wingsOf(gull);
        expect(left.scale.x).toBe(FOLDED_SPAN_SCALE);
        expect(right.scale.x).toBe(FOLDED_SPAN_SCALE);
        // Swept back: mirrored about the bird's own centre line, tips toward the tail (+z),
        // by the authored angle and no more -- the sweep is what carries the tip behind the
        // bird, so the rig holding more of it than art direction wrote is a defect.
        expect(left.rotation.y).toBeCloseTo(THREE.MathUtils.degToRad(FOLDED_SWEEP_DEG), 12);
        expect(left.rotation.y).toBeGreaterThan(0);
        expect(right.rotation.y).toBe(-left.rotation.y);
        // Tucked below the settled dihedral rather than held in the roosting V.
        expect(right.rotation.z).toBeLessThan(ROOST_DIHEDRAL);
        expect(left.rotation.z).toBeGreaterThan(-ROOST_DIHEDRAL);
      }
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });

  test('the unfold leads the climb: wings open in the first tenth of the take-off', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);
    const delta = 1 / 60;

    try {
      birds.update(delta, delta, 0, 0);
      birds.setEclipseState(ECLIPSE_ROOST_COVERAGE, 'increasing');
      for (let frame = 1; frame <= 60 * 45; frame++) birds.update(delta, frame * delta, 0, 0);

      const gull = scene.children[0];
      const { right } = wingsOf(gull);
      const restingHeight = gull.position.y;
      expect(right.scale.x).toBe(FOLDED_SPAN_SCALE);

      birds.setEclipseState(ECLIPSE_TAKE_OFF_COVERAGE, 'decreasing');
      let spreadFrame = -1;
      let spreadHeight = restingHeight;
      const spans: number[] = [];
      for (let frame = 1; frame <= 60 * 4; frame++) {
        birds.update(delta, 45 + frame * delta, 0, 0);
        spans.push(right.scale.x);
        if (spreadFrame < 0 && right.scale.x === 1) {
          spreadFrame = frame;
          spreadHeight = gull.position.y;
        }
      }

      // The unfold is monotone and takes the time it says it takes.
      for (let index = 1; index < spans.length; index++) {
        expect(spans[index]).toBeGreaterThanOrEqual(spans[index - 1]);
      }
      expect(spreadFrame).toBeGreaterThan(0);
      expect(spreadFrame * delta).toBeCloseTo(UNFOLD_SECONDS, 1);

      // …and by the time they are open the gull has barely left the roof: the wings lead.
      const climbed = spreadHeight - restingHeight;
      const totalClimb = gull.position.y - restingHeight;
      expect(climbed).toBeGreaterThan(0);
      expect(climbed / totalClimb).toBeLessThan(0.15);
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });

  /**
   * The commonest exit, and the one that had no take-off at all.
   *
   * Dawn used to go `roost` -> `fly` directly, so on the very next frame the gull was under
   * full cruise speed and full climb rate with its wings still shut -- the unfold was over
   * by the time anyone could connect it to the launch. The owner's sentence is "rozwijają je
   * do lotu, jak startują": the unfold *is* the take-off, and on this path it never was one.
   */
  test('the dawn wake-up is a take-off: the wings open before the gull leaves the roof', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const scene = new THREE.Scene();
    const birds = new Birds(scene);
    const delta = 1 / 60;

    try {
      for (let frame = 1; frame <= 60 * 90; frame++) birds.update(delta, frame * delta, 0, 1);

      const gull = scene.children[0];
      const { right } = wingsOf(gull);
      expect(right.scale.x).toBe(FOLDED_SPAN_SCALE);
      const perch = gull.position.clone();
      // What a cruising gull covers in one frame, from the rig's own speed law with
      // `Math.random` pinned at 0.5: 4.2 + 0.5 * 2.4 m/s.
      const cruiseStep = (4.2 + 0.5 * 2.4) * delta;

      birds.update(delta, 90 + delta, 0, 0);
      const firstStep = Math.hypot(gull.position.x - perch.x, gull.position.z - perch.z);
      // A bird with its wings shut is not doing 5.4 m/s. It has barely pushed off.
      expect(firstStep).toBeLessThan(cruiseStep * 0.15);

      let spreadFrame = -1;
      let spreadHeight = perch.y;
      let highest = perch.y;
      for (let frame = 2; frame <= 60 * 6; frame++) {
        birds.update(delta, 90 + frame * delta, 0, 0);
        highest = Math.max(highest, gull.position.y);
        if (spreadFrame < 0 && right.scale.x === 1) {
          spreadFrame = frame;
          spreadHeight = gull.position.y;
        }
      }

      // Open within the unfold's own quarter second, and by then hardly off the roof: the
      // same lead the eclipse exit has, because it is now the same code.
      expect(spreadFrame).toBeGreaterThan(0);
      expect(spreadFrame * delta).toBeCloseTo(UNFOLD_SECONDS, 1);
      expect(spreadHeight - perch.y).toBeGreaterThan(0);
      expect((spreadHeight - perch.y) / (highest - perch.y)).toBeLessThan(0.15);
      // And it does leave: a take-off that never climbs away is not a take-off either. The
      // highest point, not the last frame's: having reached its take-off clearance the gull
      // settles to whatever cruising height it drew, which may be lower.
      expect(highest).toBeGreaterThan(perch.y + 5);
    } finally {
      birds.dispose();
      random.mockRestore();
    }
  });
});
