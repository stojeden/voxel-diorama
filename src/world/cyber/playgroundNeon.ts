import * as THREE from 'three';

/**
 * The Cyberpunk dressing for the playground: lit tube edges and a glowing slide.
 *
 * In its own module for the same measurable reason as the train's shell and the bus's road
 * mark: the entry chunk has a 244 000 B budget with a few hundred bytes to spare, and this
 * is theme dressing that the first frame never needs. Under `src/world/cyber/` it lands in
 * the `cyber-style` chunk, and the playground imports it only when the morph first moves
 * off zero -- a classic city never loads it at all.
 *
 * It adds no geometry and no meshes. The frame, the chains and the slide are the same
 * objects in both styles; what changes is how much light they emit. That is what keeps this
 * off the geometry budget entirely, and it is also the honest description of the effect:
 * the equipment is lit, not replaced.
 */

/** Cyan for metal, the same family as the bus's under-sill mark. */
const TUBE_GLOW = 0x2ad4ff;
/** Magenta for the slide bed, so the two read apart at night. */
const BED_GLOW = 0xff3fa4;

export interface PlaygroundNeonTargets {
  /** Frame tubes and chains: a cool edge glow. */
  metal: THREE.MeshStandardMaterial[];
  /** The slide bed, which becomes the brightest thing on the plot. */
  bed: THREE.MeshStandardMaterial;
}

export interface PlaygroundNeonHandle {
  /** 0..1 morph. At 0 every material is exactly what it was before this ran. */
  set(morph: number): void;
  dispose(): void;
}

export function createPlaygroundNeon(targets: PlaygroundNeonTargets): PlaygroundNeonHandle {
  // Remembered so a morph back to zero restores the classic look rather than an
  // approximation of it. Materials are shared with the classic city; leaving them lit
  // would light the playground in a style it does not belong to.
  const original = new Map<
    THREE.MeshStandardMaterial,
    { emissive: number; intensity: number }
  >();
  const remember = (material: THREE.MeshStandardMaterial) => {
    if (!original.has(material)) {
      original.set(material, {
        emissive: material.emissive.getHex(),
        intensity: material.emissiveIntensity,
      });
    }
  };
  for (const material of targets.metal) remember(material);
  remember(targets.bed);

  const restore = (material: THREE.MeshStandardMaterial) => {
    const was = original.get(material);
    if (!was) return;
    material.emissive.setHex(was.emissive);
    material.emissiveIntensity = was.intensity;
  };

  return {
    set(morph) {
      const factor = THREE.MathUtils.clamp(morph, 0, 1);
      if (factor <= 0.001) {
        for (const material of targets.metal) restore(material);
        restore(targets.bed);
        return;
      }
      for (const material of targets.metal) {
        material.emissive.setHex(TUBE_GLOW);
        // Weak on purpose: thin tubes at this scale are a line of light, and a line of
        // light at full intensity is a white streak that swallows its own shape.
        material.emissiveIntensity = 0.35 * factor;
      }
      targets.bed.emissive.setHex(BED_GLOW);
      targets.bed.emissiveIntensity = 0.55 * factor;
    },
    dispose() {
      for (const material of targets.metal) restore(material);
      restore(targets.bed);
      original.clear();
    },
  };
}
