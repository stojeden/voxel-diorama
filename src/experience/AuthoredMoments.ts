/**
 * Moments this product authors against the sun rather than against a wall clock.
 *
 * Every number in this file is a **solar phase**, the canonical axis documented at the top
 * of `src/environment/sky.ts`: 0.25 is sunrise, 0.5 noon, 0.75 sunset, whatever the season
 * did to the clock. None of them is a `t01`, and none may be handed to anything that takes
 * one -- `ExperienceDirector.setTime`, `lockCheckpoint`, `sunDirectionAt`, `sunElevationAt`,
 * `DayNightCycle.update` -- without first going through `clockFromSolarPhase` with the
 * declination the frame is lit by.
 *
 * The two axes were the same number until seasons arrived, because the old sun was a plain
 * sinusoid that rose at 0.25 and set at 0.75 every day of an eternal year. That is why this
 * file exists: the same two literals have now been misread as clock times four separate
 * times, each time producing a sky hours away from the one their name claims.
 *
 * The conversion deliberately does not live here. This module stays free of the sky so that
 * the modules which only *author* moments -- the tour, the checkpoints, the experience
 * director -- can name one without learning what latitude is.
 */

/**
 * The opening moment: just after sunrise, the sun a degree or two above the horizon.
 *
 * Resolved as the phase it is, it is 04:08 and 2.9 degrees of elevation under June's
 * declination, and stays between 1.2 and 3.0 degrees across the whole year -- the low,
 * long-shadowed light the diorama is meant to open on. Read as a clock it is 06:17 with the
 * sun already 20.9 degrees up in June and 15.8 degrees *below* the horizon in December:
 * mid-morning glare in one season and night in the other, from one authored number.
 */
export const OPENING_SOLAR_PHASE = 0.262;

/**
 * The staged eclipse's moment: a low, late-afternoon sun for the corona to stand clear of.
 *
 * Resolved as the phase it is, it is 19:07 and 8.8 degrees under June's declination, and
 * stays between 3.5 and 9.0 degrees all year. Read as a clock it is 17:10 and 25.9 degrees
 * in June -- nearly two hours, seventeen degrees of elevation and twenty-two degrees of
 * azimuth away. The eclipse camera is placed *opposite* the sun, so the two readings do not
 * merely light the shot differently; they frame a different one.
 *
 * The same value is the `dayProgress` of the 'totality' tour chapter and the `timeOfDay` of
 * the 'totality' and 'eclipse-totality-overview' checkpoints. It is one authored moment, so
 * it is one constant, and every reader of it resolves it the same way.
 */
export const ECLIPSE_VIEW_SOLAR_PHASE = 0.715;
