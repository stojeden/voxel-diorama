import * as THREE from 'three';
import { WINDOW_COHORT_COUNT, residentialWindowActivityAt } from '../../environment/CityRhythm';
import type { QualityProfile } from '../../performance/QualityManager';
import { BUS_STOPS, GROUND_SURFACE_Y } from '../WorldLayout';
import { buildCityModel, GROUND, type CityModel } from './CityModel';
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
import { P, resolvePalette, resolvePaletteBlend } from './palette';
import { LodSelector, pixelsPerMetre } from './ScreenSpaceLod';
import { checkModel, checkProbes, type GroundContactReport, type ProbeInput } from './GroundContact';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { parseKey, type GeometryStrategy } from './strategies/strategy';
import { DetailStreamer, DETAIL_RESIDENT_LIMIT } from './DetailStreamer';
import { unpackGeometry } from './GeometryTransfer';
import { createFarDistricts, FAR_DISTRICT_ENTER, FAR_DISTRICT_EXIT } from './FarDistricts';
import type { Cluster, Layer, MaterialClass } from './surface';
import type { HybridStrategyName } from './spikeFlag';
import type { GullMast, GullRoof } from '../Birds';
import { gullMastsOf, gullRoofsOf } from './gullRoofs';
import type { Clock01, WallClock01 } from '../../units';

/** `building-24` -> 24: the cluster id carries the block index the awnings are keyed by. */
const BUILDING_BLOCK = /^building-(\d+)$/;

export { getSpikeCheckpoint, SPIKE_CHECKPOINTS, STREET_EYE_SHOT } from './spikeCheckpoints';

