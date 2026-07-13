import * as THREE from 'three';
import {
  WINDOW_COHORT_COUNT,
  type ScheduledWindowMaterial,
} from '../environment/CityRhythm';
import { LakeSurface } from '../environment/LakeSurface';
import type { QualityProfile } from '../performance/QualityManager';
import {
  BLOCK_CONFIGS,
  BENCH_DIMENSIONS,
  BENCH_SPECS,
  BUILDING_ENTRANCES,
  BUS_STOPS,
  COLORS,
  FENCE_SPECS,
  GROUND_SURFACE_Y,
  LAKE,
  LAMP_SPECS,
  KIOSK_SPECS,
  PLAYGROUND,
  STATION_STOPS,
  TRACK_HALF_GAUGE,
  TUNNEL_HEIGHT,
  TUNNEL_LENGTH,
  TUNNEL_WIDTH,
  TRAIN_ROUTE_CURVE,
  TREE_POSITIONS,
  WORLD_HALF_SIZE,
  busShelterCenter,
  isOnRoad,
  isOnSidewalk,
  stationPlatformCells,
  threeColorFromHex,
  type BlockConfig,
  type BusStop,
  type ColorHex,
  type StationStop,
} from './WorldLayout';

const VOXEL_SIZE = 1;

export interface WindUniforms {
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<number>;
}

interface VoxelData {
  position: THREE.Vector3;
  color: ColorHex;
  castShadow?: boolean;
  scale?: THREE.Vector3;
  windowCohort?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Buildings — outer shell only (interior voxels are never visible).
// ─────────────────────────────────────────────────────────────────────────

function generateBlockBuilding(block: BlockConfig): VoxelData[] {
  const voxels: VoxelData[] = [];
  const entrance = BUILDING_ENTRANCES.find((candidate) => candidate.block === block);

  for (let y = 0; y < block.h; y++) {
    for (let bx = 0; bx < block.w; bx++) {
      for (let bz = 0; bz < block.d; bz++) {
        const isOuterFace = bx === 0 || bx === block.w - 1 || bz === 0 || bz === block.d - 1;
        const isShell = isOuterFace || y === 0 || y === block.h - 1;
        if (!isShell) continue;

        const isWindowRow = y > 1 && y < block.h - 1 && y % 2 === 0;
        const isWindowColumn = (bx % 3 === 1 || bz % 3 === 1) && isOuterFace;
        const isBalcony = bz === 0 && bx % 3 === 2 && y > 1 && y < block.h - 2;
        const isDoor =
          entrance !== undefined &&
          block.x + bx === entrance.doorX &&
          block.z + bz === entrance.doorZ &&
          y <= 1;

        let color: ColorHex = COLORS.concrete;
        let windowCohort: number | undefined;
        if (y === 0) color = COLORS.concreteDark;
        if (y === block.h - 1) color = COLORS.roof;
        if (y % 5 === 0 && y > 0 && y < block.h - 1) color = block.accent;
        if (isBalcony) color = COLORS.balcony;
        if (isDoor) color = COLORS.door;
        if (!isDoor && isWindowRow && isWindowColumn) {
          const hash = Math.sin((block.x + bx) * 31.7 + (block.z + bz) * 17.3 + y * 11.1) * 43758.5453;
          const litChance = hash - Math.floor(hash);
          color = litChance > 0.38 ? COLORS.windowLit : COLORS.window;
          if (color === COLORS.windowLit) {
            const cohortHash = Math.sin(hash * 0.0137 + bx * 19.1 + bz * 7.9) * 43758.5453;
            windowCohort = Math.min(
              WINDOW_COHORT_COUNT - 1,
              Math.floor((cohortHash - Math.floor(cohortHash)) * WINDOW_COHORT_COUNT)
            );
          }
        }

        voxels.push({
          position: new THREE.Vector3(block.x + bx, y, block.z + bz),
          color,
          windowCohort,
        });
      }
    }
  }

  return voxels;
}

// ─────────────────────────────────────────────────────────────────────────
// Ground with the road network painted in (flat — markings are recolored
// ground voxels, not bumps).
// ─────────────────────────────────────────────────────────────────────────

function isRoadMarking(x: number, z: number): boolean {
  // Dashed centre lines on the avenues + south road.
  const dash = ((x % 6) + 6) % 6 < 3;
  if ((z === 24 || z === 48 || z === -48) && dash) return true;
  const dashZ = ((z % 6) + 6) % 6 < 3;
  if ((x === -34 || x === 34 || x === -56 || x === 56) && dashZ && z > -46 && z < 50) return true;
  return false;
}

function generateGround(size: number): VoxelData[] {
  const voxels: VoxelData[] = [];

  for (let x = -size; x <= size; x++) {
    for (let z = -size; z <= size; z++) {
      let color: ColorHex;
      if (isOnRoad(x, z)) {
        color = isRoadMarking(x, z) ? COLORS.roadMarking : COLORS.road;
      } else if (isOnSidewalk(x, z)) {
        color = COLORS.sidewalk;
      } else {
        color = (x + z) % 5 === 0 ? COLORS.grassDark : COLORS.grass;
      }
      voxels.push({ position: new THREE.Vector3(x, -1, z), color, castShadow: false });
    }
  }

  return voxels;
}

// ─────────────────────────────────────────────────────────────────────────
// Railway, viaduct, tunnels
// ─────────────────────────────────────────────────────────────────────────

/**
 * Realistic trackwork: two CONTINUOUS steel rails (tube geometry following
 * the route), wooden sleepers and a gravel ballast bed — instead of the old
 * dotted voxel rails. The rail head sits exactly at route height so the
 * wheels roll on it.
 */
function buildTrackwork(group: THREE.Group, disposables: Array<{ dispose: () => void }>): void {
  const samples = 700;
  const leftPts: THREE.Vector3[] = [];
  const rightPts: THREE.Vector3[] = [];
  const normal = new THREE.Vector3();

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = TRAIN_ROUTE_CURVE.getPointAt(t);
    const tangent = TRAIN_ROUTE_CURVE.getTangentAt(t).normalize();
    normal.set(-tangent.z, 0, tangent.x).normalize();
    leftPts.push(new THREE.Vector3(p.x + normal.x * TRACK_HALF_GAUGE, p.y - 0.07, p.z + normal.z * TRACK_HALF_GAUGE));
    rightPts.push(new THREE.Vector3(p.x - normal.x * TRACK_HALF_GAUGE, p.y - 0.07, p.z - normal.z * TRACK_HALF_GAUGE));
  }

  const railMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8bec4,
    metalness: 0.95,
    roughness: 0.28,
  });
  railMaterial.envMapIntensity = 1.3;
  disposables.push(railMaterial);

  for (const pts of [leftPts, rightPts]) {
    const railCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0);
    const railGeo = new THREE.TubeGeometry(railCurve, 900, 0.07, 6, false);
    const rail = new THREE.Mesh(railGeo, railMaterial);
    rail.castShadow = true;
    rail.receiveShadow = true;
    group.add(rail);
    disposables.push(railGeo);
  }

  // Sleepers (wood) + ballast bed (gravel), both instanced and oriented
  // along the local tangent.
  const routeLength = TRAIN_ROUTE_CURVE.getLength();
  const dummy = new THREE.Object3D();
  const ahead = new THREE.Vector3();

  const sleeperGeo = new THREE.BoxGeometry(2.2, 0.1, 0.55);
  const sleeperMat = new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 0.92 });
  const sleeperCount = Math.floor(routeLength / 0.95);
  const sleepers = new THREE.InstancedMesh(sleeperGeo, sleeperMat, sleeperCount);
  disposables.push(sleeperGeo, sleeperMat);

  const ballastGeo = new THREE.BoxGeometry(3.3, 0.42, 1.18);
  const ballastMat = new THREE.MeshStandardMaterial({ color: 0x55504b, roughness: 1 });
  const ballastCount = Math.floor(routeLength / 1.0);
  const ballast = new THREE.InstancedMesh(ballastGeo, ballastMat, ballastCount);
  disposables.push(ballastGeo, ballastMat);

  const placeAlong = (mesh: THREE.InstancedMesh, count: number, yOffset: number) => {
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p = TRAIN_ROUTE_CURVE.getPointAt(t);
      const tangent = TRAIN_ROUTE_CURVE.getTangentAt(t).normalize();
      dummy.position.set(p.x, p.y + yOffset, p.z);
      ahead.copy(dummy.position).add(tangent);
      dummy.lookAt(ahead);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  placeAlong(sleepers, sleeperCount, -0.17);
  placeAlong(ballast, ballastCount, -0.4);
}

