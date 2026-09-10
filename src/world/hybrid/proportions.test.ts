import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { BUS_STOPS, GROUND_SURFACE_Y, BENCH_DIMENSIONS, ROAD_RECTS } from '../WorldLayout';
import { generateBusShelter } from '../WorldGenerator';
import { PASSENGER_SCALE, buildPassenger } from '../PassengerCrowd';
import { Postman } from '../Postman';
import { createBus } from '../Bus';
import { CROSSWALK, KERB_HEIGHT, buildCityModel, type PropSpec } from './CityModel';
import { CONTACT_TOLERANCE } from './GroundContact';
import { emitBuilding } from './architecture';
import { emitProp, emitStreetscape } from './streetscape';
import { geometryFor } from './strategies/DirectSurfaceStrategy';
import { P } from './palette';
import { Emitter, type SurfacePrimitive } from './surface';

/**
 * One metric system for the whole world. Every number here is measured off the
 * finished geometry — the meshes the renderer receives, after scaling, rotation
 * and placement — never off a constructor argument, because the two disagreed:
 * the bus is built from `BUS_HEIGHT = 2.32` and finishes 2.95 m tall, and used to
 * be built from 2.6 and finish 3.569 m.
 *
 * The ranges are deliberately generous. They exist to catch absurdity, not to
 * enforce a survey: the product's stylised figure is 1.915 m, above a real adult,
 * and everything else is judged in proportion to it rather than to a tape measure.
 */

const model = buildCityModel();
const street = emitStreetscape(model).primitives;

/** World-space AABB of a set of emitted primitives, from the geometry itself. */
function boundsOf(prims: readonly SurfacePrimitive[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const prim of prims) {
    const geometry = geometryFor(prim);
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
    geometry.dispose();
  }
  return box;
}

function sizeOf(box: THREE.Box3): THREE.Vector3 {
  return box.getSize(new THREE.Vector3());
}

/** World-space AABB of a built object graph, optionally skipping decorative volumes. */
function objectBounds(root: THREE.Object3D, skip: (mesh: THREE.Mesh) => boolean = () => false): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || skip(mesh)) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
  });
  return box;
}

const PASSENGER_HEIGHT = sizeOf(objectBounds(buildPassenger().group)).y;

const busGroup = (() => {
  const scene = new THREE.Scene();
  createBus(scene);
  return scene.children.find((child) => child.type === 'Group')!;
})();
/** The headlight beams, which have their own size test below. */
const isGlow = (mesh: THREE.Mesh) => mesh.geometry.type === 'ConeGeometry';
/**
 * Decoration, which is not bodywork and must not count as bus size.
 *
 * Two different things, kept apart on purpose. The headlight beams are cones and get
 * measured as beams; the Cyberpunk under-sill mark is an additive plane that paints
 * asphalt. Folding the second into `isGlow` made the beam test measure an 8.8 m plane and
 * call it a wedge, which is a fair complaint about the wrong object. The mark is held
 * inside the carriageway by its own size instead -- see `busGlow.ts`.
 */
const isDecoration = (mesh: THREE.Mesh) => isGlow(mesh) || mesh.name === 'bus-under-glow';
const BUS = sizeOf(objectBounds(busGroup, isDecoration));

/**
 * The primitives of one prop, by identity: its own emitter re-run for that prop
 * alone. The earlier version collected everything within 1.1 m of the prop centre,
 * which for a bicycle also swept in the second bicycle and the bike rack, so the
 * "bicycle" it measured was 1.3 m wide and no single object at all.
 */
function propParts(prop: PropSpec): SurfacePrimitive[] {
  const E = new Emitter();
  emitProp(E, prop);
  return E.primitives;
}
const bikeSpec = model.props.find((prop) => prop.kind === 'bicycle')!;
const leaningSpec = model.props.find((prop) => prop.kind === 'bicycleLeaning')!;
const BIKE = boundsOf(propParts(bikeSpec));
const BIKE_SIZE = sizeOf(BIKE);
const LEANING_BIKE = boundsOf(propParts(leaningSpec));


