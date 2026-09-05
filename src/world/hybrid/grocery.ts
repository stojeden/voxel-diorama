import { KIOSK_SPECS } from '../WorldLayout';
import { GROUND } from './CityModel';
import { STYLE } from './HybridMaterial';
import { P } from './palette';
import { Emitter, type Cluster } from './surface';

/**
 * The neighbourhood grocery, and its twin by the lake.
 *
 * These were the last two things in the city still drawn as plain voxel boxes: a 4×3×3
 * shell with three lit cells for a window, next to blocks that had been rebuilt in the
 * accepted language. They are pavilions now -- plinth, plastered body, a glazed shopfront
 * with goods behind it, a green fascia under a concrete hood, a flat roof with a parapet.
 *
 * **The footprint is deliberately unchanged.** The old shell spanned x-0.5..x+3.5 and
 * z-0.5..z+2.5 with its front on -z, and three things are pinned to that: the static prop
 * footprints the layout tests check, the canvas "SPOŻYWCZY" sign the generator hangs on the
 * fascia, and the whole night raid.
 *
 * **No awning.** The shops on the tenements have one because they keep shop hours; this
 * one is open from six in the morning to eleven at night and its shopfront is sheltered by
 * a concrete hood, which is structure rather than fabric and never moves. The 10-to-6
 * hours belong to the other shops and are not imposed here.
 *
 * **The shopfront is a wall with holes in it, and that is the correction.** The first
 * version stood a solid `frame` panel in each opening, hung a transparent pane on the
 * front of it, and put the goods and the lit back *inside the solid body behind the wall*.
 * So there was nothing to see through the glass, the pane and the panel shared an outer
 * plane and fought for every pixel, and a window came out looking like a damaged patch of
 * render rather than a window. The body is set back from the frontage now, the frontage is
 * piers and a lintel with real openings between them, and the pane is recessed inside its
 * reveal -- no two faces are coplanar and the shop's interior is actually behind the glass.
 */

/** Where the front wall stands, relative to a kiosk's anchor. */
const FRONT_Z = -0.5;
const WIDTH = 4;
const DEPTH = 3;
/** Top of the plinth, the fascia and the parapet, measured from the ground. */
const PLINTH = 0.34;
const BODY_TOP = 2.62;
const FASCIA_BOTTOM = 1.86;
const ROOF_TOP = 2.95;
/** How far the concrete hood over the shopfront reaches out. */
const HOOD_REACH = 0.42;
/** Thickness of the front leaf: the piers, the lintel and the cills. */
const LEAF = 0.16;
/** How far behind the frontage the solid body starts, leaving the shop window its depth. */
const RECESS = 0.62;
/** Glazing, measured from the ground. */
const GLASS_BOTTOM = 0.62;
const GLASS_TOP = FASCIA_BOTTOM - 0.14;
/** The door is glazed too, but down to the step. */
const DOOR_BOTTOM = 0.06;

/**
 * The frontage, as widths across the four metres: pier, opening, pier, opening, pier,
 * door, pier. The outer piers are deep enough to close the ends of the window reveal;
 * the ones between openings are mullions and only as thick as the leaf.
 */
const FRONTAGE = [
  { kind: 'pier', width: 0.34 },
  { kind: 'window', width: 1.02 },
  { kind: 'pier', width: 0.18 },
  { kind: 'window', width: 1.02 },
  { kind: 'pier', width: 0.18 },
  { kind: 'door', width: 0.92 },
  { kind: 'pier', width: 0.34 },
] as const;

/** Which of the two is the one the aliens visit. Only its interior is worth dressing. */
export const GROCERY_INDEX = 0;

/**
 * The pavilion's solid extent, relative to a kiosk anchor, so the night raid can be
 * checked against the building instead of against a memory of the building.
 */