export interface HybridSpikeOptions {
  scene: THREE.Scene;
  strategy: HybridStrategyName;
  quality: QualityProfile;
  themePalette: Record<number, number>;
  /** Optional deterministic stress model; ordinary boot uses the canonical city. */
  model?: CityModel;
  /** The bloom owner must refresh its selection after streamed mesh changes. */
  onResidencyChange?: () => void;
  /**
   * Where the Cyberpunk morph already stands, 0..1. The hybrid is a lazy chunk, so a boot
   * checkpoint that sets the theme has set the morph before this city exists; without being
   * told, it built the ordinary city at rise 0 under the Cyberpunk grade, and the frame loop
   * never asked again because the morph was already at its target.
   */
  cyberRise?: number;
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
  streaming: {
    mode: 'worker' | 'fallback'; workerFailed: boolean; revision: number;
    resident: number; requested: number; pending: number; evicted: number;
    residentLimit: number; farDistricts: number; savedTriangles: number;
    foundationResident: number; proxyBuildings: number;
    eligible: number; deferred: number; visibleDeferred: number;
  };
  /** The Cyberpunk representation: how far it has risen, and what it has suppressed. */
  cyber: {
    rise: number;
    instances: number;
    meshes: number;
    geometries: number;
    suppressedClusters: string[];
  };
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
 *
 * They carry different brands for that reason and not for tidiness: two adjacent bare
 * numbers whose own doc comment has to say they are different is the exact shape this
 * codebase has already paid for six times, and it is the worst shape of all here -- every
 * test passes in simulation, where the two genuinely are equal, and only a viewer with real
 * time on ever sees the swap. The compiler now refuses it.
 */
export interface HybridFrame {
  camera: THREE.PerspectiveCamera;
  viewportHeightPx: number;
  /** Lighting phase, 0..1 of the cycle. Warped against the wall clock in real time. */
  sunT: Clock01;
  /** Hour of day, 0..1 of a real 24 h. The hour the HUD prints, in either mode. */
  clockT: WallClock01;
  night: number;
  /** Real seconds since the previous frame. Zero while a checkpoint is locked. */
  dt: number;
  /** Real seconds of presentation time -- the app's own clock, which checkpoints define. */
  elapsed: number;
  /** The grocery has been cleaned out overnight, so it stays dark until it is restocked. */
  shopRobbed: boolean;
  /** The world's own wind strength, shared with the weather rather than invented here. */
  wind: number;
  /**
   * The world's own wind DIRECTION, as the `x` and `z` of a unit vector pointing the way
   * the wind blows toward. Shared for the same reason the strength is: the plume used to
   * derive a private bearing and could lean against the trees.
   */
  windDirX: number;
  windDirZ: number;
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
  /** One theme's palette, or a point between two; `t` of 1 lands on `to` exactly. */
  setThemeBlend(from: Record<number, number>, to: Record<number, number>, t: number): void;
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
  /** Every building's roof as the gulls need it: where to sit, how high to fly. */
  getGullRoofs(): GullRoof[];
  /** The chimney and the RTV tower, which the gulls fly round. */
  getGullMasts(): GullMast[];
  dispose(): void;
}

class LodGroup {
  readonly selector = new LodSelector();
  readonly center: THREE.Vector3;
  readonly preloadBounds: THREE.Sphere;
  inView = true;
  measure = 0;
  /**
   * This cluster has been replaced by another representation and must not draw.
   *
   * It lives here rather than as a one-off `visible = false` because the LOD pass reasserts
   * visibility per mesh on every level change: hiding a cluster from outside would last
   * until the camera moved. A swap that a step backwards undoes is not a swap.
   */
  suppressed = false;
  far = false;
  constructor(readonly cluster: Cluster, readonly meshes: Map<string, THREE.Mesh>, readonly radius: number) {
    this.center = new THREE.Vector3(...cluster.center);
    this.preloadBounds = new THREE.Sphere(this.center, radius + 20);
    this.apply(0);
  }
  apply(level: Layer): void {
    for (const [key, mesh] of this.meshes) {
      mesh.visible = !this.suppressed && !this.far && parseKey(key).layer <= level;
    }
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * When each plot hands its ordinary form over to its Cyberpunk one.
 *
 * Every replaced cluster used to hand over at exactly 0.5, so the whole residential city
 * vanished and its replacement appeared inside a single frame. Measured with the camera
 * pinned, against a background of 0.92 luminance levels of the city's own motion between
 * frames: that one frame moved 16.1, and once the palettes, the grade and the four tone
 * scalars were on a fade it was the largest event left in a two-second morph by a factor of
 * eight.
 *
 * Spread across the middle third of the morph, evenly, by position in the sorted id list.
 * The first attempt hashed the id instead and it barely spread at all: the ids are
 * `building-0` through `building-33`, a hash taken modulo a thousand collapses their
 * differences, and thirty of thirty-six landed inside one frame's worth of threshold
 * (0.447 to 0.469). Even spacing is also simply the right tool -- an even spread is the
 * thing wanted, and sorting gets it exactly rather than in distribution.
 *
 * The window stays away from both ends on purpose: below 0.38 the Cyberpunk tower is still
 * too short to stand in for what it replaces, and above 0.62 there is not enough morph left
 * to cover the change. Keyed on the id, not the build order, so it survives the rebuild that
 * `setQuality` does -- a handover that moved on rebuild would flicker the city back.
 */
export const CYBER_HANDOVER_FROM = 0.38;
export const CYBER_HANDOVER_TO = 0.62;

export function cyberHandoverTable(clusterIds: readonly string[]): Map<string, number> {
  const ids = [...clusterIds].sort();
  const table = new Map<string, number>();
  const span = CYBER_HANDOVER_TO - CYBER_HANDOVER_FROM;
  for (let i = 0; i < ids.length; i++) {
    const at = ids.length === 1 ? 0.5 : i / (ids.length - 1);
    table.set(ids[i], CYBER_HANDOVER_FROM + span * at);
  }
  return table;
}

export function attachHybridSpike(options: HybridSpikeOptions): HybridHandle {
  const model = options.model ?? buildCityModel();
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
  let cyberRise = THREE.MathUtils.clamp(options.cyberRise ?? 0, 0, 1);
  cyber.setRise(cyberRise);
  /**
   * Apply the swap to whatever LOD groups currently exist.
   *
   * Called again after quality-sensitive grocery/dominant replacements. Residential
   * foundations and streamed detail groups retain their identity across profile changes.
   */
  /**
   * Built on first use from the ids the swap applies to, then kept.
   *
   * Lazily because `lodGroups` is created below this, and kept because a rebuild makes new
   * groups for the same ids -- rebuilding the table would be harmless but pointless.
   */
  let handovers: Map<string, number> | null = null;

  const applyCyberSwap = () => {
    handovers ??= cyberHandoverTable(
      lodGroups
        .filter((group) => isReplacedByCyber(group.cluster.id))
        .map((group) => group.cluster.id)
    );
    // The chimney hands over on its own threshold like every other plot, and the plume has
    // to follow THAT rather than the midpoint -- otherwise between the two moments the smoke
    // starts in mid-air above a stack that is still standing. Read off the same loop so
    // there is one source of truth for the decision.
    let chimneyOn = cyberRise > 0.5;
    for (const lodGroup of lodGroups) {
      if (!isReplacedByCyber(lodGroup.cluster.id)) continue;
      const on = cyberRise > (handovers.get(lodGroup.cluster.id) ?? 0.5);
      if (lodGroup.cluster.id.includes('chimney')) chimneyOn = on;
      // An awning leaves with the tenement it hangs on, on the same threshold.
      const block = BUILDING_BLOCK.exec(lodGroup.cluster.id);
      if (block) awnings.setBlockHidden(Number(block[1]), on);
      if (lodGroup.suppressed === on) continue;
      lodGroup.suppressed = on;
      lodGroup.apply(lodGroup.selector.level);
      const district = districtByBuilding.get(lodGroup.cluster.id);
      district?.setBuildingVisible(lodGroup.cluster.id,
        !on && (district.far || !foundations.has(lodGroup.cluster.id)));
    }
    // The ordinary stack vents just above its top segment; the Cyberpunk one is taller and
    // has a flared mouth. The plume is anchored to whichever is standing.
    const chimney = model.dominants.find((dominant) => dominant.kind === 'chimney');
    if (chimney) {
      if (chimneyOn) {
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
  const lodById = new Map<string, LodGroup>();
  const bloom: THREE.Object3D[] = [];
  let streetGround: THREE.Mesh | null = null;
  const totals = { generationMs: 0, triangles: [0, 0, 0] as [number, number, number], vertices: 0, bytes: 0, meshes: 0 };
  const details = new Map<string, Cluster>();
  /** Cold source metadata survives GPU eviction; no second copy of primitive objects. */
  const fullBuildings = new Map<string, Cluster>();
  const foundations = new Set<string>();
  const foundationTriangles = new Map<string, number>();
  const resident = new Set<string>();
  const wanted = new Set<string>();
  const eligible: LodGroup[] = [];
  const candidates: Cluster[] = [];
  const residencyFrustum = new THREE.Frustum();
  const residencyProjection = new THREE.Matrix4();
  const byPriority = (a: LodGroup, b: LodGroup): number => Number(b.inView) - Number(a.inView) || b.measure - a.measure;
  let revision = 0;
  let evicted = 0;
  let eligibleCount = 0;
  let visibleEligibleCount = 0;
  let disposed = false;
  const changed = () => { revision++; options.onResidencyChange?.(); };
  const removeMesh = (mesh: THREE.Mesh) => {
    group.remove(mesh);
    mesh.geometry.dispose();
    const index = bloom.indexOf(mesh);
    if (index >= 0) bloom.splice(index, 1);
  };
  const addMesh = (cluster: Cluster, key: string, geometry: THREE.BufferGeometry): THREE.Mesh => {
    const { cls } = parseKey(key);
    const mesh = new THREE.Mesh(geometry, materials[cls]);
    mesh.name = `hybrid-${cluster.id}-${key}`;
    mesh.castShadow = cls === 'opaque';
    mesh.receiveShadow = cls !== 'glow';
    mesh.renderOrder = cls === 'glassClear' ? 2 : 0;
    group.add(mesh);
    if (cls === 'glass' || cls === 'glow') bloom.push(mesh);
    if (cluster.id === 'streetscape' && key === 'opaque:0') streetGround = mesh;
    return mesh;
  };
  const streamer = new DetailStreamer((id, packed) => {
    const lod = lodById.get(id);
    if (!lod || !wanted.has(id)) return;
    const previous = lod.meshes.get(packed.key);
    if (previous) removeMesh(previous);
    lod.meshes.set(packed.key, addMesh(lod.cluster, packed.key, unpackGeometry(packed)));
    lod.apply(lod.selector.level);
    changed();
  }, (id) => {
    resident.add(id);
    if (foundations.has(id)) return;
    // All material buffers are present before revealing any part of a cold foundation.
    // Until this point the complete plot envelope remains visible, with no geometry holes.
    foundations.add(id);
    const lod = lodById.get(id)!;
    lod.far = false;
    lod.apply(lod.selector.level);
    districtByBuilding.get(id)?.setBuildingVisible(id, false);
    changed();
  });
  const farDistricts = createFarDistricts(model.buildings, materials.opaque);
  const districtByBuilding = new Map(farDistricts.flatMap((district) =>
    [...district.buildings].map((id) => [id, district] as const)));
  for (const district of farDistricts) group.add(district.mesh);

  const disposeMeshes = () => {
    for (const lodGroup of lodGroups) {
      for (const mesh of lodGroup.meshes.values()) {
        removeMesh(mesh);
      }
    }
    lodGroups.length = 0;
    lodById.clear();
    bloom.length = 0;
    streetGround = null;
  };

  const buildAll = () => {
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
      const isBuilding = BUILDING_BLOCK.test(cluster.id);
      if (isBuilding) {
        fullBuildings.set(cluster.id, cluster);
        details.set(cluster.id, { ...cluster, primitives: cluster.primitives.filter((p) => p.layer > 0) });
      }
      const foundation = isBuilding ? { ...cluster, primitives: cluster.primitives.filter((p) => p.layer === 0) } : cluster;
      const result = strategy(foundation);
      if (isBuilding) {
        foundations.add(cluster.id);
        foundationTriangles.set(cluster.id, result.stats.triangles[0]);
      }
      const meshes = new Map<string, THREE.Mesh>();
      for (const [key, geometry] of result.geometries) {
        const mesh = addMesh(cluster, key, geometry);
        meshes.set(key, mesh);
      }
      // Keep semantic identity and bounds, not a second copy of all detail primitives.
      const lodGroup = new LodGroup({ ...cluster, primitives: [] }, meshes, cluster.radius);
      lodGroup.selector.maxLevel = low ? 1 : 2;
      lodGroups.push(lodGroup);
      lodById.set(cluster.id, lodGroup);
      totals.generationMs += result.stats.generationMs;
      for (let layer = 0; layer < 3; layer++) totals.triangles[layer] += result.stats.triangles[layer];
      totals.vertices += result.stats.vertices;
      totals.bytes += result.stats.bytes;
      totals.meshes += meshes.size;
    }
  };
  const rebuildQualityClusters = () => {
    const replacements = [emitGroceries(low), ...model.dominants.map((d) => emitDominant(d, low))];
    for (const cluster of replacements) {
      const index = lodGroups.findIndex((lod) => lod.cluster.id === cluster.id);
      if (index < 0) continue;
      const previous = lodGroups[index];
      const result = strategy(cluster);
      const meshes = new Map<string, THREE.Mesh>();
      for (const [key, geometry] of result.geometries) meshes.set(key, addMesh(cluster, key, geometry));
      for (const mesh of previous.meshes.values()) removeMesh(mesh);
      const next = new LodGroup({ ...cluster, primitives: [] }, meshes, cluster.radius);
      next.selector.level = previous.selector.level;
      next.suppressed = previous.suppressed;
      next.apply(next.selector.level);
      lodGroups[index] = next;
      lodById.set(cluster.id, next);
    }
    changed();
  };
  /**
   * Shop awnings: their own objects, because static geometry cannot open at ten. They
   * take the shared opaque material, so the palette, theme, snow, wetness and night tint
   * reach them exactly as they reach the wall they hang on. Built before the first swap,
   * which hides the ones whose tenement the Cyberpunk city has replaced.
   */
  const awnings = new Awnings(options.scene, model.buildings, materials.opaque);
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


  return {
    update({
      camera, viewportHeightPx, sunT, clockT, night, dt, elapsed, shopRobbed,
      wind, windDirX, windDirZ,
    }) {
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
      // same wind strength AND bearing the weather publishes to the foliage shader.
      smoke.update(elapsed, wind, windDirX, windDirZ, night);
      for (let cohort = 0; cohort < WINDOW_COHORT_COUNT; cohort++) {
        // `clockT`, not `t01`: these are household windows going on and off at an HOUR, the
        // same kind of thing `groceryGlow` reads the wall clock for six lines up. It was the
        // lighting clock here purely because `const t01 = sunT` was in scope, which is
        // harmless only while the two coincide.
        uniforms.uCohort.value[cohort] = residentialWindowActivityAt(clockT, cohort);
      }
      camera.updateWorldMatrix(true, false);
      residencyProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      residencyFrustum.setFromProjectionMatrix(residencyProjection, camera.coordinateSystem);
      for (const lodGroup of lodGroups) {
        const distance = Math.max(0.5, camera.position.distanceTo(lodGroup.center) - lodGroup.radius);
        const measure = pixelsPerMetre(viewportHeightPx, camera.fov, distance);
        lodPixelsPerMetre[lodGroup.cluster.id] = measure;
        lodGroup.measure = measure;
        lodGroup.inView = residencyFrustum.intersectsSphere(lodGroup.preloadBounds);
        const previous = lodGroup.selector.level;
        const level = lodGroup.selector.update(measure, dt);
        if (level !== previous) lodGroup.apply(level);
      }
      for (const district of farDistricts) {
        const distance = Math.max(0, camera.position.distanceTo(district.center) - district.radius);
        const far = cyberRise === 0 && distance > (district.far ? FAR_DISTRICT_EXIT : FAR_DISTRICT_ENTER);
        if (far === district.far) continue;
        district.far = far;
        for (const id of district.buildings) {
          const lod = lodById.get(id);
          if (!lod) continue;
          lod.far = far || !foundations.has(id);
          lod.apply(lod.selector.level);
          district.setBuildingVisible(id, !lod.suppressed && lod.far);
        }
      }
      eligible.length = 0;
      candidates.length = 0;
      wanted.clear();
      visibleEligibleCount = 0;
      for (const lod of lodGroups) {
        if (!details.has(lod.cluster.id) || districtByBuilding.get(lod.cluster.id)?.far || lod.suppressed) continue;
        // A padded frustum preloads before an edge enters view. Very close plots get a
        // small behind-camera reserve for turns, but cannot outrank visible plots.
        if (!lod.inView && camera.position.distanceToSquared(lod.center) > (lod.radius + 25) ** 2) continue;
        if (!foundations.has(lod.cluster.id) || lod.selector.level > 0 || (resident.has(lod.cluster.id) && lod.measure >= 5)) {
          eligible.push(lod);
          if (lod.inView) visibleEligibleCount++;
        }
      }
      eligibleCount = eligible.length;
      eligible.sort(byPriority);
      if (eligible.length > DETAIL_RESIDENT_LIMIT) eligible.length = DETAIL_RESIDENT_LIMIT;
      for (const lod of eligible) {
        wanted.add(lod.cluster.id);
        if (!resident.has(lod.cluster.id)) candidates.push(
          (foundations.has(lod.cluster.id) ? details : fullBuildings).get(lod.cluster.id)!
        );
      }
      let removed = false;
      for (const lod of lodGroups) {
        if (!details.has(lod.cluster.id) || wanted.has(lod.cluster.id)) continue;
        let hadDetail = resident.delete(lod.cluster.id);
        const evictFoundation = districtByBuilding.get(lod.cluster.id)?.far || !foundations.has(lod.cluster.id);
        for (const [key, mesh] of lod.meshes) {
          if (parseKey(key).layer === 0 && !evictFoundation) continue;
          removeMesh(mesh); lod.meshes.delete(key); hadDetail = true;
        }
        if (evictFoundation) foundations.delete(lod.cluster.id);
        if (hadDetail) { evicted++; removed = true; }
      }
      if (removed) changed();
      streamer.tick(candidates, wanted);
    },
    setThemeBlend(from, to, t) {
      resolvePaletteBlend(from, to, t, uniforms.uPalette.value);
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
        rebuildQualityClusters();
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
      // Residency changes the actual buffers. Measure only when diagnostics asks, not per frame.
      const live = new Map<string, THREE.BufferGeometry>();
      for (const lod of lodGroups) for (const [key, mesh] of lod.meshes) live.set(`${lod.cluster.id}/${key}`, mesh.geometry);
      const liveTriangles: [number, number, number] = [0, 0, 0];
      let liveVertices = 0;
      let liveBytes = 0;
      let savedTriangles = 0;
      for (const lod of lodGroups) for (const [key, mesh] of lod.meshes) {
        const count = mesh.geometry.getAttribute('position').count;
        liveTriangles[parseKey(key).layer] += count / 3;
        liveVertices += count;
        for (const a of Object.values(mesh.geometry.attributes)) liveBytes += (a as THREE.BufferAttribute).array.byteLength;
      }
      for (const [id, count] of foundationTriangles) if (!foundations.has(id)) savedTriangles += count;
      // Hidden slots are zero-scale but still part of the instanced draw's triangle count.
      for (const d of farDistricts) if (d.mesh.visible) savedTriangles -= d.mesh.count * 12;
      return {
        strategy: options.strategy,
        generationMs: totals.generationMs,
        triangles: liveTriangles,
        vertices: liveVertices,
        bytes: liveBytes,
        meshes: live.size + farDistricts.length,
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
        streaming: {
          mode: streamer.mode, workerFailed: streamer.workerFailed, revision,
          resident: resident.size, requested: wanted.size, pending: streamer.pending, evicted,
          residentLimit: DETAIL_RESIDENT_LIMIT, farDistricts: farDistricts.filter((d) => d.far).length,
          savedTriangles: Math.max(0, savedTriangles),
          foundationResident: foundations.size,
          proxyBuildings: farDistricts.reduce((sum, district) => sum + district.visibleBuildings, 0),
          eligible: eligibleCount,
          deferred: Math.max(0, eligibleCount - DETAIL_RESIDENT_LIMIT),
          visibleDeferred: Math.max(0, visibleEligibleCount - DETAIL_RESIDENT_LIMIT),
        },
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
      return disposed ? [] : [...bloom, ...cyber.emissiveObjects()];
    },
    getGullRoofs() {
      return gullRoofsOf(model.buildings);
    },
    getGullMasts() {
      return gullMastsOf(model.dominants);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      streamer.dispose();
      for (const d of farDistricts) { group.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.dispose(); }
      cyber.dispose();
      smoke.dispose();
      disposeMeshes();
      awnings.dispose();
      options.scene.remove(group);
      for (const material of Object.values(materials)) material.dispose();
      changed();
    },
  };
}
