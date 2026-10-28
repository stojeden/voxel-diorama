import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCityModel, GROUND } from './CityModel';
import { emitBuilding } from './architecture';
import { Emitter } from './surface';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { packGeometry, unpackGeometry, transferBuffers, type PackedResult } from './GeometryTransfer';
import { DetailStreamer, DETAIL_UPLOAD_GEOMETRIES, DETAIL_UPLOAD_BYTES, DETAIL_RESIDENT_LIMIT } from './DetailStreamer';
import { createFarDistricts } from './FarDistricts';
import { attachHybridSpike } from './HybridSpike';
import { QUALITY_PROFILES } from '../../performance/QualityManager';
import { THEMES } from '../../experience/Themes';
import { clock01, wallClock01 } from '../../units.testing';

afterEach(() => vi.unstubAllGlobals());

describe('worker geometry contract', () => {
  test('a transferred building retains every vertex and semantic shader attribute exactly', () => {
    const cluster = emitBuilding(buildCityModel().buildings[0]);
    const direct = buildDirect(cluster);
    const packed = packGeometry(buildDirect(cluster));
    // Structured clone with transfer is the actual browser message ownership operation.
    const delivered = structuredClone(packed, { transfer: transferBuffers(packed) });
    expect(packed.geometries[0].attributes[0].array.byteLength).toBe(0);
    for (const entry of delivered.geometries) {
      const actual = unpackGeometry(entry);
      const expected = direct.geometries.get(entry.key)!;
      expect(Object.keys(actual.attributes)).toEqual(Object.keys(expected.attributes));
      for (const name of Object.keys(actual.attributes)) {
        expect(actual.getAttribute(name).array).toEqual(expected.getAttribute(name).array);
      }
      expect(actual.boundingSphere!.radius).toBeCloseTo(expected.boundingSphere!.radius, 8);
      actual.dispose(); expected.dispose();
    }
  });

  test('fallback is incremental, rejects obsolete requests, and never installs after disposal', () => {
    vi.stubGlobal('Worker', undefined);
    const emit = new Emitter();
    for (const cls of ['opaque', 'glass', 'glow'] as const) {
      for (const layer of [1, 2] as const) emit.box(0, 0, 0, 0, 1, 1, 1, { cls, layer });
    }
    const cluster = emit.cluster('test', [0, 0, 0], 1);
    const installed: string[] = [];
    const complete: string[] = [];
    const stream = new DetailStreamer((_id, g) => installed.push(g.key), (id) => complete.push(id));
    const wanted = new Set(['test']);
    stream.tick([cluster], wanted);
    expect(installed).toHaveLength(0);
    stream.tick([cluster], wanted);
    expect(installed).toHaveLength(DETAIL_UPLOAD_GEOMETRIES);
    expect(complete).toHaveLength(0);
    stream.tick([], new Set());
    expect(installed).toHaveLength(DETAIL_UPLOAD_GEOMETRIES);
    expect(complete).toHaveLength(0);
    stream.dispose();
    stream.tick([cluster], wanted);
    expect(stream.pending).toBe(0);
  });

  test('a worker error retries its active request through the bounded fallback', () => {
    let worker!: { onerror: (() => void) | null; terminate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> };
    vi.stubGlobal('Worker', class {
      onerror = null;
      onmessage = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { worker = this; }
    });
    const emit = new Emitter();
    emit.box(0, 0, 0, 0, 1, 1, 1, { layer: 1 });
    const cluster = emit.cluster('test', [0, 0, 0], 1);
    const install = vi.fn();
    const complete = vi.fn();
    const stream = new DetailStreamer(install, complete);
    stream.tick([cluster], new Set(['test']));
    stream.tick([cluster], new Set(['test']));
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.onerror!();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    stream.tick([cluster], new Set(['test']));
    stream.tick([cluster], new Set(['test']));
    expect(install).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('test');
    expect(stream.workerFailed).toBe(true);
    stream.dispose();
  });

  test('losing then regaining interest rebuilds the whole partial result, never just its tail', () => {
    vi.stubGlobal('Worker', undefined);
    const emit = new Emitter();
    for (const cls of ['opaque', 'glass', 'glow'] as const) {
      for (const layer of [1, 2] as const) emit.box(0, 0, 0, 0, 1, 1, 1, { cls, layer });
    }
    const cluster = emit.cluster('returning', [0, 0, 0], 1);
    const installed: string[] = [];
    const complete = vi.fn();
    const stream = new DetailStreamer((_id, geometry) => installed.push(geometry.key), complete);
    const wanted = new Set([cluster.id]);
    stream.tick([cluster], wanted);
    stream.tick([cluster], wanted);
    expect(installed).toHaveLength(4);
    // Hybrid evicts these buffers when interest disappears.
    installed.length = 0;
    stream.tick([], new Set());
    expect(complete).not.toHaveBeenCalled();
    stream.tick([cluster], wanted);
    stream.tick([cluster], wanted);
    expect(installed).toHaveLength(4);
    expect(complete).not.toHaveBeenCalled();
    stream.tick([cluster], wanted);
    expect(installed).toHaveLength(6);
    expect(new Set(installed).size).toBe(6);
    expect(complete).toHaveBeenCalledExactlyOnceWith(cluster.id);
    stream.dispose();
  });

  test('worker success transfers buffers, bounds each upload, and rejects late replies after disposal', () => {
    let mock!: MockWorker;
    class MockWorker {
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<{ id: string; result: PackedResult }>) => void) | null = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { mock = this; }
    }
    vi.stubGlobal('Worker', MockWorker);
    const emit = new Emitter();
    for (const cls of ['opaque', 'glass', 'glow'] as const) {
      for (const layer of [1, 2] as const) emit.box(0, 0, 0, 0, 1, 1, 1, { cls, layer });
    }
    const cluster = emit.cluster('worker-test', [0, 0, 0], 1);
    const install = vi.fn();
    const complete = vi.fn();
    const stream = new DetailStreamer(install, complete);
    const wanted = new Set([cluster.id]);
    stream.tick([cluster], wanted);
    expect(stream.mode).toBe('worker');
    expect(mock.postMessage).toHaveBeenCalledWith({ id: cluster.id, cluster });
    const packed = packGeometry(buildDirect(cluster));
    const delivered = structuredClone(packed, { transfer: transferBuffers(packed) });
    mock.onmessage!({ data: { id: cluster.id, result: delivered } } as MessageEvent);
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(DETAIL_UPLOAD_GEOMETRIES);
    expect(complete).not.toHaveBeenCalled();
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(6);
    expect(complete).toHaveBeenCalledExactlyOnceWith(cluster.id);
    // Two legal buffers fit the geometry-count cap, but not the byte budget.
    stream.tick([cluster], wanted);
    const byteResult = packGeometry(buildDirect(cluster));
    byteResult.geometries = [0, 1].map((index) => ({ key: `opaque:${index + 1}`,
      attributes: [{ name: 'position', itemSize: 3, array: new Float32Array(Math.floor(DETAIL_UPLOAD_BYTES * 0.6 / 12) * 3) }] }));
    mock.onmessage!({ data: { id: cluster.id, result: byteResult } } as MessageEvent);
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(7);
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(8);
    stream.dispose();
    mock.onmessage!({ data: { id: cluster.id, result: delivered } } as MessageEvent);
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(8);
    expect(stream.pending).toBe(0);
  });

  test('an invalidated in-flight worker reply cannot be revived by camera return', () => {
    let mock!: MockWorker;
    class MockWorker {
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<{ id: string; result: PackedResult }>) => void) | null = null;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { mock = this; }
    }
    vi.stubGlobal('Worker', MockWorker);
    const emit = new Emitter();
    emit.box(0, 0, 0, 0, 1, 1, 1, { layer: 1 });
    const cluster = emit.cluster('worker-return', [0, 0, 0], 1);
    const install = vi.fn();
    const complete = vi.fn();
    const stream = new DetailStreamer(install, complete);
    const wanted = new Set([cluster.id]);
    stream.tick([cluster], wanted);
    stream.tick([], new Set());
    stream.tick([cluster], wanted);
    expect(mock.postMessage).toHaveBeenCalledTimes(1);
    mock.onmessage!({ data: { id: cluster.id, result: packGeometry(buildDirect(cluster)) } } as MessageEvent);
    stream.tick([cluster], wanted);
    expect(install).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(stream.pending).toBe(0);
    stream.tick([cluster], wanted);
    expect(mock.postMessage).toHaveBeenCalledTimes(2);
    mock.onmessage!({ data: { id: cluster.id, result: packGeometry(buildDirect(cluster)) } } as MessageEvent);
    stream.tick([cluster], wanted);
    expect(install).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith(cluster.id);
    stream.dispose();
  });
});

