/**
 * Obstruction beacons on the two dominants and the point towers.
 *
 * Red, flashing, and fading rather than switching -- the thing that makes a light on a
 * mast read as a warning light and not as a pixel that is simply on.
 *
 * The phase is a function of world time, not of accumulated frames: `DAY_SECONDS` of
 * world time is one turn of `t01`, so the flash is reproducible from the clock, survives
 * a checkpoint or a time jump, and speeds up with the simulation the way everything else
 * in the city does.
 */

/**
 * Flashes per turn of the clock. 160 is a flash every second and a half at the default
 * `DAY_SECONDS`, inside the twenty to sixty per minute a real obstruction light uses.
 */
export const BEACON_RATE = 160;
/** The peak the palette carries; the drive scales it and never exceeds it. */
export const BEACON_PEAK = 1.6;
/** Awake but dim by day, full at night: the lamps are lit for aircraft, not for us. */
export const BEACON_DAY = 0.06;
/** They never go quite black between flashes -- dots vanishing entirely reads as a fault. */
export const BEACON_FLOOR = 0.1;

/**
 * Emissive strength for one beacon phase at a given time of day.
 *
 * `offset` puts a structure on its own phase, so the chimney and the mast do not blink
 * together: two masts a hundred metres apart flashing in step is the one thing a real
 * skyline never does.
 */
export function beaconGlow(t01: number, night: number, offset: number): number {
  const phase = (((t01 * BEACON_RATE + offset) % 1) + 1) % 1;
  const pulse = (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)) ** 2.2;
  return BEACON_PEAK * (BEACON_DAY + (1 - BEACON_DAY) * night) * (BEACON_FLOOR + (1 - BEACON_FLOOR) * pulse);
}
