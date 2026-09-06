import * as THREE from 'three';
import { GROUND, type BuildingSpec, type CityModel, type DominantSpec, layoutHash01 } from '../CityModel';

/**
 * The Cyberpunk representation of the city, built from the same `CityModel` the ordinary
 * one is built from.
 *
 * Two things went wrong in the previous version and both are addressed by that single
 * sentence. It placed its towers from `BLOCK_CONFIGS` while the drawn city came from the
 * hybrid model, so the two representations stood on different footprints and the ordinary
 * balconies hung outside the new massing. And it never hid what it replaced -- it scaled a
 * second group up over the first, which is not a swap, and no box is large enough to make
 * that look intentional. Here the footprints are the model's own plots, and the caller
 * (`attachHybridSpike`) hides the clusters this stands in for.
 *
 * Everything is an instance of one shared unit box, plus one shared cylinder and one ring
 * for the transmission tower. That is deliberate: `renderer.info.memory.geometries` counts
 * geometry objects, and the hybrid world already sits at 562 of its 600 budget. A whole
 * second city costs four geometries here, not four hundred.
 *
 * Roles come from the model, not from height. A tall mass is not automatically a place
 * people live in: `family` says which plots are residential, and `DominantSpec.kind`
 * separates the heating plant and its chimney from the transmission tower. Treating every
 * tall thing as a megablock is what turned the RTV mast into a block of flats.
 */

/** One material class. Each becomes exactly one `InstancedMesh` over a shared geometry. */
type Klass =
  | 'body'        // dark structural mass
  | 'shell'       // slightly lighter panelling, for setbacks and wings
  | 'metal'       // ribs, risers, catwalks, plant ducts
  | 'glass'       // window zones: dim, self-lit, never a mirror
  | 'accentA'     // cyan light bands
  | 'accentB'     // magenta light bands
  | 'sign'        // warm sign panels
  | 'hazard';     // sparse obstruction lights

export interface Placement {
  klass: Klass;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  ry?: number;
  rx?: number;
  shape?: 'box' | 'cylinder' | 'ring';
}

export interface CyberCityHandle {
  group: THREE.Group;
  /** 0 = absent, 1 = fully risen. Drives the morph the theme animates. */
  setRise(factor: number): void;
  /** Low drops the smallest detail classes; the silhouette is identical. */
  setLow(low: boolean): void;
  /** Where the plant's chimney vents, in world space: the smoke plume asks for this. */
  outlet(): THREE.Vector3;
  emissiveObjects(): THREE.Object3D[];
  counts(): { instances: number; meshes: number; geometries: number };
  dispose(): void;
}

/**
 * Which cluster the Cyberpunk representation stands in for.
 *
 * The rule, not a list: every residential plot and both dominants are replaced, and the
 * streetscape and the grocery are not -- the roads, pavements, lamps and trees are the
 * layout, and the layout stays in both styles. Exported so the decision can be tested
 * where it is made rather than inferred from a screenshot.
 */
export function isReplacedByCyber(clusterId: string): boolean {
  return clusterId.startsWith('building-') || clusterId.startsWith('dominant-');
}

/**
 * How far a tier may lean past its plot, and how high up it has to be before it may.
 *
 * The plot layout and the street widths are shared with the ordinary city, so an overhang
 * is a licence with a limit rather than a free hand. A metre a side, never below twelve
 * metres: above the pavement, the lamps and anything that drives down the street.
 */
const OVERHANG_LIMIT = 1;
const OVERHANG_FLOOR = 12;
/** What a tier's own mass may reach, leaving the rest of the allowance for face detail. */
const OVERHANG_REACH = OVERHANG_LIMIT - 0.3;

/** Classes Low does not draw: fine detail that never changes the silhouette. */
const LOW_SKIPS: ReadonlySet<Klass> = new Set(['sign', 'metal']);

