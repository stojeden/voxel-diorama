import { describe, expect, it } from 'vitest';
import { CHECKPOINTS, getCheckpoint } from './Checkpoints';
import { RAINBOW_MOISTURE_ZONES } from '../world/WorldLayout';

describe('checkpoints', () => {
  it('defines finite, frozen, non-auto checkpoints', () => {
    expect(Object.keys(CHECKPOINTS)).toHaveLength(14);
    for (const checkpoint of Object.values(CHECKPOINTS)) {
      expect(checkpoint.frozen).toBe(true);
      expect(checkpoint.quality).not.toBe('auto');
      expect(checkpoint.timeOfDay).toBeGreaterThanOrEqual(0);
      expect(checkpoint.timeOfDay).toBeLessThanOrEqual(1);
      if (checkpoint.rainbowMoisture !== undefined) {
        expect(checkpoint.rainbowMoisture).toBeGreaterThanOrEqual(0);
        expect(checkpoint.rainbowMoisture).toBeLessThanOrEqual(1);
      }
      if (checkpoint.rainbowSource !== undefined) {
        expect(Number.isInteger(checkpoint.rainbowSource)).toBe(true);
        expect(checkpoint.rainbowSource).toBeGreaterThanOrEqual(0);
        expect(checkpoint.rainbowSource).toBeLessThan(RAINBOW_MOISTURE_ZONES.length);
      }
      expect([...checkpoint.camera.position, ...checkpoint.camera.target].every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects unknown ids', () => {
    expect(getCheckpoint('totality')?.id).toBe('totality');
    expect(getCheckpoint('unknown')).toBeNull();
  });

  it('freezes a post-rain rainbow over the lake for visual and performance QA', () => {
    const checkpoint = CHECKPOINTS['post-rain-rainbow-lake'];
    expect(checkpoint.weather).toBe('clear');
    expect(checkpoint.rainbowMoisture).toBe(1);
    expect(checkpoint.rainbowSource).toBe(0);
    expect(checkpoint.timeOfDay).toBeCloseTo(0.68);
  });
});
