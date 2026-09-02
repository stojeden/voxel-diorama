import { CHECKPOINT_REVISION, type CheckpointDefinition, type CheckpointId } from '../../experience/Checkpoints';
import { OVERVIEW_SHOT, type CameraShot } from '../../experience/ShotDefinitions';
import { BUS_STOPS } from '../WorldLayout';

/**
 * Gate 1 frames. These live in the spike chunk on purpose: the product's
 * checkpoint table (and its 14-entry contract test) stays untouched, and the
 * ids are cast because the spike is not part of the CheckpointId union.
 */
export type SpikeCheckpointId = 'spike-overview' | 'spike-street' | 'spike-golden' | 'spike-night-street';

/** Eye 1.7 m above the south pavement of Aleja Południowa, looking at the shops and the shelter. */
export const STREET_EYE_SHOT: CameraShot = {
  position: [6.5, 1.2, 21.0],
  target: [-9, 1.9, 30],
};

function define(id: SpikeCheckpointId, timeOfDay: number, camera: CameraShot): CheckpointDefinition {
  return {
    id: id as unknown as CheckpointId,
    revision: CHECKPOINT_REVISION,
    quality: 'high',
    timeOfDay,
    weather: 'clear',
    theme: 'classic',
    eclipseProgress: null,
    busProgress: BUS_STOPS[0].atT,
    camera,
    frozen: true,
  };
}

export const SPIKE_CHECKPOINTS: Record<SpikeCheckpointId, CheckpointDefinition> = {
  'spike-overview': define('spike-overview', 0.5, OVERVIEW_SHOT),
  'spike-street': define('spike-street', 0.5, STREET_EYE_SHOT),
  'spike-golden': define('spike-golden', 0.28, OVERVIEW_SHOT),
  'spike-night-street': define('spike-night-street', 0.9, STREET_EYE_SHOT),
};

export function getSpikeCheckpoint(value: string | null | undefined): CheckpointDefinition | null {
  return value && value in SPIKE_CHECKPOINTS ? SPIKE_CHECKPOINTS[value as SpikeCheckpointId] : null;
}
