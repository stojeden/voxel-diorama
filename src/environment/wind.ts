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
 * The bearing has to be reproducible from a clock and a seed, not from the state of a
 * generator nobody can replay: a frame-rate-dependent walk would put a different wind on the
 * same second of the same seed. So the bearing is a pure function of elapsed seconds, like
 * the plume's phases are.
 *
 * ## WHICH clock, exactly
 *
 * `elapsed` is the seconds `Weather` has accumulated on the PRESENTATION clock — the delta a
 * checkpoint lock freezes to zero, which is not the same thing as wall time since page load.
 * This header used to claim that a checkpoint pinning the clock pinned the wind with it. It
 * did not: a checkpoint lock only STOPPED this clock wherever it had already got to, and no
 * checkpoint path ever set it, so the same checkpoint froze one wind on a fresh load and a
 * different one after a minute of watching.
 *
 * It is true now, and by construction rather than by luck: `Weather.pinClock` puts the clock
 * on a stated second, and a booting checkpoint calls it with `CHECKPOINT_WIND_CLOCK`. The
 * storm phase that comes next hangs off this same clock, so seeking it is a `pinClock` call,
 * not an offset to wall time that nothing can reach.
 *
 * ## Why the bearing is never wrapped
 *
 * `windBearingAt` returns a FREE-RUNNING angle that may sit outside ±π, and nothing here
 * wraps it. A `wrapPi` inside a swept quantity is what produced this codebase's 343-degree
 * torso snap: the angle is continuous, the wrap is not, and every consumer downstream
 * inherits the discontinuity. Consumers take `cos`/`sin` of it, which do not care how many
 * turns it has accumulated, so there is nothing to wrap for.
 */

/**
 * A session's wind: one AUTHORED anchor plus two drawn phases.
 *
 * The fields are `Radians`, not `number`. They are angles — their own comments said so while
 * their type did not, which is the exact shape `src/units.ts` exists to stop.
 */