export const GROCERY_SHELL = {
  /** Half-width and depth of the body, and where its front wall stands. */
  width: WIDTH,
  depth: DEPTH,
  frontZ: FRONT_Z,
  /** Highest solid point: the parapet lip on top of the flat roof. */
  top: ROOF_TOP + 0.1,
  /** How far the concrete hood reaches out in front of the facade. */
  hoodReach: HOOD_REACH,
  /** How far the widest trim stands out from the body sides. */
  overhang: 0.15,
  /** Where the shop's name board hangs, relative to the anchor: on the fascia. */
  signZ: FRONT_Z - 0.16,
  signCentreY: GROUND + (FASCIA_BOTTOM + BODY_TOP) / 2,
  signHeight: 0.68,
  signWidth: 3,
  /** The band the board has to stay inside, so the hood cannot cut across it. */
  fasciaBottomY: GROUND + FASCIA_BOTTOM,
  fasciaTopY: GROUND + BODY_TOP,
} as const;

export function emitGroceries(low: boolean): Cluster {
  const E = new Emitter();
  for (let i = 0; i < KIOSK_SPECS.length; i++) shop(E, KIOSK_SPECS[i], i, low);
  const first = KIOSK_SPECS[GROCERY_INDEX];
  return E.cluster('groceries', [first.x + 1.5, GROUND + 1.4, first.z + 1], 60);
}

