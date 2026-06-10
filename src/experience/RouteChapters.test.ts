import { describe, expect, test } from 'vitest';
import { chapterForProgress } from './RouteChapters';

describe('route chapters', () => {
  test('maps progress to chapter labels', () => {
    expect(chapterForProgress(0)).toContain('Tunel');
    expect(chapterForProgress(0.2)).toContain('Stacja');
    expect(chapterForProgress(0.6)).toContain('Wiadukt');
    expect(chapterForProgress(0.95)).toContain('Tunel');
  });

  test('handles edge values without throwing', () => {
    expect(chapterForProgress(-0.2)).toBeTruthy();
    expect(chapterForProgress(2.4)).toBeTruthy();
  });
});
