import * as THREE from 'three';
import { COLORS, GROUND_SURFACE_Y, PLAYGROUND } from './WorldLayout';

/**
 * The playground by the lake: a tube-framed slide and two swings that move in the wind.
 *
 * What was here before was a placeholder from before the rest of the city existed -- a
 * five-by-five pad of accent-coloured voxels, one blue post, and four pink cubes stepping
 * down a diagonal that were meant to read as a slide. The pad sat on a whole voxel, so its
 * top stood half a metre above the pavement, which is why the thing looked like it was
 * growing out of the grass. Nobody could tell what it was, correctly.
 *
 * Everything here is at its real size, because the diorama is built at real sizes
 * everywhere else and a playground is the one prop where a viewer knows the dimensions by
 * heart. The numbers are in `PLAYGROUND_DIMENSIONS`, and the ones that follow from them --
 * the slide's angle, the chain length, the period the swings move at -- are computed rather
 * than typed in, so they cannot drift apart.
 *
 * It all fits inside the plot the layout already reserves, and that is a constraint rather
 * than a coincidence: `isPlaceableProp` rejects tree candidates within 3.5 m of a reserved
 * plot, and the 46 tree positions are generated through it. Widening the plot by a metre
 * would re-roll the park -- one extra rejection and every later tree lands somewhere else.
 * So the equipment was sized to the plot, not the plot to the equipment.
 */

/**
 * Every dimension, in metres, and where each one comes from.
 *
 * A classic junior slide is a platform between 1.2 and 1.5 m with a bed at 30 to 40
 * degrees; a classic swing beam stands 2.0 to 2.4 m with seats at about 0.45 m. These are
 * the low ends of those ranges, because the plot is 6 by 4 m and the equipment has to
 * leave room to stand apart rather than touch.
 */
export const PLAYGROUND_DIMENSIONS = {
  /** Frame tubes: 50 mm, which is what "thin tubes" means on real equipment. */
  tubeDiameter: 0.05,
  /** Chains are thinner than the frame they hang from. */
  chainDiameter: 0.022,
  slide: {
    platformHeight: 1.2,
    /** Horizontal run of the bed. With the height above, this sets the angle. */
    run: 2.0,
    width: 0.5,
    deckLength: 0.7,
    rungs: 3,
    rungSpacing: 0.3,
    /**
     * Side rail height above the bed.
     *
     * 0.12, not 0.3. At 0.3 the two tubes floated clear of the bed and read as a pair of
     * stray poles over a ramp; at the bed's edge they read as what they are on a real
     * metal slide -- the turned-up sides of the channel.
     */
    railHeight: 0.12,
    /** The grab arch over the top of the bed: what you hold before you go. */
    archHeight: 0.55,
  },
  swing: {
    beamHeight: 2.2,
    /** Span between the two A-frames. */
    span: 2.6,
    /** How far each A-frame's feet splay from the beam, front and back. */
    legSpread: 0.45,
    seatHeight: 0.45,
    seatWidth: 0.45,
    seatDepth: 0.18,
    seatThickness: 0.05,
    /** Distance between the two seats along the beam. */
    seatSpacing: 1.4,
  },
  /**
   * How far a seat swings at full wind, in degrees.
   *
   * Six, not sixty. This is a swing moving in a breeze with nobody on it: at a 1.75 m
   * chain, six degrees is 0.18 m of travel. It also keeps the arc inside the reserved
   * plot, so the footprint the pedestrian checks are told about stays true while the
   * swings are moving.
   */
  maxSwayDegrees: 6,
  /** Sand under the equipment, a hand's depth, flush with the ground rather than on a plinth. */
  fallZoneThickness: 0.04,
} as const;

/**
 * The wind at which the swings reach `maxSwayDegrees`.
 *
 * One, because that is the range of the number that arrives: `Weather.getWind` is
 * documented as 0..1 and `updateEnvironment` is handed exactly it. This was 3 first, and
 * the swings duly did nothing -- ordinary weather here runs 0.16 clear, 0.30 in snow and
 * 0.62 in rain, so a third of the scale meant a rainy day leaned the seats 1.2 degrees,
 * which is 3.8 cm and invisible. At 1 the same rainy day is 3.7 degrees.
 */