const PALETTE: Record<Klass, { color: number; emissive?: number; intensity?: number; metalness?: number; roughness?: number }> = {
  /**
   * Dark, but not black, and not very metallic.
   *
   * The first values were 0x1a1f27 at metalness 0.55, and under this theme -- which sets a
   * night floor of 0.62 and cuts exposure to 0.64, a permanent dusk by design -- a
   * half-metallic near-black surface has almost nothing to reflect and reads as a hole in
   * the sky. The masses now separate from each other by value: the structural tiers are a
   * step darker than the panelled ones, so setbacks and overhangs are legible in daylight
   * without the bloom pass doing the work.
   */
  body: { color: 0x232a34, metalness: 0.3, roughness: 0.68 },
  shell: { color: 0x39434f, metalness: 0.26, roughness: 0.72 },
  metal: { color: 0x4d5867, metalness: 0.62, roughness: 0.42 },
  // Windows are lit from inside at a low level, so a facade reads as inhabited by day too.
  glass: { color: 0x0d1620, emissive: 0xffb457, intensity: 0.55, metalness: 0.3, roughness: 0.45 },
  accentA: { color: 0x02171d, emissive: 0x27e2ff, intensity: 1.8 },
  accentB: { color: 0x1a0413, emissive: 0xff3ea5, intensity: 1.7 },
  sign: { color: 0x140f04, emissive: 0xffc860, intensity: 1.35 },
  hazard: { color: 0x1a0505, emissive: 0xff2e2e, intensity: 1.5 },
};

/**
 * Massing for one residential plot.
 *
 * Silhouette first: a stepped stack with one real overhang and a service riser that breaks
 * the roofline, then the surface work. The plot is never exceeded -- `w` and `d` come from
 * the model, so streets stay as wide as they were and the pavement still fits.
 */