/**
 * Vertex-accurate world bounds. `Box3.applyMatrix4` transforms the eight corners of
 * a box and re-fits an AABB around them, which inflates every rotated mesh: the
 * postman's wheels measured 1.15 m across that way and 0.70 m measured properly.
 */
function trueBounds(root: THREE.Object3D, keep: (mesh: THREE.Mesh) => boolean = () => true, into?: THREE.Matrix4): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !keep(mesh)) return;
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (into) vertex.applyMatrix4(into);
      box.expandByPoint(vertex);
    }
  });
  return box;
}

/** The postman mid-ride, and a frame to measure him in: y over the road, -z forward. */
const postmanRig = (() => {
  const scene = new THREE.Scene();
  const postman = new Postman(scene);
  for (let i = 0; i < 30; i++) postman.update(0.016, 100 + i * 0.016, 0.34);
  const bike = scene.children.find((child) => child.name === 'postman-bike')!;
  const dog = scene.children.find((child) => child.name === 'postman-dog')!;
  bike.updateWorldMatrix(true, true);
  const toBike = new THREE.Matrix4().copy(bike.matrixWorld).invert();
  const named = (name: string) => trueBounds(bike.getObjectByName(name)!, () => true, toBike);
  const unnamedBy = (test: (mesh: THREE.Mesh) => boolean) => trueBounds(bike, (mesh) => !mesh.name && test(mesh), toBike);
  return { bike, dog, toBike, named, unnamedBy, postman };
})();

