import { describe, expect, test } from 'vitest';
import { eclipsePhenomenaAt } from './EclipsePhenomena';

describe('eclipsePhenomenaAt', () => {
  test('keeps every optional phenomenon disabled outside an eclipse', () => {
    expect(
      eclipsePhenomenaAt({ active: false, coverage: 0.99, totality: 0.5 }, 'high')
    ).toMatchObject({ prominences: 0, groundCrescents: 0, shadowBands: 0 });
  });

  test('shows pinhole crescents only during partial phases', () => {
    const early = eclipsePhenomenaAt({ active: true, coverage: 0.08, totality: 0 }, 'high');
    const partial = eclipsePhenomenaAt({ active: true, coverage: 0.82, totality: 0 }, 'high');
    const total = eclipsePhenomenaAt({ active: true, coverage: 1, totality: 1 }, 'high');

    expect(early.groundCrescents).toBe(0);
    expect(partial.groundCrescents).toBeGreaterThan(0.95);
    expect(total.groundCrescents).toBe(0);
  });

  test('limits shadow bands to High near contact', () => {
    const contact = { active: true, coverage: 0.99, totality: 0 };

    expect(eclipsePhenomenaAt(contact, 'low').shadowBands).toBe(0);
    expect(eclipsePhenomenaAt(contact, 'medium').shadowBands).toBe(0);
    expect(eclipsePhenomenaAt(contact, 'high').shadowBands).toBeGreaterThan(0.9);
    expect(
      eclipsePhenomenaAt({ active: true, coverage: 0.8, totality: 0 }, 'high').shadowBands
    ).toBe(0);
    expect(
      eclipsePhenomenaAt({ active: true, coverage: 1, totality: 1 }, 'high').shadowBands
    ).toBe(0);
  });

  test('reveals prominences smoothly only close to totality', () => {
    const partial = eclipsePhenomenaAt({ active: true, coverage: 0.75, totality: 0 }, 'high');
    const contact = eclipsePhenomenaAt({ active: true, coverage: 0.98, totality: 0 }, 'high');
    const total = eclipsePhenomenaAt({ active: true, coverage: 1, totality: 1 }, 'high');

    expect(partial.prominences).toBe(0);
    expect(contact.prominences).toBeGreaterThan(0);
    expect(contact.prominences).toBeLessThan(total.prominences);
    expect(total.prominences).toBe(1);
  });

  test('scales deterministic detail budgets without changing phase logic', () => {
    const input = { active: true, coverage: 0.82, totality: 0 };
    const low = eclipsePhenomenaAt(input, 'low');
    const medium = eclipsePhenomenaAt(input, 'medium');
    const high = eclipsePhenomenaAt(input, 'high');

    expect(low.groundCrescents).toBe(high.groundCrescents);
    expect(low.crescentInstances).toBeLessThan(medium.crescentInstances);
    expect(medium.crescentInstances).toBeLessThan(high.crescentInstances);
    expect(low.prominenceDetail).toBeLessThan(medium.prominenceDetail);
    expect(medium.prominenceDetail).toBeLessThan(high.prominenceDetail);
    expect(low.crescentPatternDensity).toBeLessThan(high.crescentPatternDensity);
  });

  test('clamps out-of-range timeline input', () => {
    const over = eclipsePhenomenaAt({ active: true, coverage: 3, totality: 2 }, 'high');
    const under = eclipsePhenomenaAt({ active: true, coverage: -2, totality: -1 }, 'high');

    expect(over).toMatchObject({ prominences: 1, groundCrescents: 0, shadowBands: 0 });
    expect(under).toMatchObject({ prominences: 0, groundCrescents: 0, shadowBands: 0 });
  });
});
