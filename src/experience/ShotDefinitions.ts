import type { TourCameraRig } from '../CinematicTour';

export interface CameraShot {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

export const OVERVIEW_SHOT: CameraShot = {
  position: [70, 48, 80],
  target: [0, 6, 0],
};

export const FIXED_TOUR_SHOTS: Record<Exclude<TourCameraRig, 'train' | 'bus'>, CameraShot> = {
  lake: { position: [-12, 30, 96], target: [-40, 0, 62] },
  residents: { position: [39, 13, 19], target: [25, 6, 3] },
  'golden-hour': { position: [82, 52, 88], target: [0, 7, 0] },
  // Derived from the sun direction at t=.715, looking back at the solar layer.
  totality: { position: [141, 46, -32], target: [0, 36, 0] },
  cyberpunk: { position: [-74, 31, -82], target: [-4, 15, -2] },
};
