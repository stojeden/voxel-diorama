export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityMode = 'auto' | QualityLevel;

export interface QualityProfile {
  level: QualityLevel;
  pixelRatio: number;
  msaaSamples: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  particleDensity: number;
  actorDensity: number;
  labels: boolean;
  pmremInterval: number;
  optionalActorHz: number;
  streetLightBudget: number;
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
    msaaSamples: 0,
    shadows: false,
    shadowMapSize: 512,
    bloom: false,
    particleDensity: 0.35,
    actorDensity: 0.45,
    labels: false,
    pmremInterval: 2.4,
    optionalActorHz: 20,
    streetLightBudget: 4,
    windowLightBudget: 1,
  },
  medium: {
    level: 'medium',
    pixelRatio: 1.25,
    msaaSamples: 0,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    particleDensity: 0.65,
    actorDensity: 0.72,
    labels: true,
    pmremInterval: 5,
    optionalActorHz: 20,
    streetLightBudget: 8,
    windowLightBudget: 2,
  },
  high: {
    level: 'high',
    pixelRatio: 1.5,
    msaaSamples: 0,
    shadows: true,
    shadowMapSize: 1024,
    bloom: true,
    particleDensity: 0.85,
    actorDensity: 0.9,
    labels: true,
    pmremInterval: 3,
    optionalActorHz: 24,
    streetLightBudget: 10,
    windowLightBudget: 3,
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