/** Contact wire and sparse masts make the pantograph physically legible. */
function buildCatenary(group: THREE.Group, disposables: Array<{ dispose: () => void }>): void {
  const wirePoints: THREE.Vector3[] = [];
  for (let i = 0; i <= 420; i++) {
    const point = TRAIN_ROUTE_CURVE.getPointAt(i / 420);
    wirePoints.push(new THREE.Vector3(point.x, point.y + 5.18, point.z));
  }

  const wireCurve = new THREE.CatmullRomCurve3(wirePoints, false, 'centripetal', 0.5);
  const wireGeometry = new THREE.TubeGeometry(wireCurve, 560, 0.035, 5, false);
  const metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x69737a,
    metalness: 0.88,
    roughness: 0.34,
  });
  const wire = new THREE.Mesh(wireGeometry, metalMaterial);
  wire.castShadow = false;
  group.add(wire);
  disposables.push(wireGeometry, metalMaterial);

  const routeLength = TRAIN_ROUTE_CURVE.getLength();
  const candidateCount = Math.floor(routeLength / 16);
  const mastTransforms: Array<{ point: THREE.Vector3; tangent: THREE.Vector3; normal: THREE.Vector3 }> = [];
  for (let i = 1; i < candidateCount; i++) {
    const t = i / candidateCount;
    const point = TRAIN_ROUTE_CURVE.getPointAt(t);
    if (Math.abs(point.x) > WORLD_HALF_SIZE - TUNNEL_LENGTH - 2) continue;
    const tangent = TRAIN_ROUTE_CURVE.getTangentAt(t).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const firstX = point.x + normal.x * 2.35;
    const firstZ = point.z + normal.z * 2.35;
    if (isOnRoad(Math.round(firstX), Math.round(firstZ))) normal.multiplyScalar(-1);
    const mastX = point.x + normal.x * 2.35;
    const mastZ = point.z + normal.z * 2.35;
    if (isOnRoad(Math.round(mastX), Math.round(mastZ))) continue;
    mastTransforms.push({ point, tangent, normal });
  }

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const supports = new THREE.InstancedMesh(unitBox, metalMaterial, mastTransforms.length * 2);
  const dummy = new THREE.Object3D();
  const ahead = new THREE.Vector3();
  for (let i = 0; i < mastTransforms.length; i++) {
    const { point, tangent, normal } = mastTransforms[i];
    dummy.position.set(
      point.x + normal.x * 2.35,
      point.y + 2.35,
      point.z + normal.z * 2.35
    );
    dummy.scale.set(0.14, 5.1, 0.14);
    ahead.copy(dummy.position).add(tangent);
    dummy.lookAt(ahead);
    dummy.updateMatrix();
    supports.setMatrixAt(i * 2, dummy.matrix);

    dummy.position.set(point.x, point.y + 5.08, point.z);
    dummy.scale.set(4.9, 0.12, 0.12);
    ahead.copy(dummy.position).add(tangent);
    dummy.lookAt(ahead);
    dummy.updateMatrix();
    supports.setMatrixAt(i * 2 + 1, dummy.matrix);
  }
  supports.castShadow = false;
  supports.receiveShadow = true;
  group.add(supports);
  disposables.push(unitBox);
}

function generateViaduct(): VoxelData[] {
  const voxels: VoxelData[] = [];
  const seen = new Set<string>();

  function push(position: THREE.Vector3, color: ColorHex) {
    const key = `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)},${color}`;
    if (seen.has(key)) return;
    seen.add(key);
    voxels.push({
      position: new THREE.Vector3(Math.round(position.x), Math.round(position.y), Math.round(position.z)),
      color,
    });
  }

  const samples = 200;
  for (let i = 0; i <= samples; i++) {
    const point = TRAIN_ROUTE_CURVE.getPointAt(i / samples);
    if (point.y < 1.2) continue;

    const tangent = TRAIN_ROUTE_CURVE.getTangentAt(i / samples).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const deckY = Math.max(0, point.y - 1);

    for (let offset = -2; offset <= 2; offset++) {
      push(point.clone().add(normal.clone().multiplyScalar(offset)).setY(deckY), COLORS.concreteDark);
    }
    push(point.clone().add(normal.clone().multiplyScalar(-2.6)).setY(deckY + 1), COLORS.steel);
    push(point.clone().add(normal.clone().multiplyScalar(2.6)).setY(deckY + 1), COLORS.steel);

    // Support pillars — but never in the middle of a road (the deck spans it).
    if (i % 12 === 0 && deckY >= 2) {
      for (const side of [-1.6, 1.6]) {
        const base = point.clone().add(normal.clone().multiplyScalar(side));
        if (isOnRoad(Math.round(base.x), Math.round(base.z))) continue;
        for (let y = 0; y < deckY; y++) {
          push(base.clone().setY(y), COLORS.concreteDark);
        }
      }
    } else if (deckY < 2.2) {
      // Low approach sections sit on a compact embankment instead of floating.
      for (let offset = -1; offset <= 1; offset++) {
        const base = point.clone().add(normal.clone().multiplyScalar(offset));
        if (isOnRoad(Math.round(base.x), Math.round(base.z))) continue;
        for (let y = 0; y < Math.max(1, Math.ceil(deckY)); y++) {
          push(base.clone().setY(y), COLORS.concreteDark);
        }
      }
    }
  }

  return voxels;
}

/**
 * Portal tunnel at one end of the world. The arched opening faces the city;
 * the hidden outer boundary stays open so the portal wrap cannot intersect a
 * wall. A grassy embankment makes the track read as diving into a hill.
 */
function generateTunnel(side: -1 | 1): VoxelData[] {
  const voxels: VoxelData[] = [];
  const outerX = side * WORLD_HALF_SIZE;

  for (let step = 0; step < TUNNEL_LENGTH; step++) {
    const x = outerX - side * step;
    const isInnerFace = step === TUNNEL_LENGTH - 1;

    for (let y = 0; y < TUNNEL_HEIGHT; y++) {
      for (let z = -TUNNEL_WIDTH; z <= TUNNEL_WIDTH; z++) {
        const isSideWall = Math.abs(z) === TUNNEL_WIDTH;
        const isCeiling = y === TUNNEL_HEIGHT - 1;
        // Tall, wide arch — pantograph (~4.8 m) and the slightly off-centre
        // track at the east mouth must both clear it.
        const isOpening = Math.abs(z) <= 3 && y <= 5;

        if (
          (isSideWall || isCeiling || (isInnerFace && !isOpening)) &&
          !(isInnerFace && isOpening)
        ) {
          voxels.push({
            position: new THREE.Vector3(x, y, z),
            color: isCeiling || isInnerFace ? COLORS.concreteDark : COLORS.concrete,
          });
        }
      }
    }

    // Interior cab lights along the ceiling
    if (step % 2 === 1) {
      voxels.push({
        position: new THREE.Vector3(x, TUNNEL_HEIGHT - 2, 0),
        color: COLORS.windowLit,
      });
    }

    // Grass embankment over the top
    for (let y = TUNNEL_HEIGHT; y <= TUNNEL_HEIGHT + 2; y++) {
      const half = TUNNEL_WIDTH + 1 - (y - TUNNEL_HEIGHT) * 2;
      if (half < 0) continue;
      for (let z = -half; z <= half; z++) {
        voxels.push({
          position: new THREE.Vector3(x, y, z),
          color: (x + z + y) % 4 === 0 ? COLORS.grassDark : COLORS.grass,
        });
      }
    }

    // Sloped grass skirts hugging the side walls
    for (let y = 0; y < TUNNEL_HEIGHT; y++) {
      const extra = TUNNEL_HEIGHT - 1 - y;
      for (let e = 1; e <= extra; e++) {
        for (const zSign of [-1, 1]) {
          voxels.push({
            position: new THREE.Vector3(x, y, zSign * (TUNNEL_WIDTH + e)),
            color: (x + y + e) % 4 === 0 ? COLORS.grassDark : COLORS.grass,
          });
        }
      }
    }
  }

  return voxels;
}

