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
 * - **sweep**, about the group's local **Y**, and the smallest of the three for a reason.
 *   The wing is rigid and hinges at the shoulder, so a sweep does not *tuck* the wing along
 *   the flank -- it swings the whole 1.55-unit wing about the shoulder and deposits the
 *   removed span behind the bird. At 55 degrees it put the tip a model unit back, well past
 *   the tail: a second tail rather than a folded wing. So the sweep is now sized by where the
 *   tip lands, not by how much span it removes, and the span scale removes the span. The gull
 *   model faces **-Z** (`Birds.ts` sets
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
 *
 * Neither is a rate limit on a flying bird any more. The fold now begins only once the gull
 * is down (see {@link foldednessTarget}), so its 0.45 s plays out on the roof, where 0.45 s
 * of shuffling is a beat rather than a quarter of a landing.
 */
export const FOLD_SECONDS = 0.45;
export const UNFOLD_SECONDS = 0.25;

/**
 * The folded pose, authored in degrees because that is the unit art direction is written in.
 * Converted exactly once, here, and never read as radians by accident -- see {@link Radians}.
 *
 * Measured on the real merged wing with `Box3.setFromObject(wing, true)` -- `WingFold.test.ts`
 * does the measuring, so these numbers cannot rot, and the `true` is load-bearing: without it
 * the box is the AABB of each child's AABB after rotation, which over-reports a swept wing and
 * is how the first cut published 0.4985 for a rig that was really at 0.4068.
 *
 * The three terms were then re-balanced around the corrected instrument, and around what the
 * sweep actually does to a rigid wing:
 *
 * - **span scale 0.50** does the work. It is the only term that shortens the wing rather than
 *   swinging it, and at the sizes this diorama draws a gull (tens of pixels across the wings)
 *   the span is the only part of the fold a viewer can resolve.
 * - **sweep 16 deg** is sized by where the tip ends up, not by span. It carries the tip to
 *   z = +0.45, which is 0.08 behind the back of the body (z = +0.37) -- the way a gull's
 *   primaries cross its tail. The old 55 deg put it at +1.00, a model unit out behind the
 *   bird, which reads as a tail and not as a tucked wing.
 * - **droop 24 deg** lays the folded wing down the flank rather than holding it out level;
 *   it also trims 0.09 of lateral reach, which is why the sweep does not have to.
 *
 * Measured, on the real rig: the widest lateral point of the wing group falls to **0.5000** of
 * its spread value -- half the span, which is the whole brief -- and the tip's own lateral
 * reach to **0.395**. In world units the wings go from 3.452 across to 1.726, before the
 * 0.87..1.20 per-bird scale. (The old report's 3.47 was the loose box of the same spread wing.)
 */
export const FOLDED_SWEEP_DEG = 16 as Degrees;
export const FOLDED_DROOP_DEG = 24 as Degrees;
export const FOLDED_SPAN_SCALE = 0.5;

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
 * Where a gull in this life mode wants its wings: out, unless it is down.
 *
 * This used to take an `onFinalApproach` flag, and `toRoost` folded once a 6 m distance gate
 * opened. That was wrong in the way that matters -- it is what a gull does *not* do. A real
 * gull on final approach holds its wings out and brakes with them; it draws them in once it
 * is on the roof and settled. And the gate was worse than the idea: the rig's landing law
 * floors at 0.7 m/s, so the last 6 m take about 4.2 s, and on the eclipse path the gate is
 * horizontal while the gull may still have 10 m of altitude to lose. Gulls flew a quarter of
 * a minute, hundreds of frames, beating 41%-span stumps.
 *
 * So there is no gate and no flare term. `roost` folds; everything else is spread, and the
 * braking is what the approach already does -- `Birds` decays the landing speed and lets the
 * altitude down onto the roof, with the wings out the whole way. A flare would be a fourth
 * pose axis with no measurement behind it and nothing asking for it; a gull that keeps its
 * wings out until it is down and then folds them is the whole of the defect, fixed.
 */
export function foldednessTarget(mode: WingLifeMode): number {
  return mode === 'roost' ? 1 : 0;
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
 * Written about the fold's own terms, so it assumes the dihedral it is added to is zero.
 * `tip` is the wing-local position of the outermost vertex, and all three components are
 * needed, because three.js composes the group's Euler in XYZ order: the scale runs first, then
 * the droop about Z, then the sweep about Y. So
 *
 *     x' = (spanScale * x * cos(droop) + y * sin(droop)) * cos(sweep) - z * sin(sweep)
 *
 * and dividing by the spread `x` gives what this returns. The `z` term is the sweep trading
 * span for reach behind the shoulder; the `y` term is the droop rotating the tip's own height
 * into the span axis.
 *
 * That `y` term used to be missing, and the function was documented as agreeing with the rig
 * "to about 0.003". It does not agree to about anything now -- `WingFold.test.ts` holds it to
 * twelve decimal places against the real merged geometry. A closed form that is nearly right
 * is a second instrument that has to be checked, and this file has already shipped one wrong
 * measurement.
 *
 * Both angles are {@link Radians}. That is not decoration: {@link FOLDED_SWEEP_DEG} is 16,
 * which is a perfectly plausible number of radians as far as `Math.cos` is concerned, and
 * the compiler refusing it is the only thing that would notice.
 */
export function foldedSpanFraction(
  sweep: Radians,
  droop: Radians,
  spanScale: number,
  tip: { readonly x: number; readonly y: number; readonly z: number }
): number {
  return (
    (spanScale * Math.cos(droop) + (tip.y / tip.x) * Math.sin(droop)) * Math.cos(sweep) -
    (tip.z / tip.x) * Math.sin(sweep)
  );
}
