import * as THREE from 'three';
import type { Degrees, Radians } from '../units';

/**
 * A gull's wings, folded and spread.
 *
 * A gull at rest draws each wing in against its flank: swept back along the body, tucked
 * a little below the horizontal, and -- because the primaries slide under one another --
 * roughly half as long as it was. At the sizes this diorama draws a gull (tens of pixels
 * across the wings, see `docs`), the span is the only one of the three a viewer can
 * actually resolve; the sweep is what stops the shorter wing reading as a *smaller bird*
 * rather than a tucked one.
 *
 * The wing is a single rigid merged mesh, so there is no joint to bend. The fold is
 * therefore three terms on the wing group, and which axis carries which is a fact about
 * this rig, not a convention:
 *
 * - **sweep**, about the group's local **Y**. The gull model faces **-Z** (`Birds.ts` sets
 *   `rotation.y = heading + PI` for exactly that reason, and the beak sits at z = -0.62),
 *   so sweeping *back* means moving the tip toward **+Z**. The wing segments run along
 *   **±X**, so for the right wing (+X) that is a **negative** rotation about Y, and for the
 *   left wing (-X) a positive one. They are mirror images, not copies.
 * - **droop**, about the group's local **Z**, subtracted from whatever dihedral the caller
 *   wrote. The segments lie along ±X, so a positive rotation about Z lifts the +X tip and
 *   drops the -X one -- which is why flight holds `right.z = +0.18`, `left.z = -0.18` for a
 *   shallow V. Tucking down is therefore *minus* on the right and *plus* on the left.
 * - **spanScale**, on **X** only. X is the span axis (each segment box is 0.62 long in x
 *   and 0.2 deep in z), so scaling x shortens the wing without narrowing its chord. This
 *   is the term that stands in for the primaries sliding under each other, and it is the
 *   term that does most of the work in the silhouette.
 *
 * Everything here is pure: no renderer, no scene, no time. `Birds` owns the state.
 */

/** The life modes the fold cares about; `Birds` owns the machine that moves between them. */
export type WingLifeMode = 'fly' | 'toRoost' | 'roost' | 'takeOff';

/**
 * How long a fold and an unfold take.
 *
 * A gull settles its wings in well under a second -- a shuffle, a shrug, done -- and opens
 * them faster still, because opening is what it does when it wants to be airborne *now*.
 * So the two are deliberately not the same number: 0.45 s closing, 0.25 s opening. Both are
 * long enough to be seen at 60 fps (27 and 15 frames), which is the whole point of the
 * request: the folding and the unfolding are the things to watch, not the end states.
 */
export const FOLD_SECONDS = 0.45;
export const UNFOLD_SECONDS = 0.25;

/**
 * The folded pose, authored in degrees because that is the unit art direction is written in.
 * Converted exactly once, here, and never read as radians by accident -- see {@link Radians}.
 *
 * Measured on the real merged wing (`WingFold.test.ts` does the measuring, so these numbers
 * cannot rot): the widest lateral point of the wing group falls to **0.4985** of its spread
 * value -- half the span, which is the whole brief -- and the tip's own lateral reach to
 * **0.23**, while the tip moves about one model unit behind the shoulder, past the tail,
 * where a folded gull's primaries actually sit. In world units the gull's wings go from
 * 3.47 across to 1.73, before the 0.87..1.20 per-bird scale.
 */
export const FOLDED_SWEEP_DEG = 55 as Degrees;
export const FOLDED_DROOP_DEG = 18 as Degrees;
export const FOLDED_SPAN_SCALE = 0.7;

const FOLDED_SWEEP = THREE.MathUtils.degToRad(FOLDED_SWEEP_DEG) as Radians;
const FOLDED_DROOP = THREE.MathUtils.degToRad(FOLDED_DROOP_DEG) as Radians;

/** A wing's fold, as the three terms the rig can actually apply. */
export interface WingFoldPose {
  /** Sweep back about Y, as a magnitude; the left and right wings take opposite signs. */
  readonly sweep: Radians;
  /** How far the dihedral is tucked down from whatever the caller wrote, as a magnitude. */
  readonly droop: Radians;
  /** Remaining length along the span axis, 1 spread. */
  readonly spanScale: number;
}

/**
 * Where a gull in this life mode wants its wings.
 *
 * `onFinalApproach` is what makes `toRoost` rise "as it settles" rather than the moment the
 * mode changes: a gull crossing half the city toward its roof is still flying, and only
 * starts drawing its wings in over the last few metres.
 */
export function foldednessTarget(mode: WingLifeMode, onFinalApproach: boolean): number {
  if (mode === 'roost') return 1;
  if (mode === 'toRoost') return onFinalApproach ? 1 : 0;
  return 0;
}

