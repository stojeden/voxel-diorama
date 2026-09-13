import type { RandomSource } from '../core/Random';

/**
 * The storm: clouds that light up from inside while it rains.
 *
 * ## The physics, because it is what makes the effect read
 *
 * Most lightning in a storm never reaches the ground: the great majority of discharges are
 * INTRA-CLOUD, between charge centres inside one cell. What a viewer sees is not a bolt but a
 * cloud that lights up from within and goes out — which is exactly the effect the owner asked
 * for, and the reason this module draws no geometry. A bolt would be the rarer event drawn as
 * if it were the common one.
 *
 * A flash is SHORT: one stroke's luminous life is of the order of 0.1–0.2 s, and the whole
 * event is usually made of two to four strokes down the same channel a tenth of a second
 * apart. That multiplicity is the point. A single 0.15 s fade reads as a lamp being switched;
 * the re-strike flicker is what the eye recognises as lightning. {@link STORM_STROKE_LIFE} and
 * {@link STORM_RESTRIKE_GAP} are those two numbers.
 *
 * The light goes EVERYWHERE, not only into the cloud that carries the channel: the whole deck
 * and the ground under it lift a little, and the cell containing the discharge lifts most.
 * {@link stormCloudBrightness} is that falloff, and `DayNightCycle` adds
 * {@link STORM_FILL_AMBIENT} to the world's own fill so a flash lights the city too.
 *
 * And a storm gives a FEW FLASHES A MINUTE, not one a second. An active cell might manage a
 * flash every few seconds at its peak; a diorama that did would be a strobe. One event per
 * {@link STORM_SLOT_SECONDS} is about five and a half a minute.
 *
 * ## Why a slot schedule rather than a countdown
 *
 * The flash intensity is a PURE FUNCTION of the clock and the seed: `floor(t / slot)` picks
 * the event, the event's own numbers come from a hash of its index, and nothing accumulates.
 * A countdown to the next strike would be state, and state cannot be seeked — `Weather.pinClock`
 * puts the weather clock on a stated second, including backwards, and a checkpoint that seeks
 * to second zero has to find the storm where it would have been. It is the same argument the
 * wind bearing is built on (`wind.ts`, "Why a sum of sines rather than a random walk"), for the
 * same reason: the smoke asserts that one seed and one checkpoint reproduce one frame.
 *
 * The clock is `Weather`'s PRESENTATION clock, the one a checkpoint lock freezes — the same
 * clock the wind, the gust and the foliage phase hang from. No second clock enters here.
 *
 * ## The quiet lead, which is not decoration
 *
 * No event may start in the first {@link STORM_QUIET_LEAD} seconds of its slot, so the whole
 * neighbourhood of `t = 0` — `CHECKPOINT_WIND_CLOCK`, the second every checkpoint is
 * photographed at, two of which photograph rain — is dark BY CONSTRUCTION rather than by luck
 * of the seed. Without it, whether `noon-rain-overview` was lit by lightning would depend on
 * the seed, and every luminance number measured at that checkpoint would carry it silently.
 */

/** One flash event per slot: 60 / 11 = 5.45 flashes a minute. */
export const STORM_SLOT_SECONDS = 11;

/** No flash starts within this many seconds of a slot boundary; see the header. */
export const STORM_QUIET_LEAD = 1.2;

/** One stroke's luminous life, in seconds — the 0.1–0.2 s a real one lasts. */
export const STORM_STROKE_LIFE = 0.15;

/** Gap between the re-strikes of one flash: the flicker, not a second flash. */
export const STORM_RESTRIKE_GAP = 0.11;

const STORM_MIN_STROKES = 2;
const STORM_MAX_STROKES = 4;

/** The longest a whole event can last: the last stroke's start plus its life. */
export const STORM_EVENT_SPAN = (STORM_MAX_STROKES - 1) * STORM_RESTRIKE_GAP + STORM_STROKE_LIFE;

/** Jitter window for the start, so flashes are not metronomic at the slot rate. */
const STORM_JITTER_WINDOW = STORM_SLOT_SECONDS - STORM_QUIET_LEAD - STORM_EVENT_SPAN;

/** Fraction of a stroke's life spent rising. The rest is the decay. */
const STORM_STROKE_RISE = 0.08;
/** Decay constant of the stroke's tail, normalised so the stroke reaches exactly zero. */
const STORM_STROKE_DECAY = 4.2;
const STORM_DECAY_FLOOR = Math.exp(-STORM_STROKE_DECAY);

/** Extra brightness of the cell the discharge is inside, at full flash. */
export const STORM_CLOUD_CORE_GAIN = 0.9;
/** Extra brightness the whole deck takes, however far from the channel it is. */
export const STORM_CLOUD_DECK_GAIN = 0.15;
/** Metres at which the core's share of the flash has fallen to half. */
export const STORM_CLOUD_FALLOFF = 45;

/**
 * What a flash adds to the world's own fill, at full intensity.
 *
 * Small on purpose, and additive rather than multiplicative so that a flash of zero is
 * arithmetically no change at all. At a rainy noon this lifts the ambient fill from 0.99 to
 * 1.17 (+18%); at a rainy midnight, from 0.16 to 0.34 — the same absolute lift, which is what
 * a distant light source does, and which is why a night storm reads and a noon one is subtle.
 */
export const STORM_FILL_AMBIENT = 0.18;
/** The sky half of the same lift; smaller, because the flash is inside the deck. */
export const STORM_FILL_HEMISPHERE = 0.12;

/** A session's storm, as one integer. The schedule is a pure function of it and the clock. */
export interface StormSeed {
  readonly key: number;
}