// ─────────────────────────────────────────────────────────────────────────
// Street furniture
// ─────────────────────────────────────────────────────────────────────────

function generateStreetLamp(x: number, z: number, dz: number, height = 4): VoxelData[] {
  const poleCenterY = GROUND_SURFACE_Y + height / 2;
  const topY = GROUND_SURFACE_Y + height;
  return [
    {
      position: new THREE.Vector3(x, poleCenterY, z),
      color: COLORS.concreteDark,
      scale: new THREE.Vector3(0.18, height, 0.18),
    },
    {
      position: new THREE.Vector3(x, topY - 0.12, z + dz * 0.65),
      color: COLORS.concreteDark,
      scale: new THREE.Vector3(0.18, 0.18, 1.3),
    },
    {
      position: new THREE.Vector3(x, topY - 0.22, z + dz * 1.3),
      color: COLORS.windowLit,
      scale: new THREE.Vector3(0.58, 0.22, 0.62),
      castShadow: false,
    },
  ];
}

function generatePlayground(x: number, z: number): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (let sx = -2; sx <= 2; sx++) {
    for (let sz = -2; sz <= 2; sz++) {
      voxels.push({ position: new THREE.Vector3(x + sx, 0, z + sz), color: COLORS.accent });
    }
  }
  for (let y = 0; y < 4; y++) {
    voxels.push({ position: new THREE.Vector3(x - 4, y, z), color: COLORS.accentBlue });
    voxels.push({ position: new THREE.Vector3(x - 4 + y, 3 - y * 0.5, z), color: COLORS.accentPink });
  }
  return voxels;
}

function generateBench(x: number, z: number, rotate = false, backSign: 1 | -1 = -1): VoxelData[] {
  const { length, depth, seatHeight, seatThickness, backHeight } = BENCH_DIMENSIONS;
  const alongScale = rotate
    ? new THREE.Vector3(depth, seatThickness, length)
    : new THREE.Vector3(length, seatThickness, depth);
  const backScale = rotate
    ? new THREE.Vector3(0.14, backHeight, length)
    : new THREE.Vector3(length, backHeight, 0.14);
  const seatY = GROUND_SURFACE_Y + seatHeight - seatThickness / 2;
  const backY = GROUND_SURFACE_Y + seatHeight + backHeight / 2 - 0.03;
  const backOffset = backSign * depth * 0.42;
  const voxels: VoxelData[] = [
    {
      position: new THREE.Vector3(x, seatY, z),
      color: COLORS.sleeper,
      scale: alongScale,
    },
    {
      position: new THREE.Vector3(
        x + (rotate ? backOffset : 0),
        backY,
        z + (rotate ? 0 : backOffset)
      ),
      color: COLORS.sleeper,
      scale: backScale,
    },
  ];

  const legHeight = seatHeight - seatThickness;
  for (const along of [-length * 0.36, length * 0.36]) {
    voxels.push({
      position: new THREE.Vector3(
        x + (rotate ? 0 : along),
        GROUND_SURFACE_Y + legHeight / 2,
        z + (rotate ? along : 0)
      ),
      color: COLORS.steel,
      scale: rotate
        ? new THREE.Vector3(depth * 0.72, legHeight, 0.14)
        : new THREE.Vector3(0.14, legHeight, depth * 0.72),
    });
  }
  return voxels;
}

function generateKiosk(x: number, z: number): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (let bx = 0; bx < 4; bx++) {
    for (let bz = 0; bz < 3; bz++) {
      for (let y = 0; y < 3; y++) {
        const isShell = y === 0 || bx === 0 || bx === 3 || bz === 0 || bz === 2;
        if (!isShell) continue;
        const isFront = bz === 0;
        const isWindow = isFront && y === 1 && bx < 3;
        const isDoor = isFront && bx === 3 && y <= 1;
        const isGreenBand = y === 2 && (isFront || bx === 0 || bx === 3);
        voxels.push({
          position: new THREE.Vector3(x + bx, y, z + bz),
          color: isDoor
            ? COLORS.door
            : isWindow
              ? COLORS.windowLit
              : isGreenBand
                ? COLORS.shopLime
                : COLORS.kiosk,
        });
      }
    }
  }
  voxels.push({
    position: new THREE.Vector3(x + 1.5, 3, z + 1),
    color: COLORS.roof,
    scale: new THREE.Vector3(4.5, 0.28, 3.4),
  });
  voxels.push({
    position: new THREE.Vector3(x + 1.5, 1.72, z - 0.48),
    color: COLORS.shopCream,
    scale: new THREE.Vector3(4.35, 0.16, 1.05),
    castShadow: false,
  });
  return voxels;
}

function buildKioskSigns(group: THREE.Group): Array<{ dispose: () => void }> {
  if (typeof document === 'undefined') return [];
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];

  ctx.fillStyle = '#176332';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#7fc64d';
  ctx.fillRect(0, 0, 34, canvas.height);
  ctx.fillStyle = '#f7f4df';
  ctx.font = '700 52px system-ui, sans-serif';
  ctx.fillText('SKLEP', 62, 61);
  ctx.font = '600 25px system-ui, sans-serif';
  ctx.fillText('SPOZYWCZY', 64, 101);
  ctx.fillStyle = '#f0d45c';
  ctx.beginPath();
  ctx.arc(448, 64, 22, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const geometry = new THREE.PlaneGeometry(3.5, 0.78);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.58,
    roughness: 0.7,
    metalness: 0.02,
    side: THREE.DoubleSide,
  });
  for (let i = 0; i < KIOSK_SPECS.length; i++) {
    const kiosk = KIOSK_SPECS[i];
    const sign = new THREE.Mesh(geometry, material);
    sign.name = `neighborhood-grocery-sign-${i}`;
    sign.position.set(kiosk.x + 1.5, 2.25, kiosk.z - 0.515);
    sign.rotation.y = Math.PI;
    sign.castShadow = false;
    group.add(sign);
  }
  return [texture, geometry, material];
}

const BUS_POSTERS = [
  { background: '#175f54', accent: '#f3d85a', title: 'ZIELONY', subtitle: 'WEEKEND' },
  { background: '#244f88', accent: '#f0a868', title: 'KINO', subtitle: 'POD CHMURA' },
  { background: '#9b3f4a', accent: '#f2dfb5', title: 'MUZYKA', subtitle: 'NAD JEZIOREM' },
  { background: '#56458c', accent: '#8fd3c7', title: 'CZYTAJ', subtitle: 'CODZIENNIE' },
  { background: '#327a3d', accent: '#f1c65b', title: 'BLIZEJ', subtitle: 'MIASTA' },
] as const;

