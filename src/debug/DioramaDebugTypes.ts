import type { FrameTimingReading } from './frameTiming';
import type { QualityMode, QualitySnapshot } from '../performance/QualityManager';
import type { CheckpointId } from '../experience/Checkpoints';
import type { Clock01 } from '../units';

export interface DioramaMetrics {
  ready: boolean;
  quality: QualitySnapshot;
  simulationSeed: number;
  layoutSeed: number;
  /** `voxel` (product) or a hybrid spike strategy. */
  world?: string;
  hybrid?: unknown;
  checkpoint: { id: CheckpointId; revision: number } | null;
  renderer: {
    gpu: string;
    vendor: string;
    calls: number;
    triangles: number;
    lines: number;
    points: number;
    geometries: number;
    textures: number;
    programs: number;
    pixelRatio: number;
    canvasWidth: number;
    canvasHeight: number;
    primaryTriangles?: number;
    primaryCalls?: number;
  };
}

export interface DioramaDebugHandle {
  ready: boolean;
  /**
   * Set the **clock**, not a solar phase. A harness that means "golden hour" has to resolve
   * it against the season first, the way {@link CHECKPOINTS} entries do.
   */
  setTime: (t01: Clock01) => void;
  getState: () => Record<string, unknown>;
  getMetrics: () => DioramaMetrics;
  setQuality: (mode: QualityMode) => void;
  toggleProfiler: () => Promise<boolean>;
  setWeather: (kind: 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog') => Promise<void>;
  clearWeather: () => void;
  loadCheckpoint: (id: CheckpointId) => void;
  releaseCheckpoint: () => void;
  /** One composer frame, with no readback and no encode: the GPU timer brackets this. */
  renderFrame: () => void;
  /** Diagnostic only: hold every local light off for a whole measurement window. */
  debugSetLocalLightsEnabled: (enabled: boolean) => void;
  /** How many local lights are visible right now. */
  /** Time `count` real animation frames on the GPU, without a second render. */
  debugStartFrameTiming: (count: number) => Promise<number>;
  debugCancelFrameTiming: () => void;
  debugReadFrameTiming: () => FrameTimingReading | null;
  captureFrame: (
    width?: number,
    jpegQuality?: number,
    format?: 'jpeg' | 'png'
  ) => string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __diorama: DioramaDebugHandle;
  }
}
