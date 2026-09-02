import type { Layer } from './surface';

/**
 * Screen-space level of detail. The measure is pixels per metre at the object,
 * which is independent of device class and behaves the same under zoom, in
 * photo mode and on a portrait phone. Layers are additive, so a switch only adds
 * or removes small elements; hysteresis and a cooldown keep it from flickering.
 */
export interface LodConfig {
  enter1: number;
  exit1: number;
  enter2: number;
  exit2: number;
  cooldownSeconds: number;
}

export const DEFAULT_LOD: LodConfig = { enter1: 9, exit1: 7, enter2: 36, exit2: 30, cooldownSeconds: 0.25 };

export function pixelsPerMetre(viewportHeightPx: number, fovDeg: number, distance: number): number {
  return viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(distance, 0.01);
}

export class LodSelector {
  level: Layer = 0;
  maxLevel: Layer = 2;
  private cooldown = 0;

  constructor(private readonly config: LodConfig = DEFAULT_LOD) {}

  update(pxPerMetre: number, dt: number): Layer {
    this.cooldown = Math.max(0, this.cooldown - dt);
    let target: Layer = this.level;
    if (pxPerMetre >= this.config.enter2) target = 2;
    else if (pxPerMetre >= this.config.enter1) target = this.level === 2 && pxPerMetre >= this.config.exit2 ? 2 : 1;
    else if (pxPerMetre < this.config.exit1) target = 0;
    else target = this.level === 0 ? 0 : 1;
    if (target > this.maxLevel) target = this.maxLevel;
    if (target !== this.level && this.cooldown <= 0) {
      this.level = target;
      this.cooldown = this.config.cooldownSeconds;
    }
    return this.level;
  }
}