/**
 * Within this of an end state, a foldedness *is* that end state.
 *
 * Stepping accumulates: fifteen subtractions of 1/15 land on 1.9e-16, not on zero, so the
 * clamp never fires and the pose spends a frame at a sweep of 1e-31 -- invisible, but it
 * makes `=== 0` arrive a frame late, which is the difference between a rig that is provably
 * spread and one that is merely nearly spread. 1e-9 of a fold cannot move a vertex by a
 * millionth of a pixel, so snapping costs nothing that could ever be seen.
 */
const SETTLED = 1e-9;

/**
 * Moves `current` toward `target` at the rate the direction of travel deserves.
 *
 * Deliberately not a lerp-toward-target ease: that approaches 1 asymptotically and never
 * arrives, so "folded" would be 0.998 and the pose would never be the authored one. This
 * arrives, exactly -- by the clamp, and by {@link SETTLED} for the float dust the clamp
 * cannot see -- so `=== 1` and `=== 0` hold rather than nearly holding.
 */
export function advanceFoldedness(current: number, target: number, delta: number): number {
  if (!Number.isFinite(delta) || delta <= 0) return current;
  const next =
    target > current
      ? Math.min(target, current + delta / FOLD_SECONDS)
      : Math.max(target, current - delta / UNFOLD_SECONDS);
  return Math.abs(target - next) < SETTLED ? target : next;
}

/**
 * The pose at a given foldedness.
 *
 * Smoothstepped, so the wings settle into the folded pose and leave it softly instead of
 * ramping at a constant rate and stopping dead. Smoothstep is monotone and fixes both ends
 * exactly (`0*0*(3-0) = 0`, `1*1*(3-2) = 1`), so foldedness 0 still yields *exactly* the
 * spread pose -- which is what {@link applyWingFold} relies on to leave flight untouched.
 */
export function wingFoldPose(foldedness: number): WingFoldPose {
  const clamped = THREE.MathUtils.clamp(foldedness, 0, 1);
  const eased = clamped * clamped * (3 - 2 * clamped);
  return {
    sweep: (FOLDED_SWEEP * eased) as Radians,
    droop: (FOLDED_DROOP * eased) as Radians,
    spanScale: 1 - (1 - FOLDED_SPAN_SCALE) * eased,
  };
}

/**
 * Applies a fold on top of whatever dihedral the caller has just written to `rotation.z`.
 *
 * Call it once per frame, after the pose it modifies. It reads `rotation.z` and writes it
 * back, so calling it twice on one frame folds twice.
 *
 * The spread branch is load-bearing twice over, and both halves were found by a test.
 *
 * It does not fall through, because a spread wing must come out of here *bit-identical* to
 * what flight wrote and `x + 0` is not always `x`: the first cut wrote
 * `right.rotation.y = -pose.sweep` unconditionally and turned a spread wing's `+0` into `-0`.
 *
 * It does not simply *return*, either, which the second cut did. Returning leaves whatever
 * the last folded frame wrote, and one long frame -- a tab regaining focus, a delta of half a
 * second -- takes foldedness from 1 to 0 in a single step with no intermediate frame to
 * restore anything. The wing would have flown the rest of the day swept back at 0.7 span.
 * So the spread pose is *written*, canonically, and only `rotation.z` is left to its caller.
 */
export function applyWingFold(
  left: THREE.Object3D,
  right: THREE.Object3D,
  pose: WingFoldPose
): void {
  if (pose.sweep === 0 && pose.droop === 0 && pose.spanScale === 1) {
    left.rotation.y = 0;
    right.rotation.y = 0;
    left.scale.x = 1;
    right.scale.x = 1;
    return;
  }
  left.rotation.y = pose.sweep;
  right.rotation.y = -pose.sweep;
  left.rotation.z += pose.droop;
  right.rotation.z -= pose.droop;
  left.scale.x = pose.spanScale;
  right.scale.x = pose.spanScale;
}

/**
 * The share of its lateral reach a wing tip keeps under a fold -- the span number, in closed
 * form, so the figure in the report is derived rather than eyeballed.
 *
 * Written about the fold's own terms, so it assumes the dihedral it is added to is zero;
 * `WingFold.test.ts` checks it against the real merged geometry posed the same way, and the
 * two agree to about 0.003. `tip` is the wing-local position of the outermost vertex: x
 * along the span, z behind the shoulder (the sweep trades one for the other, which is the
 * `tip.z` term and the reason a swept wing loses slightly more span than `cos` alone says).
 *
 * Both angles are {@link Radians}. That is not decoration: {@link FOLDED_SWEEP_DEG} is 55,
 * which is a perfectly plausible number of radians as far as `Math.cos` is concerned, and
 * the compiler refusing it is the only thing that would notice.
 */
export function foldedSpanFraction(
  sweep: Radians,
  droop: Radians,
  spanScale: number,
  tip: { readonly x: number; readonly z: number }
): number {
  return spanScale * Math.cos(droop) * Math.cos(sweep) - (tip.z / tip.x) * Math.sin(sweep);
}
