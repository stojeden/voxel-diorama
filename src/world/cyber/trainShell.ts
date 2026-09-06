import * as THREE from 'three';
import { mergeStaticMeshes } from '../../performance/mergeStaticMeshes';

/**
 * The Cyberpunk styling layer for the train, in its own module.
 *
 * Split out of `Train.ts` for one measurable reason: the entry chunk has a 244 000 B
 * budget with a few hundred bytes to spare, and this is theme dressing rather than
 * anything the first frame needs. Under `src/world/cyber/` it lands in the `cyber-style`
 * chunk instead, the same way the hybrid fragment and the ambient signals do.
 */

/** The materials this needs from the train's shared set. */
export interface CyberShellMaterials {
  cyberShell: THREE.Material;
  cyberBand: THREE.Material;
  cyberAccent: THREE.Material;
}

/**
 * Fold the shell into one mesh per material.
 *
 * Not a micro-optimisation: `renderer.info.memory.geometries` counts geometry objects, the
 * hybrid world is budgeted at 600, and thirteen boxes per car across four cars plus the
 * bus's strips took the Cyberpunk night to 606. Merging is the repository's own answer to
 * that -- the same helper the cars themselves use -- and it costs nothing here because the
 * shell never animates its parts independently: it is shown or it is not.
 */
function merged(shell: THREE.Group): THREE.Group {
  mergeStaticMeshes(shell);
  return shell;
}

/**
 * The Cyberpunk styling layer for one car, as a sub-group.
 *
 * A sub-group on purpose: `mergeStaticMeshes` folds direct mesh children into one buffer,
 * so anything that has to be switchable has to sit one level down. That is also why the
 * caller adds this after its merge call.
 *
 * Everything stays inside the car's existing envelope. The nose is shaped within the two
 * metres the locomotive already reserves for its nose, and nothing is lengthened: the
 * train has to keep taking the same curves, stopping at the same platforms and fitting the
 * same tunnels, and a longer nose is exactly how that breaks.
 */
export function buildCyberShell(
  mats: CyberShellMaterials,
  options: { length: number; width: number; bodyHeight: number; floorY: number; nose: boolean; bandY: number }
): THREE.Group {
  const { length, width, bodyHeight, floorY, bandY } = options;
  const shell = new THREE.Group();
  shell.name = 'train-cyber-shell';
  shell.visible = false;
  const halfL = length / 2;
  const halfW = width / 2;

  // ── One continuous window band per side, over the discrete panes ──
  const bandLength = length - (options.nose ? 3.2 : 1.0);
  const bandZ = options.nose ? 0.7 : 0;
  for (const side of [-1, 1]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.92, bandLength), mats.cyberBand);
    band.position.set(side * (halfW + 0.07), bandY, bandZ);
    shell.add(band);
    // A thin light line low on the flank: one accent, not a light show.
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, bandLength + 0.4), mats.cyberAccent);
    line.position.set(side * (halfW + 0.06), floorY + 0.22, bandZ);
    shell.add(line);
  }

  // ── Chamfers: the roof edges cut at 45°, which is what softens a box at distance ──
  for (const side of [-1, 1]) {
    const chamfer = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, length - 0.8), mats.cyberShell);
    chamfer.position.set(side * (halfW - 0.16), floorY + bodyHeight - 0.16, 0);
    chamfer.rotation.z = Math.PI / 4;
    chamfer.castShadow = true;
    shell.add(chamfer);
    // ...and a skirt that closes the gap over the bogies, so the car reads as one volume.
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, length - 1.6), mats.cyberShell);
    skirt.position.set(side * (halfW + 0.02), floorY - 0.22, 0);
    shell.add(skirt);
  }
  const roofFairing = new THREE.Mesh(new THREE.BoxGeometry(width - 0.5, 0.3, length - 1.4), mats.cyberShell);
  roofFairing.position.set(0, floorY + bodyHeight + 0.2, 0);
  roofFairing.castShadow = true;
  shell.add(roofFairing);

  if (!options.nose) return merged(shell);

  // ── Aerodynamic nose, inside the reserved two metres ──
  // Five slices that drop and narrow toward the tip: a bullet train reads by its long low
  // profile, and the way to get that here is to lower the front, not to extend it.
  const noseFrontZ = -halfL;
  const slices = 5;
  for (let slice = 0; slice < slices; slice++) {
    const progress = (slice + 0.5) / slices;
    // Front-heavy easing: most of the drop happens in the first half of the nose.
    const drop = Math.sin(progress * Math.PI * 0.5);
    const sliceHeight = bodyHeight * (1 - 0.62 * (1 - drop));
    const sliceWidth = width * (0.72 + 0.28 * drop);
    const sliceLength = 2.0 / slices;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sliceWidth, sliceHeight, sliceLength), mats.cyberShell);
    mesh.position.set(0, floorY + sliceHeight / 2, noseFrontZ + 0.55 + sliceLength * (slice + 0.5));
    mesh.castShadow = true;
    shell.add(mesh);
  }
  // A wrapped screen across the tip, and one light bar under it.
  const screen = new THREE.Mesh(new THREE.BoxGeometry(width * 0.78, 0.6, 0.12), mats.cyberBand);
  screen.position.set(0, floorY + bodyHeight * 0.52, noseFrontZ + 0.52);
  screen.rotation.x = 0.24;
  shell.add(screen);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.62, 0.1, 0.1), mats.cyberAccent);
  bar.position.set(0, floorY + 0.34, noseFrontZ + 0.5);
  shell.add(bar);
  return merged(shell);
}
