import * as THREE from 'three';
import { RAINBOW_MOISTURE_ZONES } from '../world/WorldLayout';
// Type-only, and it has to stay that way: `src/units.ts` declares brands and defines nothing,
// so this import is erased and the eager half of the split stays as cheap as it was.
import type { Radians } from '../units';

/**
 * The contract the frame loop holds, so that `RainbowAtmosphere` itself can be fetched late.
 *
 * This file is the eager half of that split and must stay cheap: it may not import
 * `RainbowAtmosphere`, `RainbowOptics` or anything else that only the drawn arc needs, or the
 * chunk it exists to keep out of the first load comes straight back in behind a type.
 */

export interface RainbowFrameInput {
  camera: THREE.PerspectiveCamera;
  sunDirection: THREE.Vector3;
  sunElevation: Radians;
  sunColor: THREE.Color;
  directSun: number;
  cloudCover: number;
  rainIntensity: number;
  airborneMoisture: number;
  wind: number;
  realDelta: number;
  elapsed: number;
}

export interface RainbowDebugState {
  visible: boolean;
  effectActive: boolean;
  strength: number;
  extinction: number;
  source: string;
  sourceIndex: number;
  sourceCenter: [number, number, number];
  sourceRadii: [number, number, number];
}

/** Everything the frame loop, the ambient status and the debug handle ask of the rainbow. */
export interface RainbowHandle {
  setQuality: (level: 'low' | 'medium' | 'high') => void;
  update: (input: RainbowFrameInput) => void;
  isVisible: () => boolean;
  isEffectActive: () => boolean;
  getSourceCenter: (target: THREE.Vector3) => THREE.Vector3;
  getSourceId: () => string;
  debugSetSource: (index: number) => void;
  releaseDebugSource: () => void;
  getDebugState: () => RainbowDebugState;
}

/**
 * The moisture curtain before any jitter has been rolled: the state a freshly constructed
 * `RainbowAtmosphere` is in, and the one a checkpoint that pins a source gets.
 *
 * It lives here rather than in `RainbowAtmosphere` because both halves of the split report
 * it and `DormantRainbow` must not drift from the object it stands in for. A second copy of
 * these three numbers is a second thing to get wrong.
 */
export const RAINBOW_SOURCE_REST = { height: 27, radiusX: 62, radiusZ: 30 } as const;

/** Wrap any requested source onto a real zone; a non-finite request means the first one. */
export function rainbowZoneIndex(requested: number): number {
  const count = RAINBOW_MOISTURE_ZONES.length;
  if (!Number.isFinite(requested)) return 0;
  return ((Math.round(requested) % count) + count) % count;
}

/**
 * What the frame loop talks to until the rainbow's chunk arrives: a real object with the real
 * answers for a world that holds no airborne moisture, not an optional chain.
 *
 * Every reading here is the truth rather than a placeholder. `RainbowAtmosphere.update`
 * computes `extinction = airborneMoisture * clearing` and holds `strength` at or below that,
 * so with no moisture in the air both are exactly zero, nothing is visible and the
 * post-process is inactive — which is precisely what this reports. The source is zone 0
 * unjittered, which is also what the real constructor selects before its first rain event.
 *
 * The defect this prevents: a scattered `rainbow?.` across nine call sites, where one missing
 * `?.` is a crash on the first frame of a shower and one wrong `?? true` leaves the
 * atmosphere pass enabled over an effect that does not exist yet.
 */
export class DormantRainbow implements RainbowHandle {
  /**
   * Set by `debugSetSource` while the chunk is still in flight, and replayed onto the real
   * object the moment it lands. Null means nothing has locked the source. Checkpoints reach
   * `debugSetSource` during boot, so without the replay a `rainbowSource` checkpoint would
   * quietly draw whichever zone the seeded random picked instead of the one it asked for.
   */
  debugSource: number | null = null;

  setQuality(): void {
    // Nothing is drawn, so there is no quality to set. The live object is handed the current
    // profile at construction instead of being told again here.
  }

  update(): void {
    // No uniforms and no smoothing state: an unloaded rainbow has nothing to integrate. The
    // real object's own smoothing also starts from zero, so nothing is lost by not running.
  }

  isVisible(): boolean {
    return false;
  }

  isEffectActive(): boolean {
    return false;
  }

  getSourceCenter(target: THREE.Vector3): THREE.Vector3 {
    const zone = RAINBOW_MOISTURE_ZONES[rainbowZoneIndex(this.debugSource ?? 0)];
    return target.set(zone.x, RAINBOW_SOURCE_REST.height, zone.z);
  }

  getSourceId(): string {
    return RAINBOW_MOISTURE_ZONES[rainbowZoneIndex(this.debugSource ?? 0)].id;
  }

  debugSetSource(index: number): void {
    this.debugSource = rainbowZoneIndex(index);
  }

  releaseDebugSource(): void {
    this.debugSource = null;
  }

  getDebugState(): RainbowDebugState {
    const index = rainbowZoneIndex(this.debugSource ?? 0);
    const zone = RAINBOW_MOISTURE_ZONES[index];
    return {
      visible: false,
      effectActive: false,
      strength: 0,
      extinction: 0,
      source: zone.id,
      sourceIndex: index,
      sourceCenter: [zone.x, RAINBOW_SOURCE_REST.height, zone.z],
      sourceRadii: [
        RAINBOW_SOURCE_REST.radiusX,
        RAINBOW_SOURCE_REST.height - zone.baseY,
        RAINBOW_SOURCE_REST.radiusZ,
      ],
    };
  }
}