test('far districts cover every plot once, preserve skyline height and reduce drawn triangle count', () => {
  const model = buildCityModel();
  const material = new THREE.MeshBasicMaterial();
  const districts = createFarDistricts(model.buildings, material);
  const ids = districts.flatMap((d) => [...d.buildings]);
  expect(new Set(ids).size).toBe(model.buildings.length);
  expect(ids).toHaveLength(model.buildings.length);
  expect(districts.length).toBeLessThan(model.buildings.length / 2);
  let nearTriangles = 0;
  for (const b of model.buildings) {
    const result = buildDirect(emitBuilding(b));
    nearTriangles += result.stats.triangles.reduce((a, n) => a + n, 0);
    for (const geometry of result.geometries.values()) geometry.dispose();
  }
  expect(model.buildings.length * 12).toBeLessThan(nearTriangles / 10);
  for (const district of districts) {
    expect(district.visibleBuildings).toBe(0);
    district.setAllBuildingsVisible(true);
    const matrix = new THREE.Matrix4();
    [...district.buildings].forEach((id, index) => {
      const b = model.buildings.find((item) => `building-${item.index}` === id)!;
      expect(district.mesh.geometry.getAttribute('aPalette').getX(index)).toBe(b.tint);
      district.mesh.getMatrixAt(index, matrix);
      expect(matrix.elements[13] + matrix.elements[5] / 2).toBeCloseTo(GROUND + b.heightMetres + b.roofHeight, 4);
    });
    district.mesh.geometry.dispose(); district.mesh.dispose();
  }
  material.dispose();
});

