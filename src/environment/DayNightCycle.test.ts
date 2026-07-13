import { describe, expect, test } from 'vitest';
import { environmentTransitionAt } from './DayNightCycle';

describe('PMREM environment transition', () => {
  test('crossfades maps without changing the total environment intensity', () => {
    const samples = Array.from({ length: 21 }, (_, index) =>
      environmentTransitionAt(index / 20)
    );

    expect(samples[0].blend).toBe(0);
    expect(samples[samples.length - 1].blend).toBe(1);
    expect(new Set(samples.map((sample) => sample.intensity)).size).toBe(1);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index].blend).toBeGreaterThan(samples[index - 1].blend);
    }
  });
});
