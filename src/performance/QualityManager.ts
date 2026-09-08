export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityMode = 'auto' | QualityLevel;

export interface QualityProfile {
  level: QualityLevel;
  pixelRatio: number;
  /**
   * The ratio the far view renders at: above the display's own resolution, on purpose.
   *
   * It used to be below it. `syncSize` multiplied `pixelRatio` by 0.8 once the camera
   * pulled back, which on High meant the overview rendered at 1.0 and a high-DPI screen
   * stretched it to 2.0 -- the softest picture in the product in the view with the most
   * detail to lose.
   *
   * Matching the display exactly is not the answer either, and this is the correction of
   * an earlier mistake in this file: at 2.0 the overview looks right and is measurably
   * *less* stable than the blurred 1.0 it replaced, because an upscale cannot shimmer and
   * a resolved sub-pixel city can. Measured on the presented image with the camera turned
   * four display pixels, pixels jumping more than 24 levels went 0.50% at 1.0, 0.89% at
   * 2.0, and back to 0.50% at 2.6 -- the last of those being sharp as well as steady,
   * because the extra samples are averaged down into the display's pixels rather than
   * thrown at detail nothing filters.
   *
   * 2.6 is 1.3x the display in each axis, and it is where the curve stops paying: 3.2
   * gains 2.6% more stability for three times the frame (12.35 ms to 30.67 ms at
   * 1440x900, device ratio 2). The far view can afford 2.6 because ambient occlusion and
   * bloom are off there -- GPU median 12.35 ms by day, 11.18 ms at night, 11.78 ms at
   * dusk, against a 16.7 ms frame, and 5 of 5 paired states improved in each.
   *
   * The near view gets none of this and it is not an oversight: at 1.6 the day street
   * costs 15.14 ms of the 16.7, a close-up 17.87 ms, and the night street 58.84 ms,
   * because it is fill-bound on sixteen lights. Its own instability is real and measured
   * -- 0.89% of the facade's pixels at 1.15 against 0.20% at 1.6 -- and it stays until
   * something makes the near frame cheaper.
   *
   * Only High was measured, so only High is raised; Medium and Low keep the 1.0 they
   * already resolved to. `syncSize` also bounds this by 1.3x whatever the display's own
   * ratio is, so a low-DPI screen supersamples gently and a very high-DPI one does not
   * run away.
   */
  farPixelRatio: number;
  msaaSamples: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  smaa: 'low' | 'medium' | 'high';
  ambientOcclusion: boolean;
  aoResolutionScale: number;
  cinematicDepthOfField: boolean;
  waterDetail: number;
  particleDensity: number;
  actorDensity: number;
  labels: boolean;
  pmremInterval: number;
  optionalActorHz: number;
  streetLightBudget: number;
  busStopLightBudget: number;
  stationLightBudget: number;
  windowLightBudget: number;
}

export interface QualitySnapshot {
  mode: QualityMode;
  level: QualityLevel;
  averageFrameMs: number;
  estimatedFps: number;
}

