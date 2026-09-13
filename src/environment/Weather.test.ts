import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createWorldRandom, DEFAULT_SIMULATION_SEED } from '../core/Random';
import { NO_EXTERNAL_WIND_FLOOR,
  CHECKPOINT_WIND_CLOCK,
  CLOUD_DOMAIN_RADIUS,
  CLOUD_LAYOUT_HALF_X,
  CLOUD_LAYOUT_HALF_Z,
  cloudEntryPoint,
  cloudEntryShape,
  cloudHasLeftTheSky,
  Weather,
} from './Weather';
import { OPENING_SHOT, OVERVIEW_SHOT, type CameraShot } from '../experience/ShotDefinitions';
import type { WindUniforms } from '../world/WorldGenerator';
import { WORLD_HALF_SIZE } from '../world/WorldLayout';

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
  // same angle, so the direction tests below pass a real stream instead. Both sources are
  // passed explicitly because both are required: see the constructor's own docblock.
  return new Weather(new THREE.Scene(), uniforms, () => 0.5, () => 0.5);
}

function createSeededWeather(seed: number, uniforms: WindUniforms): Weather {
  // Two streams off ONE world, exactly as `main.ts` builds it. This helper used to pass the
  // weather stream and leave the storm to a default, which handed every seed the default
  // world's storm — the defect the storm test below names.
  const world = createWorldRandom(seed);
  return new Weather(new THREE.Scene(), uniforms, world.stream('weather'), world.stream('storm'));
}

/**
 * A weather whose scene is kept, so a test can read the clouds as the RENDERER sees them.
 *
 * The deck is one `InstancedMesh` and its matrices are the only public record of where a
 * cloud is; a test that read a private field could pass while the picture stayed still.
 */
function createDeck(seed: number): {
  weather: Weather;
  clouds: THREE.InstancedMesh;
} {
  const scene = new THREE.Scene();
  const world = createWorldRandom(seed);
  const weather = new Weather(
    scene,
    createUniforms(),
    world.stream('weather'),
    world.stream('storm')
  );
  const clouds = scene.children.find(
    (child): child is THREE.InstancedMesh => (child as THREE.InstancedMesh).isInstancedMesh === true
  );
  if (!clouds) throw new Error('the cloud deck is not in the scene');
  return { weather, clouds };
}

/** Where the renderer will draw one cloud puff: the translation of its instance matrix. */
function puffAt(clouds: THREE.InstancedMesh, index: number): { x: number; z: number } {
  const matrix = new THREE.Matrix4();
  clouds.getMatrixAt(index, matrix);
  return { x: matrix.elements[12], z: matrix.elements[14] };
}

/** Every drawn puff, so a test can ask about the deck rather than about one cloud. */
function allPuffs(clouds: THREE.InstancedMesh): Array<{ x: number; z: number }> {
  return Array.from({ length: clouds.count }, (_, index) => puffAt(clouds, index));
}

/**
 * The share of the DRAWN deck that is over the city — the quantity a viewer actually sees.
 *
 * Measured on the instance matrices for the same reason `puffAt` exists: a cloud's private
 * `x`/`z` is not what the renderer draws, and a test that read it could pass while the sky
 * emptied. `WORLD_HALF_SIZE` is the city's own half-extent, so "over the city" is the
 * diorama's own number rather than one invented here.
 */
function cityCloudShare(clouds: THREE.InstancedMesh): number {
  let inside = 0;
  for (const puff of allPuffs(clouds)) {
    if (Math.hypot(puff.x, puff.z) < WORLD_HALF_SIZE) inside++;
  }
  return inside / clouds.count;
}

