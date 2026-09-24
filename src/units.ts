/**
 * The units this world's numbers are in, as types the compiler can check.
 *
 * Two axes and two angle units have been confused six separate times in this codebase, each
 * time costing a day, and each time the code compiled perfectly: a clock and a solar phase
 * are both `number` in 0..1, and degrees and radians are both `number` full stop. The
 * convention that told them apart was a naming convention -- `elevationDeg` against
 * `elevationRad`, `t` against `phase` -- and a convention is not a check.
 *
 * So each unit is `number` intersected with a property keyed on its own `unique symbol`.
 * Arithmetic still works, because a branded number *is* a number; what stops working is
 * handing one axis to a function that wanted the other, because no two brands are mutually
 * assignable and a bare `number` is assignable to none of them.
 *
 * **This module emits nothing.** It is `declare const` and `export type` only -- no
 * constructor functions, because an arrow function is runtime code and this refactor is
 * required to cost exactly zero bytes. Values enter a brand by `as` at the boundary where
 * the unit is first known (a literal, a conversion, an external API), which is also the
 * only place a reader has to be convinced. The proof that the rule held is that the built
 * entry chunk is byte-identical to the one before the change.
 *
 * The symbols are never read at runtime and never exist at runtime; they are declared, not
 * defined, purely so that two brands cannot collapse into the same structural type.
 */

declare const CLOCK_01: unique symbol;
declare const WALL_CLOCK_01: unique symbol;
declare const SOLAR_PHASE_01: unique symbol;
declare const RADIANS: unique symbol;
declare const DEGREES: unique symbol;

/**
 * The **lighting clock**: fraction of the simulated 24-hour day, 0.5 = solar noon.
 *
 * This is the axis the solar model takes. The simulation advances it linearly, so when a
 * season shortens the night the night is genuinely shorter to sit and watch.
 *
 * In simulation it is the same number as {@link WallClock01}. In real time it is not: it is
 * the viewer's solar time (`RealTimeSync.getCycleT`), half an hour off their hour in a Warsaw
 * summer. For a while the two coincided there too, because real time handed the hour over as
 * the sun -- which is the worst failure shape available, a swap that changes nothing in any
 * test -- and the sun ran half an hour early. The brand is what let the fix find every place
 * that read one axis as the other: the bus timetable, the residential windows.
 */
export type Clock01 = number & { readonly [CLOCK_01]: 'Clock01' };

/**
 * The **wall clock**: hour of day as a fraction of a real 24 h, which the HUD prints.
 *
 * A third brand rather than a reuse of {@link Clock01}: one is where the sun is, the other is
 * what the clock on the wall says. In simulation they hold the same number; in real time they
 * are the viewer's solar time and their hour, half an hour apart in a Warsaw summer.
 *
 * Anything about *light* is a `Clock01`; anything about an *hour* is a `WallClock01`. Where
 * one is genuinely handed to the other the cast is written `as number as`, so the crossings
 * are greppable. There are two, both simulation-only relabels where the axes are one number:
 * `clockT` in `main.ts`, and `DayNightCycle.update`'s default hour for callers with none.
 */
export type WallClock01 = number & { readonly [WALL_CLOCK_01]: 'WallClock01' };

/**
 * The **solar phase**: canonical 0..1 where 0.25 is sunrise, 0.5 noon and 0.75 sunset,
 * whatever the season did to the clock.
 *
 * Anything authored against the sun rather than against a wall clock belongs here -- the
 * horizon colour ramp, every checkpoint whose name is a claim about the light. The two axes
 * coincided exactly until seasons arrived, which is why so much of this codebase was written
 * with `number` and meant this.
 */
export type SolarPhase01 = number & { readonly [SOLAR_PHASE_01]: 'SolarPhase01' };

/** An angle in radians. What every trigonometric function here takes and returns. */
export type Radians = number & { readonly [RADIANS]: 'Radians' };

/**
 * An angle in degrees. What art direction, published tables and elevation thresholds are
 * written in, and what no trigonometric function may be handed.
 */
export type Degrees = number & { readonly [DEGREES]: 'Degrees' };