const BUS_SHELTER_END_WALL_ALONG = -2;
const BUS_SHELTER_END_WALL_HALF_DEPTH = 0.5;
const BUS_POSTER_SURFACE_GAP = 0.015;

function shelterPoint(stop: BusStop, along: number, outward: number, y: number): THREE.Vector3 {
  const center = busShelterCenter(stop);
  return stop.axis === 'x'
    ? new THREE.Vector3(center.x + along, y, center.z + outward * stop.benchSign)
    : new THREE.Vector3(center.x + outward * stop.benchSign, y, center.z + along);
}

function createBusPosterTexture(index: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const style = BUS_POSTERS[(index * 3 + 1) % BUS_POSTERS.length];
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = style.accent;
  ctx.fillRect(0, 0, 34, canvas.height);
  ctx.fillRect(42, 42, 300, 12);
  ctx.beginPath();
  ctx.arc(278, 172, 76, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fillRect(66, 92, 124, 188);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 48px system-ui, sans-serif';
  ctx.fillText(style.title, 62, 354);
  ctx.font = '700 27px system-ui, sans-serif';
  ctx.fillText(style.subtitle, 64, 398);
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillText('TWOJE MIASTO  •  TEN TYDZIEN', 64, 462);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildBusShelterDetails(group: THREE.Group): {
  lights: THREE.PointLight[];
  glowMaterials: THREE.MeshStandardMaterial[];
  disposables: Array<{ dispose: () => void }>;
} {
  const lights: THREE.PointLight[] = [];
  const glowMaterials: THREE.MeshStandardMaterial[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const posterGeometry = new THREE.PlaneGeometry(1.12, 1.75);
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: 0xa8c7cf,
    roughness: 0.18,
    metalness: 0.04,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const fixtureMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4ead4,
    emissive: 0xffe8b8,
    emissiveIntensity: 0.08,
    roughness: 0.48,
  });
  glowMaterials.push(fixtureMaterial);
  disposables.push(boxGeometry, posterGeometry, glassMaterial, fixtureMaterial);

  for (let index = 0; index < BUS_STOPS.length; index++) {
    const stop = BUS_STOPS[index];
    const glass = new THREE.Mesh(boxGeometry, glassMaterial);
    glass.name = `bus-stop-glass-${index}`;
    glass.position.copy(shelterPoint(stop, BUS_SHELTER_END_WALL_ALONG, 0.5, 1.1));
    glass.scale.set(
      stop.axis === 'x' ? 0.08 : 1.75,
      2.5,
      stop.axis === 'x' ? 1.75 : 0.08
    );
    glass.castShadow = false;
    glass.receiveShadow = true;
    group.add(glass);

    const posterTexture = createBusPosterTexture(index);
    if (posterTexture) {
      const posterMaterial = new THREE.MeshStandardMaterial({
        map: posterTexture,
        emissive: 0xffffff,
        emissiveMap: posterTexture,
        emissiveIntensity: 0.1,
        roughness: 0.52,
        metalness: 0.02,
        side: THREE.FrontSide,
      });
      glowMaterials.push(posterMaterial);
      disposables.push(posterTexture, posterMaterial);

      const interior = new THREE.Mesh(posterGeometry, posterMaterial);
      interior.name = `bus-stop-poster-${index}-interior`;
      interior.position.copy(shelterPoint(
        stop,
        BUS_SHELTER_END_WALL_ALONG + BUS_SHELTER_END_WALL_HALF_DEPTH + BUS_POSTER_SURFACE_GAP,
        0.5,
        1.14
      ));
      interior.rotation.y = stop.axis === 'x' ? Math.PI / 2 : 0;
      interior.castShadow = false;
      group.add(interior);

      const exterior = new THREE.Mesh(posterGeometry, posterMaterial);
      exterior.name = `bus-stop-poster-${index}-exterior`;
      exterior.position.copy(shelterPoint(
        stop,
        BUS_SHELTER_END_WALL_ALONG - BUS_SHELTER_END_WALL_HALF_DEPTH - BUS_POSTER_SURFACE_GAP,
        0.5,
        1.14
      ));
      exterior.rotation.y = stop.axis === 'x' ? -Math.PI / 2 : Math.PI;
      exterior.castShadow = false;
      group.add(exterior);
    }

    const fixture = new THREE.Mesh(boxGeometry, fixtureMaterial);
    fixture.name = `bus-stop-ceiling-light-${index}`;
    fixture.position.copy(shelterPoint(stop, 0, 0.45, 2.42));
    fixture.scale.set(stop.axis === 'x' ? 1.6 : 0.28, 0.1, stop.axis === 'x' ? 0.28 : 1.6);
    fixture.castShadow = false;
    group.add(fixture);

    const light = new THREE.PointLight(0xffe5b8, 0, 8, 2);
    light.name = `bus-stop-safety-light-${index}`;
    light.position.copy(shelterPoint(stop, 0, 0.45, 2.24));
    light.castShadow = false;
    light.visible = false;
    group.add(light);
    lights.push(light);
  }

  return { lights, glowMaterials, disposables };
}

function buildStationLighting(group: THREE.Group): {
  lights: THREE.PointLight[];
  glowMaterials: THREE.MeshStandardMaterial[];
  glowMesh: THREE.InstancedMesh;
  glowMaterial: THREE.ShaderMaterial;
  disposables: Array<{ dispose: () => void }>;
} {
  const lights: THREE.PointLight[] = [];
  const disposables: Array<{ dispose: () => void }> = [];
  const fixtureGeometry = new THREE.BoxGeometry(1, 1, 1);
  const fixtureMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff3d2,
    emissive: 0xffdca0,
    emissiveIntensity: 0.1,
    roughness: 0.38,
  });
  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x48515a,
    metalness: 0.52,
    roughness: 0.48,
  });
  const glowGeometry = new THREE.PlaneGeometry(1, 1);
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec2 vUv;
      void main() {
        vec2 centered = (vUv - 0.5) * vec2(1.0, 1.65);
        float radial = 1.0 - smoothstep(0.08, 0.52, length(centered));
        float alpha = radial * radial * uNight * 0.28;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.36) * radial, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const glowMesh = new THREE.InstancedMesh(glowGeometry, glowMaterial, STATION_STOPS.length);
  const dummy = new THREE.Object3D();

  for (let index = 0; index < STATION_STOPS.length; index++) {
    const station = STATION_STOPS[index];
    const center = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
    const tangent = TRAIN_ROUTE_CURVE.getTangentAt(station.centerT).setY(0).normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const platformY = Math.round(center.y);
    const shelterCenter = center.clone().addScaledVector(normal, 6);
    const fixtureRotation = Math.atan2(-tangent.z, tangent.x);

    for (const [fixtureIndex, along] of [-1.45, 1.45].entries()) {
      const fixture = new THREE.Mesh(fixtureGeometry, fixtureMaterial);
      fixture.name = `station-platform-fixture-${index}-${fixtureIndex}`;
      fixture.position.copy(shelterCenter).addScaledVector(tangent, along);
      fixture.position.y = platformY + 2.43;
      fixture.rotation.y = fixtureRotation;
      fixture.scale.set(1.9, 0.1, 0.3);
      fixture.castShadow = false;
      group.add(fixture);
    }

    // Emissive platform masts keep both ends readable without adding more
    // dynamic lights to the GPU budget.
    for (const [mastIndex, along] of [-6.5, 6.5].entries()) {
      const mastCenter = center.clone().addScaledVector(normal, 4.7).addScaledVector(tangent, along);
      const pole = new THREE.Mesh(fixtureGeometry, poleMaterial);
      pole.name = `station-platform-pole-${index}-${mastIndex}`;
      pole.position.copy(mastCenter);
      pole.position.y = platformY + 2.15;
      pole.scale.set(0.14, 3.3, 0.14);
      pole.castShadow = false;
      group.add(pole);

      const fixture = new THREE.Mesh(fixtureGeometry, fixtureMaterial);
      fixture.name = `station-platform-fixture-${index}-mast-${mastIndex}`;
      fixture.position.copy(mastCenter);
      fixture.position.y = platformY + 3.82;
      fixture.rotation.y = fixtureRotation;
      fixture.scale.set(1.2, 0.18, 0.38);
      fixture.castShadow = false;
      group.add(fixture);
    }

    const light = new THREE.PointLight(0xffdfaa, 0, 28, 1.75);
    light.name = `station-platform-light-${index}`;
    light.position.copy(shelterCenter);
    light.position.y = platformY + 2.18;
    light.castShadow = false;
    light.visible = false;
    group.add(light);
    lights.push(light);

    dummy.position.copy(center).addScaledVector(normal, 4.6);
    dummy.position.y = platformY + 0.515;
    dummy.rotation.set(-Math.PI / 2, 0, fixtureRotation);
    dummy.scale.set(17, 10, 1);
    dummy.updateMatrix();
    glowMesh.setMatrixAt(index, dummy.matrix);
  }

  glowMesh.name = 'station-platform-light-pools';
  glowMesh.visible = false;
  glowMesh.castShadow = false;
  glowMesh.receiveShadow = false;
  group.add(glowMesh);
  disposables.push(fixtureGeometry, fixtureMaterial, poleMaterial, glowGeometry, glowMaterial);
  return { lights, glowMaterials: [fixtureMaterial], glowMesh, glowMaterial, disposables };
}

