import { describe, expect, test } from 'vitest';
import { QUALITY_PROFILES } from './QualityManager';

/**
 * Quality profiles must not invert.
 *
 * They did. High was cut to six street lamps and no window pools after a measured
 * comparison, and Medium was never given the same treatment -- so the cheaper profile lit
 * the night with fourteen local lights against High's ten, and rendered a night frame in
 * 70 ms against High's 24. On the profile the owner runs. For months, silently, because
 * nothing compared the profiles to each other.
 *
 * Every budget here is "how much of a thing may be spent", so for any pair of profiles the
 * cheaper one must never ask for more than the dearer one. That is the whole rule, and it is
 * the one that was broken.
 */
const ORDER = ['low', 'medium', 'high'] as const;

/** Fields where a bigger number means more work. */
const SPEND = [
  'streetLightBudget',
  'busStopLightBudget',
  'stationLightBudget',
  'windowLightBudget',
  'shadowMapSize',
  'actorDensity',
  'particleDensity',
  'waterDetail',
  'aoResolutionScale',
  'optionalActorHz',
] as const;

describe('quality profiles', () => {
  test('a cheaper profile never spends more than a dearer one', () => {
    for (let i = 1; i < ORDER.length; i++) {
      const cheaper = QUALITY_PROFILES[ORDER[i - 1]];
      const dearer = QUALITY_PROFILES[ORDER[i]];
      for (const field of SPEND) {
        const a = cheaper[field] as number;
        const b = dearer[field] as number;
        expect(
          a,
          `${ORDER[i - 1]}.${field} = ${a} przekracza ${ORDER[i]}.${field} = ${b}`
        ).toBeLessThanOrEqual(b);
      }
    }
  });

  test('the total local light budget is ordered too', () => {
    // The count that decides the night frame: Three compiles it into every material's
    // shader, so it costs programs as well as fragments.
    const lights = (level: (typeof ORDER)[number]) => {
      const p = QUALITY_PROFILES[level];
      return (
        p.streetLightBudget + p.busStopLightBudget + p.stationLightBudget + p.windowLightBudget
      );
    };
    expect(lights('low')).toBeLessThanOrEqual(lights('medium'));
    expect(lights('medium'), 'medium swieci mocniej niz high').toBeLessThanOrEqual(lights('high'));
  });
});
