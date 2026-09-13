import * as THREE from 'three';
import type { WindUniforms } from '../world/WorldGenerator';
import type { QualityProfile } from '../performance/QualityManager';
import { fallbackRandom, type RandomSource } from '../core/Random';
import { GUST_SLOW_RATE, windBearingAt, windSeedFrom, type WindSeed, type WindVector } from './wind';
import {
  stormCloudBrightness,
  stormFlashAt,
  stormFocusAt,
  stormSeedFrom,
  type StormSeed,
} from './storm';
import type { Radians } from '../units';

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog';
export type WeatherSetting = WeatherKind | 'auto';

const RAIN_COUNT = 2200;
const RAIN_AREA = 150;
const RAIN_TOP = 42;
const RAIN_BOTTOM = -2;
const RAIN_FALL_SPEED = 20;

const SNOW_COUNT = 1500;
const SNOW_TOP = 40;
const SNOW_FALL_SPEED = 2.6;

const CLOUD_COUNT = 14;
const CLOUD_MIN_Y = 30;
const CLOUD_MAX_Y = 44;

/**
 * How far out a cloud may drift before the sky recycles it — a RADIUS, not an edge.
 *
 * The deck used to be wrapped on one axis (`if (cloud.x > RAIN_AREA) cloud.x = -RAIN_AREA`),
 * which is correct for exactly one bearing. Now that the clouds travel along the world's wind
 * the domain has to be the same shape from every direction, or a south-west wind piles the
 * whole deck into a corner and the sky empties behind it. A disc is that shape: it has no
 * corner, and the re-entry point is the boundary crossing of a straight line, whatever the
 * bearing.
 *
 * 180 m rather than `RAIN_AREA`'s 150, because the clouds are LAID OUT in a ±130 by ±120 box
 * whose far corner is 177 m out. A radius inside that would have recycled three clouds on the
 * first tick of the first load — a jump, at boot, in the shot everyone sees.
 */
export const CLOUD_DOMAIN_RADIUS = 180;

/** How much of the entry boundary the cross-wind draw may use; see {@link cloudEntryPoint}. */
const CLOUD_ENTRY_SPREAD = 0.75;

/**
 * A hair inside the boundary, so a re-entry cannot be read as an escape.
 *
 * An entry computed ON the circle lands within one ulp of it, and that rounding can fall
 * either side: `x² + z²` then exceeds `R²` by an epsilon, the escape test fires again on the
 * very next tick, and the cloud is recycled for ever without moving. 1e-9 of the radius is
 * 0.18 µm — invisible, and seven orders of magnitude above the rounding it is protecting from.
 */
const CLOUD_ENTRY_INSET = 1 - 1e-9;

/** Has this cloud left the sky the diorama keeps? Bearing-agnostic by construction. */
export function cloudHasLeftTheSky(x: number, z: number): boolean {
  return x * x + z * z > CLOUD_DOMAIN_RADIUS * CLOUD_DOMAIN_RADIUS;
}

/**
 * Where a recycled cloud comes back: the UPWIND boundary of the sky, at a fresh cross-wind
 * offset, so it crosses the world instead of reappearing where it left.
 *
 * `crossFraction` is -1..1 across the wind; the caller draws it, so the deck does not re-enter
 * in single file. It is scaled by {@link CLOUD_ENTRY_SPREAD} because an entry at the very edge
 * of the disc has a chord of nearly nothing to cross and would be recycled again within
 * seconds.
 *
 * A direction that is not a direction — both components zero, or either one NaN or infinite —
 * falls back to the west-to-east entry the deck had before it had a bearing, rather than
 * returning NaN and deleting a cloud in silence. The balloon's planner learned the same lesson
 * the expensive way; see `planBalloonCrossing`.
 */
export function cloudEntryPoint(
  windX: number,
  windZ: number,
  crossFraction: number
): { x: number; z: number } {
  const lengthSquared = windX * windX + windZ * windZ;
  let unitX = 1;
  let unitZ = 0;
  if (lengthSquared > 0 && Number.isFinite(lengthSquared)) {
    const inverse = 1 / Math.sqrt(lengthSquared);
    unitX = windX * inverse;
    unitZ = windZ * inverse;
  }
  const radius = CLOUD_DOMAIN_RADIUS * CLOUD_ENTRY_INSET;
  const across = THREE.MathUtils.clamp(crossFraction, -1, 1) * CLOUD_ENTRY_SPREAD * radius;
  const along = -Math.sqrt(Math.max(0, radius * radius - across * across));
  return {
    x: unitX * along - unitZ * across,
    z: unitZ * along + unitX * across,
  };
}

