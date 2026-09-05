import * as THREE from 'three';
import { shopfrontsOf, type Shopfront } from './architecture';
import type { BuildingSpec } from './CityModel';
import { P } from './palette';
import { STYLE } from './HybridMaterial';
import { attachAttributes } from './strategies/strategy';

/**
 * Shop awnings that open at ten and close at six.
 *
 * The old awning was a tilted sheet baked into the building's static geometry on every
 * other bay: decoration, and unable to move. These are real objects on a handful of
 * shops, and they fold and unfold with the city's own clock.
 *
 * **Three different clocks meet here, and conflating them is what went wrong first.**
 *
 *  - *The hour* decides whether the shop is open. It is a fraction of a real 24-hour day
 *    (`clockT`), which in simulation is the world clock and in real time is the viewer's
 *    local hour -- the same one the HUD prints. It used to be `t01`, the *lighting* phase,
 *    which real-time mode warps so that sunset lands on 0.75: with `CLOSE_AT = 18/24` the
 *    shop was closing at sunset, whatever hour that happened to be.
 *  - *The travel* is a movement, so it is measured in seconds and driven by the frame's
 *    own delta. It used to be 0.012 of a day, which is a couple of seconds only while a
 *    day takes 240 s; in real time the same number is seventeen minutes of creep.
 *  - *The sun* is not this file's business at all.
 *
 * **The open/closed state is a function of the hour, never of a timer.** Nothing here
 * waits for opening time, and any jump in the clock -- a drag in either direction, a
 * checkpoint, a postcard, a change of time mode, a tab coming back -- snaps the awning to
 * whatever the hour says instead of letting it travel across the jump. So the state after
 * a restore is defined by the hour alone, and the travel is only ever seen when time is
 * actually passing.
 *
 * They are the only moving things in the hybrid that are not baked into a cluster, and
 * they still take the shared hybrid material and its attribute contract, so a theme, the
 * snow cover, the wetness and the night tint reach them exactly as they reach the wall
 * they hang on.
 */

/** Ten in the morning. A real hour, not a phase of the sun. */
export const OPEN_HOUR = 10;
/** Six in the evening. */
export const CLOSE_HOUR = 18;
/** How long the awning takes to run out or in, in seconds. Short and calm. */
export const TRAVEL_SECONDS = 1.6;
/**
 * A step in the hour bigger than this is a jump, not the passage of time.
 *
 * Six minutes of the day. At the fastest clock the diorama offers, one frame advances the
 * world by about eleven seconds of world time, so nothing that is merely *time passing*
 * can trip this; a drag of the time slider, a checkpoint or a change of mode always does.
 */
export const CLOCK_JUMP = 0.004;

const smooth = (t: number) => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/**
 * Is the shop open at this hour of the day?
 *
 * The nanosecond of slack is there because callers build the hour both ways -- `10 / 24`
 * and `10 * (1 / 24)` are not the same double -- and which of them lands on the boundary
 * is not something a shop's opening time should depend on.
 */
export function isOpenAt(clockT: number): boolean {
  const hour = (((clockT % 1) + 1) % 1) * 24;
  return hour >= OPEN_HOUR - 1e-9 && hour < CLOSE_HOUR - 1e-9;
}

/** Shortest distance between two hours of the day, across midnight. */
export function clockDistance(a: number, b: number): number {
  const raw = Math.abs((((a - b) % 1) + 1) % 1);
  return Math.min(raw, 1 - raw);
}

/** Which shops have one. Deliberately few: an awning is a shop's signal, not street furniture. */
const AWNING_BLOCKS = new Set([24, 25]);

/**
 * The assembly, in the shop's own frame: the facade is z = 0, the street is +z, down is -y.
 *
 * Every dimension below is measured from the roller, which is the group's origin. The
 * housing never moves; everything else grows out of it, so there is no size at which a
 * part appears from nothing.
 */
const HOUSING_HEIGHT = 0.2;
const HOUSING_DEPTH = 0.18;
/** Sheet thickness and how far out it reaches when fully open. */
const SHEET_THICKNESS = 0.05;
const REACH_MIN = 0.05;
const REACH_MAX = 1.15;
/** How far the leading edge falls below the roller when fully open: a 16-degree slope. */
const DROP_MAX = 0.34;
/** The skirt hanging off the leading edge -- the thing that reads as "awning" at a glance. */
const VALANCE_MIN = 0.05;
const VALANCE_MAX = 0.22;
/** Where a folding arm meets the wall, below the roller, when fully open. */
const ARM_ROOT_MIN = 0.06;
const ARM_ROOT_MAX = 0.3;
const ARM_THICKNESS = 0.06;
/**
 * How far off the facade an arm is anchored. Zero would look right and be wrong: a bar
 * this thick, stood almost upright while the awning is folded, has half its width behind
 * the plane it pivots on, so it pokes through the wall.
 */
const ARM_ROOT_Z = 0.05;
/** How far in from the ends the arms sit, so they read as two members and not as edging. */
const ARM_INSET = 0.35;

interface Awning {
  group: THREE.Group;
  fabric: THREE.Mesh;
  valance: THREE.Mesh;
  arms: THREE.Mesh[];
  width: number;
}

/** A unit box carrying the hybrid attribute contract for one palette entry. */
function unitBox(palette: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  attachAttributes(geometry, { layer: 0, cls: 'opaque', palette, cohort: -1, style: STYLE.plain, ao: 1 });
  return geometry;
}

