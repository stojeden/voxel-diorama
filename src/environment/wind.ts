import type { RandomSource } from '../core/Random';
import type { Radians } from '../units';

/**
 * The world's ONE wind, as a bearing that evolves — the fact the trees, the plume and the
 * balloon all answer to.
 *
 * Before this module there were three winds: the foliage shader leaned on a hard-coded
 * (1, 0.55), the chimney plume derived a private bearing from its own pair of sines, and the
 * balloon ignored direction entirely and always drifted west to east. Three things moved
 * independently because nothing tied them together, which is exactly the defect the owner
 * could see. Direction now lives here, once.
 *
 * ## SIGN CONVENTION — read this before using the vector
 *
 * The published vector points the way the wind **BLOWS TOWARD**: it is the direction a
 * weightless parcel of air travels, so a smoke parcel, a bending branch and a balloon all
 * move ALONG it with no sign flip at the call site. It is therefore the OPPOSITE of the
 * meteorological convention, where "a north wind" names where the air comes FROM. Both are
 * defensible; only one can be true here, and this is the one — see {@link WindVector}.
 *
 * ## Why a sum of sines rather than a random walk
 *
 * The bearing has to be reproducible from a seed and a clock, not from the state of a
 * generator nobody can replay: a checkpoint that pins the clock has to pin the wind with it,
 * and a frame-rate-dependent walk would put a different wind on the same second of the same
 * seed. So the bearing is a pure function of elapsed seconds, like the plume's phases are.
 *
 * ## Why the bearing is never wrapped
 *
 * `windBearingAt` returns a FREE-RUNNING angle that may sit outside ±π, and nothing here
 * wraps it. A `wrapPi` inside a swept quantity is what produced this codebase's 343-degree
 * torso snap: the angle is continuous, the wrap is not, and every consumer downstream
 * inherits the discontinuity. Consumers take `cos`/`sin` of it, which do not care how many
 * turns it has accumulated, so there is nothing to wrap for.
 */

/** Per-session bearing offsets, so the wind is not the same one every load. */
export interface WindSeed {
  /** Where this session's wind starts, radians. */
  readonly base: number;
  /** Phase of the slow veer, so two sessions at the same clock are not in step. */
  readonly veerPhase: number;
  /** Phase of the faster swirl riding on the veer. */
  readonly swirlPhase: number;
}

/**
 * The world's wind as one ground-plane fact.
 *
 * `(x, z)` is a UNIT vector pointing the way the wind **BLOWS TOWARD** — downwind, the way
 * the air travels. A north wind (air arriving from the north, i.e. from -z) has `z > 0`.
 */
export interface WindVector {
  /** Downwind component along world +x. Unit vector with {@link WindVector.z}. */
  x: number;
  /** Downwind component along world +z. Called `z`, not `y`: this is a ground-plane vector. */
  z: number;
  /** 0..1 smoothed strength, gust excluded — the same number `Weather.getWind()` returns. */
  strength: number;
  /** The free-running bearing `(x, z)` is the cosine/sine of. Never wrapped; see the header. */
  bearing: Radians;
}

/**
 * The dominant veer: a full swing every 1500 s (25 min), ±0.55 rad (±31°).
 *
 * This is the time constant the brief asked for, and it is chosen from what a VIEWER sees
 * rather than from meteorology. The peak angular rate of this term is 0.55·2π/1500 =
 * 0.0023 rad/s, and the swirl below adds 0.0020, so the slow wind never turns faster than
 * about 0.25°/s — roughly 15° in a minute of watching. Fast enough that a viewer who leaves
 * the diorama running comes back to a different wind; slow enough that within one look it
 * reads as a settled wind rather than a weathervane.
 */
const VEER_RATE = (Math.PI * 2) / 1500;
const VEER_SWING = 0.55;
/** A shorter veer riding on the slow one, so the wind does not trace a clean sinusoid. */
const SWIRL_RATE = (Math.PI * 2) / 560;
const SWIRL_SWING = 0.18;
/**
 * Real gusts veer, so the gust nudges the bearing too — but only by 0.035 rad (2°) at full
 * strength, on the SLOWEST of the gust's three sines. The two faster gust terms (2.3 and
 * 5.1 rad/s) are deliberately left out of the bearing: 2° at 5.1 rad/s is a 0.18 rad/s
 * twitch, which is a weathervane, not a gust. Scaled by strength because a dead calm has no
 * gusts to veer.
 */
const GUST_VEER_SWING = 0.035;
const GUST_VEER_RATE = 0.9;

/** Draw a session's wind offsets. Call once; the bearing after that is clock plus seed. */
export function windSeedFrom(random: RandomSource): WindSeed {
  return {
    base: random() * Math.PI * 2,
    veerPhase: random() * Math.PI * 2,
    swirlPhase: random() * Math.PI * 2,
  };
}

/**
 * The bearing at a moment: pure in `elapsed`, free-running, continuous everywhere.
 *
 * @param elapsed seconds on the world clock
 * @param strength 0..1 smoothed wind strength — only the gust veer reads it
 * @param seed this session's offsets from {@link windSeedFrom}
 */
export function windBearingAt(elapsed: number, strength: number, seed: WindSeed): Radians {
  const gust = Math.min(1, Math.max(0, strength)) * GUST_VEER_SWING;
  return (seed.base
    + VEER_SWING * Math.sin(elapsed * VEER_RATE + seed.veerPhase)
    + SWIRL_SWING * Math.sin(elapsed * SWIRL_RATE + seed.swirlPhase)
    + gust * Math.sin(elapsed * GUST_VEER_RATE + seed.veerPhase)) as Radians;
}