test('low/high replaces only quality-sensitive clusters, leaving building buffers and cohort semantics intact', () => {
  vi.stubGlobal('Worker', undefined);
  const scene = new THREE.Scene();
  const hybrid = attachHybridSpike({ scene, strategy: 'direct', quality: QUALITY_PROFILES.high, themePalette: THEMES[0].palette });
  const before = new Map<string, THREE.BufferGeometry>();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.name.startsWith('hybrid-building-')) before.set(object.name, object.geometry);
  });
  expect(before.size).toBeGreaterThan(0);
  const disposed = vi.fn();
  for (const geometry of before.values()) geometry.addEventListener('dispose', disposed);
  const cohorts = hybrid.getWindowCohorts();
  const previousBloom = hybrid.getBloomObjects();
  hybrid.setQuality(QUALITY_PROFILES.low);
  hybrid.setQuality(QUALITY_PROFILES.high);
  expect(disposed).not.toHaveBeenCalled();
  for (const [name, geometry] of before) expect((scene.getObjectByName(name) as THREE.Mesh).geometry).toBe(geometry);
  expect(hybrid.getWindowCohorts()).toEqual(cohorts);
  for (const object of hybrid.getBloomObjects()) expect(object.parent).not.toBeNull();
  const removedBloom = previousBloom.filter((object) => object.parent === null);
  expect(removedBloom.length).toBeGreaterThan(0);
  for (const object of removedBloom) expect(hybrid.getBloomObjects()).not.toContain(object);
  hybrid.dispose();
  expect(disposed).toHaveBeenCalledTimes(before.size);
  expect(hybrid.getBloomObjects()).toEqual([]);
}, 60_000);

