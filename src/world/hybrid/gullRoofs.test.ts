import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { QUALITY_PROFILES } from '../../performance/QualityManager';
import { THEMES } from '../../experience/Themes';
import { attachHybridSpike } from './HybridSpike';
import { Birds, GULL_SEAT, nearestEclipseRoost } from '../Birds';
import { fallbackRandom } from '../../core/Random';

/**
 * The gulls' idea of a roof agrees with the roof that is drawn.
 *
 * Every building is probed by casting straight down onto the city the hybrid actually builds,
 * at points spread over its footprint, and the first thing the ray meets is compared with
 * `surfaceAt`. Chimneys and vents stand on some roofs and the rays that land on them are not
 * a disagreement about the roof, so the check is on the typical point, not on every point.
 */
describe('gull roofs match the hybrid city', () => {
  test('surface height under every roof, from the drawn geometry', () => {
    const scene = new THREE.Scene();
    const hybrid = attachHybridSpike({
      scene,
      strategy: 'direct',
      quality: QUALITY_PROFILES.high,
      themePalette: THEMES[0].palette,
    });
    scene.updateMatrixWorld(true);
    const drawn = (object: THREE.Object3D): boolean => {
      for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
      return true;
    };
    const raycaster = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const origin = new THREE.Vector3();

    const errors: number[] = [];
    let worstRoof = { index: -1, median: 0 };
    hybrid.getGullRoofs().forEach((roof, index) => {
      const local: number[] = [];
      for (let i = 1; i <= 5; i++) {
        for (let j = 1; j <= 5; j++) {
          const x = roof.minX + ((roof.maxX - roof.minX) * i) / 6;
          const z = roof.minZ + ((roof.maxZ - roof.minZ) * j) / 6;
          origin.set(x, 120, z);
          raycaster.set(origin, down);
          const hit = raycaster.intersectObjects(scene.children, true).find((h) => drawn(h.object));
          if (!hit) continue;
          local.push(Math.abs(hit.point.y - roof.surfaceAt(x, z)));
        }
      }
      local.sort((a, b) => a - b);
      const median = local[Math.floor(local.length / 2)] ?? Infinity;
      if (median > worstRoof.median) worstRoof = { index, median };
      errors.push(...local);
    });
    errors.sort((a, b) => a - b);
    const within = errors.filter((e) => e < 0.05).length / errors.length;
    expect(worstRoof.median, `roof ${worstRoof.index} is not where the gulls think`).toBeLessThan(0.05);
    expect(within, 'too many probes disagree with the drawn roof').toBeGreaterThan(0.9);
    hybrid.dispose();
  }, 120_000);

  test('a gull never perches inside a stair house or a machine room', () => {
    const scene = new THREE.Scene();
    const hybrid = attachHybridSpike({
      scene,
      strategy: 'direct',
      quality: QUALITY_PROFILES.high,
      themePalette: THEMES[0].palette,
    });
    const roofs = hybrid.getGullRoofs();
    let inside = 0;
    let checked = 0;
    for (let gull = 0; gull < 11; gull++) {
      for (let x = -70; x <= 70; x += 10) {
        for (let z = -70; z <= 70; z += 10) {
          const perch = nearestEclipseRoost({ x, z }, gull, roofs, GULL_SEAT);
          checked += 1;
          for (const roof of roofs) {
            for (const box of roof.obstacles ?? []) {
              if (perch.x > box.minX && perch.x < box.maxX && perch.z > box.minZ && perch.z < box.maxZ) inside += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(inside, 'gulls sitting inside rooftop structures').toBe(0);
    hybrid.dispose();
  }, 120_000);

  test('gulls fly over the hybrid city and sleep on its roofs', () => {
    const city = new THREE.Scene();
    const hybrid = attachHybridSpike({
      scene: city,
      strategy: 'direct',
      quality: QUALITY_PROFILES.high,
      themePalette: THEMES[0].palette,
    });
    const roofs = hybrid.getGullRoofs();
    const scene = new THREE.Scene();
    const birds = new Birds(scene, fallbackRandom('birds'));
    birds.setRoofs(roofs);
    const roofUnder = (p: THREE.Vector3) =>
      roofs.find((r) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ);

    // Ten minutes of day at the actor cadence. On the voxel blocks the gulls spent about 65
    // gull-seconds of every ten minutes inside the hybrid's buildings, and about 50 with the
    // right roofs but no look ahead; what is left is the odd shallow clip after a new target.
    const STEP = 1 / 20;
    let t = 0;
    let inside = 0;
    for (let i = 0; i < 10 * 60 * 20; i++) {
      t += STEP;
      birds.update(STEP, t, 0.3, 0);
      for (const gull of scene.children) {
        const roof = roofUnder(gull.position);
        if (roof && gull.position.y < roof.surfaceAt(gull.position.x, gull.position.z) - 0.1) inside += STEP;
      }
    }
    expect(inside, 'gull-seconds inside buildings in ten minutes').toBeLessThan(8);

    // Night: every gull that settles on a building sits on it, belly to the roof.
    for (let i = 0; i < 180 * 20; i++) {
      t += STEP;
      birds.update(STEP, t, 0.3, 1);
    }
    let seated = 0;
    for (const gull of scene.children) {
      const roof = roofUnder(gull.position);
      if (!roof) continue;
      const belly = gull.position.y - GULL_SEAT * gull.scale.y;
      expect(Math.abs(belly - roof.surfaceAt(gull.position.x, gull.position.z)), 'a gull hovers over or sinks into its roof').toBeLessThan(0.05);
      seated += 1;
    }
    expect(seated, 'no gull roosted on a building, so the check above checked nothing').toBeGreaterThan(3);
    hybrid.dispose();
  }, 240_000);
});

