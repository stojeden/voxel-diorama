import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { ROOST_DIHEDRAL, createWing } from './Birds';
import {
  FOLDED_DROOP_DEG,
  FOLDED_SPAN_SCALE,
  FOLDED_SWEEP_DEG,
  FOLD_SECONDS,
  UNFOLD_SECONDS,
  advanceFoldedness,
  applyWingFold,
  foldedSpanFraction,
  foldednessTarget,
  wingFoldPose,
} from './WingFold';
import { degrees, radians } from '../units.testing';

/**
 * The fold is pure geometry, so all of it is measurable without a renderer: a wing group is
 * an `Object3D` over a merged mesh, and `Box3.setFromObject(object, true)` reads its actual
 * vertices. Every span number in the report comes from here, on the real rig, not from an
 * author's arithmetic.
 *
 * **The second argument is the whole measurement.** Without it `setFromObject` expands the
 * box by each child's *bounding box* transformed by the world matrix -- the AABB of an AABB --
 * which for a wing rotated about Y reports the corners of a box that contains no geometry.
 * The first cut of this file omitted it and published a folded span of 0.4985 of spread; the
 * rig's real figure was 0.4068, and the headline number of the change was an artefact of the
 * instrument. Every `setFromObject` here passes `true`, and one test below measures the two
 * against each other so the argument cannot quietly go away again.
 */

/** One wing, posed as a roosting gull's right wing, shoulder offset included. */
function poseRightWing(foldedness: number, dihedral = ROOST_DIHEDRAL): THREE.Group {
  const right = createWing(1);
  const left = createWing(-1);
  right.position.set(0.18, 0.02, -0.03);
  right.rotation.z = dihedral;
  left.rotation.z = -dihedral;
  applyWingFold(left, right, wingFoldPose(foldedness));
  right.updateMatrixWorld(true);
  return right;
}

/** The widest lateral point of the wing group: what a silhouette is actually as wide as. */
function silhouetteHalfSpan(foldedness: number): number {
  return new THREE.Box3().setFromObject(poseRightWing(foldedness), true).max.x;
}

/** The wing-local position of the outermost vertex of a spread wing. */
function spreadTip(): THREE.Vector3 {
  const wing = createWing(1);
  const mesh = wing.children[0] as THREE.Mesh;
  mesh.updateMatrix();
  const attribute = mesh.geometry.getAttribute('position');
  const tip = new THREE.Vector3(-Infinity, 0, 0);
  const vertex = new THREE.Vector3();
  for (let index = 0; index < attribute.count; index++) {
    vertex.fromBufferAttribute(attribute, index).applyMatrix4(mesh.matrix);
    if (vertex.x > tip.x) tip.copy(vertex);
  }
  return tip;
}

/**
 * The rearmost point of the gull's body -- what "past the tail" is measured against.
 *
 * The model has no separate tail mesh; the body sphere, scaled 1.08 in z, is the back of the
 * bird, and `Birds.createGullMesh` builds it with exactly these numbers.
 */
const TAIL_Z = 0.3672;

describe('a folded wing is materially shorter', () => {
  test('roosting halves the silhouette of the wing', () => {
    const spread = silhouetteHalfSpan(0);
    const folded = silhouetteHalfSpan(1);

    // Sanity: a spread wing reaches about 1.73 units out from the gull's centre line.
    expect(spread).toBeGreaterThan(1.7);
    // Roughly half, which is the signal that survives at a few tens of pixels.
    expect(folded / spread).toBeGreaterThan(0.47);
    expect(folded / spread).toBeLessThan(0.53);
  });

  /**
   * The measurement bug, pinned from the other side.
   *
   * `setFromObject` without `precise` unions each child's *bounding box* after the world
   * matrix -- for a wing swept about Y that box has corners where the wing has none. It is
   * an over-estimate that grows with the sweep, so it flatters exactly the pose being
   * measured, which is how 0.4068 got published as 0.4985.
   */
  test('the loose box over-reports a swept wing, and the reported number is the precise one', () => {
    const folded = poseRightWing(1);
    const loose = new THREE.Box3().setFromObject(folded).max.x;
    const precise = new THREE.Box3().setFromObject(folded, true).max.x;

    expect(loose).toBeGreaterThan(precise);

    // Any rotation at all inflates it, which is why the *spread* figure was wrong too: the
    // published 3.47 units across is the loose box of a wing holding 0.05 of dihedral. Only
    // with the whole rotation gone -- a pure translation -- do the two agree, exactly.
    const level = poseRightWing(0, radians(0));
    expect(new THREE.Box3().setFromObject(level).max.x).toBe(
      new THREE.Box3().setFromObject(level, true).max.x
    );
    const spread = poseRightWing(0);
    expect(new THREE.Box3().setFromObject(spread).max.x).toBeGreaterThan(
      new THREE.Box3().setFromObject(spread, true).max.x
    );
  });

  test('the tip is drawn in and laid along the flank, not carried out behind the tail', () => {
    const tip = spreadTip();
    const folded = poseRightWing(1);
    const moved = tip.clone().applyMatrix4(folded.matrix);

    // Well under half its lateral reach out of the shoulder…
    expect(moved.clone().sub(folded.position).x / tip.x).toBeLessThan(0.45);
    // …and level with the back of the bird, the way a gull's primaries cross its tail --
    // not a model unit out behind it, which is a tail, not a folded wing.
    expect(moved.z).toBeGreaterThan(TAIL_Z - 0.2);
    expect(moved.z).toBeLessThan(TAIL_Z + 0.2);
  });

  test('the closed-form span fraction is the one the rig actually produces, exactly', () => {
    const pose = wingFoldPose(1);
    const tip = spreadTip();
    // Measured with the dihedral held at zero on both sides, which is the fold's own
    // effect and exactly what the closed form is written about.
    const folded = poseRightWing(1, radians(0));
    const spread = poseRightWing(0, radians(0));
    const measured =
      tip.clone().applyMatrix4(folded.matrix).sub(folded.position).x /
      tip.clone().applyMatrix4(spread.matrix).sub(spread.position).x;

    // Not "close to about 0.003", which is what an omitted term looks like from far enough
    // away: the droop rotates the tip's own y into x, and dropping that cost 0.007 of span.
    expect(foldedSpanFraction(pose.sweep, pose.droop, pose.spanScale, tip)).toBeCloseTo(
      measured,
      12
    );
  });
});

