import { describe, expect, it } from 'vitest';
import { createWorldRandom, normalizeSeed } from './Random';

describe('WorldRandom', () => {
  it('keeps direct global randomness out of production sources', () => {
    const sources = import.meta.glob('../**/*.ts', {
      eager: true,
      query: '?raw',
      import: 'default',
    }) as Record<string, string>;
    const forbidden = ['Math', 'random'].join('.');
    const offenders = Object.entries(sources)
      .filter(([path, source]) => !path.endsWith('.test.ts') && source.includes(forbidden))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('repeats a scoped sequence for the same seed', () => {
    const a = createWorldRandom(42).stream('weather');
    const b = createWorldRandom(42).stream('weather');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('keeps scopes independent from draws in another scope', () => {
    const first = createWorldRandom(42);
    const weather = first.stream('weather');
    const birds = first.stream('birds');
    weather();
    weather();
    const expectedBird = birds();

    const second = createWorldRandom(42);
    expect(second.stream('birds')()).toBe(expectedBird);
  });

  it('supports numeric and human-readable seeds', () => {
    expect(normalizeSeed('42')).toBe(42);
    expect(normalizeSeed('diorama')).toBe(normalizeSeed('diorama'));
    expect(normalizeSeed('diorama')).not.toBe(normalizeSeed('another'));
  });

  it('offers stateless indexed samples', () => {
    const random = createWorldRandom(7);
    expect(random.sample('cloud', 3)).toBe(random.sample('cloud', 3));
    expect(random.sample('cloud', 3)).not.toBe(random.sample('cloud', 4));
  });
});