export interface DeviceCapabilities {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  devicePixelRatio?: number;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    level: 'low',
    pixelRatio: 1,
    farPixelRatio: 1,
    msaaSamples: 0,
    shadows: false,
    shadowMapSize: 512,
    bloom: false,
    smaa: 'low',
    ambientOcclusion: false,
    aoResolutionScale: 0.35,
    cinematicDepthOfField: false,
    waterDetail: 0.35,
    particleDensity: 0.35,
    actorDensity: 0.45,
    labels: false,
    pmremInterval: 15,
    optionalActorHz: 20,
    streetLightBudget: 4,
    busStopLightBudget: 1,
    stationLightBudget: 2,
    windowLightBudget: 1,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1.1,
    farPixelRatio: 1,
    msaaSamples: 0,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    smaa: 'medium',
    ambientOcclusion: true,
    aoResolutionScale: 0.4,
    cinematicDepthOfField: false,
    waterDetail: 0.65,
    particleDensity: 0.65,
    actorDensity: 0.72,
    labels: true,
    pmremInterval: 12,
    optionalActorHz: 20,
    streetLightBudget: 8,
    busStopLightBudget: 2,
    stationLightBudget: 2,
    windowLightBudget: 2,
  },
  high: {
    level: 'high',
    pixelRatio: 1.15,
    farPixelRatio: 2.6,
    msaaSamples: 0,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    smaa: 'high',
    ambientOcclusion: true,
    aoResolutionScale: 0.5,
    cinematicDepthOfField: true,
    waterDetail: 1,
    particleDensity: 0.85,
    actorDensity: 0.9,
    labels: true,
    pmremInterval: 8,
    optionalActorHz: 24,
    /**
     * Fourteen physical local lights at night instead of sixteen, and which two go was
     * decided on the picture.
     *
     * Every number below states its configuration, the light count actually active, the
     * revision, the vsync mode and the file it comes from. Nothing here is interpolated
     * between runs, and nothing is carried across them: absolute frame times drift by
     * half a millisecond to a millisecond between runs on this machine, so only
     * differences measured inside one run are quoted.
     *
     * Cost of the two window pools, measured at revision 0e952ad, vsync off, this
     * profile's pixel ratio 1.15, canvas 1655x1035, night street checkpoint, three
     * orders per variant (docs/superpowers/spike/light-cost-sweep-windowpools.json,
     * which raises this budget back to 2 so the caps bite again):
     *
     *   16 active (windowLightBudget 2)   hybrid 14.08 ms   product 11.39 ms
     *   14 active (capped to 14)          hybrid  9.00 ms   product  6.43 ms
     *   the two pools, measured            hybrid  5.08 ms   product  4.96 ms
     *
     * What a *further* cut would buy, same revision and mode, measured from the shipped
     * fourteen (docs/superpowers/spike/light-cost-sweep.json):
     *
     *   14 -> 12 active   hybrid 2.01 ms   product 1.35 ms
     *   12 ->  8 active   hybrid 1.49 ms   product  none (-0.04 ms, inside the noise)
     *    8 ->  0 active   neither: 0.03, -0.01 ms and the like
     *
     * So the marginal cost of a light falls as the count falls -- 2.54 ms a light at
     * sixteen, about 1.0 at fourteen, 0.37 at twelve, nothing under eight. Fourteen is
     * where the expensive lights have been paid off and the ones left are nearly free,
     * which is why the budget stops there.
     *
     * Why the window pools and not two street lamps. At a given count any two lights
     * save about the same time -- the marginal cost is a function of how many are on,
     * not of which ones -- so the choice is settled on the picture, and it is settled by
     * a wide margin. Both alternatives were reconstructed at revision 0e952ad by putting
     * the runtime back into the old configuration and letting it light the scene itself,
     * with the animation loop parked and the same frame rendered twice as a control
     * (0 changed pixels every time, so the frames were otherwise identical):
     *
     *                        night street        near facade      stop and bus
     *   two window pools     0 px               497 px (0.03 %)   0 px
     *   two street lamps     475 186 px (27.7 %) 140 043 px (8.2 %) 172 488 px (10.1 %)
     *
     * (docs/superpowers/spike/light-budget-pre-post-windowLights.json and
     * light-budget-pre-post-streetLamps.json; the window-pool difference appears only in
     * a frame aimed straight at the facade those two pools light, and its peak is
     * 12/255.) A lit flat keeps its emissive window, which is what makes it read as lit;
     * what it gives up is the pool of light on its own facade. A street lamp takes the
     * road with it.
     */
    streetLightBudget: 6,
    busStopLightBudget: 2,
    stationLightBudget: 2,
    windowLightBudget: 0,
  },
};

const STORAGE_KEY = 'trans-city-express.quality';
const EVALUATION_SECONDS = 4;
const AUTO_WARMUP_SECONDS = 5;
const DOWNGRADE_COOLDOWN_SECONDS = 8;
const UPGRADE_COOLDOWN_SECONDS = 16;

function capabilitiesFromBrowser(): DeviceCapabilities {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return {};
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    devicePixelRatio: window.devicePixelRatio,
  };
}