function megablock(spec: BuildingSpec, push: (placement: Placement) => void): void {
  const { cx, cz, w, d } = spec;
  const hash = (salt: number) => layoutHash01(spec.index, salt);
  /**
   * Cyberpunk grows the city upwards, but by the plot's own character rather than a
   * blanket multiplier: point towers and slabs carry the skyline, walkups stay low so the
   * estate keeps a foreground. Density comes from the stacking, not from one tall box.
   */
  const growth = spec.pointTower ? 2.5 : spec.family === 'slab' ? 1.75 : spec.family === 'tower' ? 2.15 : 1.35;
  const total = spec.heightMetres * growth;
  const tierCount = spec.pointTower || spec.family === 'tower' ? 4 : 3;

  /**
   * The tiers are recorded rather than just emitted.
   *
   * Light bands, signs and window zones have to sit on the face of the tier they belong
   * to. Sizing them from the plot instead put metre-long neon lines out in mid-air beside
   * the narrowed upper tiers, which is the sort of thing that reads as a bug from the
   * overview camera and cannot be explained away as style.
   */
  interface Tier { base: number; height: number; w: number; d: number; x: number; z: number }
  const tiers: Tier[] = [];

  let base = 0;
  let footW = w;
  let footD = d;
  for (let index = 0; index < tierCount; index++) {
    const share = index === 0 ? 0.42 : (1 - 0.42) / (tierCount - 1);
    const height = total * share;
    /**
     * Each tier steps in, and one steps back OUT -- but by a stated amount, and only high up.
     *
     * An overhang is what makes a stack read as built rather than extruded, so it is worth
     * having. Unbounded it is not: the first version could reach a metre and a half past
     * the plot, and a mass that leans over the pavement at head height is the plot layout
     * quietly changing. `OVERHANG_LIMIT` per side, and never below `OVERHANG_FLOOR`, so
     * the street keeps its width where people and vehicles actually are.
     */
    const overhang = index > 0 && base >= OVERHANG_FLOOR && index === 1 + Math.floor(hash(index + 11) * 2);
    const inset = overhang ? -0.5 - hash(index + 3) * 0.4 : 0.35 + hash(index + 4) * 0.55;
    footW = Math.max(2.2, footW - inset * 2);
    footD = Math.max(2.2, footD - inset * 2);
    // A lateral shift on the upper tiers, so the stack leans instead of telescoping.
    const x = cx + (index > 1 ? (hash(index + 21) - 0.5) * Math.min(1.6, w * 0.12) : 0);
    const z = cz + (index > 1 ? (hash(index + 22) - 0.5) * Math.min(1.6, d * 0.12) : 0);
    /**
     * Clamp the tier's REACH, not its width.
     *
     * Width, lateral shift and the surface detail bolted to the face all add up, and
     * clamping the width alone let a shifted tier put its ribs 1.2 m past the plot. What
     * the contract is about is how far anything ends up from the plot line, so that is
     * what is limited -- with a margin left for the detail that hangs on the face.
     */
    footW = Math.min(footW, (w / 2 + OVERHANG_REACH - Math.abs(x - cx)) * 2);
    footD = Math.min(footD, (d / 2 + OVERHANG_REACH - Math.abs(z - cz)) * 2);
    tiers.push({ base, height, w: footW, d: footD, x, z });
    push({
      klass: index === 0 || index === tierCount - 1 ? 'body' : 'shell',
      x,
      y: base + height / 2,
      z,
      sx: footW,
      sy: height,
      sz: footD,
    });
    base += height;
  }

  /**
   * Window zones, and which of the three kinds this plot uses.
   *
   * A skyline where every facade carries the same horizontal stripes reads as one
   * building repeated, which was the first version's failure. The kind is drawn from the
   * layout hash, so the mix is varied but fixed: bands for the slabs, tall slots for the
   * towers, and a coarse grid for the rest -- with a dark tier here and there, because a
   * facade with nothing on it is what makes the lit ones read.
   */
  const zoneKind = hash(101) < 0.36 ? 'slots' : hash(101) < 0.72 ? 'bands' : 'grid';
  for (const [index, tier] of tiers.entries()) {
    if (hash(index + 111) < 0.18) continue; // one tier left dark
    const faces = [
      { ox: 0, oz: tier.d / 2 + 0.03, along: tier.w, axis: 'x' as const },
      { ox: 0, oz: -tier.d / 2 - 0.03, along: tier.w, axis: 'x' as const },
      { ox: tier.w / 2 + 0.03, oz: 0, along: tier.d, axis: 'z' as const },
      { ox: -tier.w / 2 - 0.03, oz: 0, along: tier.d, axis: 'z' as const },
    ];
    for (const face of faces) {
      const cells = zoneKind === 'slots'
        ? Math.max(2, Math.round(face.along / 3.2))
        : Math.max(2, Math.round(face.along / 2.2));
      const rows = zoneKind === 'slots' ? 1 : Math.max(1, Math.min(4, Math.round(tier.height / 3.4)));
      for (let row = 0; row < rows; row++) {
        for (let cell = 0; cell < cells; cell++) {
          // Every third opening dark, chosen from the hash: a facade with a few unlit
          // windows reads as occupied, a fully lit one reads as a texture.
          if (layoutHash01(spec.index, index * 31 + row * 7 + cell) < 0.28) continue;
          const alongOffset = ((cell + 0.5) / cells - 0.5) * face.along * 0.92;
          const cellWidth = (face.along * 0.92 / cells) * (zoneKind === 'slots' ? 0.34 : 0.62);
          const cellHeight = zoneKind === 'slots'
            ? tier.height * 0.78
            : Math.min(1.5, (tier.height / (rows + 0.8)) * 0.62);
          const y = zoneKind === 'slots'
            ? tier.base + tier.height / 2
            : tier.base + tier.height * ((row + 0.75) / (rows + 0.5));
          push({
            klass: 'glass',
            x: tier.x + face.ox + (face.axis === 'x' ? alongOffset : 0),
            y,
            z: tier.z + face.oz + (face.axis === 'z' ? alongOffset : 0),
            sx: face.axis === 'x' ? cellWidth : 0.07,
            sy: cellHeight,
            sz: face.axis === 'z' ? cellWidth : 0.07,
          });
        }
      }
    }

    // ── A deep recess on the taller tiers, built around rather than cut ──
    if (tier.height > 6) {
      const slotSide = hash(index + 31) > 0.5 ? 1 : -1;
      const wingW = tier.w * 0.24;
      // Proud of the facade by a third of a metre, which is inside the plot because tier
      // zero is always inset by at least that much. The gap between the two wings is the
      // recess; the mass behind them was already there.
      for (const sign of [-1, 1]) {
        push({
          klass: 'shell',
          x: tier.x + sign * (tier.w / 2 - wingW / 2),
          y: tier.base + tier.height / 2,
          z: tier.z + slotSide * (tier.d / 2 + 0.17),
          sx: wingW,
          sy: tier.height * 0.94,
          sz: 0.35,
        });
      }
    }

    // ── Structural ribs on the two long faces ──
    const ribs = 2 + Math.floor(hash(index + 51) * 3);
    for (let rib = 0; rib < ribs; rib++) {
      const along = (rib + 1) / (ribs + 1) - 0.5;
      for (const sign of [-1, 1]) {
        push({
          klass: 'metal',
          x: tier.x + along * tier.w,
          y: tier.base + tier.height / 2,
          z: tier.z + sign * (tier.d / 2 + 0.12),
          sx: 0.34,
          sy: tier.height,
          sz: 0.24,
        });
      }
    }
  }

  // ── Service risers: two stubby shafts, not one mast ──
  // They used to overshoot by up to a fifth of the building on a 1.1 m section, which read
  // as a second chimney from the overview. Now they clear the roof by a couple of metres
  // and are thick enough to be plant.
  const roof = tiers[tiers.length - 1];
  for (const [index, corner] of [0, 1].entries()) {
    const pick = (Math.floor(hash(61 + corner) * 4) + corner * 2) % 4;
    // Placed against the PLOT, not the top tier. Anchoring them to a tier that has been
    // inset and shifted put a 1.7 m shaft over the plot boundary from ground level up,
    // which is the pavement, not a roof.
    const riserX = cx + (pick % 2 === 0 ? 1 : -1) * Math.max(0, w / 2 - 1.05);
    const riserZ = cz + (pick < 2 ? 1 : -1) * Math.max(0, d / 2 - 1.05);
    const riserHeight = total + 1.6 + hash(62 + corner) * 2.4;
    push({ klass: 'metal', x: riserX, y: riserHeight / 2, z: riserZ, sx: 1.7, sy: riserHeight, sz: 1.7 });
    push({ klass: index === 0 ? 'accentA' : 'accentB', x: riserX, y: riserHeight - 0.6, z: riserZ, sx: 1.8, sy: 0.16, sz: 1.8 });
    if (index === 0 && total > 30) {
      push({ klass: 'hazard', x: riserX, y: riserHeight + 0.4, z: riserZ, sx: 0.34, sy: 0.34, sz: 0.34 });
    }
  }

  // ── Technical crown on the top tier ──
  const crownPieces = 2 + Math.floor(hash(71) * 3);
  for (let piece = 0; piece < crownPieces; piece++) {
    const pieceW = Math.max(1, roof.w * (0.3 + hash(piece + 72) * 0.3));
    const pieceH = 0.8 + hash(piece + 73) * 2.4;
    push({
      klass: 'metal',
      x: roof.x + (hash(piece + 74) - 0.5) * roof.w * 0.6,
      y: total + pieceH / 2,
      z: roof.z + (hash(piece + 75) - 0.5) * roof.d * 0.6,
      sx: pieceW,
      sy: pieceH,
      sz: Math.max(0.8, roof.d * (0.22 + hash(piece + 76) * 0.24)),
    });
  }

  // ── Light bands: on a tier's own face, and only a couple of them ──
  const bandCount = 1 + Math.floor(hash(81) * 2);
  for (let band = 0; band < bandCount; band++) {
    const tier = tiers[Math.floor(hash(band + 85) * tiers.length) % tiers.length];
    const klass: Klass = hash(band + 83) > 0.5 ? 'accentA' : 'accentB';
    const side = hash(band + 86) > 0.5 ? 1 : -1;
    push({
      klass,
      x: tier.x,
      y: tier.base + tier.height * (0.2 + hash(band + 82) * 0.6),
      z: tier.z + side * (tier.d / 2 + 0.05),
      sx: tier.w * 0.82,
      sy: 0.16,
      sz: 0.1,
    });
  }
  if (hash(91) > 0.55) {
    const tier = tiers[Math.floor(hash(97) * tiers.length) % tiers.length];
    const signSide = hash(92) > 0.5 ? 1 : -1;
    push({
      klass: 'sign',
      x: tier.x + signSide * (tier.w / 2 + 0.07),
      y: tier.base + tier.height * 0.5,
      z: tier.z + (hash(94) - 0.5) * tier.d * 0.4,
      sx: 0.12,
      sy: Math.min(tier.height * 0.7, 2.2 + hash(95) * 2.6),
      sz: 0.9 + hash(96) * 0.8,
    });
  }
}

