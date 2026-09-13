import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createWorldRandom } from '../core/Random';
import { Weather } from './Weather';
import type { WindUniforms } from '../world/WorldGenerator';

function createUniforms(): WindUniforms {
  return {
    uTime: { value: 0 },
    uWind: { value: 0 },
    uWindDir: { value: new THREE.Vector2(1, 0) },
  };
}

function createWeather(uniforms: WindUniforms = createUniforms()): Weather {
  // A constant source is fine for everything else here, but it makes every wind seed the
  // same angle, so the direction tests below pass a real stream instead.
  return new Weather(new THREE.Scene(), uniforms, () => 0.5);
}

function createSeededWeather(seed: number, uniforms: WindUniforms): Weather {
  return new Weather(new THREE.Scene(), uniforms, createWorldRandom(seed).stream('weather'));
}

describe('Weather post-rain moisture', () => {
  it('persists after visible rain and then decays monotonically', () => {
    const weather = createWeather();
    weather.debugSetImmediate('rain');
    expect(weather.getAirborneMoisture()).toBe(1);

    weather.debugSetImmediate('clear');
    const before = weather.getAirborneMoisture();
    weather.update(1, 1);
    const after = weather.getAirborneMoisture();

    expect(weather.getRainIntensity()).toBe(0);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    weather.dispose();
  });

  it('clears a local rain curtain faster in stronger wind', () => {
    const calm = createWeather();
    const windy = createWeather();
    for (const weather of [calm, windy]) {
      weather.debugSetImmediate('clear');
      weather.debugSetAirborneMoisture(1);
    }
    calm.setExternal('clear', 0);
    windy.setExternal('clear', 1);
    calm.update(1, 8);
    windy.update(1, 8);

    expect(windy.getAirborneMoisture()).toBeLessThan(calm.getAirborneMoisture());
    calm.dispose();
    windy.dispose();
  });

  it('keeps moisture distinct from wet asphalt and stable on a frozen frame', () => {
    const weather = createWeather();
    weather.debugSetImmediate('clear');
    weather.debugSetAirborneMoisture(0.8);
    expect(weather.getWetness()).toBe(0);

    weather.update(0, 0);
    expect(weather.getAirborneMoisture()).toBe(0.8);
    expect(weather.getWetness()).toBe(0);
    weather.dispose();
  });

  it('rejects non-finite debug moisture values', () => {
    const weather = createWeather();
    weather.debugSetAirborneMoisture(Number.NaN);
    expect(weather.getAirborneMoisture()).toBe(0);
    weather.debugSetAirborneMoisture(Number.POSITIVE_INFINITY);
    expect(weather.getAirborneMoisture()).toBe(0);
    weather.debugSetAirborneMoisture(Number.NEGATIVE_INFINITY);
    expect(weather.getAirborneMoisture()).toBe(0);
    weather.dispose();
  });
});

describe('Weather publishes one wind', () => {
  it('hands shaders and TypeScript callers the same two floats', () => {
    // The whole point of the change: a plume and the tree beside it cannot lean differently
    // if they are reading one pair of numbers written in one place.
    const uniforms = createUniforms();
    const weather = createSeededWeather(11, uniforms);
    weather.update(1, 1);
    const vector = weather.getWindVector();
    expect(uniforms.uWindDir.value.x).toBe(vector.x);
    expect(uniforms.uWindDir.value.y).toBe(vector.z);
    weather.dispose();
  });

  it('publishes a unit vector at every moment of an hour', () => {
    // Relocated from the plume's test, which used to own the only direction in the world.
    const uniforms = createUniforms();
    const weather = createSeededWeather(11, uniforms);
    weather.debugSetImmediate('rain');
    for (let minute = 0; minute < 60; minute++) {
      weather.update(60, 60);
      const vector = weather.getWindVector();
      expect(Math.hypot(vector.x, vector.z)).toBeCloseTo(1, 9);
      expect(Math.hypot(uniforms.uWindDir.value.x, uniforms.uWindDir.value.y)).toBeCloseTo(1, 6);
    }
    weather.dispose();
  });

  it('keeps getWind() the scalar its callers already read', () => {
    // The rainbow frame, the birds and the HUD want a strength and nothing else; the vector
    // carries the same number so the two can never disagree about how hard it is blowing.
    const weather = createWeather();
    weather.debugSetImmediate('rain');
    weather.update(1, 1);
    expect(weather.getWindVector().strength).toBe(weather.getWind());
    expect(weather.getWind()).toBeGreaterThan(0);
    expect(weather.getWind()).toBeLessThanOrEqual(1);
    weather.dispose();
  });

  it('gives two sessions different winds', () => {
    const a = createSeededWeather(3, createUniforms());
    const b = createSeededWeather(4, createUniforms());
    a.update(1, 1);
    b.update(1, 1);
    const first = a.getWindVector();
    const second = b.getWindVector();
    expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThan(0.1);
    a.dispose();
    b.dispose();
  });
});