describe('foldedness is a continuous term with exact ends', () => {
  /**
   * `toRoost` is the one that matters, and it used to be the defect.
   *
   * A distance gate used to open the fold over the last 6 m of the approach. The last 6 m
   * are not a moment -- the rig's own landing law floors at 0.7 m/s, so they take about
   * 4.2 s -- and on the eclipse path the gate is horizontal, so a gull could be 9 m above
   * its roof and still "arriving". A gull on final approach is flying. Only a gull that is
   * down is not.
   */
  test('the targets are exactly 0 and exactly 1, and only a landed gull folds', () => {
    expect(foldednessTarget('roost')).toBe(1);
    expect(foldednessTarget('toRoost')).toBe(0);
    expect(foldednessTarget('fly')).toBe(0);
    expect(foldednessTarget('takeOff')).toBe(0);
  });

  test('folding arrives at exactly 1 and does not overshoot', () => {
    let folded = 0;
    for (let step = 0; step < 200; step++) folded = advanceFoldedness(folded, 1, 1 / 60);
    expect(folded).toBe(1);
    expect(advanceFoldedness(1, 1, 1 / 60)).toBe(1);
    expect(wingFoldPose(1).spanScale).toBe(FOLDED_SPAN_SCALE);
  });

  test('unfolding arrives at exactly 0 and does not undershoot', () => {
    let folded = 1;
    for (let step = 0; step < 200; step++) folded = advanceFoldedness(folded, 0, 1 / 60);
    expect(folded).toBe(0);
    expect(advanceFoldedness(0, 0, 1 / 60)).toBe(0);
    expect(wingFoldPose(0).spanScale).toBe(1);
    expect(wingFoldPose(0).sweep).toBe(0);
  });

  test('the unfold is quicker than the fold, and both are well under a second', () => {
    expect(UNFOLD_SECONDS).toBeLessThan(FOLD_SECONDS);
    expect(FOLD_SECONDS).toBeLessThan(1);
  });

  test('a take-off unfold is monotone, frame by frame, and never a switch', () => {
    const delta = 1 / 60;
    let folded = 1;
    const samples = [folded];
    for (let frame = 0; frame < 60; frame++) {
      folded = advanceFoldedness(folded, foldednessTarget('takeOff'), delta);
      samples.push(folded);
    }
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1]);
    }
    expect(samples[samples.length - 1]).toBe(0);
    // Seen, not switched: a dozen frames strictly between the two end states.
    expect(samples.filter((value) => value > 0 && value < 1).length).toBeGreaterThan(10);
  });

  test('a fold is monotone too, and slower than the unfold', () => {
    const delta = 1 / 60;
    let folding = 0;
    let unfolding = 1;
    let foldFrames = 0;
    let unfoldFrames = 0;
    while (folding < 1) {
      const next = advanceFoldedness(folding, 1, delta);
      expect(next).toBeGreaterThanOrEqual(folding);
      folding = next;
      foldFrames++;
    }
    while (unfolding > 0) {
      unfolding = advanceFoldedness(unfolding, 0, delta);
      unfoldFrames++;
    }
    expect(foldFrames).toBeGreaterThan(unfoldFrames);
  });
});