/**
 * The heating plant, as a plant: segmented halls, ducts between them, a pipe run and
 * technical lighting. The chimney stays a chimney -- taller and ribbed, with a vent at the
 * top the smoke actually leaves from.
 */
function powerPlant(spec: DominantSpec, push: (placement: Placement) => void): { outletY: number } {
  const { x, z } = spec;
  const hash = (salt: number) => layoutHash01(x, z, salt);
  const hallX = x + 12;
  const hallZ = z + 2;

  /**
   * Halls of three heights, joined by a lower link: a plant reads as a process rather than
   * as one shed.
   *
   * Bigger and lighter than the first version, both for the same reason. At eleven metres
   * beside sixty-metre megablocks it was simply lost, and in `body` it was the same value
   * as them, so the industrial quarter did not separate from the residential one at all.
   * `shell` is a step lighter, which is what lets it read in daylight.
   */
  for (const [index, [ox, oz, w, h, d]] of ([
    [0, 0, 18, 16, 14],
    [15.5, 2.5, 12, 11, 11],
    [8.6, 0.8, 5, 8, 8],
  ] as const).entries()) {
    push({ klass: index === 2 ? 'metal' : 'shell', x: hallX + ox, y: h / 2, z: hallZ + oz, sx: w, sy: h, sz: d });
    if (index < 2) {
      // Roof plant: extractors and a walkway, so the top is not a lid.
      for (let unit = 0; unit < 3; unit++) {
        push({
          klass: 'metal',
          x: hallX + ox - w / 2 + (unit + 1) * (w / 4),
          y: h + 1.1,
          z: hallZ + oz,
          sx: 2.4,
          sy: 2.2,
          sz: 2.4,
          shape: 'cylinder',
        });
      }
      // Technical lighting: strips along the eaves and a lit gantry, bright enough to
      // register at noon rather than only after dark.
      push({ klass: 'accentA', x: hallX + ox, y: h + 0.1, z: hallZ + oz + d / 2 + 0.07, sx: w * 0.86, sy: 0.18, sz: 0.12 });
      push({ klass: 'sign', x: hallX + ox, y: h * 0.62, z: hallZ + oz + d / 2 + 0.07, sx: w * 0.3, sy: 1.6, sz: 0.12 });
      for (let bay = 0; bay < 4; bay++) {
        push({
          klass: 'glass',
          x: hallX + ox - w / 2 + (bay + 0.5) * (w / 4),
          y: h * 0.34,
          z: hallZ + oz + d / 2 + 0.05,
          sx: w / 6,
          sy: 2.4,
          sz: 0.08,
        });
      }
    }
  }
  // ── Cooling stack pair beside the halls: the second recognisable industrial shape ──
  for (const side of [-1, 1]) {
    push({
      klass: 'shell',
      x: hallX + 7.5,
      y: 7,
      z: hallZ + side * 11,
      sx: 7.4,
      sy: 14,
      sz: 7.4,
      shape: 'cylinder',
    });
    push({ klass: 'metal', x: hallX + 7.5, y: 14.4, z: hallZ + side * 11, sx: 8, sy: 1.2, sz: 8, shape: 'cylinder' });
  }

  // ── Pipe run from the halls to the chimney, on trestles ──
  const runLength = hallX - x - 2;
  push({ klass: 'metal', x: x + 2 + runLength / 2, y: 6.4, z: hallZ - 3.4, sx: runLength, sy: 1.1, sz: 1.1, shape: 'cylinder', ry: Math.PI / 2 });
  push({ klass: 'metal', x: x + 2 + runLength / 2, y: 8.1, z: hallZ - 3.4, sx: runLength, sy: 0.7, sz: 0.7, shape: 'cylinder', ry: Math.PI / 2 });
  const trestles = 4;
  for (let trestle = 0; trestle < trestles; trestle++) {
    const tx = x + 3 + (trestle / (trestles - 1)) * (runLength - 2);
    push({ klass: 'metal', x: tx, y: 3.1, z: hallZ - 3.4, sx: 0.4, sy: 6.2, sz: 0.4 });
  }

  // ── The chimney: still a chimney ──
  const stackHeight = spec.height * 1.18;
  push({ klass: 'body', x, y: stackHeight / 2, z, sx: 4.2, sy: stackHeight, sz: 4.2, shape: 'cylinder' });
  // Ribs up the shaft, and a wider collar at the base where a real stack is thickest.
  push({ klass: 'metal', x, y: 2.2, z, sx: 6.2, sy: 4.4, sz: 6.2, shape: 'cylinder' });
  for (let ring = 0; ring < 5; ring++) {
    push({
      klass: ring % 2 === 0 ? 'metal' : 'accentB',
      x,
      y: stackHeight * (0.28 + ring * 0.16),
      z,
      sx: 4.6,
      sy: ring % 2 === 0 ? 0.5 : 0.18,
      sz: 4.6,
      shape: 'cylinder',
    });
  }
  // The vent itself: a slightly flared mouth, which is where the plume is anchored.
  push({ klass: 'metal', x, y: stackHeight + 0.4, z, sx: 5, sy: 0.8, sz: 5, shape: 'cylinder' });
  push({ klass: 'hazard', x, y: stackHeight + 1.1, z, sx: 0.4, sy: 0.4, sz: 0.4 });
  for (let light = 0; light < 2; light++) {
    push({ klass: 'hazard', x, y: stackHeight * (0.55 + light * 0.22), z, sx: 0.3, sy: 0.3, sz: 0.3 });
  }
  return { outletY: stackHeight + 0.9 };
}