test('far residency frees full GPU foundations and restores exact geometry behind hole-free proxies', () => {
  vi.stubGlobal('Worker', undefined);
  const scene = new THREE.Scene();
  const base = buildCityModel();
  const model = { ...base, buildings: base.buildings.slice(0, 2), dominants: [] };
  let revisions = 0;
  const hybrid = attachHybridSpike({ scene, strategy: 'direct', quality: QUALITY_PROFILES.high,
    themePalette: THEMES[0].palette, model, onResidencyChange: () => { revisions++; } });
  const foundations = new Map<string, THREE.BufferGeometry>();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.name.startsWith('hybrid-building-') && object.name.endsWith(':0')) {
      foundations.set(object.name, object.geometry);
    }
  });
  for (const building of model.buildings) {
    const direct = buildDirect(emitBuilding(building));
    for (const [key, geometry] of direct.geometries) {
      if (key.endsWith(':0')) {
        const actual = foundations.get(`hybrid-building-${building.index}-${key}`)!;
        for (const name of Object.keys(geometry.attributes)) {
          expect(actual.getAttribute(name).array).toEqual(geometry.getAttribute(name).array);
        }
      }
      geometry.dispose();
    }
  }
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  const frame = { camera, viewportHeightPx: 1080, sunT: clock01(0.5), clockT: wallClock01(0.5),
    night: 0, dt: 1, elapsed: 0, shopRobbed: false, wind: 0, windDirX: 1, windDirZ: 0 };
  let nearMeshes = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    camera.position.set(model.buildings[0].cx, 25, model.buildings[0].cz);
    for (let i = 0; i < 30; i++) {
      hybrid.update(frame);
      const progress = hybrid.getMetrics().streaming;
      expect(progress.foundationResident + progress.proxyBuildings).toBe(2);
    }
    const near = hybrid.getMetrics();
    expect(near.streaming.resident).toBe(2);
    expect(near.streaming.foundationResident).toBe(2);
    expect(near.streaming.proxyBuildings).toBe(0);
    expect(near.streaming.pending).toBe(0);
    for (const [name, original] of foundations) {
      const restored = (scene.getObjectByName(name) as THREE.Mesh).geometry;
      if (cycle > 0) expect(restored).not.toBe(original);
      for (const attribute of Object.keys(original.attributes)) {
        expect(restored.getAttribute(attribute).array).toEqual(original.getAttribute(attribute).array);
      }
    }
    if (cycle === 0) nearMeshes = near.meshes;
    else expect(near.meshes).toBe(nearMeshes);
    const detailMeshes: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object.name.startsWith('hybrid-building-') && !object.name.endsWith(':0')) detailMeshes.push(object);
    });
    expect(detailMeshes.length).toBeGreaterThan(0);
    camera.position.set(10000, 10000, 10000);
    for (let i = 0; i < 3; i++) hybrid.update(frame);
    const far = hybrid.getMetrics();
    expect(far.streaming.resident).toBe(0);
    expect(far.streaming.foundationResident).toBe(0);
    expect(far.streaming.proxyBuildings).toBe(2);
    expect(far.bytes).toBeLessThan(near.bytes);
    expect(far.streaming.farDistricts).toBeGreaterThan(0);
    expect(far.streaming.savedTriangles).toBeGreaterThan(0);
    for (const object of detailMeshes) expect(object.parent).toBeNull();
    expect(hybrid.getBloomObjects().every((object) => object.parent !== null)).toBe(true);
    for (const name of foundations.keys()) expect(scene.getObjectByName(name)).toBeUndefined();
  }
  expect(revisions).toBeGreaterThan(3);
  hybrid.dispose();
  expect(hybrid.getBloomObjects()).toEqual([]);
});

test('cold foundations survive interrupted reload, quality changes and cyber handovers without holes', () => {
  vi.stubGlobal('Worker', undefined);
  const base = buildCityModel();
  const model = { ...base, buildings: base.buildings.slice(0, 1), dominants: [] };
  const scene = new THREE.Scene();
  const hybrid = attachHybridSpike({ scene, strategy: 'direct', quality: QUALITY_PROFILES.high,
    themePalette: THEMES[0].palette, model });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  const frame = { camera, viewportHeightPx: 1080, sunT: clock01(0.5), clockT: wallClock01(0.5),
    night: 0, dt: 1, elapsed: 0, shopRobbed: false, wind: 0, windDirX: 1, windDirZ: 0 };
  const far = () => { camera.position.set(10000, 10000, 10000); hybrid.update(frame); };
  const near = () => {
    camera.position.set(model.buildings[0].cx, 25, model.buildings[0].cz);
    hybrid.update(frame);
    const state = hybrid.getMetrics().streaming;
    expect(state.foundationResident + state.proxyBuildings).toBe(1);
  };
  far();
  near(); // Dispatch the full cold building.
  near(); // Upload a bounded first batch, but do not expose an incomplete foundation.
  far(); // Evict that partial batch and invalidate the old job.
  near();
  hybrid.setQuality(QUALITY_PROFILES.low);
  hybrid.setCyberRise(1);
  hybrid.update(frame);
  expect(hybrid.getMetrics().streaming.proxyBuildings).toBe(0);
  hybrid.setCyberRise(0);
  hybrid.setQuality(QUALITY_PROFILES.high);
  for (let index = 0; index < 20; index++) near();
  expect(hybrid.getMetrics().streaming.foundationResident).toBe(1);
  expect(hybrid.getMetrics().streaming.proxyBuildings).toBe(0);
  const expected = buildDirect(emitBuilding(model.buildings[0]));
  for (const [key, geometry] of expected.geometries) {
    const restored = scene.getObjectByName(`hybrid-building-${model.buildings[0].index}-${key}`) as THREE.Mesh;
    expect(restored).toBeDefined();
    for (const attribute of Object.keys(geometry.attributes)) {
      expect(restored.geometry.getAttribute(attribute).array).toEqual(geometry.getAttribute(attribute).array);
    }
    geometry.dispose();
  }
  hybrid.dispose();
});

