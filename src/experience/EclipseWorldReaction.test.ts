import { describe, expect, test } from 'vitest';
import { eclipseWorldReactionAt } from './EclipseWorldReaction';

describe('eclipse world reactions', () => {
  test('keeps ordinary city life unchanged outside an eclipse', () => {
    expect(eclipseWorldReactionAt(0, 0)).toEqual({
      attention: 0,
      movementScale: 1,
      eyeProtection: 0,
      projection: 0,
      dogAlert: 0,
    });
  });

  test('slows people and alerts the dog before totality', () => {
    const reaction = eclipseWorldReactionAt(0.9, 0);
    expect(reaction.attention).toBeGreaterThan(0.98);
    expect(reaction.movementScale).toBeLessThan(0.8);
    expect(reaction.eyeProtection).toBeGreaterThan(0.98);
    expect(reaction.projection).toBeGreaterThan(0.9);
    expect(reaction.dogAlert).toBeGreaterThan(0.9);
  });

  test('nearly stops pedestrians and removes filters during totality', () => {
    const reaction = eclipseWorldReactionAt(1, 1);
    expect(reaction.movementScale).toBeCloseTo(0.04, 6);
    expect(reaction.eyeProtection).toBe(0);
    expect(reaction.projection).toBe(0);
    expect(reaction.dogAlert).toBe(1);
  });

  test('sanitizes invalid samples', () => {
    expect(eclipseWorldReactionAt(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      attention: 0,
      movementScale: 1,
      eyeProtection: 0,
      projection: 0,
      dogAlert: 0,
    });
  });
});