/**
 * The transmission tower stays a tower: a slender shaft, technical platforms, a mast and
 * transmission rings. It is infrastructure, and the surest sign the roles were read wrong
 * would be this silhouette turning into another block of flats.
 */
function transmissionTower(spec: DominantSpec, push: (placement: Placement) => void): void {
  const { x, z } = spec;
  const hash = (salt: number) => layoutHash01(x, z, salt + 200);
  const height = spec.height * 1.22;

  // Tapered shaft in three sections: slenderness is the point, so nothing here is wide.
  const sections = 3;
  let base = 0;
  for (let section = 0; section < sections; section++) {
    const sectionHeight = height * (section === 0 ? 0.46 : 0.27);
    const radius = 2.6 - section * 0.62;
    push({ klass: section === 1 ? 'shell' : 'body', x, y: base + sectionHeight / 2, z, sx: radius * 2, sy: sectionHeight, sz: radius * 2, shape: 'cylinder' });
    // A lattice read: four legs standing off the shaft, not a solid skirt.
    if (section === 0) {
      for (let leg = 0; leg < 4; leg++) {
        const angle = (leg / 4) * Math.PI * 2 + Math.PI / 4;
        push({
          klass: 'metal',
          x: x + Math.cos(angle) * (radius + 0.9),
          y: sectionHeight * 0.5,
          z: z + Math.sin(angle) * (radius + 0.9),
          sx: 0.36,
          sy: sectionHeight,
          sz: 0.36,
        });
      }
    }
    base += sectionHeight;
  }

  // Two technical platforms with railings, and the transmission rings above them.
  for (const [index, level] of [0.42, 0.68].entries()) {
    const y = height * level;
    const radius = 4.4 - index * 1.1;
    push({ klass: 'metal', x, y, z, sx: radius * 2, sy: 0.5, sz: radius * 2, shape: 'cylinder' });
    push({ klass: 'accentA', x, y: y + 0.55, z, sx: radius * 2, sy: 0.12, sz: radius * 2, shape: 'ring', rx: Math.PI / 2 });
    for (let post = 0; post < 6; post++) {
      const angle = (post / 6) * Math.PI * 2 + hash(index) * 0.6;
      push({
        klass: 'metal',
        x: x + Math.cos(angle) * radius,
        y: y + 0.75,
        z: z + Math.sin(angle) * radius,
        sx: 0.14,
        sy: 1.1,
        sz: 0.14,
      });
    }
  }
  for (const level of [0.8, 0.88]) {
    push({ klass: 'accentB', x, y: height * level, z, sx: 5.6, sy: 0.14, sz: 5.6, shape: 'ring', rx: Math.PI / 2 });
  }

  // Mast and dishes: the recognisable part, kept sparse.
  push({ klass: 'metal', x, y: height + height * 0.16, z, sx: 0.5, sy: height * 0.34, sz: 0.5 });
  for (let dish = 0; dish < 3; dish++) {
    const angle = (dish / 3) * Math.PI * 2;
    push({
      klass: 'shell',
      x: x + Math.cos(angle) * 2.1,
      y: height * (0.72 + dish * 0.05),
      z: z + Math.sin(angle) * 2.1,
      sx: 1.7,
      sy: 1.7,
      sz: 0.35,
      ry: -angle,
    });
  }
  // Obstruction lights, sparse on purpose: three, not a string of them.
  for (const level of [0.52, 0.86, 1.3]) {
    push({ klass: 'hazard', x, y: height * level, z, sx: 0.34, sy: 0.34, sz: 0.34 });
  }
}