test('more eligible plots than the resident budget cannot grow the detail working set', () => {
  vi.stubGlobal('Worker', undefined);
  const base = buildCityModel();
  // Overlapping copies intentionally make every candidate equally close: this exercises
  // the hard capacity independently of camera distance or normal layout sparsity.
  const model = { ...base, dominants: [], buildings: Array.from({ length: DETAIL_RESIDENT_LIMIT + 3 },
    (_, index) => ({ ...base.buildings[0], index })) };
  const scene = new THREE.Scene();
  const hybrid = attachHybridSpike({ scene, strategy: 'direct', quality: QUALITY_PROFILES.high,
    themePalette: THEMES[0].palette, model });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  camera.position.set(model.buildings[0].cx, 25, model.buildings[0].cz);
  const frame = { camera, viewportHeightPx: 1080, sunT: clock01(0.5), clockT: wallClock01(0.5),
    night: 0, dt: 1, elapsed: 0, shopRobbed: false, wind: 0, windDirX: 1, windDirZ: 0 };
  for (let index = 0; index < DETAIL_RESIDENT_LIMIT * 5; index++) {
    hybrid.update(frame);
    const { streaming } = hybrid.getMetrics();
    expect(streaming.resident).toBeLessThanOrEqual(DETAIL_RESIDENT_LIMIT);
    expect(streaming.requested).toBe(DETAIL_RESIDENT_LIMIT);
    expect(streaming.eligible).toBe(DETAIL_RESIDENT_LIMIT + 3);
    expect(streaming.deferred).toBe(3);
    expect(streaming.visibleDeferred).toBe(3);
    expect(streaming.pending).toBeLessThanOrEqual(1);
  }
  expect(hybrid.getMetrics().streaming.resident).toBe(DETAIL_RESIDENT_LIMIT);
  camera.position.set(10000, 10000, 10000);
  hybrid.update(frame);
  expect(hybrid.getMetrics().streaming.resident).toBe(0);
  hybrid.dispose();
});

test('camera-facing residency omits distant behind-camera detail and rebuilds it after a turn', () => {
  vi.stubGlobal('Worker', undefined);
  const base = buildCityModel();
  const model = { ...base, dominants: [], buildings: [-1, 1].map((side, index) => ({ ...base.buildings[0],
    index, cx: side * 80, cz: side * 50, x: side * 80 - base.buildings[0].w / 2,
    z: side * 50 - base.buildings[0].d / 2 })) };
  const scene = new THREE.Scene();
  const hybrid = attachHybridSpike({ scene, strategy: 'direct', quality: QUALITY_PROFILES.high,
    themePalette: THEMES[0].palette, model });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  camera.position.set(0, 25, 0);
  const frame = { camera, viewportHeightPx: 1080, sunT: clock01(0.5), clockT: wallClock01(0.5),
    night: 0, dt: 1, elapsed: 0, shopRobbed: false, wind: 0, windDirX: 1, windDirZ: 0 };
  for (const building of model.buildings) {
    camera.lookAt(building.cx, 10, building.cz);
    for (let index = 0; index < 12; index++) hybrid.update(frame);
    expect(hybrid.getMetrics().streaming.resident).toBe(1);
    expect(hybrid.getMetrics().streaming.eligible).toBe(1);
    const detailed: string[] = [];
    scene.traverse((object) => {
      if (object.name.startsWith('hybrid-building-') && !object.name.endsWith(':0')) detailed.push(object.name);
    });
    expect(detailed.length).toBeGreaterThan(0);
    expect(detailed.every((name) => name.startsWith(`hybrid-building-${building.index}-`))).toBe(true);
  }
  hybrid.dispose();
});