/**
 * Rain intensity below which the storm is EXACTLY off, and the intensity at which it is
 * fully on.
 *
 * The floor is the same 0.4 that decides whether the roads are wetting, so "it is raining
 * hard enough to soak the asphalt" and "it is raining hard enough to thunder" are one
 * threshold rather than two that can drift apart. `THREE.MathUtils.smoothstep` returns
 * literal zero at or below its lower bound, which is what makes every dry frame — an eclipse,
 * a clear noon, every luminance number already measured — arithmetically untouched.
 */
const STORM_RAIN_FLOOR = 0.4;
const STORM_RAIN_FULL = 0.75;

/** Reused for the instance-colour write, which happens only while a flash is alight. */
const CLOUD_FLASH_COLOR = new THREE.Color();

interface WeatherTargets {
  cloud: number;
  rain: number;
  snow: number;
  fogDensity: number;
  wind: number;
}

const TARGETS: Record<WeatherKind, WeatherTargets> = {
  clear: { cloud: 0.12, rain: 0, snow: 0, fogDensity: 0.003, wind: 0.16 },
  cloudy: { cloud: 0.78, rain: 0, snow: 0, fogDensity: 0.0048, wind: 0.38 },
  /**
   * Rain blows a gale: 0.62 -> 0.82, the owner's "większa wichura".
   *
   * The strength is a multiplier on every consumer at once, so the choice is one number and
   * four consequences. At 0.82 the gusted `uWind` runs 0.53 on the mean gust and 0.97 at the
   * top of one — 32% harder than 0.62 everywhere:
   *
   *  - the canopy's peak displacement rises with it, and the PEAK gusted `uWind` stays under
   *    1.0, which is the ceiling the foliage's lean/flutter split was measured against;
   *  - the plume's full-age drift goes 3.6 m -> 4.3 m on the mean against a 13 m rise, so the
   *    column leans distinctly without lying flat;
   *  - the rain's own horizontal drift goes 2.4 m/s -> 3.2 m/s against a 20 m/s fall, tilting
   *    a streak's track from 6.9 deg off vertical to 9.1 (16.2 at the top of a gust);
   *  - the balloon is unaffected: it is grounded in rain by cover, not by wind.
   *
   * Not 1.0: `setExternal` takes a live wind normalised to 1 and publishes
   * `max(target, live)`, so an authored weather at the ceiling would leave a real gale with
   * nothing to say. Only rain moved; the other four are the numbers they have always been.
   */
  rain: { cloud: 0.92, rain: 1, snow: 0, fogDensity: 0.0085, wind: 0.82 },
  snow: { cloud: 0.85, rain: 0, snow: 1, fogDensity: 0.0068, wind: 0.3 },
  fog: { cloud: 0.55, rain: 0, snow: 0, fogDensity: 0.03, wind: 0.07 },
};

/**
 * The second on the weather clock that every checkpoint is photographed at.
 *
 * A checkpoint claims to be one reproducible frame, so the clock its wind, its gust and its
 * foliage phase are functions of has to be STATED, not inherited from however many frames ran
 * before the lock landed. Zero, because a checkpoint is the world as it opens: the wind is
 * then the authored opening bearing (`WIND_BASE_BEARING` plus this seed's phases) and the
 * gust is at the start of its own slowest sine.
 */
export const CHECKPOINT_WIND_CLOCK = 0;

/** Weighted random transitions for the automatic weather machine. */
const TRANSITIONS: Record<WeatherKind, Array<[WeatherKind, number]>> = {
  clear: [['clear', 0.45], ['cloudy', 0.55]],
  cloudy: [['clear', 0.3], ['rain', 0.28], ['snow', 0.12], ['fog', 0.18], ['cloudy', 0.12]],
  rain: [['cloudy', 0.5], ['clear', 0.3], ['rain', 0.2]],
  snow: [['cloudy', 0.5], ['clear', 0.35], ['snow', 0.15]],
  fog: [['clear', 0.45], ['cloudy', 0.55]],
};

const WEATHER_LABELS: Record<WeatherKind, string> = {
  clear: 'SŁONECZNIE',
  cloudy: 'POCHMURNO',
  rain: 'DESZCZ',
  snow: 'ŚNIEG',
  fog: 'MGŁA',
};

interface CloudDescriptor {
  x: number;
  y: number;
  z: number;
  speed: number;
  /** Index range into the instanced mesh. */
  first: number;
  count: number;
  offsets: THREE.Vector3[];
  scales: number[];
  visibility: number;
}

function pickTransition(from: WeatherKind, random: RandomSource): WeatherKind {
  const options = TRANSITIONS[from];
  let roll = random();
  for (const [kind, weight] of options) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return options[options.length - 1][0];
}