/**
 * Bus shelter: 5-long roof on two steel posts + a bench, built along either
 * street axis. `benchSign` offsets the bench/roof extension toward the road.
 */
function generateBusShelter(x: number, z: number, axis: 'x' | 'z', benchSign: 1 | -1): VoxelData[] {
  const voxels: VoxelData[] = [];
  const at = (along: number, perp: number) =>
    axis === 'x'
      ? new THREE.Vector3(x + along, 0, z + perp)
      : new THREE.Vector3(x + perp, 0, z + along);
  const lift = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);

  for (let a = 0; a < 5; a++) {
    voxels.push({ position: lift(at(a, 0), 3), color: COLORS.steel });
    voxels.push({ position: lift(at(a, benchSign), 3), color: COLORS.kiosk });
  }
  for (const a of [0, 4]) {
    for (let y = 0; y < 3; y++) {
      voxels.push({ position: lift(at(a, 0), y), color: COLORS.steel });
    }
  }
  // Lit stop sign
  voxels.push({ position: lift(at(-1, benchSign), 3), color: COLORS.signalGreen });
  const benchPos = at(2, benchSign);
  voxels.push(...generateBench(benchPos.x, benchPos.z, axis === 'z', -benchSign as 1 | -1));
  return voxels;
}

// ─────────────────────────────────────────────────────────────────────────
// Station platforms — follow the rail curve; elevated platforms get support
// columns and a railing.
// ─────────────────────────────────────────────────────────────────────────

function generateStationPlatform(station: StationStop): VoxelData[] {
  const voxels: VoxelData[] = [];
  const center = TRAIN_ROUTE_CURVE.getPointAt(station.centerT);
  const tangent = TRAIN_ROUTE_CURVE.getTangentAt(station.centerT).normalize();
  const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

  const platformY = Math.round(center.y);
  const gauge = 2.5;
  const depth = 3;
  const half = station.platformLength / 2;

  const seen = new Set<string>();
  function pushOnce(x: number, y: number, z: number, color: ColorHex) {
    const key = `${x},${y},${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    voxels.push({ position: new THREE.Vector3(x, y, z), color });
  }

  for (const cell of stationPlatformCells(station)) {
    pushOnce(
      cell.x,
      platformY,
      cell.z,
      cell.depth === 0 ? COLORS.roadMarking : COLORS.sidewalk
    );

    if (platformY > 0) {
      if (cell.depth === depth - 1 && Math.round(cell.along) % 2 === 0) {
        pushOnce(cell.x, platformY + 1, cell.z, COLORS.steel);
      }
      if (cell.depth === 1 && Math.round(cell.along) % 6 === 0) {
        for (let y = platformY - 1; y >= 0; y--) {
          pushOnce(cell.x, y, cell.z, COLORS.concreteDark);
        }
      }
    }
  }

  // Shelter mid-platform
  const shelterPx = center.x + normal.x * (gauge + depth + 0.5);
  const shelterPz = center.z + normal.z * (gauge + depth + 0.5);
  for (let s = -2; s <= 2; s++) {
    for (let y = 0; y < 3; y++) {
      const px = Math.round(shelterPx + tangent.x * s);
      const pz = Math.round(shelterPz + tangent.z * s);
      if ((s === -2 || s === 2) && y < 2) pushOnce(px, platformY + 1 + y, pz, COLORS.steel);
      if (y === 2) pushOnce(px, platformY + 1 + y, pz, COLORS.roof);
    }
  }

  // Sign post with a lit plate
  const signX = Math.round(center.x + tangent.x * (-half + 1) + normal.x * (gauge + depth));
  const signZ = Math.round(center.z + tangent.z * (-half + 1) + normal.z * (gauge + depth));
  for (let y = 0; y < 4; y++) pushOnce(signX, platformY + y, signZ, COLORS.steel);
  pushOnce(signX, platformY + 4, signZ, COLORS.windowLit);

  return voxels;
}

function generateFenceLine(x: number, z: number, length: number, alongX = true): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (let i = 0; i < length; i++) {
    const px = x + (alongX ? i : 0);
    const pz = z + (alongX ? 0 : i);
    if (i % 2 === 0) {
      voxels.push({ position: new THREE.Vector3(px, 0, pz), color: COLORS.steel });
      voxels.push({ position: new THREE.Vector3(px, 1, pz), color: COLORS.steel });
    } else {
      voxels.push({ position: new THREE.Vector3(px, 1, pz), color: COLORS.steel });
    }
  }
  return voxels;
}

function generateLake(): VoxelData[] {
  const voxels: VoxelData[] = [];
  const { x: centerX, z: centerZ, radiusX, radiusZ } = LAKE;

  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    const px = Math.round(centerX + Math.cos(angle) * (radiusX + 2));
    const pz = Math.round(centerZ + Math.sin(angle) * (radiusZ + 2));
    voxels.push({ position: new THREE.Vector3(px, -0.6, pz), color: COLORS.sidewalk });
  }

  return voxels;
}

function generateCityProps(): VoxelData[] {
  const voxels: VoxelData[] = [];

  for (const station of STATION_STOPS) {
    voxels.push(...generateStationPlatform(station));
  }

  for (const stop of BUS_STOPS) {
    voxels.push(...generateBusShelter(stop.shelterX, stop.shelterZ, stop.axis, stop.benchSign));
  }

  for (const kiosk of KIOSK_SPECS) voxels.push(...generateKiosk(kiosk.x, kiosk.z));
  for (const fence of FENCE_SPECS) {
    voxels.push(...generateFenceLine(fence.x, fence.z, fence.length, fence.alongX));
  }
  for (const bench of BENCH_SPECS) {
    voxels.push(...generateBench(bench.x, bench.z, bench.rotate));
  }

  return voxels;
}

// ─────────────────────────────────────────────────────────────────────────
// Trees — trunks are static voxels, foliage is its own instanced mesh with
// a wind-sway vertex shader (driven by the shared wind uniforms).
// ─────────────────────────────────────────────────────────────────────────

interface FoliageInstance {
  position: THREE.Vector3;
  /** 0 = COLORS.tree, 1 = COLORS.treeLight — used for theme recolouring. */
  variant: 0 | 1;
}

function buildTreeData(): { trunkVoxels: VoxelData[]; foliage: FoliageInstance[] } {
  const trunkVoxels: VoxelData[] = [];
  const foliage: FoliageInstance[] = [];

  for (let i = 0; i < TREE_POSITIONS.length; i++) {
    const [x, z] = TREE_POSITIONS[i];
    for (let y = 0; y < 3; y++) {
      trunkVoxels.push({ position: new THREE.Vector3(x, y, z), color: COLORS.treeTrunk });
    }
    const foliageRadius = 2;
    for (let fx = -foliageRadius; fx <= foliageRadius; fx++) {
      for (let fy = 0; fy <= foliageRadius * 2; fy++) {
        for (let fz = -foliageRadius; fz <= foliageRadius; fz++) {
          const dist = Math.sqrt(fx * fx + (fy - foliageRadius) ** 2 + fz * fz);
          if (dist <= foliageRadius + 0.5) {
            foliage.push({
              position: new THREE.Vector3(x + fx, 3 + fy, z + fz),
              variant: (fx + fy + fz + i) % 3 === 0 ? 1 : 0,
            });
          }
        }
      }
    }
  }

  return { trunkVoxels, foliage };
}

function buildFoliageMesh(
  foliage: FoliageInstance[],
  geometry: THREE.BoxGeometry,
  windUniforms: WindUniforms
): { mesh: THREE.InstancedMesh; material: THREE.MeshStandardMaterial } {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 });
  material.envMapIntensity = 0.2;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    shader.uniforms.uWind = windUniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nuniform float uWind;'
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iorigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float windPhase = iorigin.x * 0.43 + iorigin.z * 0.31;
          float windHeight = max(iorigin.y - 2.5, 0.0);
          float windGust = sin(uTime * 1.7 + windPhase) + 0.6 * sin(uTime * 2.9 + windPhase * 1.7);
          float windAmp = uWind * 0.085 * windHeight;
          transformed.x += windGust * windAmp;
          transformed.z += windGust * windAmp * 0.55;
        #endif
        `
      );
  };

  const mesh = new THREE.InstancedMesh(geometry, material, foliage.length);
  const dummy = new THREE.Object3D();
  const treeColor = new THREE.Color(COLORS.tree);
  const treeLightColor = new THREE.Color(COLORS.treeLight);
  for (let i = 0; i < foliage.length; i++) {
    dummy.position.copy(foliage[i].position);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, foliage[i].variant === 1 ? treeLightColor : treeColor);
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return { mesh, material };
}

