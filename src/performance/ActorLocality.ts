import * as THREE from 'three';

export type ActorTier = 'near' | 'mid' | 'far';

/** Persistent, actor-owned state. Never share a slot between unrelated actors/cells. */
export class ActorLocalitySlot {
  tier: ActorTier = 'near';
  private lastPresentation = -Infinity;

  due(time: number, tier: ActorTier, nearInterval = 0): boolean {
    const promoted = (tier === 'near' && this.tier !== 'near') || (tier === 'mid' && this.tier === 'far');
    this.tier = tier;
    const interval = tier === 'near' ? nearInterval : tier === 'mid' ? 0.2 : 1;
    if (!promoted && time - this.lastPresentation < interval - 1e-9) return false;
    this.lastPresentation = time;
    return true;
  }
}

/**
 * Camera/cell presentation budget, independent of population density.
 * Logical state machines MUST still run each simulation frame: this is not a physics
 * sleep/catch-up integrator. Sparse poses must be sampled from current logical state,
 * never integrated using just the current frame's delta.
 */
export class ActorLocality {
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private readonly bounds = new THREE.Sphere();
  private focusX = 0;
  private focusZ = 0;
  private time = 0;
  private ready = false;
  private nearInterval = 0;

  constructor(private readonly nearRadius = 70, private readonly midRadius = 180) {
    if (!(nearRadius > 0 && midRadius >= nearRadius)) throw new RangeError('Invalid actor locality radii');
  }

  /** Call once after camera controls, before actor updates. Uses presentation time. */
  beginFrame(camera: THREE.Camera, delta: number, focus: Pick<THREE.Vector3, 'x' | 'z'>, nearHz = Infinity): void {
    this.nearInterval = nearHz > 0 ? 1 / nearHz : 0;
    this.time += Math.max(0, delta);
    this.focusX = focus.x;
    this.focusZ = focus.z;
    camera.updateWorldMatrix(true, false);
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection, camera.coordinateSystem);
    this.ready = true;
  }

  /** No arrays, vectors, closures or per-frame registrations are allocated here. */
  shouldPresent(slot: ActorLocalitySlot, position: THREE.Vector3, radius = 12): boolean {
    if (!this.ready) return true;
    this.bounds.center.copy(position);
    this.bounds.radius = radius;
    const dx = position.x - this.focusX;
    const dz = position.z - this.focusZ;
    const distanceSquared = dx * dx + dz * dz;
    const visible = this.frustum.intersectsSphere(this.bounds);
    const tier: ActorTier = visible && distanceSquared <= (this.nearRadius + radius) ** 2
      ? 'near'
      : visible || distanceSquared <= (this.midRadius + radius) ** 2 ? 'mid' : 'far';
    return slot.due(this.time, tier, this.nearInterval);
  }
}