/** One flash event: everything about it, derived from its slot index. */
export interface StormEvent {
  /** Seconds on the presentation clock at which the first stroke begins. */
  readonly start: number;
  /** How many times this flash re-strikes, 2..4. */
  readonly strokes: number;
  /** 0..1 peak — not every cell is overhead. */
  readonly amplitude: number;
  /** 0..1 which cloud carries the channel, as a fraction of the deck. */
  readonly focus: number;
}

/**
 * Draw a storm from a stream of its own.
 *
 * Deliberately NOT the weather stream. That stream is positional — every raindrop, snowflake
 * and cloud puff is a draw from it in order, and the wind's phases are taken last precisely so
 * that adding one cannot shift a world several checkpoints are pinned to. A separate named
 * stream costs nothing and cannot move anything.
 */
export function stormSeedFrom(random: RandomSource): StormSeed {
  return { key: (random() * 4294967296) >>> 0 };
}

/** Avalanche a slot index and a channel into 0..1. The same family as `core/Random`. */
function hash(key: number, slot: number, channel: number): number {
  let value = (key ^ Math.imul(slot | 0, 0x9e3779b1) ^ Math.imul(channel | 0, 0x85ebca6b)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** The flash that belongs to one slot of the clock. Pure; no state anywhere. */
export function stormEventFor(slot: number, seed: StormSeed): StormEvent {
  const index = Math.floor(slot);
  return {
    start: index * STORM_SLOT_SECONDS
      + STORM_QUIET_LEAD
      + hash(seed.key, index, 1) * STORM_JITTER_WINDOW,
    strokes: STORM_MIN_STROKES
      + Math.floor(hash(seed.key, index, 2) * (STORM_MAX_STROKES - STORM_MIN_STROKES + 1)),
    amplitude: 0.55 + hash(seed.key, index, 3) * 0.45,
    focus: hash(seed.key, index, 4),
  };
}

/**
 * One stroke's light over its life: a fast rise, then a decay that reaches exactly zero.
 *
 * "Exactly" matters. A tail cut off at 1.5% of its peak is a step to black on the frame the
 * stroke ends, and a step is what the eye catches.
 */
function strokeEnvelope(age01: number): number {
  if (age01 < 0 || age01 >= 1) return 0;
  if (age01 < STORM_STROKE_RISE) return age01 / STORM_STROKE_RISE;
  const decayed = Math.exp(
    (-STORM_STROKE_DECAY * (age01 - STORM_STROKE_RISE)) / (1 - STORM_STROKE_RISE)
  );
  return (decayed - STORM_DECAY_FLOOR) / (1 - STORM_DECAY_FLOOR);
}

/**
 * 0..1 flash at a moment — 0 almost always, which is what a storm looks like.
 *
 * The strokes are combined with `max`, not a sum: two overlapping tails must not add up to a
 * brighter flash than either stroke, and the intensity has to stay inside 0..1 for the
 * brightness law downstream to be a lift rather than a multiplier nobody bounded.
 *
 * @param elapsed seconds on `Weather`'s presentation clock. A negative clock is silent.
 * @param seed this session's storm from {@link stormSeedFrom}
 */
export function stormFlashAt(elapsed: number, seed: StormSeed): number {
  if (!(elapsed >= 0)) return 0;
  // An event is contained in its own slot by construction -- start + span never passes the
  // boundary -- so exactly one slot can be alight at a time and there is no neighbour to check.
  const slot = Math.floor(elapsed / STORM_SLOT_SECONDS);
  const event = stormEventFor(slot, seed);
  const since = elapsed - event.start;
  if (since < 0 || since >= STORM_EVENT_SPAN) return 0;
  let flash = 0;
  for (let stroke = 0; stroke < event.strokes; stroke++) {
    // The first stroke is the brightest; the re-strikes down the ionised channel are dimmer
    // and unequal, which is what keeps the flicker from looking like a square wave.
    const scale = stroke === 0 ? 1 : 0.5 + hash(seed.key, slot, 8 + stroke) * 0.4;
    const age = (since - stroke * STORM_RESTRIKE_GAP) / STORM_STROKE_LIFE;
    flash = Math.max(flash, scale * strokeEnvelope(age));
  }
  return flash * event.amplitude;
}

/**
 * 0..1 which cloud of the deck carries the channel at this moment.
 *
 * Separate from {@link stormFlashAt} rather than returned beside it, because a frame that is
 * dark — almost all of them — must not pay for an object to say so. The caller reads it only
 * while a flash is alight.
 */
export function stormFocusAt(elapsed: number, seed: StormSeed): number {
  if (!(elapsed >= 0)) return 0;
  return stormEventFor(Math.floor(elapsed / STORM_SLOT_SECONDS), seed).focus;
}

/**
 * What to multiply a cloud's colour by: exactly 1 with no flash, more with one.
 *
 * Never less than 1, which is the point of writing it as a lift. The standing invariant is
 * that literal rgb(0,0,0) never appears in a frame; a brightness that could dip below 1 would
 * be a new way to darken a cloud toward it.
 *
 * @param flash 0..1 from {@link stormFlashAt}
 * @param distance metres from the cloud carrying the channel
 */
export function stormCloudBrightness(flash: number, distance: number): number {
  if (!(flash > 0)) return 1;
  const spread = distance / STORM_CLOUD_FALLOFF;
  const core = 1 / (1 + spread * spread);
  return 1 + flash * (STORM_CLOUD_DECK_GAIN + STORM_CLOUD_CORE_GAIN * core);
}
