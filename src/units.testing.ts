/**
 * Identity casts into the unit brands, **for tests only**.
 *
 * Product code does not get these and must not import them: `src/units.ts` deliberately has
 * no constructors, because an arrow function is runtime code and the refactor that introduced
 * the brands is required to cost exactly zero bytes in the built bundle. A test file is not in
 * the bundle, so the same rule buys nothing there and costs a great deal of noise -- several
 * hundred inline `as` casts across the suite, in exactly the assertions a reader is meant to be
 * able to read.
 *
 * Nothing in `src/` outside a `*.test.ts` may import this module. Nothing reachable from
 * `index.html` imports it, which is why it does not reach `dist/`; the entry chunk's hash is
 * what checks that, and it is checked.
 */
import type { Clock01, Degrees, Radians, SolarPhase01, WallClock01 } from './units';

/** A clock reading: fraction of the simulated 24 h day, 0.5 = solar noon. */
export const clock01 = (n: number): Clock01 => n as Clock01;
/** An hour of the day as a fraction of a real 24 h -- what the HUD prints, what shops read. */
export const wallClock01 = (n: number): WallClock01 => n as WallClock01;
/** A canonical solar phase: 0.25 sunrise, 0.5 noon, 0.75 sunset, whatever the season did. */
export const solarPhase01 = (n: number): SolarPhase01 => n as SolarPhase01;
/** An angle in radians. */
export const radians = (n: number): Radians => n as Radians;
/** An angle in degrees. */
export const degrees = (n: number): Degrees => n as Degrees;
