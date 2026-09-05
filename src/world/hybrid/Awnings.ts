import * as THREE from 'three';
import { shopfrontsOf, type Shopfront } from './architecture';
import type { BuildingSpec } from './CityModel';
import { P } from './palette';

/**
 * Shop awnings that open at ten and close at six.
 *
 * The old awning was a tilted sheet baked into the building's static geometry on every
 * other bay: decoration, and unable to move. These are real objects on a handful of
 * shops, and they fold and unfold with the city's own clock.
 *
 * **The state is a function of world time, never of a timer.** `fold(t01)` is pure, so
 * arriving at any hour, dragging the clock in either direction, loading a checkpoint or a
 * postcard, switching time mode and coming back all give the same answer: whatever the
 * hour says, with no history to get out of step. Nothing here waits for opening time.
 */

/** Ten in the morning, as a fraction of the day. */
export const OPEN_AT = 10 / 24;
/** Six in the evening. */
export const CLOSE_AT = 18 / 24;
/**
 * How much of the day the movement takes: about seventeen minutes of world time, which
 * at the diorama's default clock is a couple of seconds of calm travel.
 */
export const TRAVEL = 0.012;

const smooth = (t: number) => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/**
 * How far the awning is out at a given time of day: 0 folded, 1 fully extended.
 *
 * Open from OPEN_AT up to CLOSE_AT, with a short ramp at each end. Outside that it is
 * flat zero, including across midnight -- the function never looks at anything but `t01`.
 */
export function awningFold(t01: number): number {
  const t = ((t01 % 1) + 1) % 1;
  if (t < OPEN_AT) return 0;
  if (t >= CLOSE_AT + TRAVEL) return 0;
  return smooth((t - OPEN_AT) / TRAVEL) - smooth((t - CLOSE_AT) / TRAVEL);
}

/** Which shops have one. Deliberately few: an awning is a shop's signal, not street furniture. */
const AWNING_BLOCKS = new Set([24, 25]);

interface Awning {
  group: THREE.Group;
  fabric: THREE.Mesh;
  arms: THREE.Mesh[];
}

export class Awnings {
  private readonly group = new THREE.Group();
  private readonly items: Awning[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private applied = -1;

  constructor(scene: THREE.Scene, buildings: readonly BuildingSpec[]) {
    this.group.name = 'shop-awnings';

    // One geometry and one material set for every awning in the city.
    const fabricGeo = new THREE.BoxGeometry(1, 0.06, 1);
    const armGeo = new THREE.BoxGeometry(0.07, 0.07, 1);
    const fabricMat = new THREE.MeshStandardMaterial({ color: P.accentRose, roughness: 0.82 });
    const armMat = new THREE.MeshStandardMaterial({ color: P.frame, roughness: 0.6, metalness: 0.3 });
    this.disposables.push(fabricGeo, armGeo, fabricMat, armMat);

    const fronts: Shopfront[] = buildings
      .filter((b) => AWNING_BLOCKS.has(b.index))
      .flatMap((b) => shopfrontsOf(b));

    for (const front of fronts) {
      const group = new THREE.Group();
      group.position.set(front.x, front.y - 0.33, front.z);
      group.rotation.y = front.ry;

      const fabric = new THREE.Mesh(fabricGeo, fabricMat);
      fabric.scale.set(front.width - 0.5, 1, 1);
      fabric.castShadow = false;
      group.add(fabric);

      const arms = [-1, 1].map((side) => {
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.position.x = side * (front.width - 0.5) / 2;
        arm.castShadow = false;
        group.add(arm);
        return arm;
      });

      this.group.add(group);
      this.items.push({ group, fabric, arms });
    }

    scene.add(this.group);
    this.update(0);
  }

  /** How many shops actually have one, for tests and for the report. */
  get count(): number {
    return this.items.length;
  }

  /**
   * Set every awning from the clock. One call for all of them, not a loop per shop.
   *
   * The whole assembly is driven by one number, so the sheet and its arms cannot come
   * apart: they share a reach, and the sheet's tilt is derived from it. Folded, the reach
   * is 6 cm -- the sheet sits against the wall above the window rather than inside it.
   */
  update(t01: number): void {
    const fold = awningFold(t01);
    if (Math.abs(fold - this.applied) < 0.001) return;
    this.applied = fold;

    const reach = 0.06 + fold * 1.15;
    const drop = fold * 0.34;
    const visible = fold > 0.002;
    this.group.visible = visible;
    if (!visible) return;

    for (const { fabric, arms } of this.items) {
      fabric.scale.z = reach;
      fabric.position.set(0, -drop / 2, reach / 2);
      fabric.rotation.x = -Math.atan2(drop, reach);
      for (const arm of arms) {
        arm.scale.z = reach;
        arm.position.y = -drop / 2;
        arm.position.z = reach / 2;
        arm.rotation.x = fabric.rotation.x;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) item.dispose();
  }
}
