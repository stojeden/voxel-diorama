import type { QualityMode, QualitySnapshot } from '../performance/QualityManager';
import type { CheckpointId } from '../experience/Checkpoints';

export interface DioramaMetrics {
  ready: boolean;
  quality: QualitySnapshot;
  simulationSeed: number;
  layoutSeed: number;
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
  };
}

export interface DioramaDebugHandle {
  ready: boolean;
  setTime: (t01: number) => void;
  getState: () => Record<string, unknown>;
  getMetrics: () => DioramaMetrics;
  setQuality: (mode: QualityMode) => void;
  toggleProfiler: () => Promise<boolean>;
  setWeather: (kind: 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog') => void;
  clearWeather: () => void;
  loadCheckpoint: (id: CheckpointId) => void;
  releaseCheckpoint: () => void;
  captureFrame: (width?: number, jpegQuality?: number) => string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __diorama: DioramaDebugHandle;
  }
}
