import * as THREE from 'three';
import { WINDOW_COHORT_COUNT, residentialWindowActivityAt } from '../../environment/CityRhythm';
import type { QualityProfile } from '../../performance/QualityManager';
import { BUS_STOPS, GROUND_SURFACE_Y } from '../WorldLayout';
import { buildCityModel, GROUND } from './CityModel';
import { emitBuilding } from './architecture';
import { Awnings } from './Awnings';
import { emitStreetscape } from './streetscape';
import { emitDominant } from './dominants';
import { emitGroceries } from './grocery';
import { createHybridMaterial, createHybridUniforms } from './HybridMaterial';
import { beaconGlow } from './beacons';
import { groceryGlow } from './shopHours';
import { createCyberCity, isReplacedByCyber, type CyberCityHandle } from './cyber/CyberCity';
import { createChimneySmoke, type ChimneySmokeHandle } from './ChimneySmoke';
import { P, resolvePalette } from './palette';
import { LodSelector, pixelsPerMetre } from './ScreenSpaceLod';
import { checkModel, checkProbes, type GroundContactReport, type ProbeInput } from './GroundContact';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { parseKey, type GeometryStrategy } from './strategies/strategy';
import type { Cluster, Layer, MaterialClass } from './surface';
import type { HybridStrategyName } from './spikeFlag';

export { getSpikeCheckpoint, SPIKE_CHECKPOINTS, STREET_EYE_SHOT } from './spikeCheckpoints';

export interface HybridSpikeOptions {
  scene: THREE.Scene;
  strategy: HybridStrategyName;
  quality: QualityProfile;
  themePalette: Record<number, number>;
}

export interface HybridMetrics {
  strategy: HybridStrategyName;
  generationMs: number;
  triangles: [number, number, number];
  vertices: number;
  bytes: number;
  meshes: number;
  clusters: number;
  lodLevels: Record<string, Layer>;
  /** Pixels per metre that produced those levels, per cluster. */
  lodPixelsPerMetre: Record<string, number>;
  low: boolean;
  /**
   * What the grocery's display glass is emitting, and how far the awnings are out.
   *
   * Both are states a picture can be argued about and a number cannot, and neither can be
   * read back off the canvas: the renderer has no `preserveDrawingBuffer`, so a
   * `drawImage` of it comes out blank. So "the light inside signals that the shop is open"
   * is checked against what the frame actually put in the uniform.
   */
  shopGlow: number;
  awningFold: number;
}

/**
 * What the hybrid needs from one frame.
 *
 * `sunT` and `clockT` are the same number in simulation and different numbers in real
 * time, and telling them apart is the whole point of the split: real-time mode warps the
 * lighting phase so the viewer's real sunrise lands on 0.25 and their real sunset on 0.75,
 * which is right for the sky and useless as a clock. Anything about *light* reads `sunT`;
 * anything about an *hour* reads `clockT`.
 */
export interface HybridFrame {
  camera: THREE.PerspectiveCamera;
  viewportHeightPx: number;
  /** Lighting phase, 0..1 of the cycle. Warped against the wall clock in real time. */
  sunT: number;
  /** Hour of day, 0..1 of a real 24 h. The hour the HUD prints, in either mode. */
  clockT: number;
  night: number;
  /** Real seconds since the previous frame. Zero while a checkpoint is locked. */
  dt: number;
  /** Real seconds of presentation time -- the app's own clock, which checkpoints define. */
  elapsed: number;
  /** The grocery has been cleaned out overnight, so it stays dark until it is restocked. */
  shopRobbed: boolean;
  /** The world's own wind strength, shared with the weather rather than invented here. */
  wind: number;
}

/** One window cohort: how many openings are in it, and what the frame is driving it with. */
export interface HybridWindowCohort {
  cohort: number;
  /** Openings assigned to this cohort across the city -- the population being observed. */
  windows: number;
  /** The value the last frame wrote into `uCohort`, which is what lights them. */
  activity: number;
}

export interface HybridHandle {
  update(frame: HybridFrame): void;
  /**
   * The hybrid's residential windows, as cohorts and their sizes.
   *
   * The voxel city drives each window through its own material, so it can be observed by
   * listing materials. The hybrid drives all of them from `uCohort`, one value per cohort,
   * read per vertex from `aCohort` -- so the observable is the cohort table plus how many
   * openings were assigned to each. Without this, a diagnostic that lists voxel materials
   * sees nothing at all in the default world.
   */
  getWindowCohorts(): HybridWindowCohort[];
  setTheme(palette: Record<number, number>): void;
  setSnowCover(cover: number): void;
  setWetness(wetness: number): void;
  setQuality(profile: QualityProfile): void;
  /**
   * 0 = the ordinary city, 1 = the Cyberpunk one. Hides what it replaces on the way up and
   * gives all of it back on the way down.
   */
  setCyberRise(factor: number): void;
  getMetrics(): HybridMetrics;
  /** Static model rules plus a live raycast of every probe (and the shelter passengers) onto the drawn ground. */
  checkGroundContact(): GroundContactReport;
  getBloomObjects(): THREE.Object3D[];
  dispose(): void;
}

