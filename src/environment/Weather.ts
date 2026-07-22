import * as THREE from 'three';
import type { WindUniforms } from '../world/WorldGenerator';
import type { QualityProfile } from '../performance/QualityManager';

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
  rain: { cloud: 0.92, rain: 1, snow: 0, fogDensity: 0.0085, wind: 0.62 },
  snow: { cloud: 0.85, rain: 0, snow: 1, fogDensity: 0.0068, wind: 0.3 },
  fog: { cloud: 0.55, rain: 0, snow: 0, fogDensity: 0.03, wind: 0.07 },
};

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

function pickTransition(from: WeatherKind): WeatherKind {
  const options = TRANSITIONS[from];
  let roll = Math.random();
  for (const [kind, weight] of options) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return options[options.length - 1][0];
}

export class Weather {
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

  constructor(scene: THREE.Scene, windUniforms: WindUniforms) {
    this.scene = scene;
    this.windUniforms = windUniforms;

    // ── Rain (slanted streaks) ──
    this.rainPositions = new Float32Array(RAIN_COUNT * 2 * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (Math.random() - 0.5) * RAIN_AREA * 2;
      const y = Math.random() * (RAIN_TOP - RAIN_BOTTOM) + RAIN_BOTTOM;
      const z = (Math.random() - 0.5) * RAIN_AREA * 2;
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
      this.snowPositions[i * 3] = (Math.random() - 0.5) * RAIN_AREA * 2;
      this.snowPositions[i * 3 + 1] = Math.random() * SNOW_TOP;
      this.snowPositions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA * 2;
      this.snowPhases[i] = Math.random() * Math.PI * 2;
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
      const puffs = 18 + Math.floor(Math.random() * 16);
      const offsets: THREE.Vector3[] = [];
      const scales: number[] = [];
      const spreadX = 7 + Math.random() * 6;
      for (let p = 0; p < puffs; p++) {
        const ox = (Math.random() - 0.5) * 2 * spreadX;
        const oz = (Math.random() - 0.5) * 2 * (spreadX * 0.55);
        const oy = (Math.random() - 0.5) * 2.4 * (1 - Math.abs(ox) / (spreadX + 1));
        offsets.push(new THREE.Vector3(ox, oy, oz));
        scales.push(0.7 + Math.random() * 0.9 * (1 - Math.abs(ox) / (spreadX + 2)));
      }
      cloudData.push({ offsets, scales });
      totalInstances += puffs;
    }

    this.cloudMesh = new THREE.InstancedMesh(this.cloudGeometry, this.cloudMaterial, totalInstances);
    this.cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Broad cloud shadows are both visually unstable and disproportionately
    // expensive. Cloud cover already attenuates the directional sun light.
    this.cloudMesh.castShadow = false;
    this.cloudMesh.frustumCulled = false;

    let cursor = 0;
    for (let c = 0; c < CLOUD_COUNT; c++) {
      const data = cloudData[c];
      this.clouds.push({
        x: (Math.random() - 0.5) * 2 * (RAIN_AREA - 20),
        y: CLOUD_MIN_Y + Math.random() * (CLOUD_MAX_Y - CLOUD_MIN_Y),
        z: (Math.random() - 0.5) * 2 * (RAIN_AREA - 30),
        speed: 0.8 + Math.random() * 0.7,
        first: cursor,
        count: data.offsets.length,
        offsets: data.offsets,
        scales: data.scales,
        visibility: 0,
      });
      cursor += data.offsets.length;
    }
    scene.add(this.cloudMesh);
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

  /** 0..1 current wind strength (smoothed, without gusts). */
  getWind(): number {
    return this.values.wind;
  }

  /** 0..1 snow lying on roofs/grass — builds up while it snows, then melts. */
  getSnowCover(): number {
    return this.snowCover;
  }

  debugSetSnowCover(cover: number): void {
    this.snowCover = THREE.MathUtils.clamp(cover, 0, 1);
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
  }

  /**
   * @param simDelta seconds of simulated time (scaled by clock speed)
   * @param realDelta seconds of wall-clock time (particles animate on this)
   */
  update(simDelta: number, realDelta: number): void {
    this.elapsed += realDelta;

    // ── State machine ──
    if (this.externalKind !== null) {
      this.kind = this.externalKind;
    } else if (this.setting === 'auto') {
      this.nextChangeIn -= simDelta;
      if (this.nextChangeIn <= 0) {
        this.kind = pickTransition(this.kind);
        this.nextChangeIn = 25 + Math.random() * 35;
      }
    }

    // ── Crossfade toward targets ──
    const target = TARGETS[this.kind];
    const windTarget = this.externalKind !== null ? Math.max(target.wind, this.externalWind) : target.wind;
    const fade = 1 - Math.exp(-0.35 * Math.max(realDelta, 0.0001));
    this.values.cloud += (target.cloud - this.values.cloud) * fade;
    this.values.rain += (target.rain - this.values.rain) * fade;
    this.values.snow += (target.snow - this.values.snow) * fade;
    this.values.fogDensity += (target.fogDensity - this.values.fogDensity) * fade;
    this.values.wind += (windTarget - this.values.wind) * fade;

    // ── Snow accumulation: builds while snowing, slowly melts otherwise ──
    const snowing = this.values.snow > 0.45;
    this.snowCover = Math.min(
      1,
      Math.max(0, this.snowCover + (snowing ? realDelta * 0.045 : -realDelta * 0.012))
    );

    // ── Road wetness: soaks fast in rain, dries slowly afterwards ──
    const raining = this.values.rain > 0.4;
    this.wetness = Math.min(
      1,
      Math.max(0, this.wetness + (raining ? realDelta * 0.09 : -realDelta * 0.016))
    );

    // ── Fog density (colour is owned by DayNightCycle) ──
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) fog.density = this.values.fogDensity;

    // ── Gusty wind uniform for trees / particles ──
    const gust =
      0.65 +
      0.25 * Math.sin(this.elapsed * 0.9) +
      0.18 * Math.sin(this.elapsed * 2.3 + 1.7) +
      0.1 * Math.sin(this.elapsed * 5.1 + 0.4);
    const wind = this.values.wind * Math.max(0.2, gust);
    this.windUniforms.uWind.value = wind;
    this.windUniforms.uTime.value = this.elapsed;

    // ── Rain ──
    const rainAlpha = this.values.rain;
    this.rainMesh.visible = rainAlpha > 0.02;
    this.rainMaterial.opacity = 0.45 * rainAlpha;
    if (this.rainMesh.visible) {
      const dy = RAIN_FALL_SPEED * realDelta;
      const slant = wind * 6 * realDelta;
      for (let i = 0; i < this.activeRainCount; i++) {
        const idx = i * 6;
        this.rainPositions[idx + 1] -= dy;
        this.rainPositions[idx + 4] -= dy;
        this.rainPositions[idx] += slant;
        this.rainPositions[idx + 3] += slant;
        if (this.rainPositions[idx + 1] < RAIN_BOTTOM) {
          const x = (Math.random() - 0.5) * RAIN_AREA * 2;
          const z = (Math.random() - 0.5) * RAIN_AREA * 2;
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
      const dy = SNOW_FALL_SPEED * realDelta;
      for (let i = 0; i < this.activeSnowCount; i++) {
        const idx = i * 3;
        this.snowPositions[idx + 1] -= dy * (0.7 + 0.3 * Math.sin(this.snowPhases[i]));
        this.snowPositions[idx] +=
          (Math.sin(this.elapsed * 0.8 + this.snowPhases[i]) * 0.5 + wind * 2.4) * realDelta;
        this.snowPositions[idx + 2] += Math.cos(this.elapsed * 0.6 + this.snowPhases[i]) * 0.4 * realDelta;
        if (this.snowPositions[idx + 1] < -1) {
          this.snowPositions[idx] = (Math.random() - 0.5) * RAIN_AREA * 2;
          this.snowPositions[idx + 1] = SNOW_TOP;
          this.snowPositions[idx + 2] = (Math.random() - 0.5) * RAIN_AREA * 2;
        }
      }
      (this.snowGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // ── Clouds drift in with cover, drift out without it ──
    // Their slow, distant motion does not benefit from 60 matrix uploads per
    // second. Updating at 24 Hz saves CPU and GPU traffic while rain, snow,
    // actors and the train remain full-rate.
    this.cloudUpdateAccumulator += realDelta;
    if (this.cloudUpdateAccumulator >= 1 / 24) {
      const cloudDelta = Math.min(this.cloudUpdateAccumulator, 0.15);
      this.cloudUpdateAccumulator = 0;
      const visibleClouds = Math.round(this.values.cloud * this.activeCloudCount);
      for (let c = 0; c < this.activeCloudCount; c++) {
        const cloud = this.clouds[c];
        const wantVisible = c < visibleClouds ? 1 : 0;
        cloud.visibility += (wantVisible - cloud.visibility) * Math.min(1, cloudDelta * 0.5);
        cloud.x += (cloud.speed + wind * 5) * cloudDelta;
        if (cloud.x > RAIN_AREA) {
          cloud.x = -RAIN_AREA;
          cloud.z = (Math.random() - 0.5) * 2 * (RAIN_AREA - 30);
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
