import { describe, expect, it } from 'vitest';
import {
  FAR_PIXEL_BUDGET,
  QualityManager,
  farViewPixelRatio,
  recommendedLevel,
} from './QualityManager';

function sample(manager: QualityManager, fps: number, seconds: number): void {
  const delta = 1 / fps;
  for (let elapsed = 0; elapsed < seconds; elapsed += delta) manager.sampleFrame(delta);
}

describe('recommendedLevel', () => {
  it('selects a conservative profile for constrained devices', () => {
    expect(recommendedLevel({ hardwareConcurrency: 4, deviceMemory: 8 })).toBe('low');
    expect(recommendedLevel({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe('low');
  });

  it('selects high for M1 Pro class hardware', () => {
    expect(recommendedLevel({ hardwareConcurrency: 10 })).toBe('high');
    expect(recommendedLevel({ hardwareConcurrency: 10, deviceMemory: 16 })).toBe('high');
  });
});

describe('QualityManager', () => {
  it('reserves expensive P1 rendering features for capable profiles', () => {
    const high = new QualityManager({}, 'high').getProfile();
    const low = new QualityManager({}, 'low').getProfile();
    expect(high).toMatchObject({
      ambientOcclusion: true,
      aoResolutionScale: 0.5,
      cinematicDepthOfField: true,
      smaa: 'high',
      pixelRatio: 1.15,
    });
    expect(low).toMatchObject({
      ambientOcclusion: false,
      cinematicDepthOfField: false,
      smaa: 'low',
      pixelRatio: 1,
    });
  });

  it('never renders the far view below the near one', () => {
    // The bug this pins: the far view used to be 0.8x the near ratio, so on High it fell
    // to 1.0 and a high-DPI screen stretched it. It is the view with the finest detail --
    // the panel joints that were reported as flickering -- and the one with ambient
    // occlusion and bloom already switched off, so it is the one that can pay for pixels.
    for (const level of ['low', 'medium', 'high'] as const) {
      const profile = new QualityManager({}, level).getProfile();
      expect(profile.farPixelRatio).toBeGreaterThanOrEqual(
        Math.max(1, profile.pixelRatio * 0.8)
      );
    }
    // Only High was measured, so only High was raised -- and past the display's own
    // resolution, because matching it exactly was measurably less stable than either the
    // blur it replaced or the supersampling that replaced it.
    const high = new QualityManager({}, 'high').getProfile();
    expect(high.farPixelRatio).toBe(2.6);
    expect(high.farPixelRatio).toBeGreaterThan(high.pixelRatio);
    expect(new QualityManager({}, 'medium').getProfile().farPixelRatio).toBe(1);
    expect(new QualityManager({}, 'low').getProfile().farPixelRatio).toBe(1);
  });

  it('keeps manual modes stable regardless of frame time', () => {
    const manager = new QualityManager({}, 'high');
    sample(manager, 20, 40);
    expect(manager.getSnapshot()).toMatchObject({ mode: 'high', level: 'high' });
  });

  it('downgrades sustained slow auto rendering with cooldown', () => {
    const manager = new QualityManager({ hardwareConcurrency: 10 }, 'auto');
    sample(manager, 40, 10);
    expect(manager.getSnapshot().level).toBe('medium');
    sample(manager, 25, 12);
    expect(manager.getSnapshot().level).toBe('low');
  });

  it('requires sustained headroom before upgrading', () => {
    const manager = new QualityManager({ hardwareConcurrency: 4 }, 'auto');
    sample(manager, 75, 10);
    expect(manager.getSnapshot().level).toBe('medium');
    sample(manager, 75, 20);
    expect(manager.getSnapshot().level).toBe('high');
  });

  it('ignores background-tab stalls', () => {
    const manager = new QualityManager({ hardwareConcurrency: 10 }, 'auto');
    for (let i = 0; i < 100; i++) manager.sampleFrame(1);
    expect(manager.getSnapshot().level).toBe('high');
  });

  it('accounts for severe foreground overload instead of clipping it to 100 ms', () => {
    const manager = new QualityManager({ hardwareConcurrency: 10 }, 'auto');
    sample(manager, 5, 20);
    expect(manager.getSnapshot().level).toBe('low');
  });
});

describe('farViewPixelRatio', () => {
  const buffer = (ratio: number, w: number, h: number) => Math.round(w * ratio) * Math.round(h * ratio);

  it('supersamples the measured viewport exactly as it was measured', () => {
    // 1440x900 at a device ratio of 2 is where 2.6 was measured, at 12.35 ms.
    expect(farViewPixelRatio(2.6, 2, 1440, 900)).toBeCloseTo(2.6, 2);
  });

  it('never asks for more pixels than have been measured', () => {
    // A ratio is not a budget: the same 2.6 would ask a 2560x1440 window for 24.9 Mpx.
    for (const [w, h] of [[1440, 900], [2560, 1440], [3440, 1440], [1024, 1366], [393, 852]]) {
      const ratio = farViewPixelRatio(2.6, 3, w, h);
      expect(buffer(ratio, w, h)).toBeLessThanOrEqual(FAR_PIXEL_BUDGET * 1.01);
    }
    expect(farViewPixelRatio(2.6, 2, 2560, 1440)).toBeLessThan(2.6);
  });

  it('supersamples gently on a display that is not high-DPI, and never below 1', () => {
    expect(farViewPixelRatio(2.6, 1, 1440, 900)).toBeCloseTo(1.3, 2);
    expect(farViewPixelRatio(1, 3, 393, 852)).toBe(1);
    expect(farViewPixelRatio(2.6, 0.5, 1440, 900)).toBe(1);
  });

  it('is bounded by the profile, so an unmeasured profile stays where it is', () => {
    // Medium and Low ask for 1 and get 1, on any screen.
    expect(farViewPixelRatio(1, 3, 393, 852)).toBe(1);
    expect(farViewPixelRatio(1, 2, 1024, 1366)).toBe(1);
  });
});