/** One plot's worth of massing, as data. Exported so the plot bounds can be asserted. */
export function planBuilding(spec: BuildingSpec): Placement[] {
  const placements: Placement[] = [];
  megablock(spec, (placement) => placements.push(placement));
  return placements;
}

/** One dominant's worth, as data, with the vent height when it is the plant. */
export function planDominant(spec: DominantSpec): { placements: Placement[]; outletY: number } {
  const placements: Placement[] = [];
  const push = (placement: Placement) => placements.push(placement);
  const outletY = spec.kind === 'chimney' ? powerPlant(spec, push).outletY : (transmissionTower(spec, push), 0);
  return { placements, outletY };
}

/**
 * Everything the representation is made of, as plain data.
 *
 * Separated from the meshes so the shapes can be checked without a renderer: whether a
 * megablock stays inside its plot, whether the transmission tower is still slender, whether
 * the plant is a plant. Those are the regressions worth a test, and none of them needs GL.
 */
export function planCyberCity(model: CityModel): { placements: Placement[]; outletY: number } {
  const placements: Placement[] = [];
  const push = (placement: Placement) => placements.push(placement);
  for (const building of model.buildings) megablock(building, push);
  let outletY = 0;
  for (const dominant of model.dominants) {
    if (dominant.kind === 'chimney') outletY = powerPlant(dominant, push).outletY;
    else transmissionTower(dominant, push);
  }
  return { placements, outletY };
}

