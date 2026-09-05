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
 * accepted language. They are rebuilt in it here -- plinth, plastered body, framed
 * display windows with goods behind them, a green fascia, a flat roof with a parapet --
 * while staying the same small building in the same place.
 *
 * **The footprint is deliberately unchanged.** The old shell spanned x-0.5..x+3.5 and
 * z-0.5..z+2.5 with its front on -z, and three things are pinned to that: the static prop
 * footprints the layout tests check, the canvas "SPOŻYWCZY" sign the generator still hangs
 * at (x+1.5, 2.25, z-0.515), and the whole night raid -- the UFO hovers over
 * `KIOSK_MAIN + (1, 1)`, the goods crate stands at `KIOSK_MAIN + (-1.4, 1)` and the
 * "ZAMKNIĘTE" barrier goes up at `KIOSK_MAIN + (2, -1.2)`. Moving the shopfront by half a
 * metre would leave the beam pulling a crate through a wall.
 *
 * **No awning.** The shops on the tenements have one because they keep shop hours; this
 * one is open from six in the morning to eleven at night and its shopfront is sheltered by
 * a concrete hood, which is structure rather than fabric and never moves. The 10-to-6
 * hours belong to the other shops and are not imposed here.
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

  // ── Plinth, body, roof ──
  E.box(P.plinth, cx, GROUND + PLINTH / 2, cz, WIDTH + 0.12, PLINTH, DEPTH + 0.12, { layer: 0 });
  E.box(wall, cx, GROUND + (PLINTH + BODY_TOP) / 2, cz, WIDTH, BODY_TOP - PLINTH, DEPTH, {
    layer: 0,
    style: STYLE.seams,
  });
  E.box(P.roofFlat, cx, GROUND + (BODY_TOP + ROOF_TOP) / 2, cz, WIDTH + 0.22, ROOF_TOP - BODY_TOP, DEPTH + 0.22, {
    layer: 0,
  });
  // A parapet lip, so the roof reads as flat rather than as a lid.
  E.box(P.trim, cx, GROUND + ROOF_TOP + 0.05, cz, WIDTH + 0.3, 0.1, DEPTH + 0.3, { layer: 1 });

  // ── Fascia: the green band the place is recognised by, and the sign sits on it ──
  E.box(P.goodsB, cx, GROUND + (FASCIA_BOTTOM + BODY_TOP) / 2, front - 0.06, WIDTH - 0.1, BODY_TOP - FASCIA_BOTTOM, 0.12, {
    layer: 0,
  });
  E.box(P.trim, cx, GROUND + FASCIA_BOTTOM - 0.04, front - 0.08, WIDTH - 0.1, 0.08, 0.16, { layer: 1 });
  // Concrete hood over the shopfront. Structure, not fabric: it does not move, and it is
  // the reason this shop needs no awning.
  E.box(P.concrete, cx, GROUND + BODY_TOP + 0.06, front - HOOD_REACH / 2, WIDTH + 0.16, 0.12, HOOD_REACH, {
    layer: 0,
  });

  // ── Shopfront: two display windows, then the door ──
  const glassTop = FASCIA_BOTTOM - 0.14;
  const glassBottom = 0.62;
  for (const bay of [-1.25, -0.05]) {
    // The frame first, then the glass inset into it, then what is standing behind it.
    E.box(P.frame, cx + bay, GROUND + (glassBottom + glassTop) / 2, front - 0.02, 1.06, glassTop - glassBottom + 0.12, 0.1, {
      layer: 0,
    });
    // Clear glass, so the goods behind it are the thing that reads -- an opaque pane with
    // the glow painted on it is a lightbox, and hides the only detail that says "grocery".
    E.box(P.glass, cx + bay, GROUND + (glassBottom + glassTop) / 2, front - 0.05, 0.9, glassTop - glassBottom, 0.04, {
      layer: 0,
      style: STYLE.glass,
      cls: 'glassClear',
    });
    // Sill below the glass, and the dwarf wall it stands on.
    E.box(wall, cx + bay, GROUND + (PLINTH + glassBottom) / 2, front - 0.01, 1.06, glassBottom - PLINTH, 0.08, { layer: 1 });
    E.box(P.trim, cx + bay, GROUND + glassBottom - 0.03, front - 0.06, 1.1, 0.07, 0.16, { layer: 2 });
    // The lit back of the shop. `shopGlow` is the entry whose emissive follows the
    // grocery's own hours, so this is the light that is on inside while it is open --
    // and, being behind the goods, it silhouettes them at night the way a real one does.
    E.box(P.shopGlow, cx + bay, GROUND + (glassBottom + glassTop) / 2, front + 0.52, 0.94, glassTop - glassBottom, 0.06, {
      layer: 0,
    });
    if (low) continue;
    E.box(P.interior, cx + bay, GROUND + (glassBottom + glassTop) / 2, front + 0.3, 0.94, glassTop - glassBottom, 0.4, {
      layer: 1,
      ao: 0.85,
    });
    for (let shelf = 0; shelf < 2; shelf++) {
      const y = GROUND + glassBottom + 0.16 + shelf * 0.42;
      for (let k = 0; k < 3; k++) {
        const goods = (index + shelf + k) % 2 === 0 ? P.goodsA : P.goodsB;
        E.box(goods, cx + bay - 0.3 + k * 0.3, y, front + 0.14, 0.2, 0.26, 0.2, { layer: 2 });
      }
      E.box(P.trim, cx + bay, y - 0.16, front + 0.14, 0.9, 0.04, 0.26, { layer: 2 });
    }
  }

  // Entrance on the right-hand bay, with a step up off the pavement.
  const doorX = cx + 1.35;
  E.box(P.frame, doorX, GROUND + (glassTop + 0.02) / 2, front - 0.02, 1.1, glassTop + 0.02, 0.1, { layer: 0 });
  E.box(P.glassWarm, doorX, GROUND + glassTop / 2, front - 0.06, 0.88, glassTop - 0.06, 0.06, {
    layer: 0,
    style: STYLE.glass,
    cls: 'glass',
  });
  E.box(P.pavement, doorX, GROUND + 0.05, front - 0.32, 1.3, 0.1, 0.5, { layer: 1 });
  // A single amber accent by the door: the shop's own colour note.
  E.box(P.goodsA, cx - 1.92, GROUND + (FASCIA_BOTTOM + BODY_TOP) / 2, front - 0.07, 0.22, BODY_TOP - FASCIA_BOTTOM, 0.14, {
    layer: 1,
  });
}
