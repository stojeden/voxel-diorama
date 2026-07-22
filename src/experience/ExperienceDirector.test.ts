import { describe, expect, it, vi } from 'vitest';
import { ExperienceDirector } from './ExperienceDirector';
import { createFrameContext } from './FrameContext';

describe('ExperienceDirector', () => {
  it('advances simulation time and respects checkpoint lock', () => {
    const experience = new ExperienceDirector({ daySeconds: 100, initialDayProgress: 0.2 });
    const frame = createFrameContext();
    frame.realDelta = 1;
    frame.simulationDelta = 1;
    expect(experience.update(frame, null).t01).toBeCloseTo(0.21);
    experience.lockCheckpoint(0.5);
    expect(experience.update(frame, null).t01).toBe(0.5);
  });

  it('reports a new day exactly on rollover', () => {
    const onNewDay = vi.fn();
    const experience = new ExperienceDirector({ daySeconds: 10, initialDayProgress: 0.99, onNewDay });
    const frame = createFrameContext();
    frame.realDelta = 0.2;
    frame.simulationDelta = 0.2;
    experience.update(frame, null);
    expect(onNewDay).toHaveBeenCalledTimes(1);
  });

  it('locks only the clock while presentation remains externally controllable', () => {
    const experience = new ExperienceDirector({ daySeconds: 100, initialDayProgress: 0.2 });
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