// ─────────────────────────────────────────────────────────────────────────
// World assembly
// ─────────────────────────────────────────────────────────────────────────

export interface WorldHandle {
  scene: THREE.Scene;
  voxelMeshes: THREE.Group;
  streetLights: THREE.PointLight[];
  streetGlowMesh: THREE.InstancedMesh;
  streetGlowMaterial: THREE.ShaderMaterial;
  busStopLights: THREE.PointLight[];
  busStopGlowMaterials: THREE.MeshStandardMaterial[];
  stationLights: THREE.PointLight[];
  stationGlowMaterials: THREE.MeshStandardMaterial[];
  stationGlowMesh: THREE.InstancedMesh;
  stationGlowMaterial: THREE.ShaderMaterial;
  windowLights: THREE.PointLight[];
  /** Deterministic residential groups controlled by the city clock. */
  windowGlowMaterials: ScheduledWindowMaterial[];
  /** 0..1 lying snow: whitens grass/roofs and grows snow caps on buildings & trees. */
  setSnowCover: (cover: number) => void;
  /** 0..1 rain wetness: roads darken and turn mirror-like. */
  setWetness: (wetness: number) => void;
  /** Apply a diorama theme palette (original colour value → themed value). */
  setTheme: (palette: Record<number, number>, foliage?: { tree: number; treeLight: number }) => void;
  /** 0..1 — cyberpunk morph: megatowers rise out of the blocks. */
  setCyberRise: (factor: number) => void;
  setQuality: (profile: QualityProfile) => void;
  updateEnvironment: (
    elapsed: number,
    wind: number,
    rain: number,
    freeze: number,
    mist: number
  ) => void;
  dispose: () => void;
}

function buildStreetLightPools(): {
  mesh: THREE.InstancedMesh;
  geometry: THREE.PlaneGeometry;
  material: THREE.ShaderMaterial;
} {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying vec2 vUv;
      void main() {
        float distanceFromLamp = distance(vUv, vec2(0.5));
        float radial = 1.0 - smoothstep(0.08, 0.5, distanceFromLamp);
        float alpha = radial * radial * uNight * 0.16;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(vec3(1.0, 0.58, 0.24) * radial, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, LAMP_SPECS.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < LAMP_SPECS.length; i++) {
    const lamp = LAMP_SPECS[i];
    dummy.position.set(lamp.x, GROUND_SURFACE_Y + 0.025, lamp.z + lamp.dz * 1.3);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.set(8, 11, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.name = 'street-light-pools';
  mesh.visible = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, geometry, material };
}

/** Sleek megatowers that grow OVER the apartment blocks in cyberpunk mode. */
function buildCyberTowers(): { group: THREE.Group; disposables: Array<{ dispose: () => void }> } {
  const group = new THREE.Group();
  group.name = 'cyber-towers';
  group.visible = false;
  group.scale.y = 0.0001;
  const disposables: Array<{ dispose: () => void }> = [];

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x10141b, metalness: 0.85, roughness: 0.28 });
  bodyMat.envMapIntensity = 1.7;
  const neonA = new THREE.MeshStandardMaterial({ color: 0x021014, emissive: 0x00e5ff, emissiveIntensity: 2.2 });
  const neonB = new THREE.MeshStandardMaterial({ color: 0x14020c, emissive: 0xff2da0, emissiveIntensity: 2.2 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0x05070b, emissive: 0x9fd9ff, emissiveIntensity: 1.1 });
  disposables.push(bodyMat, neonA, neonB, bandMat);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(unitBox);
  const bodyInstances = new THREE.InstancedMesh(unitBox, bodyMat, BLOCK_CONFIGS.length * 2);
  const cyanCount = BLOCK_CONFIGS.filter((_, i) => i % 2 === 0).length * 5;
  const magentaCount = BLOCK_CONFIGS.filter((_, i) => i % 2 === 1).length * 5;
  const cyanInstances = new THREE.InstancedMesh(unitBox, neonA, cyanCount);
  const magentaInstances = new THREE.InstancedMesh(unitBox, neonB, magentaCount);
  const bandInstances = new THREE.InstancedMesh(unitBox, bandMat, BLOCK_CONFIGS.length * 3);
  const dummy = new THREE.Object3D();
  let bodyIndex = 0;
  let cyanIndex = 0;
  let magentaIndex = 0;
  let bandIndex = 0;

  const setInstance = (
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number
  ) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  };

  for (let i = 0; i < BLOCK_CONFIGS.length; i++) {
    const block = BLOCK_CONFIGS[i];
    const height = Math.min(46, Math.max(26, block.h * 2.5));
    const width = block.w + 1.6;
    const depth = block.d + 1.6;
    const cx = block.x + block.w / 2 - 0.5;
    const cz = block.z + block.d / 2 - 0.5;

    setInstance(bodyInstances, bodyIndex++, cx, height / 2, cz, width, height, depth);
    setInstance(bodyInstances, bodyIndex++, cx, height + 3, cz, 0.3, 6, 0.3);

    const neonMesh = i % 2 === 0 ? cyanInstances : magentaInstances;
    let neonIndex = i % 2 === 0 ? cyanIndex : magentaIndex;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      setInstance(
        neonMesh,
        neonIndex++,
        cx + (sx * width) / 2,
        height / 2,
        cz + (sz * depth) / 2,
        0.28,
        height,
        0.28
      );
    }
    setInstance(neonMesh, neonIndex++, cx, height + 6.2, cz, 0.5, 0.5, 0.5);
    if (i % 2 === 0) cyanIndex = neonIndex;
    else magentaIndex = neonIndex;

    for (const factor of [0.3, 0.55, 0.8]) {
      setInstance(
        bandInstances,
        bandIndex++,
        cx,
        height * factor,
        cz,
        width + 0.12,
        0.55,
        depth + 0.12
      );
    }
  }

  bodyInstances.castShadow = true;
  bodyInstances.receiveShadow = true;
  for (const mesh of [bodyInstances, cyanInstances, magentaInstances, bandInstances]) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    group.add(mesh);
  }

  return { group, disposables };
}