export interface WindSeed {
  /** The anchor the veer swings about. Authored; see {@link WIND_BASE_BEARING}. */
  readonly base: Radians;
  /** Phase of the slow veer, so two sessions at the same clock are not in step. */
  readonly veerPhase: Radians;
  /** Phase of the faster swirl riding on the veer. */
  readonly swirlPhase: Radians;
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

/**
 * Half the width of the ONLY wedge this wind ever occupies: 0.765 rad, 43.8 degrees.
 *
 * `windBearingAt` is an authored base plus three BOUNDED sines, so the reachable set of
 * bearings is `base ± (VEER_SWING + SWIRL_SWING + GUST_VEER_SWING)` — 87.7 degrees wide — for
 * every seed, every strength and every clock. Sampling a day of every one of sixty seeds at
 * both strength extremes reaches -83.8° to +3.8°, which is that arithmetic within 0.05°.
 *
 * Exported because it is the number that decides whether {@link WIND_BASE_BEARING} is
 * defensible, and because the test that holds the wedge must measure against a stated
 * constant rather than a literal copied out of a comment.
 *
 * `Radians`, like every other angle here. It shipped as a bare `number` in the same file whose
 * `WindSeed` docblock says angles must not -- which is how a branded boundary ends up one field
 * short of the place it was written for, twice in the same feature.
 */
export const WIND_BEARING_SWING = (VEER_SWING + SWIRL_SWING + GUST_VEER_SWING) as Radians;

/**
 * The rate of the gust's slowest sine — the ONE the strength gust and the bearing share.
 *
 * `Weather` builds its strength gust from three sines and this is the slowest of them, phase
 * zero; the veer below rides the SAME term with the SAME argument. That is the whole point:
 * the veer used to run on `seed.veerPhase`, drawn per session, so the relation between "the
 * wind gusts harder" and "the wind veers" was whatever the draw happened to be — veering as
 * it strengthened in one session and as it eased in the next. A real gust veers as it
 * arrives, so the bearing now reaches the far end of its swing exactly when the gust is at
 * its hardest and is back on the mean bearing as the gust passes.
 *
 * Exported so `Weather` builds its own slowest term from this constant. Two copies of 0.9 in
 * two files is the same defect written twice.
 */
export const GUST_SLOW_RATE = 0.9;

/**
 * The CENTRE of the only wedge this wind ever occupies — AUTHORED, not drawn.
 *
 * This used to be `random() * 2π`, which reads like variety and is not: `DEFAULT_SIMULATION_SEED`
 * is fixed in production, so every load drew the same angle — 242.6°, which is 10.7° off the
 * opening camera's own view bearing. A wind that runs down the view axis is the one wind the
 * shot cannot show: the balloon enters off-frame, recedes down the middle and shrinks to a
 * speck instead of crossing. It is the feature's whole point failing, every load, at the only
 * moment every viewer sees.
 *
 * So the base is authored, the way the eclipse's staged hour and the themes' declinations
 * already are. 320° is within 2° of perpendicular to the two cameras the diorama opens on:
 * the free camera boots at (55, 42, 70) looking at (0, 5, 0), bearing 231.8°, and
 * `OVERVIEW_SHOT` — what every checkpoint and the golden-hour chapter frame — sits at
 * (70, 48, 80) looking at (0, 6, 0), bearing 228.8°. 320° crosses both from frame-left to
 * frame-right (it is within 2° of the free camera's own right-hand vector), so the balloon
 * enters at one edge of the picture and leaves by the other.
 *
 * ## What this constant actually buys, stated honestly
 *
 * It does NOT buy a good opening and then hand the wind over to a veer that explores the
 * compass. This header claimed exactly that — "the 25-minute veer carries the wind around the
 * compass, so a viewer who watches gets every direction" — and it was false. Every term in
 * `windBearingAt` is a bounded sine, so the bearing is confined to `base ±
 * {@link WIND_BEARING_SWING}` for ever: an 87.7° wedge from -83.8° to +3.8°, measured over a
 * day of every one of sixty seeds at both strength extremes, identical to within 0.05° for
 * all of them. There is no term that could carry it further, and there was none when the
 * sentence was written.
 *
 * So the constant authors the WHOLE SESSION, not the first thirty seconds, and that is a
 * larger claim needing a larger reason. It is this: every bearing in the wedge is at least
 * 44.3° off the view line of both authored cameras, so the failure that started this — a
 * balloon receding down the middle of the picture — is arithmetically unreachable rather
 * than merely unlikely at load. The price is honest and worth naming: the wind will never
 * blow from the other side of the diorama. A showpiece watched from two authored cameras
 * would rather have 87.7° of variety that can all be seen than 360° a quarter of which
 * cannot.
 *
 * Widening the model was the alternative and was rejected deliberately: the only way to
 * reach the whole compass while keeping a pure function of the clock is a slow term of
 * swing ≥ π, and any such term walks the wind through the view axis on a schedule — putting
 * the original blocker back, later, where nobody is watching for it.
 *
 * Nothing here reads a camera at runtime and nothing should: the camera moves, and a wind
 * that chased it would be a weathervane bolted to the viewport.
 */
export const WIND_BASE_BEARING = ((-40 * Math.PI) / 180) as Radians;

/**
 * Draw a session's wind phases. Call once; the bearing after that is clock plus seed.
 *
 * Two draws, not three: the base is authored above. The two phases therefore move one slot
 * earlier in the stream, which changes THIS wind for a given seed and nothing else in the
 * world — `Weather` draws these last, after every raindrop, snowflake and cloud puff, exactly
 * so that a change here cannot shift the world several checkpoints are pinned to.
 */
export function windSeedFrom(random: RandomSource): WindSeed {
  return {
    base: WIND_BASE_BEARING,
    veerPhase: (random() * Math.PI * 2) as Radians,
    swirlPhase: (random() * Math.PI * 2) as Radians,
  };
}

/**
 * The bearing at a moment: pure in `elapsed`, free-running, continuous everywhere.
 *
 * @param elapsed seconds on `Weather`'s presentation clock — the one a checkpoint pins and
 *   freezes; see "WHICH clock, exactly" in the header
 * @param strength 0..1 smoothed wind strength — only the gust veer reads it
 * @param seed this session's offsets from {@link windSeedFrom}
 */
export function windBearingAt(elapsed: number, strength: number, seed: WindSeed): Radians {
  const gust = Math.min(1, Math.max(0, strength)) * GUST_VEER_SWING;
  return (seed.base
    + VEER_SWING * Math.sin(elapsed * VEER_RATE + seed.veerPhase)
    + SWIRL_SWING * Math.sin(elapsed * SWIRL_RATE + seed.swirlPhase)
    // No phase term: this IS the strength gust's own slowest sine, argument for argument, so
    // the veer and the gust it rides cannot drift apart. See GUST_SLOW_RATE.
    + gust * Math.sin(elapsed * GUST_SLOW_RATE)) as Radians;
}
