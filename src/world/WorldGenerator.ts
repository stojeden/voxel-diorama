import * as THREE from 'three';
import {
  BLOCK_CONFIGS,
  BUS_STOPS,
  COLORS,
  LAKE,
  LAMP_SPECS,
  STATION_STOPS,
  TUNNEL_HEIGHT,
  TUNNEL_LENGTH,
  TUNNEL_WIDTH,
  TRAIN_ROUTE_CURVE,
  TREE_POSITIONS,
  WORLD_HALF_SIZE,
  isOnRoad,
  isOnSidewalk,
  threeColorFromHex,
  type BlockConfig,
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
}

// ─────────────────────────────────────────────────────────────────────────
// Buildings — outer shell only (interior voxels are never visible).
// ─────────────────────────────────────────────────────────────────────────

function generateBlockBuilding(block: BlockConfig): VoxelData[] {
  const voxels: VoxelData[] = [];

  for (let y = 0; y < block.h; y++) {
    for (let bx = 0; bx < block.w; bx++) {
      for (let bz = 0; bz < block.d; bz++) {
        const isOuterFace = bx === 0 || bx === block.w - 1 || bz === 0 || bz === block.d - 1;
        const isShell = isOuterFace || y === 0 || y === block.h - 1;
        if (!isShell) continue;

        const isWindowRow = y > 1 && y < block.h - 1 && y % 2 === 0;
        const isWindowColumn = (bx % 3 === 1 || bz % 3 === 1) && isOuterFace;
        const isBalcony = bz === 0 && bx % 3 === 2 && y > 1 && y < block.h - 2;

        let color: ColorHex = COLORS.concrete;
        if (y === 0) color = COLORS.concreteDark;
        if (y === block.h - 1) color = COLORS.roof;
        if (y % 5 === 0 && y > 0 && y < block.h - 1) color = block.accent;
        if (isBalcony) color = COLORS.balcony;
        if (isWindowRow && isWindowColumn) {
          const hash = Math.sin((block.x + bx) * 31.7 + (block.z + bz) * 17.3 + y * 11.1) * 43758.5453;
          color = hash - Math.floor(hash) > 0.38 ? COLORS.windowLit : COLORS.window;
        }

        voxels.push({ position: new THREE.Vector3(block.x + bx, y, block.z + bz), color });
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
      voxels.push({ position: new THREE.Vector3(x, -1, z), color });
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
    leftPts.push(new THREE.Vector3(p.x + normal.x * 0.52, p.y - 0.07, p.z + normal.z * 0.52));
    rightPts.push(new THREE.Vector3(p.x - normal.x * 0.52, p.y - 0.07, p.z - normal.z * 0.52));
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
    }
  }

  return voxels;
}

/**
 * Portal tunnel at one end of the world. The arched opening faces the city
 * (inner end); the outer end is sealed. A grassy embankment is mounded over
 * the structure so it reads as a hill the track dives into.
 */
function generateTunnel(side: -1 | 1): VoxelData[] {
  const voxels: VoxelData[] = [];
  const outerX = side * WORLD_HALF_SIZE;

  for (let step = 0; step < TUNNEL_LENGTH; step++) {
    const x = outerX - side * step;
    const isInnerFace = step === TUNNEL_LENGTH - 1;
    const isOuterFace = step === 0;

    for (let y = 0; y < TUNNEL_HEIGHT; y++) {
      for (let z = -TUNNEL_WIDTH; z <= TUNNEL_WIDTH; z++) {
        const isSideWall = Math.abs(z) === TUNNEL_WIDTH;
        const isCeiling = y === TUNNEL_HEIGHT - 1;
        // Tall, wide arch — pantograph (~4.8 m) and the slightly off-centre
        // track at the east mouth must both clear it.
        const isOpening = Math.abs(z) <= 3 && y <= 5;

        if (
          (isSideWall || isCeiling || isOuterFace || (isInnerFace && !isOpening)) &&
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
  const voxels: VoxelData[] = [];
  for (let y = 0; y < height; y++) {
    voxels.push({ position: new THREE.Vector3(x, y, z), color: COLORS.concreteDark });
  }
  voxels.push({ position: new THREE.Vector3(x, height, z + dz), color: COLORS.concreteDark });
  voxels.push({ position: new THREE.Vector3(x, height, z + dz * 2), color: COLORS.windowLit });
  return voxels;
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

function generateBench(x: number, z: number, rotate = false): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (const offset of [-1, 0, 1]) {
    voxels.push({
      position: new THREE.Vector3(x + (rotate ? 0 : offset), 1, z + (rotate ? offset : 0)),
      color: COLORS.sleeper,
    });
    voxels.push({
      position: new THREE.Vector3(x + (rotate ? -1 : offset), 2, z + (rotate ? offset : -1)),
      color: COLORS.sleeper,
    });
  }
  for (const leg of [-1, 1]) {
    voxels.push({
      position: new THREE.Vector3(x + (rotate ? 0 : leg), 0, z + (rotate ? leg : 0)),
      color: COLORS.steel,
    });
  }
  return voxels;
}

function generateKiosk(x: number, z: number): VoxelData[] {
  const voxels: VoxelData[] = [];
  for (let bx = 0; bx < 4; bx++) {
    for (let bz = 0; bz < 3; bz++) {
      for (let y = 0; y < 3; y++) {
        const isWindow = y === 1 && bz === 0 && bx > 0 && bx < 3;
        voxels.push({
          position: new THREE.Vector3(x + bx, y, z + bz),
          color: isWindow ? COLORS.windowLit : COLORS.kiosk,
        });
      }
    }
  }
  for (let bx = -1; bx <= 4; bx++) {
    voxels.push({ position: new THREE.Vector3(x + bx, 3, z - 1), color: COLORS.roof });
    voxels.push({ position: new THREE.Vector3(x + bx, 3, z + 3), color: COLORS.roof });
  }
  return voxels;
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
    voxels.push({ position: at(a, 0), color: COLORS.sidewalk });
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
  voxels.push(...generateBench(benchPos.x, benchPos.z, axis === 'z'));
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

  for (let along = -half; along <= half; along += 1) {
    for (let d = 0; d < depth; d++) {
      const px = Math.round(center.x + tangent.x * along + normal.x * (gauge + d));
      const pz = Math.round(center.z + tangent.z * along + normal.z * (gauge + d));
      // Warning strip along the platform edge, otherwise paving.
      pushOnce(px, platformY, pz, d === 0 ? COLORS.roadMarking : COLORS.sidewalk);

      // Elevated platforms: support columns + outer railing.
      if (platformY > 0) {
        if (d === depth - 1 && Math.round(along) % 2 === 0) {
          pushOnce(px, platformY + 1, pz, COLORS.steel);
        }
        if (d === 1 && Math.round(along) % 6 === 0) {
          for (let y = platformY - 1; y >= 0; y--) pushOnce(px, y, pz, COLORS.concreteDark);
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

  for (let x = -radiusX; x <= radiusX; x++) {
    for (let z = -radiusZ; z <= radiusZ; z++) {
      const normalized = (x * x) / (radiusX * radiusX) + (z * z) / (radiusZ * radiusZ);
      if (normalized <= 1) {
        const edge = normalized > 0.72;
        voxels.push({
          position: new THREE.Vector3(centerX + x, -0.82, centerZ + z),
          color: edge ? COLORS.water : COLORS.waterDeep,
        });
        if (edge && (x + z) % 4 === 0) {
          voxels.push({
            position: new THREE.Vector3(centerX + x, 0, centerZ + z),
            color: COLORS.reeds,
          });
        }
      }
    }
  }

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

  voxels.push(...generateKiosk(-30, 16));
  voxels.push(...generateKiosk(20, 53));
  voxels.push(...generateFenceLine(-62, 4, 20));
  voxels.push(...generateFenceLine(-50, -22, 26));
  voxels.push(...generateFenceLine(40, 20, 14));

  // NOTE: keep benches away from the bus loop roads, the cow meadow and the lake.
  const benches: Array<[number, number, boolean]> = [
    [-52, 72, false], [-28, 74, true], [4, 53, false],
    [-20, -40, false], [30, -40, true], [50, 20, false],
  ];
  for (const [x, z, rotate] of benches) {
    voxels.push(...generateBench(x, z, rotate));
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
  windowLights: THREE.PointLight[];
  /** Materials whose emissive should brighten at night. */
  windowGlowMaterials: THREE.MeshStandardMaterial[];
  /** 0..1 lying snow: whitens grass/roofs and grows snow caps on buildings & trees. */
  setSnowCover: (cover: number) => void;
  /** 0..1 rain wetness: roads darken and turn mirror-like. */
  setWetness: (wetness: number) => void;
  /** Apply a diorama theme palette (original colour value → themed value). */
  setTheme: (palette: Record<number, number>, foliage?: { tree: number; treeLight: number }) => void;
  /** 0..1 — cyberpunk morph: megatowers rise out of the blocks. */
  setCyberRise: (factor: number) => void;
  dispose: () => void;
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

  for (let i = 0; i < BLOCK_CONFIGS.length; i++) {
    const block = BLOCK_CONFIGS[i];
    const H = Math.min(46, Math.max(26, block.h * 2.5));
    const w = block.w + 1.6;
    const d = block.d + 1.6;
    const cx = block.x + block.w / 2 - 0.5;
    const cz = block.z + block.d / 2 - 0.5;

    const bodyGeo = new THREE.BoxGeometry(w, H, d);
    disposables.push(bodyGeo);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.set(cx, H / 2, cz);
    body.castShadow = true;
    group.add(body);

    // Corner neon strips (alternating cyan / magenta)
    const stripGeo = new THREE.BoxGeometry(0.28, H, 0.28);
    disposables.push(stripGeo);
    const stripMat = i % 2 === 0 ? neonA : neonB;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const strip = new THREE.Mesh(stripGeo, stripMat);
      strip.position.set(cx + (sx * w) / 2, H / 2, cz + (sz * d) / 2);
      group.add(strip);
    }

    // Glowing window bands
    const bandGeo = new THREE.BoxGeometry(w + 0.12, 0.55, d + 0.12);
    disposables.push(bandGeo);
    for (const f of [0.3, 0.55, 0.8]) {
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.set(cx, H * f, cz);
      group.add(band);
    }

    // Rooftop antenna with a beacon
    const antGeo = new THREE.BoxGeometry(0.3, 6, 0.3);
    disposables.push(antGeo);
    const antenna = new THREE.Mesh(antGeo, bodyMat);
    antenna.position.set(cx, H + 3, cz);
    group.add(antenna);
    const tipGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    disposables.push(tipGeo);
    const tip = new THREE.Mesh(tipGeo, stripMat);
    tip.position.set(cx, H + 6.2, cz);
    group.add(tip);
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

  allVoxels.push(...generatePlayground(-12, 68));
  allVoxels.push(...generateCityProps());
  allVoxels.push(...generateLake());

  // ── Dynamic point lights (kept few for laptop GPUs) ──
  const streetLights: THREE.PointLight[] = [];
  const activeLamps = LAMP_SPECS.filter((_, index) => index % 3 === 0);
  for (const lamp of activeLamps) {
    const light = new THREE.PointLight(COLORS.windowLit, 0, 18, 2);
    light.position.set(lamp.x, 5, lamp.z + lamp.dz * 2);
    light.castShadow = false;
    scene.add(light);
    streetLights.push(light);
  }

  const windowLights: THREE.PointLight[] = [];
  const activeWindowBlocks = BLOCK_CONFIGS.filter((_, index) => index % 5 === 0);
  for (const block of activeWindowBlocks) {
    const light = new THREE.PointLight(COLORS.windowLit, 0, 14, 2);
    light.position.set(block.x + block.w / 2, Math.min(block.h - 2, 6), block.z + block.d / 2);
    light.castShadow = false;
    scene.add(light);
    windowLights.push(light);
  }

  // ── Instanced voxel meshes, one per colour ──
  const geometry = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
  const colorMap = new Map<ColorHex, VoxelData[]>();
  for (const voxel of allVoxels) {
    if (!colorMap.has(voxel.color)) colorMap.set(voxel.color, []);
    colorMap.get(voxel.color)!.push(voxel);
  }

  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const materials: THREE.MeshStandardMaterial[] = [];
  const windowGlowMaterials: THREE.MeshStandardMaterial[] = [];
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
  }
  const lookEntries: LookEntry[] = [];

  for (const [color, voxels] of colorMap) {
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
    if (color === COLORS.windowLit) windowGlowMaterials.push(material);
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
    });

    const instancedMesh = new THREE.InstancedMesh(geometry, material, voxels.length);
    for (let i = 0; i < voxels.length; i++) {
      dummy.position.copy(voxels[i].position);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
    }
    instancedMesh.castShadow = true;
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
      entry.material.color.copy(tmpColor);
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
    windowLights,
    windowGlowMaterials,
    setSnowCover,
    setWetness,
    setTheme,
    setCyberRise,
    dispose() {
      scene.remove(cyberBuild.group);
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
