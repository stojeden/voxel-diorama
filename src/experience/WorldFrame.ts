import type { DayLightState } from '../environment/DayNightCycle';
import type { ExperienceFrameState } from './ExperienceDirector';
import type { TrainPublicState } from '../world/Train';

/**
 * What presentation needs from a stepped world, and nothing else.
 *
 * `animate()` used to compute these as locals and read them a hundred lines later, which is
 * why a second presentation mode had no way in: the only thing that knew how to advance the
 * world was the same function that knew how to draw it. These eight values are the entire
 * measured contract between the two halves -- found by asking which locals declared before
 * the camera update are still referenced after it, not by guessing at a boundary.
 *
 * Nothing here is a Three.js object. A passthrough or stereo presenter consumes the same
 * eight values and draws them its own way; the world neither knows nor cares.
 *
 * One mutable object is reused per frame, like {@link FrameContext}: no per-frame allocation.
 */
export interface WorldFrame {
  /** Lighting phase in [0,1). Not the hour of day when real time warps the cycle. */
  t01: number;
  /**
   * The three deltas, carried rather than recomputed.
   *
   * Presentation must not pick its own: `realDelta` runs UI cadence and keeps counting
   * while a checkpoint freezes the picture, `presentationDelta` runs damping and post,
   * `simulationDelta` is zero whenever the world is paused. Choosing the wrong one is how
   * a frozen frame ends up with a moving camera.
   */
  realDelta: number;
  presentationDelta: number;
  simulationDelta: number;
  /** Cloud cover the sky was actually built with, including the theme's turbidity. */
  skyCloud: number;
  /** The lighting solution. A passthrough presenter wants this and not the sky dome. */
  light: DayLightState;
  experienceState: ExperienceFrameState;
  stationState: TrainPublicState;
  /** Running, or still unwinding: the HUD and the grade both need the wider window. */
  eclipseActive: boolean;
}

/**
 * Seeded from the systems that already own these truths, because a half-built carrier would
 * be a second source of them. None of these initial values is ever read: `stepWorld` writes
 * all eight before `presentWorld` runs, on the first frame and every frame after.
 */
export function createWorldFrame(
  experienceState: ExperienceFrameState,
  stationState: TrainPublicState
): WorldFrame {
  return {
    t01: 0,
    realDelta: 0,
    presentationDelta: 0,
    simulationDelta: 0,
    skyCloud: 0,
    light: { night: 0, golden: 0, sunElevation: 0, directSun: 0, eclipse: 0 },
    experienceState,
    stationState,
    eclipseActive: false,
  };
}
