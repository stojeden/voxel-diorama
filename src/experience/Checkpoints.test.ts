import { describe, expect, it } from 'vitest';
import { CHECKPOINTS, getCheckpoint } from './Checkpoints';

describe('checkpoints', () => {
  it('defines finite, frozen, non-auto checkpoints', () => {
    expect(Object.keys(CHECKPOINTS)).toHaveLength(12);
    for (const checkpoint of Object.values(CHECKPOINTS)) {
      expect(checkpoint.frozen).toBe(true);
      expect(checkpoint.quality).not.toBe('auto');
      expect(checkpoint.timeOfDay).toBeGreaterThanOrEqual(0);
      expect(checkpoint.timeOfDay).toBeLessThanOrEqual(1);
      expect([...checkpoint.camera.position, ...checkpoint.camera.target].every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects unknown ids', () => {
    expect(getCheckpoint('totality')?.id).toBe('totality');
    expect(getCheckpoint('unknown')).toBeNull();
  });
});