/** Colours that react to rain wetness. */
const WET_COLOR_KEYS = new Set<number>([COLORS.road, COLORS.sidewalk, COLORS.roadMarking]);

/** Snowy replacement colours for the world palette (lerped by snow cover). */
const SNOW_TINTS: Partial<Record<number, number>> = {
  [COLORS.grass]: 0xe9eff5,
  [COLORS.grassDark]: 0xd7e2ea,
  [COLORS.roof]: 0xe9eef4,
  [COLORS.sidewalk]: 0xcdd2d7,
  [COLORS.road]: 0x4a4c52,
  [COLORS.reeds]: 0xbcc8cc,
  [COLORS.tree]: 0xd9e4ea,
  [COLORS.treeLight]: 0xe6eef2,
  [COLORS.concreteDark]: 0x8f989f,
  // The lake freezes over in deep winter.
  [COLORS.water]: 0xcfe3ee,
  [COLORS.waterDeep]: 0xb5cedd,
};

/** Build the static list of "snow cap" slab positions (roofs + tree crowns). */
function buildSnowCapPositions(): THREE.Vector3[] {
  const positions: THREE.Vector3[] = [];
  for (const block of BLOCK_CONFIGS) {
    for (let bx = 0; bx < block.w; bx++) {
      for (let bz = 0; bz < block.d; bz++) {
        positions.push(new THREE.Vector3(block.x + bx, block.h - 0.38, block.z + bz));
      }
    }
  }
  for (const [tx, tz] of TREE_POSITIONS) {
    positions.push(new THREE.Vector3(tx, 7.62, tz));
    positions.push(new THREE.Vector3(tx + 1, 6.62, tz));
    positions.push(new THREE.Vector3(tx - 1, 6.62, tz));
    positions.push(new THREE.Vector3(tx, 6.62, tz + 1));
    positions.push(new THREE.Vector3(tx, 6.62, tz - 1));
  }
  return positions;
}

function materialParamsFor(color: ColorHex): Partial<THREE.MeshStandardMaterialParameters> & {
  envIntensity: number;
} {
  switch (color) {
    case COLORS.window:
      return { roughness: 0.08, metalness: 0.65, envIntensity: 2.0 };
    case COLORS.windowLit:
      return {
        roughness: 0.18,
        metalness: 0.4,
        emissive: COLORS.windowLit,
        emissiveIntensity: 0.45,
        envIntensity: 1.1,
      };
    case COLORS.water:
    case COLORS.waterDeep:
      return { roughness: 0.08, metalness: 0.35, envIntensity: 1.4 };
    case COLORS.track:
      return { roughness: 0.4, metalness: 0.55, envIntensity: 0.7 };
    default:
      return { roughness: 0.85, metalness: 0.05, envIntensity: 0.25 };
  }
}

