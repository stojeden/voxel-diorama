import { GROUND, KERB_HEIGHT, type CityModel, type PropSpec } from './CityModel';
import { STYLE } from './HybridMaterial';
import { P } from './palette';
import { Emitter, type Cluster } from './surface';

/** Pavement, kerbs, crosswalk and the props that make the corner read as used. */
export function emitStreetscape(model: CityModel): Cluster {
  const E = new Emitter();
  for (const cell of [...model.pavement, ...model.forecourt]) {
    E.plane(P.pavement, cell.x, GROUND, cell.z, 1, 1, { layer: 0, style: STYLE.pavement, rx: -Math.PI / 2 });
  }
  for (const kerb of model.kerbs) {
    const alongX = kerb.side === '+z' || kerb.side === '-z';
    const dx = kerb.side === '+x' ? 0.39 : kerb.side === '-x' ? -0.39 : 0;
    const dz = kerb.side === '+z' ? 0.39 : kerb.side === '-z' ? -0.39 : 0;
    E.box(P.kerb, kerb.x + dx, GROUND + KERB_HEIGHT / 2, kerb.z + dz, alongX ? 1 : 0.22, KERB_HEIGHT, alongX ? 0.22 : 1, { layer: 0 });
  }
  // Aleja Poludniowa runs along x, so the bars run across it (along z) and repeat
  // along the road, clipped to the crossing: bars and gaps of one equal width.
  const cw = model.crosswalk;
  const cz = (cw.minZ + cw.maxZ) / 2;
  const barLength = cw.maxZ - cw.minZ - 0.3;
  const barWidth = (cw.maxX - cw.minX) / (cw.stripes * 2 - 1);
  for (let k = 0; k < cw.stripes; k++) {
    const x = cw.minX + barWidth * (2 * k + 0.5);
    E.box(P.marking, x, GROUND + 0.006, cz, barWidth, 0.012, barLength, { layer: 0 });
  }
  for (const prop of model.props) emitProp(E, prop);
  // clipped hedge along the forecourt edge (planted, so it sits on the ground by construction)
  for (let z = 28.2; z <= 31; z += 0.6) {
    E.box(P.goodsB, 6.2, GROUND + 0.32, z, 0.6, 0.55, 0.6, { layer: 1 });
  }
  return E.cluster('streetscape', [-9, GROUND, 28], 32);
}

function emitProp(E: Emitter, prop: PropSpec): void {
  const { x, z, ry } = prop;
  switch (prop.kind) {
    case 'bikeRack': {
      for (const dx of [-0.5, 0.5]) {
        E.box(P.steel, x + dx, GROUND + 0.375, z - 0.3, 0.05, 0.75, 0.05, { layer: 1 });
        E.box(P.steel, x + dx, GROUND + 0.375, z + 0.3, 0.05, 0.75, 0.05, { layer: 1 });
        E.box(P.steel, x + dx, GROUND + 0.75, z, 0.05, 0.05, 0.65, { layer: 1 });
      }
      return;
    }
    case 'bicycle':
      bicycle(E, x, z, ry, 0);
      return;
    case 'bicycleLeaning':
      bicycle(E, x, z, ry, 0.2);
      return;
    case 'bin':
      E.cylinder(P.steel, x, GROUND + 0.45, z, 0.26, 0.24, 0.9, 12, { layer: 1 });
      E.cylinder(P.interior, x, GROUND + 0.93, z, 0.28, 0.28, 0.06, 12, { layer: 2 });
      return;
    case 'planter':
      E.box(P.wood, x, GROUND + 0.22, z, 0.9, 0.44, 0.4, { layer: 1 });
      E.box(P.goodsB, x, GROUND + 0.6, z, 0.8, 0.36, 0.34, { layer: 1 });
      return;
    case 'noticeBoard':
      E.box(P.wood, x, GROUND + 1.0, z, 1.0, 0.8, 0.06, { layer: 2 });
      E.box(P.trim, x, GROUND + 1.0, z - 0.035, 0.88, 0.68, 0.02, { layer: 2 });
      E.box(P.steel, x, GROUND + 0.3, z, 0.05, 0.6, 0.05, { layer: 2 });
      return;
    default:
      return;
  }
}

/**
 * Low-poly city bicycle heading along +x, rotated by `ry`, rolled by `lean`
 * about its own long axis. Wheel centres are lifted by r·cos(lean) and shifted
 * sideways by r·sin(lean) so the tyres touch the ground exactly at the probes.
 */
function bicycle(E: Emitter, x: number, z: number, ry: number, lean: number): void {
  const r = 0.34;
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const lift = Math.cos(lean);
  const side = Math.sin(lean);
  const at = (dx: number, dy: number, dz: number) => ({
    x: x + dx * c + (dz + dy * side) * s,
    y: GROUND + dy * lift,
    z: z - dx * s + (dz + dy * side) * c,
  });
  const o = { layer: 1 as const, rx: lean, ry, order: 'YXZ' as const };
  for (const dx of [-0.55, 0.55]) {
    const p = at(dx, r, 0);
    E.torus(P.interior, p.x, p.y, p.z, r, 0.03, o);
  }
  const part = (palette: number, dx: number, dy: number, dz: number, w: number, h: number, d: number, rz = 0) => {
    const p = at(dx, dy, dz);
    E.box(palette, p.x, p.y, p.z, w, h, d, { ...o, rz });
  };
  part(P.accentRose, 0.0, 0.62, 0, 0.9, 0.04, 0.04);
  part(P.accentRose, -0.15, 0.55, 0, 0.04, 0.5, 0.04);
  part(P.accentRose, 0.45, 0.6, 0, 0.04, 0.6, 0.04);
  part(P.accentRose, -0.2, 0.36, 0, 0.7, 0.04, 0.04, 0.35);
  part(P.wood, -0.15, 0.86, 0, 0.28, 0.06, 0.14);
  part(P.steel, 0.5, 0.95, 0, 0.04, 0.04, 0.5);
  part(P.steel, -0.55, 0.72, 0, 0.36, 0.03, 0.08);
}
