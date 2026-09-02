import * as THREE from 'three';
import { WINDOW_COHORT_COUNT, residentialWindowActivityAt } from '../../environment/CityRhythm';
import type { QualityProfile } from '../../performance/QualityManager';
import { BUS_STOPS, GROUND_SURFACE_Y } from '../WorldLayout';
import { buildCityModel } from './CityModel';
import { emitBuilding } from './architecture';
import { emitStreetscape } from './streetscape';
import { emitDominant } from './dominants';
import { createHybridMaterial, createHybridUniforms } from './HybridMaterial';
import { resolvePalette } from './palette';
import { LodSelector, pixelsPerMetre } from './ScreenSpaceLod';
import { checkModel, checkProbes, type GroundContactReport, type ProbeInput } from './GroundContact';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { buildGreedy } from './strategies/GreedyVoxelStrategy';
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
  /** Greedy only: voxel edge and how many thin dimensions were dilated to one cell. */
  cell: number | null;
  dilated: number;
  low: boolean;
}

export interface HybridHandle {
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number, t01: number, night: number, dt: number): void;
  setTheme(palette: Record<number, number>): void;
  setSnowCover(cover: number): void;
  setWetness(wetness: number): void;
  setQuality(profile: QualityProfile): void;
  getMetrics(): HybridMetrics;
  /** Static model rules plus a live raycast of every probe (and the shelter passengers) onto the drawn ground. */
  checkGroundContact(): GroundContactReport;
  getBloomObjects(): THREE.Object3D[];
  dispose(): void;
}

class LodGroup {
  readonly selector = new LodSelector();
  readonly center: THREE.Vector3;
  constructor(readonly cluster: Cluster, readonly meshes: Map<string, THREE.Mesh>, readonly radius: number) {
    this.center = new THREE.Vector3(...cluster.center);
    this.apply(0);
  }
  apply(level: Layer): void {
    for (const [key, mesh] of this.meshes) mesh.visible = parseKey(key).layer <= level;
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

export function attachHybridSpike(options: HybridSpikeOptions): HybridHandle {
  const model = buildCityModel();
  const uniforms = createHybridUniforms();
  resolvePalette(options.themePalette, uniforms.uPalette.value);
  const materials: Record<MaterialClass, THREE.MeshStandardMaterial> = {
    opaque: createHybridMaterial(uniforms),
    glass: createHybridMaterial(uniforms),
    glassClear: createHybridMaterial(uniforms, { transparent: true }),
    glow: createHybridMaterial(uniforms),
  };
  const strategy: GeometryStrategy = options.strategy === 'greedy' ? buildGreedy : buildDirect;
  const group = new THREE.Group();
  group.name = 'hybrid-spike';
  options.scene.add(group);

  let low = options.quality.level === 'low';
  const lodGroups: LodGroup[] = [];
  const bloom: THREE.Object3D[] = [];
  let streetGround: THREE.Mesh | null = null;
  const totals = { generationMs: 0, triangles: [0, 0, 0] as [number, number, number], vertices: 0, bytes: 0, meshes: 0, dilated: 0, cell: null as number | null };

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
    totals.dilated = 0;
    totals.cell = null;
    const clusters: Cluster[] = [
      ...model.buildings.map(emitBuilding),
      emitStreetscape(model),
      ...model.dominants.map((dominant) => emitDominant(dominant, low)),
    ];
    for (const cluster of clusters) {
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
      totals.dilated += result.stats.extra.dilated ?? 0;
      if (result.stats.extra.cell !== undefined) totals.cell = result.stats.extra.cell;
    }
  };
  buildAll();

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

  return {
    update(camera, viewportHeightPx, t01, night, dt) {
      uniforms.uNight.value = night;
      for (let cohort = 0; cohort < WINDOW_COHORT_COUNT; cohort++) {
        uniforms.uCohort.value[cohort] = residentialWindowActivityAt(t01, cohort);
      }
      for (const lodGroup of lodGroups) {
        const distance = Math.max(0.5, camera.position.distanceTo(lodGroup.center) - lodGroup.radius);
        const previous = lodGroup.selector.level;
        const level = lodGroup.selector.update(pixelsPerMetre(viewportHeightPx, camera.fov, distance), dt);
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
    setQuality(profile) {
      const nextLow = profile.level === 'low';
      if (nextLow !== low) {
        low = nextLow;
        buildAll();
      }
      for (const lodGroup of lodGroups) {
        lodGroup.selector.maxLevel = low ? 1 : 2;
        if (lodGroup.selector.level > lodGroup.selector.maxLevel) {
          lodGroup.selector.level = lodGroup.selector.maxLevel;
          lodGroup.apply(lodGroup.selector.level);
        }
      }
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
        lodLevels: lodLevels(),
        cell: totals.cell,
        dilated: totals.dilated,
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
      return [...bloom];
    },
    dispose() {
      disposeMeshes();
      options.scene.remove(group);
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}