class LodGroup {
  readonly selector = new LodSelector();
  readonly center: THREE.Vector3;
  /**
   * This cluster has been replaced by another representation and must not draw.
   *
   * It lives here rather than as a one-off `visible = false` because the LOD pass reasserts
   * visibility per mesh on every level change: hiding a cluster from outside would last
   * until the camera moved. A swap that a step backwards undoes is not a swap.
   */
  suppressed = false;
  constructor(readonly cluster: Cluster, readonly meshes: Map<string, THREE.Mesh>, readonly radius: number) {
    this.center = new THREE.Vector3(...cluster.center);
    this.apply(0);
  }
  apply(level: Layer): void {
    for (const [key, mesh] of this.meshes) {
      mesh.visible = !this.suppressed && parseKey(key).layer <= level;
    }
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

export function attachHybridSpike(options: HybridSpikeOptions): HybridHandle {
  const model = buildCityModel();
  const uniforms = createHybridUniforms();
  resolvePalette(options.themePalette, uniforms.uPalette.value);
  const materials: Record<MaterialClass, THREE.MeshStandardMaterial> = {
    opaque: createHybridMaterial(uniforms),
    // The product gives an unlit window envIntensity 2.0 and drops it to 1.1 once the
    // window is lit. One shared material cannot switch, and measurement says the higher
    // value costs more in lit-window contrast than it buys in glassiness, so the
    // fragment keeps 1.0 and takes its glassiness from roughness and colour.
    glass: createHybridMaterial(uniforms),
    glassClear: createHybridMaterial(uniforms, { transparent: true }),
    glow: createHybridMaterial(uniforms),
  };
  const strategy: GeometryStrategy = buildDirect;
  const group = new THREE.Group();
  group.name = 'hybrid-spike';
  options.scene.add(group);

  /**
   * The Cyberpunk representation, and the clusters it stands in for.
   *
   * Built from the same `CityModel`, so a megablock occupies its plot and nothing of the
   * ordinary building it replaces can hang outside it. Which clusters get replaced is
   * decided by role: every residential plot, plus the two dominants, each of which gets a
   * transform of its own kind. The streetscape and the grocery are not replaced -- the
   * roads, pavements, lamps and trees are the layout, and the layout stays.
   */
  const cyber = createCyberCity(model);
  options.scene.add(cyber.group);
  const smoke = createChimneySmoke();
  options.scene.add(smoke.object);
  let cyberRise = 0;
  /**
   * Apply the swap to whatever LOD groups currently exist.
   *
   * Called again after every rebuild, because `setQuality` throws the groups away and
   * makes new ones: without this, switching profile while Cyberpunk was up brought the
   * ordinary city back underneath it.
   */
  const applyCyberSwap = () => {
    const on = cyberRise > 0.5;
    for (const lodGroup of lodGroups) {
      if (!isReplacedByCyber(lodGroup.cluster.id)) continue;
      if (lodGroup.suppressed === on) continue;
      lodGroup.suppressed = on;
      lodGroup.apply(lodGroup.selector.level);
    }
    // The ordinary stack vents just above its top segment; the Cyberpunk one is taller and
    // has a flared mouth. The plume is anchored to whichever is standing.
    const chimney = model.dominants.find((dominant) => dominant.kind === 'chimney');
    if (chimney) {
      if (on) {
        const outlet = cyber.outlet();
        smoke.setOutlet(outlet.x, outlet.y, outlet.z);
      } else {
        smoke.setOutlet(chimney.x, GROUND + chimney.height + 0.6, chimney.z);
      }
    }
  };

  let low = options.quality.level === 'low';
  /** Openings per window cohort, counted from the primitives that carry the assignment. */
  const cohortWindows = new Array<number>(WINDOW_COHORT_COUNT).fill(0);
  const lodGroups: LodGroup[] = [];
  const bloom: THREE.Object3D[] = [];
  let streetGround: THREE.Mesh | null = null;
  const totals = { generationMs: 0, triangles: [0, 0, 0] as [number, number, number], vertices: 0, bytes: 0, meshes: 0 };

  const disposeMeshes = () => {
    for (const lodGroup of lodGroups) {
      for (const mesh of lodGroup.meshes.values()) {
        group.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    lodGroups.length = 0;
    bloom.length = 0;
    streetGround = null;
  };

  const buildAll = () => {
    disposeMeshes();
    totals.generationMs = 0;
    totals.triangles = [0, 0, 0];
    totals.vertices = 0;
    totals.bytes = 0;
    totals.meshes = 0;
    const clusters: Cluster[] = [
      ...model.buildings.map(emitBuilding),
      emitStreetscape(model),
      emitGroceries(low),
      ...model.dominants.map((dominant) => emitDominant(dominant, low)),
    ];
    cohortWindows.fill(0);
    for (const cluster of clusters) {
      // Counted here, before the primitives are merged away into buffers: after that the
      // assignment survives only as a per-vertex attribute, and counting openings from
      // vertices means guessing how many vertices an opening had.
      for (const primitive of cluster.primitives) {
        if (primitive.cohort >= 0 && primitive.cohort < WINDOW_COHORT_COUNT) {
          cohortWindows[primitive.cohort] += 1;
        }
      }
      const result = strategy(cluster);
      const meshes = new Map<string, THREE.Mesh>();
      for (const [key, geometry] of result.geometries) {
        const { cls } = parseKey(key);
        const mesh = new THREE.Mesh(geometry, materials[cls]);
        mesh.name = `hybrid-${cluster.id}-${key}`;
        mesh.castShadow = cls === 'opaque' || cls === 'glass';
        mesh.receiveShadow = cls !== 'glow';
        mesh.renderOrder = cls === 'glassClear' ? 2 : 0;
        group.add(mesh);
        meshes.set(key, mesh);
        if (cls === 'glass' || cls === 'glow') bloom.push(mesh);
        if (cluster.id === 'streetscape' && key === 'opaque:0') streetGround = mesh;
      }
      const lodGroup = new LodGroup(cluster, meshes, cluster.radius);
      lodGroup.selector.maxLevel = low ? 1 : 2;
      lodGroups.push(lodGroup);
      totals.generationMs += result.stats.generationMs;
      for (let layer = 0; layer < 3; layer++) totals.triangles[layer] += result.stats.triangles[layer];
      totals.vertices += result.stats.vertices;
      totals.bytes += result.stats.bytes;
      totals.meshes += meshes.size;
    }
  };
  buildAll();
  // After the first build, never before it: the swap reads `lodGroups`, and `buildAll` is
  // what fills them. Calling it earlier threw a temporal-dead-zone error inside the
  // fragment's own module, so `hybrid` stayed null -- a city that silently did not build,
  // while a check for "no ordinary meshes visible" passed for the wrong reason.
  applyCyberSwap();

  const raycaster = new THREE.Raycaster();
  const rayOrigin = new THREE.Vector3();
  const groundAt = (x: number, z: number): number => {
    if (!streetGround) return GROUND_SURFACE_Y;
    rayOrigin.set(x, GROUND_SURFACE_Y + 4, z);
    raycaster.set(rayOrigin, DOWN);
    raycaster.far = 8;
    const hits = raycaster.intersectObject(streetGround, false);
    return hits.length > 0 ? hits[0].point.y : GROUND_SURFACE_Y;
  };

  const lodLevels = (): Record<string, Layer> => {
    const levels: Record<string, Layer> = {};
    for (const lodGroup of lodGroups) levels[lodGroup.cluster.id] = lodGroup.selector.level;
    return levels;
  };
  /** Last LOD input per cluster: gate 3 has to see the measure, not just the outcome. */
  const lodPixelsPerMetre: Record<string, number> = {};

  /**
   * Shop awnings: their own objects, because static geometry cannot open at ten. They
   * take the shared opaque material, so the palette, theme, snow, wetness and night tint
   * reach them exactly as they reach the wall they hang on.
   */
  const awnings = new Awnings(options.scene, model.buildings, materials.opaque);

  return {
    update({ camera, viewportHeightPx, sunT, clockT, night, dt, elapsed, shopRobbed, wind }) {
      const t01 = sunT;
      uniforms.uNight.value = night;
      // Real seconds, not fractions of the day: a warning light keeps its own rate
      // whatever the clock over it is doing. The chimney and the mast flash half a period
      // apart, so the skyline never blinks as one object.
      uniforms.uEmissive.value[P.aviationRed] = beaconGlow(elapsed, night, 0);
      uniforms.uEmissive.value[P.aviationRedAlt] = beaconGlow(elapsed, night, 0.5);
      // The grocery keeps its own hours -- six in the morning to eleven at night -- and
      // the light inside is on while it is open, brighter once it is dark out.
      uniforms.uEmissive.value[P.shopGlow] = groceryGlow(clockT, night, shopRobbed);
      // One call for every awning in the city, on the hour and the frame's own delta.
      awnings.update(clockT, dt);
      // One plume, one clock, one wind: the same elapsed seconds the beacons use and the
      // same wind strength the weather publishes.
      smoke.update(elapsed, wind, night);
      for (let cohort = 0; cohort < WINDOW_COHORT_COUNT; cohort++) {
        uniforms.uCohort.value[cohort] = residentialWindowActivityAt(t01, cohort);
      }
      for (const lodGroup of lodGroups) {
        const distance = Math.max(0.5, camera.position.distanceTo(lodGroup.center) - lodGroup.radius);
        const measure = pixelsPerMetre(viewportHeightPx, camera.fov, distance);
        lodPixelsPerMetre[lodGroup.cluster.id] = measure;
        const previous = lodGroup.selector.level;
        const level = lodGroup.selector.update(measure, dt);
        if (level !== previous) lodGroup.apply(level);
      }
    },
    setTheme(palette) {
      resolvePalette(palette, uniforms.uPalette.value);
    },
    setSnowCover(cover) {
      uniforms.uSnow.value = THREE.MathUtils.clamp(cover, 0, 1);
    },
    setWetness(wetness) {
      uniforms.uWet.value = THREE.MathUtils.clamp(wetness, 0, 1);
    },
    setCyberRise(factor) {
      cyberRise = THREE.MathUtils.clamp(factor, 0, 1);
      cyber.setRise(cyberRise);
      applyCyberSwap();
    },
    setQuality(profile) {
      const nextLow = profile.level === 'low';
      if (nextLow !== low) {
        low = nextLow;
        buildAll();
        // The rebuild made new LOD groups, which start unsuppressed: put the swap back
        // before the next frame draws two cities on top of each other.
        applyCyberSwap();
      }
      cyber.setLow(nextLow);
      smoke.setLow(nextLow);
      for (const lodGroup of lodGroups) {
        lodGroup.selector.maxLevel = low ? 1 : 2;
        if (lodGroup.selector.level > lodGroup.selector.maxLevel) {
          lodGroup.selector.level = lodGroup.selector.maxLevel;
          lodGroup.apply(lodGroup.selector.level);
        }
      }
    },
    getWindowCohorts() {
      const out: HybridWindowCohort[] = [];
      for (let cohort = 0; cohort < WINDOW_COHORT_COUNT; cohort++) {
        if (cohortWindows[cohort] === 0) continue;
        out.push({ cohort, windows: cohortWindows[cohort], activity: uniforms.uCohort.value[cohort] });
      }
      return out;
    },

    getMetrics() {
      return {
        strategy: options.strategy,
        generationMs: totals.generationMs,
        triangles: [...totals.triangles] as [number, number, number],
        vertices: totals.vertices,
        bytes: totals.bytes,
        meshes: totals.meshes,
        clusters: lodGroups.length,
        shopGlow: uniforms.uEmissive.value[P.shopGlow],
        awningFold: awnings.progress,
        lodLevels: lodLevels(),
        /** The replacement representation, so a test can see the swap rather than infer it. */
        cyber: {
          rise: cyberRise,
          ...cyber.counts(),
          suppressedClusters: lodGroups.filter((lodGroup) => lodGroup.suppressed).map((lodGroup) => lodGroup.cluster.id),
        },
        lodPixelsPerMetre: { ...lodPixelsPerMetre },
        low,
      };
    },
    checkGroundContact() {
      const report = checkModel(model, BUS_STOPS[0]);
      const probes: ProbeInput[] = [];
      for (const prop of model.props) {
        prop.probes.forEach((probe, index) => probes.push({ id: `scene:${prop.id}#${index}`, x: probe.x, y: probe.y, z: probe.z }));
      }
      options.scene.traverse((object) => {
        if (object.name.startsWith('bus-passenger-Osiedle Centralne-')) {
          probes.push({ id: `scene:${object.name}`, x: object.position.x, y: object.position.y, z: object.position.z });
        }
      });
      const runtime = checkProbes(probes, groundAt);
      report.violations.push(...runtime.violations);
      report.checked += runtime.checked;
      report.ok = report.violations.length === 0;
      return report;
    },
    getBloomObjects() {
      return [...bloom, ...cyber.emissiveObjects()];
    },
    dispose() {
      cyber.dispose();
      smoke.dispose();
      disposeMeshes();
      awnings.dispose();
      options.scene.remove(group);
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