export class Awnings {
  private readonly group = new THREE.Group();
  private readonly items: Awning[] = [];
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  /** Linear progress of the movement, 0 folded to 1 out. The eased shape is derived. */
  private travel = 0;
  private applied = -1;
  private lastClockT: number | null = null;

  constructor(scene: THREE.Scene, buildings: readonly BuildingSpec[], material: THREE.Material) {
    this.group.name = 'shop-awnings';

    /** One unit box per palette entry in play, shared by every awning that uses it. */
    const boxOf = (palette: number): THREE.BufferGeometry => {
      let geometry = this.geometries.get(palette);
      if (!geometry) {
        geometry = unitBox(palette);
        this.geometries.set(palette, geometry);
      }
      return geometry;
    };

    const fronts: Shopfront[] = buildings
      .filter((b) => AWNING_BLOCKS.has(b.index))
      .flatMap((b) => shopfrontsOf(b));

    for (const front of fronts) {
      const group = new THREE.Group();
      group.position.set(front.x, front.y - 0.33, front.z);
      group.rotation.y = front.ry;
      const width = front.width - 0.5;
      // The sheet takes the colour of the sign over the same bay, so a shop reads as one
      // thing rather than as a wall with unrelated fittings stuck to it.
      const cloth = boxOf(front.sign);
      const metal = boxOf(P.steel);

      const housing = new THREE.Mesh(metal, material);
      housing.scale.set(width + 0.06, HOUSING_HEIGHT, HOUSING_DEPTH);
      housing.position.set(0, 0, HOUSING_DEPTH / 2);
      group.add(housing);

      const fabric = new THREE.Mesh(cloth, material);
      const valance = new THREE.Mesh(cloth, material);
      const arms = [-1, 1].map(() => new THREE.Mesh(metal, material));
      for (const part of [fabric, valance, ...arms]) group.add(part);

      this.group.add(group);
      this.items.push({ group, fabric, valance, arms, width });
    }

    scene.add(this.group);
  }

  /** How many shops actually have one, for tests and for the report. */
  get count(): number {
    return this.items.length;
  }

  /** Where the movement is, 0 folded to 1 out. The checkpoint story reads this. */
  get progress(): number {
    return this.travel;
  }

  /**
   * Set every awning from the hour and the frame's own delta. One call for all of them.
   *
   * `clockT` is the hour of day as a fraction of 24 h; `dt` is real seconds. A jump in the
   * hour, or a frame with no time in it, puts the awning straight where the hour says --
   * the state after a checkpoint or a time drag is the hour's state, with no travel left
   * over from before the jump.
   */
  update(clockT: number, dt: number): void {
    const target = isOpenAt(clockT) ? 1 : 0;
    const jumped = this.lastClockT === null || clockDistance(clockT, this.lastClockT) > CLOCK_JUMP;
    this.lastClockT = clockT;

    if (jumped || !(dt > 0)) {
      this.travel = target;
    } else {
      const limit = dt / TRAVEL_SECONDS;
      this.travel += Math.max(-limit, Math.min(limit, target - this.travel));
    }
    this.apply(smooth(this.travel));
  }

  /**
   * Put the whole assembly at one fold value, 0 folded to 1 out.
   *
   * The assembly is derived from that one number, so it cannot come apart: the sheet runs
   * from the roller to the leading edge, the skirt hangs off that edge, and each arm runs
   * from the wall to the same edge. Folded, all three collapse into the housing.
   */
  private apply(fold: number): void {
    if (Math.abs(fold - this.applied) < 0.001) return;
    this.applied = fold;

    const reach = REACH_MIN + fold * (REACH_MAX - REACH_MIN);
    const drop = fold * DROP_MAX;
    const valanceHeight = VALANCE_MIN + fold * (VALANCE_MAX - VALANCE_MIN);
    const armRoot = ARM_ROOT_MIN + fold * (ARM_ROOT_MAX - ARM_ROOT_MIN);

    // Roller (0, 0, 0) to leading edge (0, -drop, reach).
    const sheetLength = Math.hypot(drop, reach);
    const sheetTilt = Math.atan2(drop, reach);
    // Wall (0, -armRoot, ARM_ROOT_Z) to the same leading edge.
    const armRise = armRoot - drop;
    const armRun = reach - ARM_ROOT_Z;
    const armLength = Math.hypot(armRise, armRun);
    const armTilt = Math.atan2(-armRise, armRun);

    for (const { fabric, valance, arms, width } of this.items) {
      fabric.scale.set(width, SHEET_THICKNESS, sheetLength);
      fabric.position.set(0, -drop / 2, reach / 2);
      fabric.rotation.x = sheetTilt;

      valance.scale.set(width, valanceHeight, SHEET_THICKNESS);
      valance.position.set(0, -drop - valanceHeight / 2, reach);

      for (let i = 0; i < arms.length; i++) {
        const arm = arms[i];
        arm.scale.set(ARM_THICKNESS, ARM_THICKNESS, armLength);
        arm.position.set((i === 0 ? -1 : 1) * (width / 2 - ARM_INSET), -(armRoot + drop) / 2, (ARM_ROOT_Z + reach) / 2);
        arm.rotation.x = armTilt;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
  }
}