/** Where the renderer will draw one rain vertex: rain is LineSegments, two vertices a drop. */
function rainVertices(scene: THREE.Scene): Float32Array {
  const mesh = scene.children.find(
    (child): child is THREE.LineSegments => (child as THREE.LineSegments).isLineSegments === true
  );
  if (!mesh) throw new Error('the rain is not in the scene');
  return (mesh.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
}

/** Where the renderer will draw the snow: one vertex a flake. */
function snowVertices(scene: THREE.Scene): Float32Array {
  const mesh = scene.children.find(
    (child): child is THREE.Points => (child as THREE.Points).isPoints === true
  );
  if (!mesh) throw new Error('the snow is not in the scene');
  return (mesh.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
}

/** A weather whose scene is kept, so the precipitation can be read as the renderer sees it. */
function createFall(seed: number): { weather: Weather; scene: THREE.Scene } {
  const scene = new THREE.Scene();
  const world = createWorldRandom(seed);
  const weather = new Weather(
    scene,
    createUniforms(),
    world.stream('weather'),
    world.stream('storm')
  );
  return { weather, scene };
}

function run(weather: Weather, steps: number, delta: number): void {
  for (let step = 0; step < steps; step++) weather.update(delta, delta);
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

describe('the clouds answer the wind', () => {
  it('drifts the deck along the published vector, not toward +x for ever', () => {
    // The defect: `cloud.x += (cloud.speed + wind * 5) * cloudDelta`. The trees, the plume
    // and the balloon read a bearing; the sky did not, so in a wind blowing south the clouds
    // still crossed the picture west to east.
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('cloudy');
    // One tick first: the deck's matrices are written by `update`, so a reading taken before
    // the first one is the identity, not a cloud.
    run(weather, 1, 0.1);
    const before = puffAt(clouds, 0);
    run(weather, 120, 0.1);
    const after = puffAt(clouds, 0);

    const wind = weather.getWindVector();
    const dx = after.x - before.x;
    const dz = after.z - before.z;
    const travelled = Math.hypot(dx, dz);
    expect(travelled).toBeGreaterThan(5);
    // The drift is ALONG the wind: the unit of the displacement is the unit of the wind.
    expect((dx * wind.x + dz * wind.z) / travelled).toBeCloseTo(1, 3);
    // And the test is worth running: this wind is not the +x the old code assumed.
    expect(Math.abs(wind.z)).toBeGreaterThan(0.2);
    weather.dispose();
  });

  it('keeps every cloud its own speed, so the deck is not one slab', () => {
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('cloudy');
    run(weather, 1, 0.1);
    const before = allPuffs(clouds);
    run(weather, 120, 0.1);
    const after = allPuffs(clouds);

    const distances = after.map((puff, index) =>
      Math.hypot(puff.x - before[index].x, puff.z - before[index].z)
    );
    expect(Math.max(...distances)).toBeGreaterThan(Math.min(...distances) * 1.1);
    weather.dispose();
  });

  it('recycles a cloud that leaves the sky, at whatever bearing it left on', () => {
    // The wrap was written for +x: `if (cloud.x > RAIN_AREA) cloud.x = -RAIN_AREA`. On any
    // other bearing the clouds walk off one corner and the sky empties behind them.
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    run(weather, 6000, 0.1);

    const puffs = allPuffs(clouds);
    for (const puff of puffs) {
      expect(Math.hypot(puff.x, puff.z)).toBeLessThan(CLOUD_DOMAIN_RADIUS + 25);
    }
    // The sky has not emptied into a corner: the deck still spans the world both ways.
    const spanX = Math.max(...puffs.map((p) => p.x)) - Math.min(...puffs.map((p) => p.x));
    const spanZ = Math.max(...puffs.map((p) => p.z)) - Math.min(...puffs.map((p) => p.z));
    expect(spanX).toBeGreaterThan(120);
    expect(spanZ).toBeGreaterThan(120);
    weather.dispose();
  });

  it('re-enters upwind, on the sky boundary, at every bearing', () => {
    for (let step = 0; step < 24; step++) {
      const bearing = (step * Math.PI) / 12;
      const windX = Math.cos(bearing);
      const windZ = Math.sin(bearing);
      for (const cross of [-1, -0.5, 0, 0.37, 1]) {
        const entry = cloudEntryPoint(windX, windZ, cross);
        expect(Math.hypot(entry.x, entry.z)).toBeCloseTo(CLOUD_DOMAIN_RADIUS, 6);
        // Upwind: behind the world along the wind, so the cloud crosses rather than leaves.
        expect(entry.x * windX + entry.z * windZ).toBeLessThan(0);
        expect(cloudHasLeftTheSky(entry.x, entry.z)).toBe(false);
      }
    }
  });

  it('falls back to the old west-to-east entry when handed a direction that is not one', () => {
    for (const [x, z] of [[0, 0], [NaN, 1], [0, Infinity]]) {
      const entry = cloudEntryPoint(x, z, 0);
      expect(Number.isFinite(entry.x)).toBe(true);
      expect(Number.isFinite(entry.z)).toBe(true);
      expect(entry.x).toBeCloseTo(-CLOUD_DOMAIN_RADIUS, 6);
    }
  });

  it('bends a uniform cross-wind draw into a triangle, keeping the rim and the centre', () => {
    // The shaping on its own, without an hour of simulation in the way. It must be monotone
    // and fix -1, 0 and +1, or the boundary and the middle stop meaning what they mean.
    expect(cloudEntryShape(-1)).toBeCloseTo(-1, 12);
    expect(cloudEntryShape(0)).toBe(0);
    expect(cloudEntryShape(1)).toBeCloseTo(1, 12);
    expect(cloudEntryShape(-3)).toBeCloseTo(-1, 12);
    expect(cloudEntryShape(3)).toBeCloseTo(1, 12);
    let previous = -Infinity;
    for (let step = -100; step <= 100; step++) {
      const shaped = cloudEntryShape(step / 100);
      expect(shaped).toBeGreaterThan(previous);
      previous = shaped;
      // Odd, so neither side of the wind is favoured over the other.
      expect(shaped).toBeCloseTo(-cloudEntryShape(-step / 100), 12);
    }
    // Triangular: the density of |shaped| is 2(1 - s), so the share inside |s| < t is
    // t(2 - t). The half closest to the middle takes three quarters of the draws.
    const buckets = 2000;
    let inside = 0;
    for (let step = 0; step < buckets; step++) {
      if (Math.abs(cloudEntryShape((step + 0.5) / buckets)) < 0.5) inside++;
    }
    expect(inside / buckets).toBeCloseTo(0.75, 2);
  });

  it('keeps the deck as thick over the city after an hour as the sky is authored', () => {
    // The defect the bounding-span test above cannot see. Re-entry drew the cross-wind offset
    // UNIFORMLY over +/-0.75R, and a uniform entry profile IS a uniform steady-state areal
    // density -- so the deck spread from the box it is laid out in (260 by 240 m, 62 400 m^2)
    // over the whole swept band of the disc (87 104 m^2) and thinned by 28% doing it. The span
    // stayed over 120 m the whole time, because a bounding span is the one statistic that
    // cannot tell "spread out" from "spread thin": both make it larger.
    //
    // The reference is the density the sky is AUTHORED with -- the share of a uniform draw in
    // the layout box that lands over the city -- because that is a property of the deck rather
    // than of one seed's draw, and it therefore has no noise in it. Measured share of DRAWN
    // puffs, sampled for an hour per seed after the first 100 s of settling: 0.233 before this
    // change (0.72x the authored density), 0.320 after (0.99x).
    const authored =
      (Math.PI * WORLD_HALF_SIZE * WORLD_HALF_SIZE) /
      (4 * CLOUD_LAYOUT_HALF_X * CLOUD_LAYOUT_HALF_Z);
    expect(authored).toBeCloseTo(0.322, 3);

    const steadies: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const { weather, clouds } = createDeck(seed);
      weather.debugSetImmediate('cloudy');
      const samples: number[] = [];
      for (let block = 0; block < 600; block++) {
        run(weather, 10, 0.1);
        if (block > 100) samples.push(cityCloudShare(clouds));
      }
      steadies.push(samples.reduce((total, value) => total + value, 0) / samples.length);
      weather.dispose();
    }
    const steady = steadies.reduce((total, value) => total + value, 0) / steadies.length;
    expect(steady / authored).toBeGreaterThan(0.94);
    expect(steady / authored).toBeLessThan(1.06);
    // And no single seed has a sky that empties over the city while the others carry the mean.
    expect(Math.min(...steadies) / authored).toBeGreaterThan(0.8);
  });
});

describe('the rain blows with the world, not east', () => {
  it('drifts every drop along the published wind', () => {
    // The fifth consumer with no direction: `rainPositions[idx] += slant` moved +x and only
    // +x, so in the gale that this branch raised to 0.82 the rain blew due east while the
    // trees beside it leaned 58 degrees away from it.
    const { weather, scene } = createFall(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    run(weather, 1, 0.02);
    const before = Float32Array.from(rainVertices(scene));
    const steps = 20;
    const delta = 0.02;
    run(weather, steps, delta);
    const after = rainVertices(scene);

    const wind = weather.getWindVector();
    // The test is worth running only if this wind is not the +x the old code assumed.
    expect(Math.abs(wind.z)).toBeGreaterThan(0.2);

    const fall = 20 * steps * delta;
    let checked = 0;
    for (let drop = 0; drop < 200; drop++) {
      const idx = drop * 6;
      // A drop that hit the ground was respawned at a fresh place; its displacement is a draw,
      // not a drift. It is recognised by the fall it did NOT make.
      if (Math.abs(before[idx + 1] - after[idx + 1] - fall) > 1e-3) continue;
      const dx = after[idx] - before[idx];
      const dz = after[idx + 2] - before[idx + 2];
      const travelled = Math.hypot(dx, dz);
      expect(travelled).toBeGreaterThan(0.01);
      expect((dx * wind.x + dz * wind.z) / travelled).toBeCloseTo(1, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    weather.dispose();
  });

  it('leans the streak along the track the drop is actually on', () => {
    // A rain streak is not a sprite that happens to be tilted: it IS the drop's motion over
    // the exposure, so the segment has to be parallel to the drop's own velocity. The shipped
    // streak was a FIXED (0.2, -0.9, 0.1) offset -- 14 degrees off vertical toward a bearing
    // of 26.6 degrees, hard-coded -- while the branch's own docblock claimed the track was
    // 9.1 degrees off vertical along the wind. Two different tilts, neither reading the other.
    const { weather, scene } = createFall(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    run(weather, 1, 0.02);
    const before = Float32Array.from(rainVertices(scene));
    const steps = 20;
    const delta = 0.02;
    run(weather, steps, delta);
    const after = rainVertices(scene);
    const wind = weather.getWindVector();
    expect(Math.abs(wind.z)).toBeGreaterThan(0.2);

    const fall = 20 * steps * delta;
    let checked = 0;
    for (let drop = 0; drop < 200; drop++) {
      const idx = drop * 6;
      if (Math.abs(before[idx + 1] - after[idx + 1] - fall) > 1e-3) continue;
      // The drop's own track over the run, and the streak drawn at the end of it.
      const track = [
        after[idx] - before[idx],
        after[idx + 1] - before[idx + 1],
        after[idx + 2] - before[idx + 2],
      ];
      const streak = [
        after[idx + 3] - after[idx],
        after[idx + 4] - after[idx + 1],
        after[idx + 5] - after[idx + 2],
      ];
      const trackLength = Math.hypot(...track);
      const streakLength = Math.hypot(...streak);
      // Head to tail runs the same way the drop is going, so the cosine is +1.
      const cosine =
        (track[0] * streak[0] + track[1] * streak[1] + track[2] * streak[2]) /
        (trackLength * streakLength);
      expect(cosine).toBeGreaterThan(0.9999);
      // The parallelism above is dominated by the fall, which both vectors share, so on its
      // own it barely moves when the lean is wrong — the shipped fixed offset scored 0.9942.
      // The HORIZONTAL part is where the whole disagreement lives: it was a fixed bearing of
      // 26.6 degrees against a wind of 301.7, which is a dot product of 0.089.
      const acrossLength = Math.hypot(streak[0], streak[2]);
      expect(acrossLength).toBeGreaterThan(0.001);
      expect((streak[0] * wind.x + streak[2] * wind.z) / acrossLength).toBeCloseTo(1, 3);
      // And it is still a streak, not a dot or a smear: the length the deck shipped.
      // Four places, not more: these are Float32Array positions, and a drop 100 m out carries
      // its own rounding into the difference.
      expect(streakLength).toBeCloseTo(Math.hypot(0.2, 0.9, 0.1), 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    weather.dispose();
  });
});

describe('the snow blows with the world, and still wanders', () => {
  it('drifts the fall along the published wind', () => {
    // The sixth consumer: `(sin(...) * 0.5 + wind * 2.4)` put the whole drift on +x. The
    // wander is per-flake and zero-mean, so the DECK's mean displacement is the drift alone
    // and that is the quantity with a direction to get wrong.
    const { weather, scene } = createFall(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('snow');
    run(weather, 1, 0.02);
    const before = Float32Array.from(snowVertices(scene));
    run(weather, 100, 0.02);
    const after = snowVertices(scene);

    const wind = weather.getWindVector();
    expect(Math.abs(wind.z)).toBeGreaterThan(0.2);

    let sumX = 0;
    let sumZ = 0;
    let counted = 0;
    for (let flake = 0; flake < 1500; flake++) {
      const idx = flake * 3;
      // A respawned flake jumped back to the top; it is recognised by having risen.
      if (after[idx + 1] > before[idx + 1]) continue;
      sumX += after[idx] - before[idx];
      sumZ += after[idx + 2] - before[idx + 2];
      counted++;
    }
    expect(counted).toBeGreaterThan(1000);
    const meanX = sumX / counted;
    const meanZ = sumZ / counted;
    const travelled = Math.hypot(meanX, meanZ);
    expect(travelled).toBeGreaterThan(0.1);
    expect((meanX * wind.x + meanZ * wind.z) / travelled).toBeGreaterThan(0.97);
    weather.dispose();
  });

  it('keeps each flake its own wander, so the fall is not one sheet', () => {
    // The brief's other half: snow is slower and wanders more, and only its DIRECTION was
    // wrong. A drift that replaced the wander would be a curtain of glass.
    const { weather, scene } = createFall(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('snow');
    run(weather, 1, 0.02);
    const before = Float32Array.from(snowVertices(scene));
    run(weather, 100, 0.02);
    const after = snowVertices(scene);

    const horizontal: number[] = [];
    for (let flake = 0; flake < 1500; flake++) {
      const idx = flake * 3;
      if (after[idx + 1] > before[idx + 1]) continue;
      horizontal.push(Math.hypot(after[idx] - before[idx], after[idx + 2] - before[idx + 2]));
    }
    // Flakes a hundred steps apart in phase must not have travelled the same distance.
    expect(Math.max(...horizontal)).toBeGreaterThan(Math.min(...horizontal) * 2);
    weather.dispose();
  });
});

describe('rain blows a gale', () => {
  it('raises the wind in rain and leaves the other four weathers alone', () => {
    const weather = createWeather();
    const measured: Record<string, number> = {};
    for (const kind of ['clear', 'cloudy', 'rain', 'snow', 'fog'] as const) {
      weather.debugSetImmediate(kind);
      measured[kind] = weather.getWind();
    }
    expect(measured.rain).toBe(0.82);
    expect(measured.clear).toBe(0.16);
    expect(measured.cloudy).toBe(0.38);
    expect(measured.snow).toBe(0.3);
    expect(measured.fog).toBe(0.07);
    // The gale is the strongest weather by a clear margin, and still leaves headroom for a
    // live wind from REAL TIME mode, which is normalised to 1.
    expect(measured.rain).toBeGreaterThan(measured.cloudy * 2);
    expect(measured.rain).toBeLessThan(1);
    weather.dispose();
  });

  it('keeps the balloon on the ground for the whole shower, by cover alone', () => {
    // The owner's third sentence -- no balloon while it rains -- is already true, and this
    // pins it: `Balloon.update` gates on `cloudCover < 0.4`, and rain's cover is 0.92. The
    // crossfade is the part worth testing: every path INTO and OUT OF rain has to hold the
    // cover above that gate for as long as the rain is above the threshold that wets the
    // roads, or a balloon appears in a downpour for a few seconds.
    for (const from of ['clear', 'cloudy', 'snow', 'fog'] as const) {
      const weather = createWeather();
      weather.debugSetImmediate(from);
      weather.setExternal('rain', NO_EXTERNAL_WIND_FLOOR);
      for (let step = 0; step < 400; step++) {
        weather.update(0.05, 0.05);
        if (weather.getRainIntensity() > 0.4) expect(weather.getCloudCover()).toBeGreaterThan(0.4);
      }
      weather.setExternal(from, NO_EXTERNAL_WIND_FLOOR);
      for (let step = 0; step < 400; step++) {
        weather.update(0.05, 0.05);
        if (weather.getRainIntensity() > 0.4) expect(weather.getCloudCover()).toBeGreaterThan(0.4);
      }
      weather.dispose();
    }
  });
});

describe('the storm', () => {
  /** The flash trace of a weather stepped at 60 Hz. */
  function flashes(weather: Weather, steps: number): number[] {
    const trace: number[] = [];
    for (let step = 0; step < steps; step++) {
      weather.update(1 / 60, 1 / 60);
      trace.push(weather.getStormFlash());
    }
    return trace;
  }

  it('lights the clouds while it rains', () => {
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    const trace = flashes(weather, 60 * 60);
    expect(Math.max(...trace)).toBeGreaterThan(0.3);
    expect(trace.filter((value) => value > 0).length).toBeGreaterThan(10);
    // The flash reaches the deck through the instance colour the mesh already carries.
    expect(clouds.instanceColor).not.toBe(null);
    weather.dispose();
  });

  it('is exactly off, and the deck exactly white, in every dry weather', () => {
    // `toBe(0)`, not "close to": an eclipse frame, a clear noon and every luminance number
    // this project has measured must be untouched by a feature that did not exist for them.
    for (const kind of ['clear', 'cloudy', 'snow', 'fog'] as const) {
      const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
      weather.debugSetImmediate(kind);
      for (const value of flashes(weather, 60 * 120)) expect(value).toBe(0);
      for (const channel of clouds.instanceColor?.array ?? [1]) expect(channel).toBe(1);
      weather.dispose();
    }
  });

  it('leaves the deck exactly white again when the rain stops', () => {
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    flashes(weather, 60 * 60);
    weather.debugSetImmediate('clear');
    flashes(weather, 60);
    for (const channel of clouds.instanceColor?.array ?? [1]) expect(channel).toBe(1);
    expect(weather.getStormFlash()).toBe(0);
    weather.dispose();
  });

  it('never darkens a cloud below the colour it was', () => {
    const { weather, clouds } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    for (let step = 0; step < 60 * 90; step++) {
      weather.update(1 / 60, 1 / 60);
      if (weather.getStormFlash() > 0) {
        for (const channel of clouds.instanceColor?.array ?? [1]) {
          expect(channel).toBeGreaterThanOrEqual(1);
        }
      }
    }
    weather.dispose();
  });

  it('is dark at the second every checkpoint is photographed at', () => {
    const { weather } = createDeck(DEFAULT_SIMULATION_SEED);
    weather.debugSetImmediate('rain');
    flashes(weather, 60 * 30);
    weather.pinClock(CHECKPOINT_WIND_CLOCK);
    expect(weather.getStormFlash()).toBe(0);
    for (let frame = 0; frame < 120; frame++) {
      weather.update(0, 0);
      expect(weather.getStormFlash()).toBe(0);
    }
    weather.dispose();
  });

  it('is keyed to the world the caller asked for, never to a default it did not', () => {
    // `stormRandom = fallbackRandom('storm')` -- a default on a determinism slot. `fallbackRandom`
    // is `createWorldRandom()` with DEFAULT_SIMULATION_SEED, so EVERY caller that omitted the
    // fourth argument got one storm, the default seed's, whatever world it had asked for. It
    // was already happening here: `createSeededWeather` takes a seed and passes three
    // arguments. The repo has paid for this shape before -- a default let three warm-up calls
    // feed the night floor into a declination slot in silence.
    const trace = (weather: Weather): number[] => {
      weather.debugSetImmediate('rain');
      const values: number[] = [];
      for (let step = 0; step < 60 * 90; step++) {
        weather.update(1 / 60, 1 / 60);
        values.push(weather.getStormFlash());
      }
      return values;
    };
    const a = createSeededWeather(3, createUniforms());
    const b = createSeededWeather(4, createUniforms());
    const first = trace(a);
    const second = trace(b);
    expect(Math.max(...first)).toBeGreaterThan(0);
    expect(second).not.toEqual(first);
    a.dispose();
    b.dispose();
  });

  it('gives the same seed and the same clock the same storm, twice', () => {
    const first = createDeck(4242);
    const second = createDeck(4242);
    first.weather.debugSetImmediate('rain');
    second.weather.debugSetImmediate('rain');
    const a = flashes(first.weather, 60 * 90);
    const b = flashes(second.weather, 60 * 90);
    expect(b).toEqual(a);
    expect(Math.max(...a)).toBeGreaterThan(0);

    const other = createDeck(99);
    other.weather.debugSetImmediate('rain');
    expect(flashes(other.weather, 60 * 90)).not.toEqual(a);
    first.weather.dispose();
    second.weather.dispose();
    other.weather.dispose();
  });
});
