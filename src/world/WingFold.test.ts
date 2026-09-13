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
 * an `Object3D` over a merged mesh, and `Box3.setFromObject` reads its actual vertices. Every
 * span number in the report comes from here, on the real rig, not from an author's arithmetic.
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
  return new THREE.Box3().setFromObject(poseRightWing(foldedness)).max.x;
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

describe('a folded wing is materially shorter', () => {
  test('roosting halves the silhouette of the wing', () => {
    const spread = silhouetteHalfSpan(0);
    const folded = silhouetteHalfSpan(1);

    // Sanity: a spread wing reaches about 1.72 units out from the gull's centre line.
    expect(spread).toBeGreaterThan(1.7);
    // Roughly half, which is the signal that survives at a few tens of pixels.
    expect(folded / spread).toBeGreaterThan(0.44);
    expect(folded / spread).toBeLessThan(0.56);
  });

  test('the tip is drawn in and carried behind the shoulder, not merely shrunk', () => {
    const tip = spreadTip();
    const folded = poseRightWing(1);
    const moved = tip.clone().applyMatrix4(folded.matrix).sub(folded.position);

    // A third of its lateral reach left, and a full model unit behind the shoulder: past
    // the tail, which is where a roosting gull's primaries lie.
    expect(moved.x / tip.x).toBeLessThan(0.35);
    expect(moved.z).toBeGreaterThan(0.9);
  });

  test('the closed-form span fraction is the one the rig actually produces', () => {
    const pose = wingFoldPose(1);
    const tip = spreadTip();
    // Measured with the dihedral held at zero on both sides, which is the fold's own
    // effect and exactly what the closed form is written about.
    const folded = poseRightWing(1, radians(0));
    const spread = poseRightWing(0, radians(0));
    const measured =
      tip.clone().applyMatrix4(folded.matrix).sub(folded.position).x /
      tip.clone().applyMatrix4(spread.matrix).sub(spread.position).x;

    expect(foldedSpanFraction(pose.sweep, pose.droop, pose.spanScale, tip)).toBeCloseTo(
      measured,
      2
    );
  });
});

describe('foldedness is a continuous term with exact ends', () => {
  test('the targets are exactly 0 and exactly 1', () => {
    expect(foldednessTarget('roost', false)).toBe(1);
    expect(foldednessTarget('toRoost', true)).toBe(1);
    expect(foldednessTarget('toRoost', false)).toBe(0);
    expect(foldednessTarget('fly', true)).toBe(0);
    expect(foldednessTarget('takeOff', true)).toBe(0);
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
      folded = advanceFoldedness(folded, foldednessTarget('takeOff', false), delta);
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
    const tip = { x: 1.55, z: 0.29 };
    // @ts-expect-error a bare number does not say which unit the sweep is in
    foldedSpanFraction(0.96, radians(0.31), 0.7, tip);
    // @ts-expect-error the art-direction degrees cannot be handed to the trigonometry
    foldedSpanFraction(FOLDED_SWEEP_DEG, radians(0.31), 0.7, tip);
    // @ts-expect-error nor can the droop, whose 18 is an equally plausible radian count
    foldedSpanFraction(radians(0.96), FOLDED_DROOP_DEG, 0.7, tip);
    // @ts-expect-error and degrees stay degrees however they are built
    foldedSpanFraction(radians(0.96), degrees(18), 0.7, tip);
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
