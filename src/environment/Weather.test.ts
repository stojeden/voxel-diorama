import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createWorldRandom, DEFAULT_SIMULATION_SEED } from '../core/Random';
import { CHECKPOINT_WIND_CLOCK, Weather } from './Weather';
import { OPENING_SHOT, OVERVIEW_SHOT, type CameraShot } from '../experience/ShotDefinitions';
import type { WindUniforms } from '../world/WorldGenerator';

/** The ground bearing a shot looks along, in the wind's own convention (x = cos, z = sin). */
function viewBearing(shot: CameraShot): number {
  return Math.atan2(shot.target[2] - shot.position[2], shot.target[0] - shot.position[0]);
}

/** Degrees between a wind bearing and a view LINE: 0 runs down it, 90 crosses it. */
function offViewAxisDeg(bearing: number, view: number): number {
  const between = Math.abs(Math.atan2(Math.sin(bearing - view), Math.cos(bearing - view)));
  return (Math.min(between, Math.PI - between) * 180) / Math.PI;
}

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

  it('puts the production wind ACROSS the opening shot, at the second it opens on', () => {
    // The blocker this whole change exists for, measured on the world as it actually boots:
    // the default seed, the weather stream's real draw order (the wind's phases are taken
    // last, after every raindrop), clear weather, second zero.
    //
    // Before: 242.6 deg, which is 10.7 deg off the opening camera's own view bearing of
    // 231.8 deg -- the balloon entered off-frame and receded down the middle of the picture
    // instead of crossing it. After: 301.7 deg, 69.9 deg off that axis.
    const weather = createSeededWeather(DEFAULT_SIMULATION_SEED, createUniforms());
    const bearing = weather.getWindVector().bearing;
    expect(offViewAxisDeg(bearing, viewBearing(OPENING_SHOT))).toBeGreaterThan(60);
    expect(offViewAxisDeg(bearing, viewBearing(OVERVIEW_SHOT))).toBeGreaterThan(60);
    // Still crossing a minute and a half in, which is the span a viewer watches one balloon
    // cross: the veer must not undo the authoring before the first flight lands.
    for (let second = 0; second < 90; second++) weather.update(1, 1);
    expect(offViewAxisDeg(weather.getWindVector().bearing, viewBearing(OPENING_SHOT)))
      .toBeGreaterThan(45);
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

describe('a checkpoint pins the weather clock', () => {
  it('states the second rather than inheriting the frames that ran before the lock', () => {
    // The module header claimed "a checkpoint that pins the clock pins the wind with it"
    // while nothing pinned this clock: it is an accumulator, and a checkpoint lock only
    // stopped it wherever it had got to. A session watched for two minutes and then sent to a
    // checkpoint froze a different wind under the same checkpoint name than one that had just
    // loaded — same seed, same name, two pictures.
    const justLoaded = createSeededWeather(5, createUniforms());
    const watchedForAWhile = createSeededWeather(5, createUniforms());
    for (let second = 0; second < 120; second++) watchedForAWhile.update(1, 1);
    expect(watchedForAWhile.getWindVector().bearing).not.toBe(justLoaded.getWindVector().bearing);

    for (const weather of [justLoaded, watchedForAWhile]) weather.pinClock(CHECKPOINT_WIND_CLOCK);
    expect(watchedForAWhile.getWindVector().bearing).toBe(justLoaded.getWindVector().bearing);
    justLoaded.dispose();
    watchedForAWhile.dispose();
  });

  it('pins the foliage phase with it, because the canopy reads the same clock', () => {
    const uniforms = createUniforms();
    const weather = createSeededWeather(5, uniforms);
    for (let second = 0; second < 30; second++) weather.update(1, 1);
    expect(uniforms.uTime.value).toBeGreaterThan(0);
    weather.pinClock(CHECKPOINT_WIND_CLOCK);
    expect(uniforms.uTime.value).toBe(CHECKPOINT_WIND_CLOCK);
    weather.dispose();
  });

  it('holds the wind still while the lock freezes the presentation delta', () => {
    // What a checkpoint then relies on: the bearing is a function of this clock alone, so a
    // frozen delta is a frozen wind however many frames are drawn.
    const weather = createSeededWeather(5, createUniforms());
    weather.pinClock(CHECKPOINT_WIND_CLOCK);
    const pinned = weather.getWindVector().bearing;
    for (let frame = 0; frame < 60; frame++) weather.update(0, 0);
    expect(weather.getWindVector().bearing).toBe(pinned);
    weather.dispose();
  });
});
