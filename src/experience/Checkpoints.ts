import type { QualityMode } from '../performance/QualityManager';
import type { TourChapterId } from '../CinematicTour';
import { FIXED_TOUR_SHOTS, OVERVIEW_SHOT } from './ShotDefinitions';
export { WORLD_LAYOUT_SEED } from '../world/WorldLayout';

export const CHECKPOINT_REVISION = 2;
export type BenchmarkCheckpointId =
  | 'golden-clear-overview'
  | 'noon-rain-overview'
  | 'post-rain-clear-lake'
  | 'post-rain-rainbow-lake'
  | 'night-snow-train'
  | 'evening-rain-bus'
  | 'eclipse-totality-overview';
export type CheckpointId = TourChapterId | BenchmarkCheckpointId;

export interface CheckpointDefinition {
  readonly id: CheckpointId;
  readonly revision: number;
  readonly quality: Exclude<QualityMode, 'auto'>;
  readonly timeOfDay: number;
  readonly weather: 'clear' | 'rain' | 'snow';
  readonly theme: 'classic' | 'cyberpunk';
  readonly eclipseProgress: number | null;
  readonly trainProgress?: number;
  readonly busProgress?: number;
  readonly rainbowMoisture?: number;
  readonly rainbowSource?: number;
  readonly camera: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
  };
  readonly frozen: true;
}

interface CheckpointOptions {
  readonly eclipseProgress?: number | null;
  readonly theme?: 'classic' | 'cyberpunk';
  readonly weather?: 'clear' | 'rain' | 'snow';
  readonly trainProgress?: number;
  readonly busProgress?: number;
  readonly rainbowMoisture?: number;
  readonly rainbowSource?: number;
}

export const CHECKPOINTS: Record<CheckpointId, CheckpointDefinition> = {
  train: checkpoint('train', 0.42, [52, 18, 23], [30, 4, 2], { trainProgress: 0.68 }),
  bus: checkpoint('bus', 0.46, [48, 12, -18], [27, 3, -10], { busProgress: 0.25 }),
  lake: checkpoint('lake', 0.52, FIXED_TOUR_SHOTS.lake.position, FIXED_TOUR_SHOTS.lake.target),
  residents: checkpoint('residents', 0.48, FIXED_TOUR_SHOTS.residents.position, FIXED_TOUR_SHOTS.residents.target),
  'golden-hour': checkpoint('golden-hour', 0.28, FIXED_TOUR_SHOTS['golden-hour'].position, FIXED_TOUR_SHOTS['golden-hour'].target),
  totality: checkpoint('totality', 0.715, FIXED_TOUR_SHOTS.totality.position, FIXED_TOUR_SHOTS.totality.target, { eclipseProgress: 0.5 }),
  cyberpunk: checkpoint('cyberpunk', 0.86, FIXED_TOUR_SHOTS.cyberpunk.position, FIXED_TOUR_SHOTS.cyberpunk.target, { theme: 'cyberpunk' }),
  'golden-clear-overview': checkpoint('golden-clear-overview', 0.28, OVERVIEW_SHOT.position, OVERVIEW_SHOT.target),
  'noon-rain-overview': checkpoint('noon-rain-overview', 0.5, OVERVIEW_SHOT.position, OVERVIEW_SHOT.target, { weather: 'rain' }),
  'post-rain-clear-lake': checkpoint(
    'post-rain-clear-lake',
    0.68,
    [-54, 10, 98.2],
    [-13, 11, 54]
  ),
  'post-rain-rainbow-lake': checkpoint(
    'post-rain-rainbow-lake',
    0.68,
    [-54, 10, 98.2],
    [-13, 11, 54],
    { rainbowMoisture: 1, rainbowSource: 0 }
  ),
  'night-snow-train': checkpoint('night-snow-train', 0.02, OVERVIEW_SHOT.position, OVERVIEW_SHOT.target, { weather: 'snow', trainProgress: 0.68 }),
  'evening-rain-bus': checkpoint('evening-rain-bus', 0.82, OVERVIEW_SHOT.position, OVERVIEW_SHOT.target, { weather: 'rain', busProgress: 0.25 }),
  'eclipse-totality-overview': checkpoint('eclipse-totality-overview', 0.715, FIXED_TOUR_SHOTS.totality.position, FIXED_TOUR_SHOTS.totality.target, { eclipseProgress: 0.5 }),
};

function checkpoint(
  id: CheckpointId,
  timeOfDay: number,
  position: readonly [number, number, number],
  target: readonly [number, number, number],
  options: CheckpointOptions = {}
): CheckpointDefinition {
  return {
    id,
    revision: CHECKPOINT_REVISION,
    quality: 'high',
    timeOfDay,
    weather: options.weather ?? 'clear',
    theme: options.theme ?? 'classic',
    eclipseProgress: options.eclipseProgress ?? null,
    trainProgress: options.trainProgress,
    busProgress: options.busProgress,
    rainbowMoisture: options.rainbowMoisture,
    rainbowSource: options.rainbowSource,
    camera: { position, target },
    frozen: true,
  };
}

export function getCheckpoint(value: string | null | undefined): CheckpointDefinition | null {
  return value && value in CHECKPOINTS ? CHECKPOINTS[value as CheckpointId] : null;
}