export function recommendedLevel(capabilities: DeviceCapabilities): QualityLevel {
  const cores = capabilities.hardwareConcurrency ?? 6;
  const memory = capabilities.deviceMemory;
  if (cores <= 4 || (memory !== undefined && memory <= 4)) return 'low';
  if (cores >= 8 && (memory === undefined || memory >= 8)) return 'high';
  return 'medium';
}

function storedMode(): QualityMode {
  if (typeof localStorage === 'undefined') return 'auto';
  const value = localStorage.getItem(STORAGE_KEY);
  return value === 'low' || value === 'medium' || value === 'high' || value === 'auto'
    ? value
    : 'auto';
}

export class QualityManager {
  private readonly recommended: QualityLevel;
  private mode: QualityMode;
  private level: QualityLevel;
  private listeners = new Set<(profile: QualityProfile, snapshot: QualitySnapshot) => void>();
  private elapsed = 0;
  private evaluationElapsed = 0;
  private evaluationFrameTime = 0;
  private evaluationFrames = 0;
  private cooldown = AUTO_WARMUP_SECONDS;
  private averageFrameMs = 16.67;

  constructor(capabilities = capabilitiesFromBrowser(), initialMode = storedMode()) {
    this.recommended = recommendedLevel(capabilities);
    this.mode = initialMode;
    this.level = initialMode === 'auto' ? this.recommended : initialMode;
  }

  getProfile(): QualityProfile {
    return QUALITY_PROFILES[this.level];
  }

  getSnapshot(): QualitySnapshot {
    return {
      mode: this.mode,
      level: this.level,
      averageFrameMs: this.averageFrameMs,
      estimatedFps: this.averageFrameMs > 0 ? 1000 / this.averageFrameMs : 0,
    };
  }

  setMode(mode: QualityMode): void {
    this.mode = mode;
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, mode);
    this.setLevel(mode === 'auto' ? this.recommended : mode);
    this.cooldown = AUTO_WARMUP_SECONDS;
    this.resetEvaluation();
    this.emit();
  }

  cycleMode(): QualityMode {
    const order: QualityMode[] = ['auto', 'low', 'medium', 'high'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    return this.mode;
  }

  subscribe(listener: (profile: QualityProfile, snapshot: QualitySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getProfile(), this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /** Samples wall-clock frame time. Long background-tab frames are ignored. */
  sampleFrame(deltaSeconds: number): void {
    if (!(deltaSeconds > 0) || deltaSeconds > 0.5) return;
    this.elapsed += deltaSeconds;
    this.cooldown = Math.max(0, this.cooldown - deltaSeconds);
    this.evaluationElapsed += deltaSeconds;
    this.evaluationFrameTime += deltaSeconds;
    this.evaluationFrames += 1;

    if (this.evaluationElapsed < EVALUATION_SECONDS) return;
    this.averageFrameMs = (this.evaluationFrameTime / this.evaluationFrames) * 1000;
    this.resetEvaluation();

    if (this.mode !== 'auto' || this.elapsed < AUTO_WARMUP_SECONDS || this.cooldown > 0) return;

    const next = this.nextAutomaticLevel(this.averageFrameMs);
    if (next !== this.level) {
      const isUpgrade = this.rank(next) > this.rank(this.level);
      this.setLevel(next);
      this.cooldown = isUpgrade ? UPGRADE_COOLDOWN_SECONDS : DOWNGRADE_COOLDOWN_SECONDS;
      this.emit();
    }
  }

  private nextAutomaticLevel(frameMs: number): QualityLevel {
    if (this.level === 'high' && frameMs > 18) return 'medium';
    if (this.level === 'medium' && frameMs > 21) return 'low';
    if (this.level === 'medium' && frameMs < 15.2) return 'high';
    if (this.level === 'low' && frameMs < 16.2) return 'medium';
    return this.level;
  }

  private setLevel(level: QualityLevel): void {
    this.level = level;
  }

  private rank(level: QualityLevel): number {
    return level === 'low' ? 0 : level === 'medium' ? 1 : 2;
  }

  private resetEvaluation(): void {
    this.evaluationElapsed = 0;
    this.evaluationFrameTime = 0;
    this.evaluationFrames = 0;
  }

  private emit(): void {
    const profile = this.getProfile();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(profile, snapshot);
  }
}