const FULL_WIND = 1;

/** Sand. The palette has no sand, and several props already carry their own colour. */
const SAND_COLOUR = 0xc4b48c;

/** The slide's angle, in degrees. Not a constant: it follows from the height and the run. */
export function slideAngleDegrees(): number {
  const { platformHeight, run } = PLAYGROUND_DIMENSIONS.slide;
  return (Math.atan2(platformHeight, run) * 180) / Math.PI;
}

/** Length of the bed along the slope. */
export function slideBedLength(): number {
  const { platformHeight, run } = PLAYGROUND_DIMENSIONS.slide;
  return Math.hypot(platformHeight, run);
}

/** Chain length: the drop from the beam to the seat. */
export function swingChainLength(): number {
  const { beamHeight, seatHeight } = PLAYGROUND_DIMENSIONS.swing;
  return beamHeight - seatHeight;
}

/**
 * How long one swing takes, in seconds.
 *
 * A pendulum, not a preference: `2*pi*sqrt(L/g)`. The two seats hang from the same beam on
 * the same chains, so they share the period exactly -- what separates them is a phase, not
 * a speed. Getting this from the chain length is the difference between a swing and a
 * decoration that waves.
 */
export function swingPeriodSeconds(): number {
  return 2 * Math.PI * Math.sqrt(swingChainLength() / 9.81);
}