export class Weather {
  private readonly random: RandomSource;
  private setting: WeatherSetting = 'auto';
  private kind: WeatherKind = 'clear';
  private externalKind: WeatherKind | null = null;
  private externalWind = 0;
  private nextChangeIn = 18;
  private elapsed = 0;
  /** 0..1 — how much snow is LYING on the world (accumulates / melts). */
  private snowCover = 0;
  /** 0..1 — how wet the roads are (builds in rain, dries afterwards). */
  private wetness = 0;
  /**
   * 0..1 — optically useful drops in a receding local rain curtain. This is
   * separate from road wetness: wet asphalt cannot create a rainbow.
   */
  private airborneMoisture = 0;

  private readonly values: WeatherTargets = { ...TARGETS.clear };

  private readonly scene: THREE.Scene;
  private readonly windUniforms: WindUniforms;

  private readonly rainGeometry: THREE.BufferGeometry;
  private readonly rainMaterial: THREE.LineBasicMaterial;
  private readonly rainMesh: THREE.LineSegments;
  private readonly rainPositions: Float32Array;

  private readonly snowGeometry: THREE.BufferGeometry;
  private readonly snowMaterial: THREE.PointsMaterial;
  private readonly snowMesh: THREE.Points;
  private readonly snowPositions: Float32Array;
  private readonly snowPhases: Float32Array;

  private readonly cloudMesh: THREE.InstancedMesh;
  private readonly cloudGeometry: THREE.BoxGeometry;
  private readonly cloudMaterial: THREE.MeshStandardMaterial;
  private readonly clouds: CloudDescriptor[] = [];
  private readonly cloudDummy = new THREE.Object3D();
  private activeRainCount = RAIN_COUNT;
  private activeSnowCount = SNOW_COUNT;
  private activeCloudCount = CLOUD_COUNT;
  private cloudUpdateAccumulator = 0;

  /** This session's bearing offsets; drawn once, in the constructor. */
  private readonly windSeed: WindSeed;
  /** This session's storm; drawn from a stream of its own. See {@link stormSeedFrom}. */
  private readonly stormSeed: StormSeed;
  /** 0..1 this frame's flash; exactly 0 whenever it is not raining hard enough to thunder. */
  private stormFlash = 0;
  /** Which cloud carries the current channel — an index into {@link Weather.clouds}. */
  private stormFocus = 0;
  /**
   * Whether the instance colours are currently anything but white.
   *
   * The deck is repainted only while a flash is alight AND for the one frame that puts it
   * out. A dry world never writes an instance colour at all, which is what "exactly off"
   * has to mean for a buffer.
   */
  private cloudsLit = false;
  /**
   * The published wind, reused rather than rebuilt.
   *
   * `getWindVector()` hands this same object out every frame, so the balloon reading it in
   * the actor tick costs no allocation. Callers must treat it as a live view of the wind,
   * not a snapshot: it is the one fact, and it keeps evolving underneath them.
   */
  private readonly windVector: WindVector = {
    x: 1,
    z: 0,
    strength: TARGETS.clear.wind,
    bearing: 0 as Radians,
  };