function shop(E: Emitter, spec: { x: number; z: number }, index: number, low: boolean): void {
  const cx = spec.x + 1.5;
  const cz = spec.z + 1;
  const front = spec.z + FRONT_Z;
  // Two neighbours, not two copies: one sand, one rose, the way two estate pavilions
  // built in the same year and painted in different decades look.
  const wall = index === GROCERY_INDEX ? P.plasterSand : P.plasterRose;
  const bodyDepth = DEPTH - RECESS;

  // ── Plinth, body, roof. The body starts behind the frontage; the plinth, the roof and
  //    the parapet still span the full depth, so the silhouette is unchanged. ──
  E.box(P.plinth, cx, GROUND + PLINTH / 2, cz, WIDTH + 0.12, PLINTH, DEPTH + 0.12, { layer: 0 });
  E.box(wall, cx, GROUND + (PLINTH + BODY_TOP) / 2, front + RECESS + bodyDepth / 2, WIDTH, BODY_TOP - PLINTH, bodyDepth, {
    layer: 0,
    style: STYLE.seams,
  });
  E.box(P.roofFlat, cx, GROUND + (BODY_TOP + ROOF_TOP) / 2, cz, WIDTH + 0.22, ROOF_TOP - BODY_TOP, DEPTH + 0.22, {
    layer: 0,
  });
  // A parapet lip, so the roof reads as flat rather than as a lid.
  E.box(P.trim, cx, GROUND + ROOF_TOP + 0.05, cz, WIDTH + 0.3, 0.1, DEPTH + 0.3, { layer: 1 });

  // ── Fascia and hood. The fascia is the band the name board is mounted on, so it and the
  //    hood above it must not share any height: the board lives entirely between them. ──
  E.box(P.goodsB, cx, GROUND + (FASCIA_BOTTOM + BODY_TOP) / 2, front - 0.06, WIDTH - 0.1, BODY_TOP - FASCIA_BOTTOM, 0.12, {
    layer: 0,
  });
  E.box(P.trim, cx, GROUND + FASCIA_BOTTOM - 0.08, front - 0.08, WIDTH - 0.1, 0.08, 0.16, { layer: 1 });
  // Concrete hood over the shopfront. Structure, not fabric: it does not move, and it is
  // the reason this shop needs no awning.
  E.box(P.concrete, cx, GROUND + BODY_TOP + 0.06, front - HOOD_REACH / 2, WIDTH + 0.16, 0.12, HOOD_REACH, {
    layer: 0,
  });
  // A single amber accent at the end of the fascia: the shop's own colour note.
  E.box(P.goodsA, cx - 1.92, GROUND + (FASCIA_BOTTOM + BODY_TOP) / 2, front - 0.07, 0.22, BODY_TOP - FASCIA_BOTTOM, 0.14, {
    layer: 1,
  });
  // Lintel over the whole frontage, between the glazing and the fascia.
  E.box(wall, cx, GROUND + (GLASS_TOP + FASCIA_BOTTOM) / 2, front + LEAF / 2, WIDTH, FASCIA_BOTTOM - GLASS_TOP, LEAF, {
    layer: 0,
  });

  // ── The frontage: piers with real openings between them ──
  let x = cx - WIDTH / 2;
  for (let i = 0; i < FRONTAGE.length; i++) {
    const part = FRONTAGE[i];
    const centre = x + part.width / 2;
    x += part.width;
    if (part.kind === 'pier') {
      // The outer piers close the ends of the reveal; the mullions are leaf-thin.
      const outer = i === 0 || i === FRONTAGE.length - 1;
      const depth = outer ? RECESS : LEAF;
      E.box(wall, centre, GROUND + (PLINTH + GLASS_TOP) / 2, front + depth / 2, part.width, GLASS_TOP - PLINTH, depth, {
        layer: 0,
      });
      continue;
    }
    const bottom = part.kind === 'door' ? DOOR_BOTTOM : GLASS_BOTTOM;
    const height = GLASS_TOP - bottom;
    const gy = GROUND + (bottom + height / 2);
    if (part.kind === 'window') {
      // Cill wall under the glass, and the stone cill on top of it.
      E.box(wall, centre, GROUND + (PLINTH + GLASS_BOTTOM) / 2, front + LEAF / 2, part.width, GLASS_BOTTOM - PLINTH, LEAF, {
        layer: 0,
      });
      E.box(P.trim, centre, GROUND + GLASS_BOTTOM - 0.03, front - 0.03, part.width + 0.12, 0.07, LEAF + 0.1, { layer: 2 });
    } else {
      E.box(P.pavement, centre, GROUND + 0.05, front - 0.34, part.width + 0.3, 0.1, 0.5, { layer: 1 });
      // Rails and a handle. Without them a glazed door with a lit shop behind it is a
      // flat bright panel: correct geometry, and it does not read as a door.
      E.box(P.frame, centre, GROUND + DOOR_BOTTOM + 0.13, front - 0.03, part.width - 0.06, 0.26, 0.06, { layer: 1 });
      E.box(P.frame, centre, GROUND + 1.02, front - 0.03, part.width - 0.06, 0.09, 0.06, { layer: 1 });
      E.box(P.steel, centre + part.width / 2 - 0.18, GROUND + 1.06, front - 0.07, 0.05, 0.3, 0.05, { layer: 2 });
    }

    // A slim frame standing proud of the reveal, then the pane set back inside it. The
    // 4 cm between them is what stops the two outer faces sharing a plane.
    const glassW = part.width - 0.1;
    for (const [dx, dy, w, h] of [
      [-glassW / 2 - 0.04, 0, 0.08, height + 0.16],
      [glassW / 2 + 0.04, 0, 0.08, height + 0.16],
      [0, height / 2 + 0.04, glassW + 0.16, 0.08],
    ] as const) {
      E.box(P.frame, centre + dx, gy + dy, front - 0.025, w, h, 0.05, { layer: 0 });
    }
    E.box(P.glass, centre, gy, front + 0.03, glassW, height, 0.03, {
      layer: 0,
      style: STYLE.glass,
      cls: 'glassClear',
    });

    // The lit back of the shop, on the recessed body wall. `shopGlow` is the entry whose
    // emissive follows the grocery's own hours, so this is the light that is on inside
    // while it is open -- and it silhouettes the goods the way a real one does.
    E.box(P.shopGlow, centre, gy, front + RECESS - 0.03, part.width - 0.06, height, 0.05, { layer: 0 });
    if (low || part.kind !== 'window') continue;
    // Goods on show: the only detail that says "grocery" from the pavement.
    for (let shelf = 0; shelf < 2; shelf++) {
      const y = GROUND + GLASS_BOTTOM + 0.18 + shelf * 0.44;
      E.box(P.trim, centre, y - 0.17, front + 0.34, part.width - 0.12, 0.04, 0.24, { layer: 2 });
      for (let k = 0; k < 3; k++) {
        const goods = (index + shelf + k) % 2 === 0 ? P.goodsA : P.goodsB;
        E.box(goods, centre - 0.31 + k * 0.31, y, front + 0.34, 0.2, 0.26, 0.2, { layer: 2 });
      }
    }
  }
}