describe('one metric system', () => {
  test('the figure everything else is judged against is human-sized', () => {
    expect(PASSENGER_HEIGHT).toBeGreaterThan(1.6);
    expect(PASSENGER_HEIGHT).toBeLessThan(2.0);
  });

  test('the bus is a bus, not a tower on wheels', () => {
    expect(BUS.z).toBeGreaterThan(7.5);
    expect(BUS.z).toBeLessThan(9.0);
    expect(BUS.x).toBeGreaterThan(2.2);
    expect(BUS.x).toBeLessThan(2.8);
    // The defect this test exists for: 3.569 m of height on 8.18 m of length.
    expect(BUS.y).toBeGreaterThan(2.6);
    expect(BUS.y).toBeLessThan(3.15);
    const slenderness = BUS.y / BUS.z;
    expect(slenderness, `bus height/length ${slenderness.toFixed(3)}`).toBeLessThan(0.40);
    const versusPerson = BUS.y / PASSENGER_HEIGHT;
    expect(versusPerson, `bus/person ${versusPerson.toFixed(2)}`).toBeLessThan(1.75);
    expect(versusPerson).toBeGreaterThan(1.3);
  });

  test('the headlight glow is a glow, not an eight metre wedge', () => {
    const glow = objectBounds(busGroup, (mesh) => !isGlow(mesh));
    const size = sizeOf(glow);
    // Both cones together, so the width spans the pair; the length is the giveaway.
    expect(size.z, `glow length ${size.z.toFixed(2)} m`).toBeLessThan(3.0);
    expect(size.y, `glow height ${size.y.toFixed(2)} m`).toBeLessThan(1.6);
  });

  test('the bicycle is a bicycle, not a toy', () => {
    expect(BIKE_SIZE.z, `length ${BIKE_SIZE.z.toFixed(3)}`).toBeGreaterThan(1.7);
    expect(BIKE_SIZE.z).toBeLessThan(1.95);
    // Height at the bars. The miniature version topped out at 1.00 m.
    expect(BIKE_SIZE.y, `height ${BIKE_SIZE.y.toFixed(3)}`).toBeGreaterThan(1.04);
    expect(BIKE_SIZE.y).toBeLessThan(1.25);

    const tyres = street.filter((prim) => prim.kind === 'torus' && prim.tube > 0.03);
    expect(tyres.length).toBe(6);
    for (const tyre of tyres) {
      if (tyre.kind !== 'torus') continue;
      const diameter = 2 * (tyre.radius + tyre.tube);
      expect(diameter, `wheel ${diameter.toFixed(3)} m`).toBeGreaterThan(0.65);
      expect(diameter).toBeLessThan(0.78);
      // Thin enough to vanish at the street camera is the toy signature.
      expect(tyre.tube, 'tyre section').toBeGreaterThanOrEqual(0.04);
    }
    // Frame tubes have to survive the street camera too.
    const frame = street.filter(
      (prim) => prim.palette === P.accentRose && prim.kind === 'box'
    );
    expect(frame.length).toBeGreaterThan(0);
    for (const tube of frame) {
      if (tube.kind !== 'box') continue;
      const section = Math.max(Math.min(tube.w, tube.h), Math.min(tube.h, tube.d));
      expect(section, 'frame tube section').toBeGreaterThanOrEqual(0.04);
    }
  });

  test('bus, person and bicycle read as one family of sizes', () => {
    const busOverBike = BUS.y / BIKE_SIZE.y;
    expect(busOverBike, `bus/bicycle ${busOverBike.toFixed(2)}`).toBeLessThan(3.0);
    expect(busOverBike).toBeGreaterThan(2.0);
    const personOverBike = PASSENGER_HEIGHT / BIKE_SIZE.y;
    expect(personOverBike, `person/bicycle ${personOverBike.toFixed(2)}`).toBeLessThan(2.0);
    expect(personOverBike).toBeGreaterThan(1.4);
  });

  test('what a person walks past is at a human height', () => {
    /**
     * Doors, by the glass only a door is made of.
     *
     * "Any cohort-less glass pane" also catches the walkup's stairwell landing window --
     * 0.8 by 1.1 m, correct for a stairwell and wrong for a door. Nothing had noticed
     * because no walkup stood inside the five-block fragment these tests used to see.
     * `P.glassWarm` is used by `doorAt` and by nothing else.
     */
    const doors = model.buildings.flatMap((b) =>
      emitBuilding(b).primitives.filter(
        (p) => p.cls === 'glass' && p.cohort < 0 && p.kind === 'plane' && p.palette === P.glassWarm
      )
    );
    expect(doors.length).toBeGreaterThan(0);
    for (const door of doors) {
      if (door.kind !== 'plane') continue;
      expect(door.h, `door ${door.h}`).toBeGreaterThanOrEqual(2.0);
      expect(door.h).toBeLessThanOrEqual(2.8);
    }
    for (const b of model.buildings) {
      expect(b.groundFloorHeight, `blok ${b.index} parter`).toBeGreaterThanOrEqual(2.7);
      expect(b.groundFloorHeight).toBeLessThanOrEqual(4.0);
      expect(b.floorHeight, `blok ${b.index} pietro`).toBeGreaterThanOrEqual(2.7);
      expect(b.floorHeight).toBeLessThanOrEqual(3.3);
    }
    expect(KERB_HEIGHT).toBeGreaterThanOrEqual(0.10);
    expect(KERB_HEIGHT).toBeLessThanOrEqual(0.16);
    expect(BENCH_DIMENSIONS.seatHeight).toBeGreaterThanOrEqual(0.40);
    expect(BENCH_DIMENSIONS.seatHeight).toBeLessThanOrEqual(0.52);
  });

  test('facade trim bands stay thin, because thickening them makes them flicker', () => {
    /**
     * A stability budget written as a proportion. It exists because the opposite was tried
     * on purpose, at the owner's request, and measured.
     *
     * Image differencing named `hybrid-building-3-opaque:1` -- the layer-1 `P.trim` bands
     * on a slab facade -- as the one mesh of 709 that moves the artefact the owner
     * photographed. The obvious reading was that the bands are too thin to resolve, so they
     * were thickened and swept from 0.07 m to 0.48 m. Flicker rose at every step, with a
     * plain patch of the same wall held as a control:
     *
     *   band     shipped  0.07   0.14   0.24   0.36   0.48    control
     *   wobble    0.40%   0.66%  1.07%  1.48%  1.76%  1.98%    0.07%
     *
     * as a share of the wall's own luminance, where roughly 1% is where a moving edge
     * becomes visible. Measured by creeping the camera two buffer pixels in sixteen steps
     * inside one synchronous block -- so the world cannot advance and the whole sub-pixel
     * phase range is covered -- and taking the standard deviation of the band's total
     * light. The sweep's 0.07 m column reads higher than the shipped column because every
     * swept build also carried a balustrade panel thickened from 0.08 to 0.14 m: that one
     * 6 mm-per-side change, alone, cost 0.40% -> 0.66%.
     *
     * The mechanism is why no thickness wins. The camera sits about ten degrees above the
     * horizon, so a band's 1.3 m top face foreshortens to some two pixels however thick the
     * band is. What is sub-pixel is the foreshortening, not the thickness, and every
     * millimetre added is more bright area whose coverage flips as the camera creeps.
     *
     * The lever that does work is contrast, and it is why these bands have their own
     * palette entry: see `trimBand` in `palette.ts` for that sweep. Flicker tracks contrast
     * against whatever lies behind, so the bands were darkened towards the wall they lie on
     * while the parapets, which lie against the sky, were left alone.
     *
     * The sweep moved the sill and the loggia slab together, so the family bound below is
     * what the evidence supports -- it catches thickening of the kind that was measured,
     * not a centimetre's nudge, which nothing here can speak to. The sill gets its own
     * tighter bound because it is the element the differencing named and it has no measured
     * headroom at all. The balustrade panel is knowingly outside this net: it is `accent`
     * rather than `P.trim`, and it is the one element with an isolated number against it.
     *
     * Roof parapets are excluded: 0.42 m by design, read against the sky rather than
     * against a wall, and nothing here measured them.
     */
    let bands = 0;
    let sills = 0;
    for (const b of model.buildings) {
      for (const prim of emitBuilding(b).primitives) {
        // `P.trimBand` IS the facade-band family, so the palette does the selecting. An
        // earlier version of this test filtered `P.trim` by "thinner than it is deep"
        // instead, and a lintel thickened to 0.22 m escaped it -- thickening it past its
        // own 0.18 m depth stopped it looking like a band at all.
        if (prim.kind !== 'box' || prim.palette !== P.trimBand || prim.layer !== 1) continue;
        expect(prim.h, `blok ${b.index}: pas ${prim.h.toFixed(2)} m nie lezy poziomo`).toBeLessThan(prim.w);
        expect(
          prim.h,
          `blok ${b.index}: plyta elewacyjna ${prim.h.toFixed(2)} m -- grubsza migota mocniej`
        ).toBeLessThanOrEqual(0.16);
        bands++;
        // The sill under a window: shallow enough that nobody stands on it, which is what
        // separates it from the balcony and loggia slabs at 0.84 and 1.30 m deep.
        if (prim.d > 0.2 && prim.d < 0.35) {
          expect(
            prim.h,
            `blok ${b.index}: parapet ${prim.h.toFixed(2)} m -- zmierzony jako winowajca`
          ).toBeLessThanOrEqual(0.1);
          sills++;
        }
      }
    }
    expect(bands, 'zadna plyta elewacyjna nie zostala zmierzona').toBeGreaterThan(900);
    expect(sills, 'zaden parapet nie zostal zmierzony').toBeGreaterThan(600);
  });

  test('balustrade posts are the height a balustrade has to be', () => {
    // Measured on the members themselves, not on a search for the slab under them:
    // two earlier versions of this test matched a window sill and a lower rail and
    // reported 0.52 m and 1.56 m for a railing that is 1.00 m.
    let posts = 0;
    for (const b of model.buildings) {
      for (const prim of emitBuilding(b).primitives) {
        if (prim.kind !== 'box' || prim.palette !== P.steel) continue;
        const upright = prim.h > prim.w * 2 && prim.h > prim.d * 2;
        if (!upright || prim.h < 0.3) continue;
        expect(prim.h, `blok ${b.index} slupek balustrady ${prim.h.toFixed(2)} m`).toBeGreaterThan(0.8);
        expect(prim.h, `blok ${b.index} slupek balustrady ${prim.h.toFixed(2)} m`).toBeLessThan(1.35);
        posts++;
      }
    }
    expect(posts, 'zaden slupek balustrady nie zostal zmierzony').toBeGreaterThan(0);
  });

  test('street furniture is furniture, not architecture', () => {
    // Measured off the voxels the shelter emits -- centre plus or minus scale --
    // because that is the geometry the renderer receives. Reading
    // `BUS_SHELTER_ROOF_Y` back in a test would only restate a constant and could
    // not catch a roof slab or a bench that stopped following it.
    const stop = BUS_STOPS[0];
    const shelter = generateBusShelter(stop.shelterX, stop.shelterZ, stop.axis, stop.benchSign);
    const boxes = shelter.map((voxel) => {
      const scale = voxel.scale ?? new THREE.Vector3(1, 1, 1);
      return new THREE.Box3().setFromCenterAndSize(voxel.position, scale);
    });
    const roof = boxes.reduce((a, b) => (b.max.y - b.min.y < 0.3 && (b.max.x - b.min.x) * (b.max.z - b.min.z) > 4 ? b : a));
    const posts = boxes.filter((b) => b.max.y - b.min.y > 1.5 && (b.max.x - b.min.x) < 0.25);
    const seat = boxes.filter((b) => b.max.y - b.min.y < 0.2 && b.min.y - GROUND_SURFACE_Y > 0.3 && b.min.y - GROUND_SURFACE_Y < 0.6);

    const roofTop = roof.max.y - GROUND_SURFACE_Y;
    const clearance = roof.min.y - GROUND_SURFACE_Y;
    expect(posts.length, 'wiata bez slupkow').toBeGreaterThanOrEqual(2);
    expect(seat.length, 'przystanek bez siedziska').toBeGreaterThanOrEqual(1);

    // Justified, not invented: a shelter has to let this world's tallest resident
    // walk in and stand under it, and a roof that clears him by more than a storey
    // is a canopy, not a shelter. Nothing here compares it to the bus -- that the
    // shelter is lower than the bus is a styling choice in this diorama, not a rule
    // of realism, and asserting it would freeze the choice as a law.
    expect(clearance, `przeswit ${clearance.toFixed(2)} m`).toBeGreaterThan(PASSENGER_HEIGHT + 0.1);
    expect(roofTop - clearance, `plyta dachu ${(roofTop - clearance).toFixed(2)} m`).toBeLessThan(0.35);
    expect(roofTop, `wiata ${roofTop.toFixed(2)} m`).toBeLessThan(PASSENGER_HEIGHT + 0.9);

    // The roof has to be over the bench, not beside it.
    const bench = seat.reduce((a, b) => (b.getSize(new THREE.Vector3()).length() > a.getSize(new THREE.Vector3()).length() ? b : a));
    expect(bench.min.x, 'siedzisko wystaje przed dach').toBeGreaterThan(roof.min.x - 0.2);
    expect(bench.max.x).toBeLessThan(roof.max.x + 0.2);
    expect(bench.min.z).toBeGreaterThan(roof.min.z - 0.2);
    expect(bench.max.z).toBeLessThan(roof.max.z + 0.2);

    // The bench itself, measured: a seat someone can sit on, deep enough to sit back
    // on, long enough for two of this world's residents at 0.45 m of shoulder each.
    const benchSize = bench.getSize(new THREE.Vector3());
    const seatTop = bench.max.y - GROUND_SURFACE_Y;
    const benchLength = Math.max(benchSize.x, benchSize.z);
    const benchDepth = Math.min(benchSize.x, benchSize.z);
    expect(seatTop, `siedzisko ${seatTop.toFixed(2)} m`).toBeGreaterThan(0.40);
    expect(seatTop, `siedzisko ${seatTop.toFixed(2)} m`).toBeLessThan(0.52);
    expect(benchDepth, `glebokosc ${benchDepth.toFixed(2)} m`).toBeGreaterThan(0.40);
    expect(benchDepth).toBeLessThan(0.70);
    expect(benchLength, `dlugosc ${benchLength.toFixed(2)} m`).toBeGreaterThan(0.9);
    expect(benchLength, `dlugosc ${benchLength.toFixed(2)} m`).toBeLessThan(2.2);
    const seats = Math.floor(benchLength / 0.45);
    expect(seats, `miejsca ${seats}`).toBeGreaterThanOrEqual(2);
  });

  test('the street a person crosses has believable widths', () => {
    const lane = (ROAD_RECTS[0].maxZ - ROAD_RECTS[0].minZ) / 2;
    expect(lane, `pas ruchu ${lane} m`).toBeGreaterThanOrEqual(1.8);
    const crossing = CROSSWALK.maxX - CROSSWALK.minX;
    expect(crossing, `przejscie ${crossing.toFixed(2)} m`).toBeGreaterThanOrEqual(2.5);
    // Bars along the carriageway, repeating across it.
    const bars = street.filter((p) => p.palette === P.marking && p.kind === 'box');
    expect(bars.length).toBe(CROSSWALK.stripes);
    for (const bar of bars) if (bar.kind === 'box') expect(bar.w).toBeGreaterThan(bar.d);
  });

  test('nothing floats above the pavement or sinks into it', () => {
    // The fragment's own contact tolerance, 12 mm, on the finished geometry of each
    // prop measured on its own. The previous version allowed 50 mm of sink, which is
    // exactly what it was hiding: every tyre was built as a 0.34 m torus with a
    // 0.045 m section and its hub at 0.34, so the tread sat 45 mm under the pavement.
    for (const prop of model.props) {
      const prims = propParts(prop);
      if (!prims.length) continue;
      const box = boundsOf(prims);
      const gap = box.min.y - GROUND_SURFACE_Y;
      expect(gap, `${prop.id} spod ${gap.toFixed(4)} m`).toBeGreaterThan(-CONTACT_TOLERANCE);
      expect(gap, `${prop.id} unosi sie ${gap.toFixed(4)} m`).toBeLessThan(CONTACT_TOLERANCE);
    }
  });

  test('the leaning bicycle leans without burying a tyre', () => {
    const gap = LEANING_BIKE.min.y - GROUND_SURFACE_Y;
    expect(gap, `rower oparty spod ${gap.toFixed(4)} m`).toBeGreaterThan(-CONTACT_TOLERANCE);
    expect(gap).toBeLessThan(CONTACT_TOLERANCE);
    // A leaning wheel's hub is displaced sideways from its contact patch by
    // r*sin(lean); an upright one sits over it. Measured on the tyre's own vertices,
    // which is also the check that catches a lean applied to the frame but not to
    // the wheels. (Comparing bounding-box heights proves nothing here: rotating a
    // box raises a corner, so the leaning bicycle's AABB is the taller of the two.)
    const offsetOf = (prop: PropSpec): number => {
      const tyre = propParts(prop).find((prim) => prim.kind === 'torus' && prim.tube > 0.03);
      const geometry = geometryFor(tyre!);
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      const vertex = new THREE.Vector3();
      const lowest = new THREE.Vector3(0, Infinity, 0);
      const centre = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i);
        centre.add(vertex);
        if (vertex.y < lowest.y) lowest.copy(vertex);
      }
      centre.divideScalar(position.count);
      geometry.dispose();
      return Math.hypot(centre.x - lowest.x, centre.z - lowest.z);
    };
    const leaning = offsetOf(leaningSpec);
    const upright = offsetOf(bikeSpec);
    expect(upright, `rower stojacy: os nad sladem ${upright.toFixed(4)} m`).toBeLessThan(0.005);
    expect(leaning, `rower oparty: os obok sladu ${leaning.toFixed(4)} m`).toBeGreaterThan(0.04);
    expect(leaning).toBeLessThan(0.12);
  });

  test('the postman rides his bicycle instead of hovering over it', () => {
    const { bike, named, unnamedBy, toBike } = postmanRig;
    const rig = trueBounds(bike, () => true, toBike);
    const wheels = unnamedBy((mesh) => mesh.geometry.type === 'TorusGeometry');
    const wheelSize = sizeOf(wheels);
    const bars = unnamedBy((mesh) => mesh.geometry.type === 'BoxGeometry' && mesh.position.y > 0.9);
    const saddle = unnamedBy((mesh) => mesh.geometry.type === 'BoxGeometry' && Math.abs(mesh.position.z - 0.32) < 0.01 && mesh.position.y > 0.8);
    const legs = named('postman-legs');
    const arms = named('postman-left-arm');
    const head = named('postman-head');

    // Contact, in the bike's own frame where y = 0 is the road it stands on. The
    // whole rig used to ride at y = 0 while the road is the ground plane at -0.5, so
    // postman, bicycle and dog floated half a metre with detached shadows.
    expect(rig.min.y, `spod kola ${rig.min.y.toFixed(4)} m`).toBeGreaterThan(-CONTACT_TOLERANCE);
    expect(wheels.min.y, `kolo nad droga ${wheels.min.y.toFixed(4)} m`).toBeLessThan(CONTACT_TOLERANCE);
    // And the same contact in world coordinates, against the road: the check above
    // is in the bicycle's own frame, where its wheels touch y = 0 whatever height
    // the whole rig is flying at.
    const world = trueBounds(bike);
    const gap = world.min.y - GROUND_SURFACE_Y;
    expect(gap, `listonosz ${gap.toFixed(3)} m nad droga`).toBeGreaterThan(-CONTACT_TOLERANCE);
    expect(gap, `listonosz ${gap.toFixed(3)} m nad droga`).toBeLessThan(CONTACT_TOLERANCE);
    const dogGap = trueBounds(postmanRig.dog).min.y - GROUND_SURFACE_Y;
    expect(dogGap, `pies ${dogGap.toFixed(3)} m nad droga`).toBeGreaterThan(-CONTACT_TOLERANCE);
    expect(dogGap).toBeLessThan(CONTACT_TOLERANCE);

    // One family of wheels: the street bicycles are 0.74 m, this was 0.84 m.
    const streetWheel = (() => {
      const tyre = propParts(bikeSpec).find((prim) => prim.kind === 'torus' && prim.tube > 0.03)!;
      return tyre.kind === 'torus' ? 2 * (tyre.radius + tyre.tube) : 0;
    })();
    expect(wheelSize.y, `kolo ${wheelSize.y.toFixed(3)} m`).toBeGreaterThan(0.65);
    expect(wheelSize.y).toBeLessThan(0.78);
    expect(Math.abs(wheelSize.y - streetWheel), 'kola listonosza i ulicy rozjezdzaja sie').toBeLessThan(0.1);

    // A bicycle he fits on: hips on the saddle, hands on the bars, feet off the road
    // and under the saddle. Everything below is measured on finished meshes.
    const saddleTop = saddle.max.y;
    const hip = legs.max.y;
    expect(saddleTop, `siodlo ${saddleTop.toFixed(3)} m`).toBeGreaterThan(0.8);
    expect(saddleTop).toBeLessThan(1.0);
    expect(bars.min.y, 'kierownica nizej niz siodlo').toBeGreaterThan(saddleTop - 0.1);
    expect(-bars.max.z, 'kierownica nie jest przed siodlem').toBeGreaterThan(-saddle.min.z);
    expect(Math.abs(hip - saddleTop), `biodra ${(hip - saddleTop).toFixed(3)} m od siodla`).toBeLessThan(0.14);
    // Hands: the arm's lower end has to overlap the grips in height and reach them.
    expect(arms.min.y, `rece ${arms.min.y.toFixed(3)} m wobec kierownicy ${bars.min.y.toFixed(3)}`).toBeLessThan(bars.max.y + 0.05);
    expect(arms.min.y).toBeGreaterThan(bars.min.y - 0.15);
    expect(-arms.min.z, 'rece nie dosiegaja kierownicy').toBeGreaterThan(-bars.max.z - 0.1);
    expect(legs.min.y, `stopa ${legs.min.y.toFixed(3)} m`).toBeGreaterThan(0.05);
    expect(legs.min.y).toBeLessThan(saddleTop);
    // Feet on the pedals, and there is something to put them on. The pose said
    // pedalling while the picture showed a leg ending above nothing between the two
    // wheels, which is a thing a frame shows and a bounding box does not.
    const crank = unnamedBy((mesh) => mesh.geometry.type === 'BoxGeometry' && mesh.position.y < 0.5);
    const foot = { y: legs.min.y, z: (legs.min.z + legs.max.z) / 2 };
    const crankCentre = { y: (crank.min.y + crank.max.y) / 2, z: (crank.min.z + crank.max.z) / 2 };
    expect(crank.max.y, `korba ${crankCentre.y.toFixed(3)} m nad droga`).toBeLessThan(saddleTop - 0.3);
    expect(crank.min.y).toBeGreaterThan(0.15);
    const reach = Math.hypot(foot.y - crankCentre.y, foot.z - crankCentre.z);
    expect(reach, `stopa ${reach.toFixed(3)} m od korby`).toBeLessThan(0.3);

    // He is one of this world's people, not a bigger species.
    const crown = rig.max.y;
    expect(crown, `czubek czapki ${crown.toFixed(3)} m`).toBeGreaterThan(PASSENGER_HEIGHT);
    expect(crown, `czubek czapki ${crown.toFixed(3)} m`).toBeLessThan(PASSENGER_HEIGHT * 1.25);
    expect(head.max.y).toBeLessThan(crown + 0.001);
    const rider = bike.getObjectByName('postman-rider')!;
    expect(rider.scale.x, 'jezdziec skalowany inaczej niz mieszkancy').toBeCloseTo(PASSENGER_SCALE, 5);
  });

  test('the bus stands on the road it drives on', () => {
    // Measured after the bus has been placed by its own update, because that is
    // where the defect was: the route is stored at y = 0, the road is the ground
    // plane, and nothing reconciled them -- the bus drove half a metre in the air
    // with its shadow detached from its wheels.
    const scene = new THREE.Scene();
    const bus = createBus(scene);
    bus.update(1 / 60, 0, false, 12 / 24); // midday, running service
    const group = scene.children.find((child) => child.type === 'Group')!;
    const bounds = trueBounds(group, (mesh) => mesh.geometry.type !== 'ConeGeometry');
    const gap = bounds.min.y - GROUND_SURFACE_Y;
    expect(gap, `autobus ${gap.toFixed(3)} m nad jezdnia`).toBeGreaterThan(-0.02);
    expect(gap, `autobus ${gap.toFixed(3)} m nad jezdnia`).toBeLessThan(0.05);
  });

  test('the dog is a dog, not a pony', () => {
    // Before any update, too: the yard position is where the dog is put on
    // construction, and it is a separate constant from the one the update writes.
    const fresh = new THREE.Scene();
    new Postman(fresh);
    const parked = trueBounds(fresh.children.find((child) => child.name === 'postman-dog')!);
    expect(parked.min.y - GROUND_SURFACE_Y, `pies w budzie ${(parked.min.y - GROUND_SURFACE_Y).toFixed(3)} m nad ziemia`)
      .toBeLessThan(CONTACT_TOLERANCE);
    expect(parked.min.y - GROUND_SURFACE_Y).toBeGreaterThan(-CONTACT_TOLERANCE);

    const dog = trueBounds(postmanRig.dog);
    const size = sizeOf(dog);
    const shoulder = dog.max.y - GROUND_SURFACE_Y;
    expect(shoulder, `pies ${shoulder.toFixed(2)} m w klebie`).toBeGreaterThan(0.35);
    expect(shoulder, `pies ${shoulder.toFixed(2)} m w klebie`).toBeLessThan(0.75);
    expect(Math.max(size.x, size.z), `dlugosc ${Math.max(size.x, size.z).toFixed(2)} m`).toBeLessThan(1.1);
    expect(shoulder).toBeLessThan(PASSENGER_HEIGHT * 0.45);
  });
});