describe('a spread wing is left exactly as flight wrote it', () => {
  test('flap and glide poses are untouched at foldedness 0', () => {
    const pose = wingFoldPose(0);
    const left = new THREE.Group();
    const right = new THREE.Group();

    // The two flight poses `Birds.update` writes, at an arbitrary point in each cycle.
    for (const wingAngle of [Math.sin(3.7) * 0.55, -0.12 + Math.sin(1.1) * 0.04]) {
      left.rotation.z = -0.18 + wingAngle;
      right.rotation.z = 0.18 - wingAngle;
      applyWingFold(left, right, pose);
      expect(left.rotation.z).toBe(-0.18 + wingAngle);
      expect(right.rotation.z).toBe(0.18 - wingAngle);
      expect(left.rotation.y).toBe(0);
      expect(right.rotation.y).toBe(0);
      expect(left.scale.x).toBe(1);
      expect(right.scale.x).toBe(1);
    }
  });

  /**
   * Found by tracing an unfold frame by frame rather than by thinking about it.
   *
   * The first cut simply returned early on a spread pose, which leaves whatever the previous
   * frame wrote. At 60 fps the ramp always passes through intermediate frames so the wings
   * looked fine -- but one long frame (a tab regaining focus, a delta of half a second) takes
   * foldedness from 1 to 0 in a single step, and the wing would have stayed swept back at 0.7
   * span for the whole of the rest of the flight.
   */
  test('a spread pose restores the wing exactly, however folded it was a moment ago', () => {
    const left = new THREE.Group();
    const right = new THREE.Group();
    left.rotation.z = -0.18;
    right.rotation.z = 0.18;
    applyWingFold(left, right, wingFoldPose(1));
    expect(right.scale.x).toBe(FOLDED_SPAN_SCALE);

    // One long frame: fully folded to fully spread in a single step.
    const spread = advanceFoldedness(1, 0, 0.5);
    expect(spread).toBe(0);
    left.rotation.z = -0.18;
    right.rotation.z = 0.18;
    applyWingFold(left, right, wingFoldPose(spread));
    expect(left.scale.x).toBe(1);
    expect(right.scale.x).toBe(1);
    expect(left.rotation.y).toBe(0);
    expect(right.rotation.y).toBe(0);
    // Not a negative zero left behind by a mirrored write, either.
    expect(Object.is(right.rotation.y, 0)).toBe(true);
    expect(right.rotation.z).toBe(0.18);
  });

  test('an unfold lands on exactly 0 on the frame it arrives, not the frame after', () => {
    const delta = 1 / 60;
    let folded = 1;
    let frames = 0;
    while (folded > 0 && frames < 100) {
      folded = advanceFoldedness(folded, 0, delta);
      frames++;
    }
    // Fifteen frames of 1/60 s at 0.25 s, and the fifteenth is exactly spread: stepping by
    // 1/15 accumulates to 1.9e-16 rather than to 0, which used to leave one frame at a sweep
    // of 1e-31 and a -0 that nothing ever cleared.
    expect(frames).toBe(Math.round(UNFOLD_SECONDS * 60));
    expect(folded).toBe(0);
  });

  test('a folded wing sweeps back on both sides and tucks down on both sides', () => {
    const pose = wingFoldPose(1);
    const left = new THREE.Group();
    const right = new THREE.Group();
    left.rotation.z = -0.18;
    right.rotation.z = 0.18;
    applyWingFold(left, right, pose);

    // Mirror images: the tips go the same way in the bird's frame, opposite ways in x.
    expect(left.rotation.y).toBe(-right.rotation.y);
    expect(left.rotation.y).toBeGreaterThan(0);
    // Tucked: the dihedral falls on both sides.
    expect(left.rotation.z).toBeGreaterThan(-0.18);
    expect(right.rotation.z).toBeLessThan(0.18);
    expect(left.scale.x).toBe(FOLDED_SPAN_SCALE);
    expect(right.scale.x).toBe(FOLDED_SPAN_SCALE);
  });
});

describe('the fold angles are branded', () => {
  test('a bare number is not an angle, and degrees are not radians', () => {
    const tip = { x: 1.5491, y: 0.0267, z: 0.2859 };
    // @ts-expect-error a bare number does not say which unit the sweep is in
    foldedSpanFraction(0.28, radians(0.42), 0.5, tip);
    // @ts-expect-error the art-direction degrees cannot be handed to the trigonometry
    foldedSpanFraction(FOLDED_SWEEP_DEG, radians(0.42), 0.5, tip);
    // @ts-expect-error nor can the droop, whose 24 is an equally plausible radian count
    foldedSpanFraction(radians(0.28), FOLDED_DROOP_DEG, 0.5, tip);
    // @ts-expect-error and degrees stay degrees however they are built
    foldedSpanFraction(radians(0.28), degrees(24), 0.5, tip);
    // @ts-expect-error the pose carries radians, so its own terms cannot be read as degrees
    const _swept: typeof FOLDED_SWEEP_DEG = wingFoldPose(1).sweep;

    // Converted, it is an ordinary call, and it is the number the pose reports.
    const pose = wingFoldPose(1);
    expect(
      foldedSpanFraction(
        radians(THREE.MathUtils.degToRad(FOLDED_SWEEP_DEG)),
        radians(THREE.MathUtils.degToRad(FOLDED_DROOP_DEG)),
        FOLDED_SPAN_SCALE,
        tip
      )
    ).toBeCloseTo(foldedSpanFraction(pose.sweep, pose.droop, pose.spanScale, tip), 12);
  });
});
