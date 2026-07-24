import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Weather } from './Weather';
import type { WindUniforms } from '../world/WorldGenerator';

function createWeather(): Weather {
  const wind: WindUniforms = {
    uTime: { value: 0 },
    uWind: { value: 0 },
  };
  return new Weather(new THREE.Scene(), wind, () => 0.5);
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