/** Where each part stands, so the test can check the lot fits the reserved plot. */
export interface PlaygroundPart {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Where every part stands, derived once.
 *
 * Both the builder and the footprint below read this, and that is the point: they started
 * as two sets of expressions for the same plan and immediately disagreed -- the ladder
 * stood 8 cm outside the rectangle the footprint declared, which would have made the
 * pedestrian clearance checks describe a playground that is not the one on screen.
 */
export function playgroundLayout(centre: { x: number; z: number } = PLAYGROUND) {
  const dims = PLAYGROUND_DIMENSIONS;
  const beamCentreX = centre.x - 2.3;
  const deckCentreZ = centre.z - 1.3;
  const halfDeckX = dims.slide.width / 2;
  const halfDeckZ = dims.slide.deckLength / 2;
  const bedStart = deckCentreZ + halfDeckZ;
  return {
    beamCentreX,
    beamZ: centre.z,
    beamY: GROUND_SURFACE_Y + dims.swing.beamHeight,
    seatPivots: [
      beamCentreX - dims.swing.seatSpacing / 2,
      beamCentreX + dims.swing.seatSpacing / 2,
    ] as const,
    /** How far a seat travels from rest at full wind. */
    arc: swingChainLength() * Math.sin((dims.maxSwayDegrees * Math.PI) / 180),
    slideX: centre.x + 0.7,
    deckCentreZ,
    deckHalfX: halfDeckX,
    deckHalfZ: halfDeckZ,
    deckTopY: GROUND_SURFACE_Y + dims.slide.platformHeight,
    ladderZ: deckCentreZ - halfDeckZ - 0.22,
    bedStartZ: bedStart,
    bedEndZ: bedStart + dims.slide.run,
    /** Handrails sit just outside the deck posts. */
    railOffsetX: halfDeckX + PLAYGROUND_DIMENSIONS.tubeDiameter / 2,
  };
}

/** Where each part stands, so the test can check the lot fits the reserved plot. */
export interface PlaygroundPart {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The plot, part by part: swings west, slide east, sand under both.
 *
 * The swing arc is a part of its own, because a moving seat that left the declared
 * rectangle would make the clearance checks wrong exactly when the wind blows. Every
 * rectangle includes the tube radius of whatever stands at its edge.
 */
export function playgroundParts(
  centre: { x: number; z: number } = PLAYGROUND
): PlaygroundPart[] {
  const { swing, slide, tubeDiameter } = PLAYGROUND_DIMENSIONS;
  const l = playgroundLayout(centre);
  const r = tubeDiameter / 2;
  return [
    {
      id: 'swing-frame',
      minX: l.beamCentreX - swing.span / 2 - r,
      maxX: l.beamCentreX + swing.span / 2 + r,
      minZ: l.beamZ - swing.legSpread - r,
      maxZ: l.beamZ + swing.legSpread + r,
    },
    {
      id: 'swing-arc',
      minX: l.seatPivots[0] - swing.seatWidth / 2,
      maxX: l.seatPivots[1] + swing.seatWidth / 2,
      minZ: l.beamZ - l.arc - swing.seatDepth / 2,
      maxZ: l.beamZ + l.arc + swing.seatDepth / 2,
    },
    {
      id: 'slide',
      minX: l.slideX - l.railOffsetX - r,
      maxX: l.slideX + l.railOffsetX + r,
      minZ: l.ladderZ - r,
      maxZ: l.bedEndZ + slide.width / 2,
    },
    {
      id: 'fall-zone',
      minX: centre.x - 3.9,
      maxX: centre.x + 1.2,
      minZ: centre.z - 1.95,
      maxZ: centre.z + 1.3,
    },
  ];
}

export interface PlaygroundHandle {
  readonly group: THREE.Group;
  /** `elapsed` is the simulation clock, `wind` the shared world wind. */
  update(elapsed: number, wind: number): void;
  /** 0..1 Cyberpunk morph. Neon lives in its own module; this passes it along. */
  setCyber(morph: number): void;
  dispose(): void;
}

interface SwingState {
  pivotX: number;
  phase: number;
}

/**
 * Build the playground.
 *
 * Two geometries for the whole thing -- one tube, one box -- because everything is an
 * instance of one or the other, and geometry count is a budget this repository holds at
 * 600. Six draw calls: the static frame, the chains, the seats, the deck, the bed and the
 * sand.
 *
 * The two moving meshes are instanced and their matrices are rewritten each frame. That is
 * six matrices for two swings, which is why this is on the processor and not in a vertex
 * shader: the shader route is what the tree foliage and the chimney smoke use because they
 * animate hundreds of instances, and the passenger crowd sways on the processor for the
 * same reason this does -- there are two of them.
 */
export function buildPlayground(
  centre: { x: number; z: number } = PLAYGROUND
): PlaygroundHandle {
  const { slide, swing, tubeDiameter, chainDiameter } = PLAYGROUND_DIMENSIONS;
  const group = new THREE.Group();
  group.name = 'playground';

  // ── Geometry: one unit tube, one unit box ──
  // Eight radial segments: a 50 mm tube covers a fraction of a pixel of arc at any
  // distance the camera reaches, so more sides buy nothing.
  const tube = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
  const box = new THREE.BoxGeometry(1, 1, 1);

  const steel = new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.42, metalness: 0.6 });
  const chainMaterial = new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.35, metalness: 0.75 });
  const bedMaterial = new THREE.MeshStandardMaterial({ color: COLORS.accentBlue, roughness: 0.3, metalness: 0.35 });
  const woodMaterial = new THREE.MeshStandardMaterial({ color: COLORS.sleeper, roughness: 0.82, metalness: 0.02 });
  const sandMaterial = new THREE.MeshStandardMaterial({ color: SAND_COLOUR, roughness: 0.95, metalness: 0 });

  const l = playgroundLayout(centre);
  const { beamY, beamZ, beamCentreX, slideX, deckCentreZ, deckTopY, deckHalfX, deckHalfZ } = l;

  // ── Static frame ──
  const dummy = new THREE.Object3D();
  const tubes: THREE.Matrix4[] = [];
  const pushTube = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    diameter: number = tubeDiameter
  ) => {
    const mid = from.clone().add(to).multiplyScalar(0.5);
    const axis = to.clone().sub(from);
    const length = axis.length();
    dummy.position.copy(mid);
    dummy.scale.set(diameter, length, diameter);
    dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    dummy.updateMatrix();
    tubes.push(dummy.matrix.clone());
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Swings: two A-frames and the beam they carry.
  for (const side of [-1, 1]) {
    const x = beamCentreX + (side * swing.span) / 2;
    pushTube(v(x, beamY, beamZ), v(x, GROUND_SURFACE_Y, beamZ - swing.legSpread));
    pushTube(v(x, beamY, beamZ), v(x, GROUND_SURFACE_Y, beamZ + swing.legSpread));
  }
  pushTube(
    v(beamCentreX - swing.span / 2, beamY, beamZ),
    v(beamCentreX + swing.span / 2, beamY, beamZ),
    tubeDiameter * 1.2
  );

  // Slide: four deck posts, a ladder, and a handrail either side of the bed.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = slideX + sx * deckHalfX;
      const z = deckCentreZ + sz * deckHalfZ;
      pushTube(v(x, GROUND_SURFACE_Y, z), v(x, deckTopY, z));
    }
  }
  const ladderZ = l.ladderZ;
  const ladderTopY = deckTopY + 0.15;
  for (const sx of [-1, 1]) {
    const x = slideX + sx * deckHalfX;
    pushTube(v(x, GROUND_SURFACE_Y, ladderZ), v(x, ladderTopY, ladderZ));
  }
  for (let rung = 1; rung <= slide.rungs; rung++) {
    const y = GROUND_SURFACE_Y + rung * slide.rungSpacing;
    pushTube(v(slideX - deckHalfX, y, ladderZ), v(slideX + deckHalfX, y, ladderZ));
  }
  const { bedStartZ, bedEndZ } = l;
  // Parallel to the bed, not merely sloping: the rail drops the same 1.2 m over the same
  // 2.0 m run, which is what makes it read as part of the slide rather than a stray pole.
  for (const sx of [-1, 1]) {
    const x = slideX + sx * l.railOffsetX;
    pushTube(
      v(x, deckTopY + slide.railHeight, bedStartZ),
      v(x, GROUND_SURFACE_Y + slide.railHeight, bedEndZ)
    );
  }

  // The grab arch: two uprights at the head of the bed and a bar across them. It is the
  // detail that makes a tube slide legible as one -- without it the top is just a plank
  // meeting a ramp.
  const archTopY = deckTopY + slide.archHeight;
  for (const sx of [-1, 1]) {
    const x = slideX + sx * l.railOffsetX;
    pushTube(v(x, deckTopY, bedStartZ), v(x, archTopY, bedStartZ));
  }
  pushTube(
    v(slideX - l.railOffsetX, archTopY, bedStartZ),
    v(slideX + l.railOffsetX, archTopY, bedStartZ)
  );

  const frame = new THREE.InstancedMesh(tube, steel, tubes.length);
  frame.name = 'playground-frame';
  for (let i = 0; i < tubes.length; i++) frame.setMatrixAt(i, tubes[i]);
  // Nothing thin casts a shadow here, and that is measured rather than lazy: the sun's
  // shadow map covers about 0.136 m per texel in a street view, so a 50 mm tube is a third
  // of a texel and the map can only answer with the dashed stair-steps that were reported
  // under the window sills. A shadow that cannot be drawn is better left undrawn.
  frame.castShadow = false;
  frame.receiveShadow = true;
  group.add(frame);

  // ── Deck, bed and sand ──
  const deck = new THREE.Mesh(box, woodMaterial);
  deck.name = 'playground-deck';
  deck.scale.set(slide.width + 0.08, 0.06, slide.deckLength);
  deck.position.set(slideX, deckTopY - 0.03, deckCentreZ);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  const bed = new THREE.Mesh(box, bedMaterial);
  bed.name = 'playground-slide';
  bed.scale.set(slide.width, 0.05, slideBedLength());
  bed.position.set(
    slideX,
    (deckTopY + GROUND_SURFACE_Y) / 2 + 0.02,
    (bedStartZ + bedEndZ) / 2
  );
  // Positive: the far end has to fall away from the deck. Negative lifted it instead, and
  // the slide read as a plank tilted the wrong way.
  bed.rotation.x = Math.atan2(slide.platformHeight, slide.run);
  bed.castShadow = true;
  bed.receiveShadow = true;
  group.add(bed);

  const zone = playgroundParts(centre).find((part) => part.id === 'fall-zone')!;
  const sand = new THREE.Mesh(box, sandMaterial);
  sand.name = 'playground-sand';
  sand.scale.set(
    zone.maxX - zone.minX,
    PLAYGROUND_DIMENSIONS.fallZoneThickness,
    zone.maxZ - zone.minZ
  );
  // Flush with the ground: the placeholder's plinth is exactly what read as an anomaly.
  sand.position.set(
    (zone.minX + zone.maxX) / 2,
    GROUND_SURFACE_Y + PLAYGROUND_DIMENSIONS.fallZoneThickness / 2,
    (zone.minZ + zone.maxZ) / 2
  );
  sand.receiveShadow = true;
  group.add(sand);

  // ── The two swings ──
  const swings: SwingState[] = [
    { pivotX: l.seatPivots[0], phase: 0 },
    // Not pi: opposite phases look mirrored and mechanical. 2.1 rad reads as two swings
    // that happen to be moving, which is the point.
    { pivotX: l.seatPivots[1], phase: 2.1 },
  ];
  const chains = new THREE.InstancedMesh(tube, chainMaterial, swings.length * 2);
  chains.name = 'playground-chains';
  chains.castShadow = false;
  const seats = new THREE.InstancedMesh(box, woodMaterial, swings.length);
  seats.name = 'playground-seats';
  seats.castShadow = false;
  seats.receiveShadow = true;
  group.add(chains);
  group.add(seats);

  const chainLength = swingChainLength();
  const period = swingPeriodSeconds();
  const maxSway = (PLAYGROUND_DIMENSIONS.maxSwayDegrees * Math.PI) / 180;

  const place = (elapsed: number, wind: number) => {
    const amplitude = maxSway * THREE.MathUtils.clamp(wind / FULL_WIND, 0, 1);
    for (let i = 0; i < swings.length; i++) {
      const state = swings[i];
      const angle = amplitude * Math.sin((elapsed * 2 * Math.PI) / period + state.phase);
      const drop = Math.cos(angle);
      const swingOut = Math.sin(angle);
      for (const side of [-1, 1]) {
        dummy.position.set(
          state.pivotX + (side * (swing.seatWidth - 0.06)) / 2,
          beamY - (chainLength / 2) * drop,
          beamZ + (chainLength / 2) * swingOut
        );
        dummy.rotation.set(angle, 0, 0);
        dummy.scale.set(chainDiameter, chainLength, chainDiameter);
        dummy.updateMatrix();
        chains.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), dummy.matrix);
      }
      dummy.position.set(
        state.pivotX,
        beamY - chainLength * drop,
        beamZ + chainLength * swingOut
      );
      dummy.rotation.set(angle, 0, 0);
      dummy.scale.set(swing.seatWidth, swing.seatThickness, swing.seatDepth);
      dummy.updateMatrix();
      seats.setMatrixAt(i, dummy.matrix);
    }
    dummy.rotation.set(0, 0, 0);
    chains.instanceMatrix.needsUpdate = true;
    seats.instanceMatrix.needsUpdate = true;
  };
  // At rest before the first frame, so a checkpoint's first render is not a swing mid-air.
  place(0, 0);

  let neon: { set: (morph: number) => void; dispose: () => void } | null = null;
  let neonPending = 0;

  return {
    group,
    update(elapsed, wind) {
      place(elapsed, wind);
    },
    setCyber(morph) {
      neonPending = THREE.MathUtils.clamp(morph, 0, 1);
      if (!neon) {
        if (neonPending <= 0.001) return;
        // Loaded on first use so the neon materials land in the `cyber-style` chunk and
        // the classic city never pays for them.
        void import('./cyber/playgroundNeon').then(({ createPlaygroundNeon }) => {
          neon = createPlaygroundNeon({ metal: [steel, chainMaterial], bed: bedMaterial });
          neon.set(neonPending);
        });
        return;
      }
      neon.set(neonPending);
    },
    dispose() {
      group.removeFromParent();
      neon?.dispose();
      tube.dispose();
      box.dispose();
      for (const material of [steel, chainMaterial, bedMaterial, woodMaterial, sandMaterial]) {
        material.dispose();
      }
    },
  };
}
