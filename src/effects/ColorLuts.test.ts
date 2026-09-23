import { describe, expect, test } from 'vitest';
import { ColorLutPipeline } from './ColorLuts';

/**
 * Re-picking the theme that is already showing must not touch its colour grade.
 *
 * The same-id case used to share the classic branch, whose one-way fade takes the active
 * table's strength from full to zero: a settled re-click of Retro, Złota jesień or Zabawkowy
 * faded its grade out and left it off until another theme was chosen.
 */
describe('a theme blended with itself holds its grade', () => {
  test.each(['retro', 'autumn', 'toy'])('%s', (id) => {
    const luts = new ColorLutPipeline();
    luts.setThemeBlend('classic', id, 1);
    const settled = luts.themeEffect.blendMode.opacity.value;
    expect(settled, 'the theme has no grade, so this test means nothing').toBeGreaterThan(0);
    for (const t of [0, 0.5, 1]) {
      luts.setThemeBlend(id, id, t);
      expect(luts.themeEffect.blendMode.opacity.value).toBeCloseTo(settled, 6);
    }
    luts.dispose();
  });

  test('classic with itself stays at no grade at all', () => {
    const luts = new ColorLutPipeline();
    luts.setThemeBlend('classic', 'classic', 1);
    expect(luts.themeEffect.blendMode.opacity.value).toBe(0);
    luts.dispose();
  });
});