export function createWorld(scene: THREE.Scene, windUniforms: WindUniforms): WorldHandle {
  const allVoxels: VoxelData[] = [];
  const lakeSurface = new LakeSurface(scene);

  allVoxels.push(...generateGround(WORLD_HALF_SIZE));
  allVoxels.push(...generateViaduct());
  allVoxels.push(...generateTunnel(-1));
  allVoxels.push(...generateTunnel(1));

  for (const block of BLOCK_CONFIGS) {
    allVoxels.push(...generateBlockBuilding(block));
  }

  const { trunkVoxels, foliage } = buildTreeData();
  allVoxels.push(...trunkVoxels);

  for (const lamp of LAMP_SPECS) {
    allVoxels.push(...generateStreetLamp(lamp.x, lamp.z, lamp.dz));
  }

  allVoxels.push(...generatePlayground(PLAYGROUND.x, PLAYGROUND.z));
  allVoxels.push(...generateCityProps());
  allVoxels.push(...generateLake());

  // Keep a candidate at every physical lamp. DayNightCycle activates only the
  // nearest profile-budgeted subset, so camera-local streets are illuminated
  // without increasing the simultaneous light count.
  const streetLights: THREE.PointLight[] = [];
  for (const lamp of LAMP_SPECS) {
    const light = new THREE.PointLight(0xffd58a, 0, 26, 2);
    light.position.set(lamp.x, 3.08, lamp.z + lamp.dz * 1.3);
    light.castShadow = false;
    light.visible = false;
    scene.add(light);
    streetLights.push(light);
  }

  const windowLights: THREE.PointLight[] = [];
  for (const block of BLOCK_CONFIGS) {
    const light = new THREE.PointLight(0xffcf86, 0, 18, 2);
    light.position.set(block.x + block.w / 2, Math.min(block.h - 2, 6), block.z + block.d / 2);
    light.castShadow = false;
    light.visible = false;
    scene.add(light);
    windowLights.push(light);
  }

  // ── Instanced voxel meshes, one per colour ──
  const geometry = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
  const colorMap = new Map<
    string,
    { color: ColorHex; castShadow: boolean; windowCohort?: number; voxels: VoxelData[] }
  >();
  for (const voxel of allVoxels) {
    const castShadow = voxel.castShadow !== false;
    const key = `${voxel.color}:${castShadow ? 1 : 0}:${voxel.windowCohort ?? -1}`;
    const batch = colorMap.get(key);
    if (batch) batch.voxels.push(voxel);
    else {
      colorMap.set(key, {
        color: voxel.color,
        castShadow,
        windowCohort: voxel.windowCohort,
        voxels: [voxel],
      });
    }
  }

  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const unitScale = new THREE.Vector3(1, 1, 1);
  const materials: THREE.MeshStandardMaterial[] = [];
  const windowGlowMaterials: ScheduledWindowMaterial[] = [];
  interface LookEntry {
    material: THREE.MeshStandardMaterial;
    colorKey: number;
    /** Theme base colour (original palette colour by default). */
    themed: THREE.Color;
    original: THREE.Color;
    snowTarget: THREE.Color | null;
    baseRoughness: number;
    baseMetalness: number;
    baseEnv: number;
    windowSchedule?: ScheduledWindowMaterial;
  }
  const lookEntries: LookEntry[] = [];

  for (const { color, castShadow, windowCohort, voxels } of colorMap.values()) {
    const params = materialParamsFor(color);
    const material = new THREE.MeshStandardMaterial({
      color: threeColorFromHex(color),
      roughness: params.roughness,
      metalness: params.metalness,
      emissive: params.emissive ?? 0x000000,
      emissiveIntensity: params.emissiveIntensity ?? 0,
    });
    material.envMapIntensity = params.envIntensity;
    materials.push(material);
    const windowSchedule =
      color === COLORS.windowLit && windowCohort !== undefined
        ? {
            material,
            cohort: windowCohort,
            litColor: material.color.clone(),
            darkColor: new THREE.Color(COLORS.window),
            activity: 1,
          }
        : undefined;
    if (windowSchedule) windowGlowMaterials.push(windowSchedule);
    const snowTint = SNOW_TINTS[color as number];
    lookEntries.push({
      material,
      colorKey: color as number,
      themed: material.color.clone(),
      original: material.color.clone(),
      snowTarget: snowTint !== undefined ? new THREE.Color(snowTint) : null,
      baseRoughness: params.roughness ?? 0.85,
      baseMetalness: params.metalness ?? 0.05,
      baseEnv: params.envIntensity,
      windowSchedule,
    });

    const instancedMesh = new THREE.InstancedMesh(geometry, material, voxels.length);
    for (let i = 0; i < voxels.length; i++) {
      dummy.position.copy(voxels[i].position);
      dummy.scale.copy(voxels[i].scale ?? unitScale);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    dummy.scale.copy(unitScale);
    instancedMesh.castShadow = castShadow;
    instancedMesh.receiveShadow = true;
    group.add(instancedMesh);
  }

  // ── Wind-swaying tree foliage ──
  const foliageBuild = buildFoliageMesh(foliage, geometry, windUniforms);
  group.add(foliageBuild.mesh);
  materials.push(foliageBuild.material);

  // ── Continuous rails + sleepers + ballast ──
  const trackDisposables: Array<{ dispose: () => void }> = [];
  buildTrackwork(group, trackDisposables);
  buildCatenary(group, trackDisposables);
  trackDisposables.push(...buildKioskSigns(group));
  const busStopDetails = buildBusShelterDetails(group);
  trackDisposables.push(...busStopDetails.disposables);
  const stationLighting = buildStationLighting(group);
  trackDisposables.push(...stationLighting.disposables);
  const streetGlow = buildStreetLightPools();
  group.add(streetGlow.mesh);
  trackDisposables.push(streetGlow.geometry, streetGlow.material);

  // ── Cyberpunk megatowers (hidden until the theme morph) ──
  const cyberBuild = buildCyberTowers();
  scene.add(cyberBuild.group);
  const setCyberRise = (factor: number) => {
    cyberBuild.group.visible = factor > 0.01;
    cyberBuild.group.scale.y = Math.max(factor, 0.0001);
  };

  // ── Snow caps (hidden until it actually snows) ──
  const snowCapPositions = buildSnowCapPositions();
  const snowCapGeo = new THREE.BoxGeometry(1, 0.26, 1);
  const snowCapMat = new THREE.MeshStandardMaterial({ color: 0xf4f8fc, roughness: 0.85 });
  snowCapMat.envMapIntensity = 0.4;
  const snowCaps = new THREE.InstancedMesh(snowCapGeo, snowCapMat, snowCapPositions.length);
  snowCaps.castShadow = false;
  snowCaps.receiveShadow = true;
  snowCaps.visible = false;
  group.add(snowCaps);
  trackDisposables.push(snowCapGeo, snowCapMat);

  // ── Layered look: theme palette → snow whitening → rain wetness ──
  const look = { snow: 0, wet: 0 };
  let lookDirty = true;
  const tmpColor = new THREE.Color();

  const applyLook = () => {
    lookDirty = false;
    for (const entry of lookEntries) {
      tmpColor.copy(entry.themed);
      if (entry.snowTarget && look.snow > 0.001) {
        tmpColor.lerp(entry.snowTarget, look.snow);
      }
      const isWetKey = WET_COLOR_KEYS.has(entry.colorKey);
      if (isWetKey && look.wet > 0.001) {
        // Wet asphalt: darker, smoother, mirror-like.
        tmpColor.multiplyScalar(1 - look.wet * 0.38);
        entry.material.roughness = THREE.MathUtils.lerp(entry.baseRoughness, 0.12, look.wet);
        entry.material.metalness = THREE.MathUtils.lerp(entry.baseMetalness, 0.45, look.wet);
        entry.material.envMapIntensity = THREE.MathUtils.lerp(entry.baseEnv, 1.7, look.wet);
      } else if (isWetKey) {
        entry.material.roughness = entry.baseRoughness;
        entry.material.metalness = entry.baseMetalness;
        entry.material.envMapIntensity = entry.baseEnv;
      }
      if (entry.windowSchedule) {
        entry.windowSchedule.litColor.copy(tmpColor);
        entry.material.color
          .copy(entry.windowSchedule.darkColor)
          .lerp(entry.windowSchedule.litColor, entry.windowSchedule.activity);
      } else {
        entry.material.color.copy(tmpColor);
      }
    }

    // Frost the wind-blown foliage via emissive (its colours are per-instance).
    foliageBuild.material.emissive.setHex(0x9fb4c2);
    foliageBuild.material.emissiveIntensity = look.snow * 0.55;

    snowCaps.visible = look.snow > 0.03;
    if (snowCaps.visible) {
      const scale = Math.max(look.snow, 0.001);
      for (let i = 0; i < snowCapPositions.length; i++) {
        const p = snowCapPositions[i];
        dummy.position.set(p.x, p.y - 0.13 + 0.13 * scale, p.z);
        dummy.scale.set(1, scale, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        snowCaps.setMatrixAt(i, dummy.matrix);
      }
      snowCaps.instanceMatrix.needsUpdate = true;
    }
  };

  const setSnowCover = (cover: number) => {
    if (Math.abs(cover - look.snow) < 0.015 && !(cover <= 0 && look.snow > 0)) {
      if (!lookDirty) return;
    }
    look.snow = cover;
    applyLook();
  };

  const setWetness = (wetness: number) => {
    if (Math.abs(wetness - look.wet) < 0.02 && !(wetness <= 0 && look.wet > 0)) return;
    look.wet = wetness;
    applyLook();
  };

  const setTheme = (
    palette: Record<number, number>,
    foliageTheme?: { tree: number; treeLight: number }
  ) => {
    const darkWindowColor = palette[COLORS.window] ?? COLORS.window;
    for (const schedule of windowGlowMaterials) schedule.darkColor.setHex(darkWindowColor);
    for (const entry of lookEntries) {
      const override = palette[entry.colorKey];
      entry.themed.copy(entry.original);
      if (override !== undefined) entry.themed.setHex(override);
    }
    // Recolour tree crowns per instance.
    const treeColor = new THREE.Color(foliageTheme?.tree ?? COLORS.tree);
    const treeLightColor = new THREE.Color(foliageTheme?.treeLight ?? COLORS.treeLight);
    for (let i = 0; i < foliage.length; i++) {
      foliageBuild.mesh.setColorAt(i, foliage[i].variant === 1 ? treeLightColor : treeColor);
    }
    if (foliageBuild.mesh.instanceColor) foliageBuild.mesh.instanceColor.needsUpdate = true;
    applyLook();
  };

  scene.add(group);

  return {
    scene,
    voxelMeshes: group,
    streetLights,
    streetGlowMesh: streetGlow.mesh,
    streetGlowMaterial: streetGlow.material,
    busStopLights: busStopDetails.lights,
    busStopGlowMaterials: busStopDetails.glowMaterials,
    stationLights: stationLighting.lights,
    stationGlowMaterials: stationLighting.glowMaterials,
    stationGlowMesh: stationLighting.glowMesh,
    stationGlowMaterial: stationLighting.glowMaterial,
    windowLights,
    windowGlowMaterials,
    setSnowCover,
    setWetness,
    setTheme,
    setCyberRise,
    setQuality(profile) {
      lakeSurface.setQuality(profile.waterDetail);
    },
    updateEnvironment(elapsed, wind, rain, freeze, mist) {
      lakeSurface.update(elapsed, wind, rain, freeze, mist);
    },
    dispose() {
      lakeSurface.dispose();
      scene.remove(cyberBuild.group);
      cyberBuild.group.traverse((child) => {
        if (child instanceof THREE.InstancedMesh) child.dispose();
      });
      for (const item of cyberBuild.disposables) item.dispose();
      scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.InstancedMesh) child.dispose();
      });
      geometry.dispose();
      for (const material of materials) material.dispose();
      for (const item of trackDisposables) item.dispose();
      for (const light of streetLights) scene.remove(light);
      for (const light of windowLights) scene.remove(light);
    },
  };
}
