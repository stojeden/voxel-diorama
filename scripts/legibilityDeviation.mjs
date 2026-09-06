/**
 * The one legibility result the owner has accepted, and the rule that applies it.
 *
 * Kept in its own module for one reason: a rule this narrow has to be testable without
 * booting a browser, and every boundary of it -- the world, the profile, the shot, the
 * group, the floor -- is a place where an exception could quietly widen into a habit.
 *
 * What was accepted on 2026-09-06 (variant A): the bicycle and the city keep the look that
 * was signed off, and the frame's *luminance* contrast in `postman-side` is an explicit
 * limitation of this version. It is not a pass, and it is not evidence that the object
 * reads well. In that shot the frame renders at RGB 55/0/0 against a road at 8/16/6 -- 47
 * code values apart in red, about 2 apart in luminance -- and this gate weighs luminance
 * only. Nothing occludes it: in the measured conditions city geometry covers 5 of 5 078
 * mask pixels, the voxel world measures the same, so does the bicycle moved along its
 * route, and turning shadow maps off makes the ground darker rather than lighter.
 *
 * The floor is a tolerance for bounded deterioration, NOT a guarantee that every
 * regression is caught: a change that leaves the figure at 27.5% passes through it.
 */
export const ACCEPTED_DEVIATION = {
  world: 'hybrid-direct',
  quality: 'high',
  shot: 'postman-side',
  group: 'frame',
  /** Unchanged for everything, this case included: the case simply does not meet it. */
  gate: 50,
  /** At or above this and below the gate: a deviation. Below it: a failure like any other. */
  floor: 27,
  acceptedOn: '2026-09-06',
  reason: 'wariant A: zachowana estetyka roweru i miasta; bramka wazy sama luminancje',
};

/**
 * PASS, DEVIATION or FAIL for one legibility measurement.
 *
 * The exception covers exactly one (world, quality, shot, group). Another world, another
 * profile, the wheels in the same shot, the frame in another shot -- all of them fail below
 * the gate, because none of them is what was accepted.
 */
export function classifyLegibility({ world, quality, shot, group, separatedPercent }) {
  if (!Number.isFinite(separatedPercent)) {
    throw new Error(`separatedPercent is not a number: ${separatedPercent}`);
  }
  if (separatedPercent >= ACCEPTED_DEVIATION.gate) return 'PASS';
  const covered = world === ACCEPTED_DEVIATION.world
    && quality === ACCEPTED_DEVIATION.quality
    && shot === ACCEPTED_DEVIATION.shot
    && group === ACCEPTED_DEVIATION.group;
  if (!covered) return 'FAIL';
  return separatedPercent >= ACCEPTED_DEVIATION.floor ? 'DEVIATION' : 'FAIL';
}
