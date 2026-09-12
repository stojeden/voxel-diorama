import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ExperienceDirector } from './ExperienceDirector';
import { createFrameContext } from './FrameContext';
import {
  AUTUMN_DECLINATION_DEG,
  JUNE_DECLINATION_DEG,
  clockFromSolarPhase,
  sunElevationAt,
} from '../environment/sky';

describe('ExperienceDirector', () => {
  it('advances simulation time and respects checkpoint lock', () => {
    const experience = new ExperienceDirector({ daySeconds: 100, initialDayPhase: 0.2 });
    const frame = createFrameContext();
    frame.realDelta = 1;
    frame.simulationDelta = 1;
    expect(experience.update(frame, null).t01).toBeCloseTo(0.21);
    experience.lockCheckpoint(0.5);
    expect(experience.update(frame, null).t01).toBe(0.5);
  });

  it('reports a new day exactly on rollover', () => {
    const onNewDay = vi.fn();
    const experience = new ExperienceDirector({ daySeconds: 10, initialDayPhase: 0.99, onNewDay });
    const frame = createFrameContext();
    frame.realDelta = 0.2;
    frame.simulationDelta = 0.2;
    experience.update(frame, null);
    expect(onNewDay).toHaveBeenCalledTimes(1);
  });

  it('locks only the clock while presentation remains externally controllable', () => {
    const experience = new ExperienceDirector({ daySeconds: 100, initialDayPhase: 0.2 });
    const frame = createFrameContext();
    frame.realDelta = 1;
    frame.simulationDelta = 1;
    experience.setClockLocked(true);
    experience.setTime(0.6);
    expect(experience.update(frame, null).t01).toBeCloseTo(0.6);
    experience.setTime(0.1);
    expect(experience.update(frame, null).t01).toBeCloseTo(0.1);
  });
});

/**
 * The opening moment, checked against the sky rather than against the literal.
 *
 * The product opens "just after sunrise". That is a claim about the sun's elevation, so it is
 * the elevation that is asserted: a couple of degrees up, in every season. The number that
 * expresses it is a solar phase, and the whole point of these tests is that they fail if it
 * is ever read as a clock again -- under June's declination that reading is 06:17 with the
 * sun 20.9 degrees up, which is mid-morning, and in December it is 15.8 degrees below the
 * horizon, which is night.
 */
describe('the opening moment', () => {
  const deg = (radians: number) => THREE.MathUtils.radToDeg(radians);
  /** Elevation of the sun at the clock the director actually opens on. */
  const openingElevation = (declinationDeg: number) => {
    const declination = THREE.MathUtils.degToRad(declinationDeg);
    const experience = new ExperienceDirector({ daySeconds: 100 });
    experience.setPhaseToClock((phase) => clockFromSolarPhase(phase, declination));
    return deg(sunElevationAt(experience.getState().t01, declination));
  };

  it('opens on a sun just above the horizon, in every season', () => {
    for (const declinationDeg of [JUNE_DECLINATION_DEG, AUTUMN_DECLINATION_DEG, 0, -23.44]) {
      const elevation = openingElevation(declinationDeg);
      expect(elevation).toBeGreaterThan(0.5);
      expect(elevation).toBeLessThan(4);
    }
  });

  it('gives the boot checkpoint the last word, rather than dragging it back to dawn', () => {
    const experience = new ExperienceDirector({ daySeconds: 100 });
    experience.lockCheckpoint(0.5);
    experience.setPhaseToClock((phase) => clockFromSolarPhase(phase, 0));
    expect(experience.getState().t01).toBeCloseTo(0.5);
  });
});
