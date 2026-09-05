/**
 * Obstruction beacons on the two dominants and the point towers.
 *
 * Red, flashing, and fading rather than switching -- the thing that makes a light on a
 * mast read as a warning light and not as a pixel that is simply on.
 *
 * The phase is measured in **real seconds**, not in fractions of the simulated day. It
 * used to be 160 turns of `t01`, which is a flash every second and a half only while a
 * day takes 240 s: switch to real time, where a turn of `t01` takes 24 hours, and the
 * same number gives a flash every nine minutes. A warning light flashes at its own rate
 * whatever the clock over it is doing.
 *
 * Seconds come from the app's own accumulated presentation time, so the phase is a pure
 * function of a value the checkpoint machinery already defines -- not of an independent
 * timer nobody can reproduce.
 */

/** Seconds per flash. Forty a minute, inside the twenty to sixty a real beacon uses. */
export const BEACON_PERIOD = 1.5;
/** The peak the palette carries; the drive scales it and never exceeds it. */
export const BEACON_PEAK = 1.6;
/** Awake but dim by day, full at night: the lamps are lit for aircraft, not for us. */
export const BEACON_DAY = 0.06;
/** They never go quite black between flashes -- dots vanishing entirely reads as a fault. */
export const BEACON_FLOOR = 0.1;

/**
 * Emissive strength for one beacon phase.
 *
 * `seconds` is elapsed presentation time; `offset` is a fraction of a flash, and puts a
 * structure on its own phase so the chimney and the mast do not blink together -- two
 * masts a hundred metres apart flashing in step is the one thing a real skyline never
 * does.
 */
export function beaconGlow(seconds: number, night: number, offset: number): number {
  const phase = (((seconds / BEACON_PERIOD + offset) % 1) + 1) % 1;
  const pulse = (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)) ** 2.2;
  return BEACON_PEAK * (BEACON_DAY + (1 - BEACON_DAY) * night) * (BEACON_FLOOR + (1 - BEACON_FLOOR) * pulse);
}
