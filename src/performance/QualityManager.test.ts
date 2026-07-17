import { describe, expect, it } from 'vitest';
import { QualityManager, recommendedLevel } from './QualityManager';

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