export function createCyberCity(model: CityModel): CyberCityHandle {
  const group = new THREE.Group();
  group.name = 'cyber-city';
  group.visible = false;
  // Built relative to the walkable surface, so the rise animation scales from the ground
  // rather than from the world origin half a metre below it.
  group.position.y = GROUND;
  group.scale.y = 0.0001;

  const { placements, outletY } = planCyberCity(model);

  // ── One geometry per shape, one InstancedMesh per (shape, class) actually used ──
  const geometries: Record<'box' | 'cylinder' | 'ring', THREE.BufferGeometry> = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
    ring: new THREE.TorusGeometry(0.5, 0.06, 6, 18),
  };
  const materials = new Map<Klass, THREE.MeshStandardMaterial>();
  const materialOf = (klass: Klass) => {
    let material = materials.get(klass);
    if (!material) {
      const spec = PALETTE[klass];
      material = new THREE.MeshStandardMaterial({
        color: spec.color,
        metalness: spec.metalness ?? 0.2,
        roughness: spec.roughness ?? 0.5,
        emissive: spec.emissive ?? 0x000000,
        emissiveIntensity: spec.intensity ?? 0,
      });
      material.envMapIntensity = 1.2;
      materials.set(klass, material);
    }
    return material;
  };

  const buckets = new Map<string, Placement[]>();
  for (const placement of placements) {
    const key = `${placement.shape ?? 'box'}|${placement.klass}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(placement);
    else buckets.set(key, [placement]);
  }

  const dummy = new THREE.Object3D();
  const meshes: THREE.InstancedMesh[] = [];
  const emissive: THREE.Object3D[] = [];
  for (const [key, bucket] of buckets) {
    const [shape, klass] = key.split('|') as ['box' | 'cylinder' | 'ring', Klass];
    const mesh = new THREE.InstancedMesh(geometries[shape], materialOf(klass), bucket.length);
    mesh.name = `cyber-${klass}-${shape}`;
    mesh.castShadow = klass === 'body' || klass === 'shell';
    mesh.receiveShadow = klass === 'body' || klass === 'shell';
    for (const [index, placement] of bucket.entries()) {
      dummy.position.set(placement.x, placement.y, placement.z);
      dummy.rotation.set(placement.rx ?? 0, placement.ry ?? 0, 0);
      dummy.scale.set(placement.sx, placement.sy, placement.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    meshes.push(mesh);
    if (PALETTE[klass].emissive) emissive.push(mesh);
  }

  let low = false;
  let rise = 0;
  const applyVisibility = () => {
    group.visible = rise > 0.01;
    for (const mesh of meshes) {
      const klass = mesh.name.split('-')[1] as Klass;
      mesh.visible = !(low && LOW_SKIPS.has(klass));
    }
  };
  applyVisibility();

  return {
    group,
    setRise(factor) {
      rise = THREE.MathUtils.clamp(factor, 0, 1);
      group.scale.y = Math.max(rise, 0.0001);
      applyVisibility();
    },
    setLow(next) {
      low = next;
      applyVisibility();
    },
    outlet() {
      const chimney = model.dominants.find((dominant) => dominant.kind === 'chimney');
      return new THREE.Vector3(chimney?.x ?? 0, GROUND + outletY, chimney?.z ?? 0);
    },
    emissiveObjects() {
      return [...emissive];
    },
    counts() {
      return { instances: placements.length, meshes: meshes.length, geometries: Object.keys(geometries).length };
    },
    dispose() {
      group.removeFromParent();
      for (const mesh of meshes) mesh.dispose();
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const material of materials.values()) material.dispose();
    },
  };
}