  constructor(
    scene: THREE.Scene,
    windUniforms: WindUniforms,
    random = fallbackRandom('weather'),
    stormRandom = fallbackRandom('storm')
  ) {
    this.scene = scene;
    this.windUniforms = windUniforms;
    this.random = random;

    // ── Rain (slanted streaks) ──
    this.rainPositions = new Float32Array(RAIN_COUNT * 2 * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (random() - 0.5) * RAIN_AREA * 2;
      const y = random() * (RAIN_TOP - RAIN_BOTTOM) + RAIN_BOTTOM;
      const z = (random() - 0.5) * RAIN_AREA * 2;
      const idx = i * 6;
      this.rainPositions[idx] = x;
      this.rainPositions[idx + 1] = y;
      this.rainPositions[idx + 2] = z;
      this.rainPositions[idx + 3] = x + 0.2;
      this.rainPositions[idx + 4] = y - 0.9;
      this.rainPositions[idx + 5] = z + 0.1;
    }
    this.rainGeometry = new THREE.BufferGeometry();
    this.rainGeometry.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rainMaterial = new THREE.LineBasicMaterial({
      color: 0xb8d4e8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.rainMesh = new THREE.LineSegments(this.rainGeometry, this.rainMaterial);
    this.rainMesh.visible = false;
    this.rainMesh.frustumCulled = false;
    scene.add(this.rainMesh);

    // ── Snow ──
    this.snowPositions = new Float32Array(SNOW_COUNT * 3);
    this.snowPhases = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      this.snowPositions[i * 3] = (random() - 0.5) * RAIN_AREA * 2;
      this.snowPositions[i * 3 + 1] = random() * SNOW_TOP;
      this.snowPositions[i * 3 + 2] = (random() - 0.5) * RAIN_AREA * 2;
      this.snowPhases[i] = random() * Math.PI * 2;
    }
    this.snowGeometry = new THREE.BufferGeometry();
    this.snowGeometry.setAttribute('position', new THREE.BufferAttribute(this.snowPositions, 3));
    this.snowMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.34,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.snowMesh = new THREE.Points(this.snowGeometry, this.snowMaterial);
    this.snowMesh.visible = false;
    this.snowMesh.frustumCulled = false;
    scene.add(this.snowMesh);

    // ── Voxel clouds (one instanced mesh, per-cloud drift & fade) ──
    this.cloudGeometry = new THREE.BoxGeometry(2.2, 1.4, 2.2);
    this.cloudMaterial = new THREE.MeshStandardMaterial({
      color: 0xf4f4f2,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.88,
    });
    this.cloudMaterial.envMapIntensity = 0.15;

    let totalInstances = 0;
    const cloudData: Array<{ offsets: THREE.Vector3[]; scales: number[] }> = [];
    for (let c = 0; c < CLOUD_COUNT; c++) {
      const puffs = 18 + Math.floor(random() * 16);
      const offsets: THREE.Vector3[] = [];
      const scales: number[] = [];
      const spreadX = 7 + random() * 6;
      for (let p = 0; p < puffs; p++) {
        const ox = (random() - 0.5) * 2 * spreadX;
        const oz = (random() - 0.5) * 2 * (spreadX * 0.55);
        const oy = (random() - 0.5) * 2.4 * (1 - Math.abs(ox) / (spreadX + 1));
        offsets.push(new THREE.Vector3(ox, oy, oz));
        scales.push(0.7 + random() * 0.9 * (1 - Math.abs(ox) / (spreadX + 2)));
      }
      cloudData.push({ offsets, scales });
      totalInstances += puffs;
    }

    this.cloudMesh = new THREE.InstancedMesh(this.cloudGeometry, this.cloudMaterial, totalInstances);
    this.cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /**
     * Allocate the per-instance colour ONCE, all white, at construction.
     *
     * This is what buys the storm zero new draw calls and zero new geometries: the deck is
     * already one `InstancedMesh`, and `instanceColor` gives every cloud in it a brightness of
     * its own for the price of a 3-float attribute (360 instances, 4.3 kB) and no second pass.
     *
     * Allocated here rather than at the first flash for two reasons. It keeps the program
     * stable — three compiles `USE_INSTANCING_COLOR` into the material the first time the
     * attribute exists, and doing that mid-flight would be a shader compile in the frame a
     * storm starts. And white is arithmetically nothing: `setColorAt(0, white)` fills the whole
     * attribute with 1.0 (`InstancedMesh.setColorAt` allocates `new Float32Array(n * 3).fill(1)`),
     * the vertex chunk multiplies `vColor` by it and the fragment multiplies `diffuseColor` by
     * that, and a multiply by exactly 1.0 is exact in IEEE 754. A dry frame renders the pixels
     * it rendered before.
     *
     * That the material respects it at all was checked in the pinned three build rather than
     * assumed: `color_fragment` guards on `USE_COLOR`, which the FRAGMENT prefix defines as
     * `parameters.vertexColors || parameters.instancingColor` (three r185,
     * `build/three.module.js`), and `instancingColor` is `object.instanceColor !== null`. So a
     * `MeshStandardMaterial` with `vertexColors` left false does take the instance colour, and
     * no material flag has to change here.
     */
    this.cloudMesh.setColorAt(0, CLOUD_FLASH_COLOR.setScalar(1));
    // Broad cloud shadows are both visually unstable and disproportionately
    // expensive. Cloud cover already attenuates the directional sun light.
    this.cloudMesh.castShadow = false;
    this.cloudMesh.frustumCulled = false;

    let cursor = 0;
    for (let c = 0; c < CLOUD_COUNT; c++) {
      const data = cloudData[c];
      this.clouds.push({
        x: (random() - 0.5) * 2 * (RAIN_AREA - 20),
        y: CLOUD_MIN_Y + random() * (CLOUD_MAX_Y - CLOUD_MIN_Y),
        z: (random() - 0.5) * 2 * (RAIN_AREA - 30),
        speed: 0.8 + random() * 0.7,
        first: cursor,
        count: data.offsets.length,
        offsets: data.offsets,
        scales: data.scales,
        visibility: 0,
      });
      cursor += data.offsets.length;
    }
    scene.add(this.cloudMesh);

    // Drawn LAST on purpose. Every draw above fixes a raindrop, a snowflake or a cloud
    // puff, and the stream is positional: taking three numbers earlier would have shifted
    // all of them and changed a world that several checkpoints are pinned to.
    this.windSeed = windSeedFrom(random);
    // A stream of its own, so a storm cannot move a raindrop. See `stormSeedFrom`.
    this.stormSeed = stormSeedFrom(stormRandom);
    this.publishWind(0);
  }

  /**
   * Recompute the one wind and push it everywhere that reads it.
   *
   * Both the TypeScript view and the shader uniform are written from the SAME two floats,
   * in one place, so a plume and the tree beside it cannot disagree.
   */
  private publishWind(elapsed: number): void {
    const bearing = windBearingAt(elapsed, this.values.wind, this.windSeed);
    const x = Math.cos(bearing);
    const z = Math.sin(bearing);
    this.windVector.x = x;
    this.windVector.z = z;
    this.windVector.strength = this.values.wind;
    this.windVector.bearing = bearing;
    this.windUniforms.uWindDir.value.set(x, z);
  }

  setQuality(profile: QualityProfile): void {
    this.activeRainCount = Math.max(200, Math.round(RAIN_COUNT * profile.particleDensity));
    this.activeSnowCount = Math.max(150, Math.round(SNOW_COUNT * profile.particleDensity));
    this.activeCloudCount = Math.max(4, Math.round(CLOUD_COUNT * profile.particleDensity));
    this.rainGeometry.setDrawRange(0, this.activeRainCount * 2);
    this.snowGeometry.setDrawRange(0, this.activeSnowCount);
    const lastCloud = this.clouds[this.activeCloudCount - 1];
    this.cloudMesh.count = lastCloud.first + lastCloud.count;
    this.cloudMesh.castShadow = false;
  }

  /** Transparent atmosphere must not contribute opaque normals to SSAO. */
  getOcclusionExclusions(): THREE.Object3D[] {
    return [this.rainMesh, this.snowMesh, this.cloudMesh];
  }

  /** Manual cycling (W key / UI): auto → clear → cloudy → rain → snow → fog → auto. */
  cycle(): WeatherSetting {
    const order: WeatherSetting[] = ['auto', 'clear', 'cloudy', 'rain', 'snow', 'fog'];
    this.setting = order[(order.indexOf(this.setting) + 1) % order.length];
    if (this.setting !== 'auto') {
      this.kind = this.setting as WeatherKind;
    }
    return this.setting;
  }

  getSetting(): WeatherSetting {
    return this.setting;
  }

  getKind(): WeatherKind {
    return this.kind;
  }

  getLabel(): string {
    if (this.externalKind !== null) return `NA ŻYWO · ${WEATHER_LABELS[this.kind]}`;
    const auto = this.setting === 'auto' ? 'AUTO · ' : '';
    return `${auto}${WEATHER_LABELS[this.kind]}`;
  }

  /** 0..1 — used by the sky for turbidity / star dimming. */
  getCloudCover(): number {
    return this.values.cloud;
  }

  /**
   * 0..1 current wind strength (smoothed, without gusts).
   *
   * Kept exactly as it was: the rainbow frame, the birds and the HUD want a strength and
   * nothing else, and direction arriving did not make them wrong.
   */
  getWind(): number {
    return this.values.wind;
  }

  /**
   * The world's one wind, direction included.
   *
   * The `(x, z)` pair points the way the wind BLOWS TOWARD — downwind — and is the same
   * pair the foliage and the plume read out of `uWindDir`. See `src/environment/wind.ts`
   * for why that sign and not the meteorological one.
   *
   * The returned object is REUSED between frames, so do not keep it expecting a snapshot.
   */
  getWindVector(): WindVector {
    return this.windVector;
  }

  /** 0..1 current precipitation intensity after weather cross-fading. */
  getRainIntensity(): number {
    return this.values.rain;
  }

  /**
   * 0..1 how hard the storm is flashing THIS frame — exactly 0 unless it is raining.
   *
   * The clouds are lit from inside by `Weather` itself, through the deck's instance colour.
   * This is the share of the flash that leaves the deck: `DayNightCycle` adds it to the
   * world's ambient and hemisphere fill so a flash lights the city a little, which is what a
   * storm does and what a cloud-only flash would look wrong without.
   */
  getStormFlash(): number {
    return this.stormFlash;
  }

  /**
   * Recompute the flash and, if anything is alight, repaint the deck.
   *
   * Called from `update`, from `pinClock` and from `debugSetImmediate` — every path that
   * moves this clock or this weather — so the storm is never a frame behind the state it is
   * a function of.
   */
  private updateStorm(): void {
    const gate = THREE.MathUtils.smoothstep(this.values.rain, STORM_RAIN_FLOOR, STORM_RAIN_FULL);
    // Literal zero below the floor, and therefore no write, no upload and no change to a
    // frame that has nothing to do with rain.
    this.stormFlash = gate > 0 ? gate * stormFlashAt(this.elapsed, this.stormSeed) : 0;
    if (this.stormFlash > 0) {
      this.stormFocus = Math.min(
        this.activeCloudCount - 1,
        Math.floor(stormFocusAt(this.elapsed, this.stormSeed) * this.activeCloudCount)
      );
    }
    if (this.stormFlash > 0 || this.cloudsLit) this.paintStorm();
  }

  /**
   * Write the per-cloud brightness into the deck's instance colour.
   *
   * Every puff of a cloud takes that cloud's own brightness, so a cell lights as one body
   * rather than dissolving into speckle. The whole deck lifts a little and the cell carrying
   * the channel lifts most — see {@link stormCloudBrightness}, which returns exactly 1 when
   * the flash is 0, so the frame that puts the storm out writes white and stops.
   */
  private paintStorm(): void {
    const focus = this.clouds[Math.min(this.stormFocus, this.activeCloudCount - 1)];
    // EVERY cloud, not just the active ones. A quality drop mid-flash shrinks the drawn count,
    // and a cloud left bright in the buffer would come back bright when the count grows again.
    for (let c = 0; c < this.clouds.length; c++) {
      const cloud = this.clouds[c];
      const brightness = stormCloudBrightness(
        this.stormFlash,
        Math.hypot(cloud.x - focus.x, cloud.z - focus.z)
      );
      CLOUD_FLASH_COLOR.setScalar(brightness);
      for (let p = 0; p < cloud.count; p++) {
        this.cloudMesh.setColorAt(cloud.first + p, CLOUD_FLASH_COLOR);
      }
    }
    if (this.cloudMesh.instanceColor) this.cloudMesh.instanceColor.needsUpdate = true;
    this.cloudsLit = this.stormFlash > 0;
  }

  /** 0..1 drops remaining in a local curtain after the foreground shower. */
  getAirborneMoisture(): number {
    return this.airborneMoisture;
  }

  /** 0..1 snow lying on roofs/grass — builds up while it snows, then melts. */
  getSnowCover(): number {
    return this.snowCover;
  }

  debugSetSnowCover(cover: number): void {
    this.snowCover = THREE.MathUtils.clamp(cover, 0, 1);
  }

  /** Deterministic post-rain state for checkpoints and browser validation. */
  debugSetAirborneMoisture(moisture: number): void {
    this.airborneMoisture = Number.isFinite(moisture)
      ? THREE.MathUtils.clamp(moisture, 0, 1)
      : 0;
  }

  /** 0..1 road wetness — mirror-like asphalt right after rain. */
  getWetness(): number {
    return this.wetness;
  }

  isClearNight(): boolean {
    return this.kind === 'clear';
  }

  /** Real-world weather override (REAL TIME mode). Pass null to release. */
  setExternal(kind: WeatherKind | null, windNorm = 0): void {
    this.externalKind = kind;
    this.externalWind = windNorm;
    if (kind !== null) this.kind = kind;
  }

  /** Deterministic state setter for browser smoke and performance scenarios. */
  debugSetImmediate(kind: WeatherKind): void {
    this.setExternal(kind);
    Object.assign(this.values, TARGETS[kind]);
    this.snowCover = kind === 'snow' ? 1 : 0;
    this.wetness = kind === 'rain' ? 1 : 0;
    if (kind === 'rain') this.airborneMoisture = 1;
    // This setter exists so a checkpoint lands on a state without waiting for the crossfade.
    // The wind vector is part of that state, so it jumps with the rest rather than staying
    // one frame behind on a paused clock. So is the storm: jumping OUT of rain has to put the
    // deck back to white on the same tick, not on the next one that happens to run.
    this.publishWind(this.elapsed);
    this.updateStorm();
  }

  /**
   * Put the weather clock on a stated second.
   *
   * The wind bearing, the gust and the foliage's `uTime` are all pure functions of this
   * clock, so this is the handle that makes them reproducible. It exists because the claim
   * "a checkpoint that pins the clock pins the wind" was not true when it was written: this
   * clock is an accumulator, a checkpoint lock merely stopped it wherever it had got to, and
   * no checkpoint path ever set it. Loading a checkpoint at boot happened to freeze it near
   * zero; loading one after a minute of watching would have frozen a different wind under the
   * same name. `applyBootCheckpoint` now calls this with {@link CHECKPOINT_WIND_CLOCK}, so a
   * checkpoint states its second instead of inheriting one.
   *
   * The storm phase hangs off this same clock: seeking it is a call here, not an offset to
   * wall time that nothing can reach.
   */
  pinClock(seconds: number): void {
    this.elapsed = seconds;
    this.windUniforms.uTime.value = seconds;
    this.publishWind(this.elapsed);
    // The storm is a pure function of this clock, which is the whole reason it was built that
    // way: seeking the clock seeks the storm, and `CHECKPOINT_WIND_CLOCK` is inside the quiet
    // lead of a slot, so a checkpoint is dark by construction rather than by luck of the seed.
    this.updateStorm();
  }

  /**
   * @param simDelta seconds of simulated time (scaled by clock speed)
   * @param presentationDelta seconds of the presentation clock — wall time, EXCEPT that a
   *   checkpoint lock freezes it to zero. Particles, the gust and the wind bearing animate on
   *   it, which is precisely why a checkpoint holds the wind still.
   */
  update(simDelta: number, presentationDelta: number): void {
    this.elapsed += presentationDelta;

    // ── State machine ──
    if (this.externalKind !== null) {
      this.kind = this.externalKind;
    } else if (this.setting === 'auto') {
      this.nextChangeIn -= simDelta;
      if (this.nextChangeIn <= 0) {
        this.kind = pickTransition(this.kind, this.random);
        this.nextChangeIn = 25 + this.random() * 35;
      }
    }

    // ── Crossfade toward targets ──
    const target = TARGETS[this.kind];
    const windTarget = this.externalKind !== null ? Math.max(target.wind, this.externalWind) : target.wind;
    const fade = 1 - Math.exp(-0.35 * Math.max(presentationDelta, 0.0001));
    this.values.cloud += (target.cloud - this.values.cloud) * fade;
    this.values.rain += (target.rain - this.values.rain) * fade;
    this.values.snow += (target.snow - this.values.snow) * fade;
    this.values.fogDensity += (target.fogDensity - this.values.fogDensity) * fade;
    this.values.wind += (windTarget - this.values.wind) * fade;

    // ── Snow accumulation: builds while snowing, slowly melts otherwise ──
    const snowing = this.values.snow > 0.45;
    this.snowCover = Math.min(
      1,
      Math.max(0, this.snowCover + (snowing ? presentationDelta * 0.045 : -presentationDelta * 0.012))
    );

    // ── Road wetness: soaks fast in rain, dries slowly afterwards ──
    const raining = this.values.rain > 0.4;
    this.wetness = Math.min(
      1,
      Math.max(0, this.wetness + (raining ? presentationDelta * 0.09 : -presentationDelta * 0.016))
    );

    // A local curtain can outlive the foreground shower over the lake or park.
    // Wind moves/clears it faster, but never introduces randomness here.
    const moistureDelta = raining
      ? presentationDelta * (0.055 + this.values.rain * 0.08)
      : -presentationDelta * (0.012 + this.values.wind * 0.012);
    this.airborneMoisture = THREE.MathUtils.clamp(
      this.airborneMoisture + moistureDelta,
      0,
      1
    );

    // ── Fog density (colour is owned by DayNightCycle) ──
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) fog.density = this.values.fogDensity;

    // ── Gusty wind uniform for trees / particles ──
    // The slowest term's rate comes from `wind.ts` because the bearing's gust veer rides that
    // same sine, argument for argument. Written twice, the two would drift apart and the wind
    // would veer on one schedule while it strengthened on another.
    const gust =
      0.65 +
      0.25 * Math.sin(this.elapsed * GUST_SLOW_RATE) +
      0.18 * Math.sin(this.elapsed * 2.3 + 1.7) +
      0.1 * Math.sin(this.elapsed * 5.1 + 0.4);
    const wind = this.values.wind * Math.max(0.2, gust);
    this.windUniforms.uWind.value = wind;
    this.windUniforms.uTime.value = this.elapsed;
    // Direction is published from the same tick as strength, so nothing downstream can read
    // this frame's gust against last frame's bearing.
    this.publishWind(this.elapsed);

    // ── The storm ──
    // Evaluated at full frame rate, not on the clouds' own 24 Hz budget: a stroke lives 0.15 s
    // and re-strikes 0.11 s apart, so sampling the flicker four times a flash would turn the
    // thing that makes it read as lightning into a square wave.
    this.updateStorm();

    // ── Rain ──
    const rainAlpha = this.values.rain;
    this.rainMesh.visible = rainAlpha > 0.02;
    this.rainMaterial.opacity = 0.45 * rainAlpha;
    if (this.rainMesh.visible) {
      const dy = RAIN_FALL_SPEED * presentationDelta;
      const slant = wind * 6 * presentationDelta;
      for (let i = 0; i < this.activeRainCount; i++) {
        const idx = i * 6;
        this.rainPositions[idx + 1] -= dy;
        this.rainPositions[idx + 4] -= dy;
        this.rainPositions[idx] += slant;
        this.rainPositions[idx + 3] += slant;
        if (this.rainPositions[idx + 1] < RAIN_BOTTOM) {
          const x = (this.random() - 0.5) * RAIN_AREA * 2;
          const z = (this.random() - 0.5) * RAIN_AREA * 2;
          this.rainPositions[idx] = x;
          this.rainPositions[idx + 1] = RAIN_TOP;
          this.rainPositions[idx + 2] = z;
          this.rainPositions[idx + 3] = x + 0.2;
          this.rainPositions[idx + 4] = RAIN_TOP - 0.9;
          this.rainPositions[idx + 5] = z + 0.1;
        }
      }
      (this.rainGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // ── Snow ──
    const snowAlpha = this.values.snow;
    this.snowMesh.visible = snowAlpha > 0.02;
    this.snowMaterial.opacity = 0.9 * snowAlpha;
    if (this.snowMesh.visible) {
      const dy = SNOW_FALL_SPEED * presentationDelta;
      for (let i = 0; i < this.activeSnowCount; i++) {
        const idx = i * 3;
        this.snowPositions[idx + 1] -= dy * (0.7 + 0.3 * Math.sin(this.snowPhases[i]));
        this.snowPositions[idx] +=
          (Math.sin(this.elapsed * 0.8 + this.snowPhases[i]) * 0.5 + wind * 2.4) * presentationDelta;
        this.snowPositions[idx + 2] += Math.cos(this.elapsed * 0.6 + this.snowPhases[i]) * 0.4 * presentationDelta;
        if (this.snowPositions[idx + 1] < -1) {
          this.snowPositions[idx] = (this.random() - 0.5) * RAIN_AREA * 2;
          this.snowPositions[idx + 1] = SNOW_TOP;
          this.snowPositions[idx + 2] = (this.random() - 0.5) * RAIN_AREA * 2;
        }
      }
      (this.snowGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // ── Clouds drift in with cover, drift out without it ──
    // Their slow, distant motion does not benefit from 60 matrix uploads per
    // second. Updating at 24 Hz saves CPU and GPU traffic while rain, snow,
    // actors and the train remain full-rate.
    this.cloudUpdateAccumulator += presentationDelta;
    if (this.cloudUpdateAccumulator >= 1 / 24) {
      const cloudDelta = Math.min(this.cloudUpdateAccumulator, 0.15);
      this.cloudUpdateAccumulator = 0;
      const visibleClouds = Math.round(this.values.cloud * this.activeCloudCount);
      // The deck answers the world's one wind, like the trees, the plume and the balloon. It
      // was the fourth consumer with no direction: `cloud.x += ...` drifted every cloud toward
      // +x in every weather for ever, so in a wind blowing south the sky still crossed the
      // picture west to east. The per-cloud `speed` stays — it is what keeps the deck from
      // travelling as one slab — and only its AXIS is now shared.
      const driftX = this.windVector.x;
      const driftZ = this.windVector.z;
      for (let c = 0; c < this.activeCloudCount; c++) {
        const cloud = this.clouds[c];
        const wantVisible = c < visibleClouds ? 1 : 0;
        cloud.visibility += (wantVisible - cloud.visibility) * Math.min(1, cloudDelta * 0.5);
        const travelled = (cloud.speed + wind * 5) * cloudDelta;
        cloud.x += driftX * travelled;
        cloud.z += driftZ * travelled;
        if (cloudHasLeftTheSky(cloud.x, cloud.z)) {
          // One draw per recycle, exactly as before -- the old wrap drew a fresh `z` here. The
          // stream's consumption is unchanged, so no raindrop moves because a cloud wrapped.
          const entry = cloudEntryPoint(driftX, driftZ, this.random() * 2 - 1);
          cloud.x = entry.x;
          cloud.z = entry.z;
        }

        const s = cloud.visibility;
        for (let p = 0; p < cloud.count; p++) {
          const offset = cloud.offsets[p];
          this.cloudDummy.position.set(cloud.x + offset.x, cloud.y + offset.y, cloud.z + offset.z);
          const scale = cloud.scales[p] * s;
          this.cloudDummy.scale.setScalar(Math.max(scale, 0.0001));
          this.cloudDummy.rotation.set(0, 0, 0);
          this.cloudDummy.updateMatrix();
          this.cloudMesh.setMatrixAt(cloud.first + p, this.cloudDummy.matrix);
        }
      }
      this.cloudMesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.scene.remove(this.rainMesh, this.snowMesh, this.cloudMesh);
    this.rainGeometry.dispose();
    this.rainMaterial.dispose();
    this.snowGeometry.dispose();
    this.snowMaterial.dispose();
    this.cloudGeometry.dispose();
    this.cloudMaterial.dispose();
    this.cloudMesh.dispose();
  }
}
