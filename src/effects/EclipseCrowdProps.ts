import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { EclipseWorldReactionState } from '../experience/EclipseWorldReaction';
import type { EclipsePassengerPose } from '../world/PassengerCrowd';
import type { QualityLevel } from '../performance/QualityManager';

/**
 * Below this a prop is not drawn at all — the strength under which an instanced mesh is
 * switched off rather than faded.
 *
 * Exported because it is the floor the eye-protection window has to clear at the two diamond
 * rings: `eyeProtection` was 0.070 at both bead peaks under the old (0.08, 0.72) window, over
 * this gate by four hundredths, so the glasses were drawn at seven percent opacity at the two
 * frames the one eclipse-safety rule calls mandatory. A test that names this number rather
 * than a literal cannot go quietly stale if the gate ever moves.
 */
export const PROP_VISIBILITY_GATE = 0.03;

function buildGlassesGeometry(): THREE.BufferGeometry {
  const left = new THREE.BoxGeometry(0.28, 0.17, 0.065).translate(-0.18, 0, 0);
  const right = new THREE.BoxGeometry(0.28, 0.17, 0.065).translate(0.18, 0, 0);
  const bridge = new THREE.BoxGeometry(0.12, 0.045, 0.05);
  const geometry = mergeGeometries([left, right, bridge], false);
  left.dispose();
  right.dispose();
  bridge.dispose();
  if (!geometry) throw new Error('Failed to build eclipse glasses geometry');
  return geometry;
}

function groupOpacity(group: THREE.Object3D): number {
  let opacity = 1;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (material && 'opacity' in material) opacity = Math.min(opacity, material.opacity);
  });
  return opacity;
}

function isWorldVisible(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export class EclipseCrowdProps {
  private readonly scene: THREE.Scene;
  private readonly glassesCandidates: THREE.Object3D[] = [];
  private readonly cardCandidates: THREE.Group[] = [];
  private readonly glassesGeometry = buildGlassesGeometry();
  private readonly cardGeometry = new THREE.PlaneGeometry(0.56, 0.38);
  private readonly glassesMaterial = new THREE.MeshBasicMaterial({
    color: 0xf0ad42,
    transparent: true,
    toneMapped: false,
  });
  private readonly cardMaterial: THREE.ShaderMaterial;
  private readonly glasses: THREE.InstancedMesh;
  private readonly cards: THREE.InstancedMesh;
  private readonly localGlasses = new THREE.Matrix4().makeTranslation(0, 0, 0.33);
  /**
   * The card is held in FRONT of the figure, not behind it.
   *
   * It was at local -0.72 z -- 0.51 m behind the back, on the side opposite both the face
   * and the two raised arms, which swing to +Z. That was invisible while every figure faced
   * an arbitrary direction; now that a projection user turns their back to the sun on
   * purpose, a card behind them is a card in the sun's own shadow, which is the one place a
   * pinhole image cannot fall. +0.62 puts it just past the hands at their -1.18 rad reach.
   */
  private readonly localCard = new THREE.Matrix4()
    .makeRotationX(-Math.PI / 2)
    .premultiply(new THREE.Matrix4().makeTranslation(0, 1.46, 0.62));
  private readonly instanceMatrix = new THREE.Matrix4();
  private density = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const passengers: THREE.Group[] = [];
    scene.traverse((object) => {
      if (
        object instanceof THREE.Group &&
        (object.name.startsWith('station-passenger-') || object.name.startsWith('bus-passenger-'))
      ) {
        passengers.push(object);
      }
    });
    passengers.sort((a, b) => a.name.localeCompare(b.name));
    /**
     * Who holds a card is read off the figure, not derived a second time.
     *
     * This used to be `index % 3 === 1` over the name-sorted global list above, while the
     * pose came from `eclipsePassengerPoseFor(i)` over a per-stop index. Two derivations of
     * one fact, and they agree only at the first stop: with four figures to a bus stop the
     * second stop's global 4..7 map to per-stop 0..3, so the global rule picked per-stop 0
     * and 3 -- both posed as glasses wearers. The result was cards hovering on figures
     * wearing glasses and figures holding both arms up with nothing between them.
     */
    for (const passenger of passengers) {
      const pose = passenger.userData.eclipsePose as EclipsePassengerPose | undefined;
      if (pose === 'projection') {
        this.cardCandidates.push(passenger);
      } else {
        this.glassesCandidates.push(passenger.getObjectByName('passenger-head') ?? passenger);
      }
    }

    /**
     * The pinhole card a figure holds up, with the crescent projected on it.
     *
     * `uSeparation` offsets the little moon along the CARD's own u axis, which has no relation
     * to the chord the moon crosses the sky on: the card is a quad held at whatever angle its
     * instance matrix gives it, and a pinhole image is inverted into the bargain. Aligning the
     * two would mean modelling the card's orientation, for a prop a few pixels across on a
     * figure thirteen pixels tall. Left alone deliberately, and named here rather than left to
     * be discovered -- the ground crescents in `EclipseGroundEffects` take their side the same
     * way, for the same reason.
     *
     * In a docblock rather than in the shader string because a comment inside a template
     * literal is SHIPPED: the first draft of this note cost 575 bytes of the entry chunk,
     * against a budget with 2.9 kB of headroom left.
     */
    this.cardMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSeparation: { value: 1 },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uSeparation;
        uniform float uOpacity;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(1.5, 1.0);
          float sun = 1.0 - smoothstep(0.23, 0.25, length(p));
          vec2 moonCenter = vec2(uSeparation * 0.3, 0.0);
          float moon = 1.0 - smoothstep(0.23, 0.25, length(p - moonCenter));
          float crescent = sun * (1.0 - moon);
          vec3 paper = vec3(0.78, 0.72, 0.58);
          vec3 lightMark = vec3(1.0, 0.78, 0.28) * crescent * 1.8;
          gl_FragColor = vec4(paper + lightMark, uOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
    });

    this.glasses = new THREE.InstancedMesh(
      this.glassesGeometry,
      this.glassesMaterial,
      Math.max(1, this.glassesCandidates.length)
    );
    this.cards = new THREE.InstancedMesh(
      this.cardGeometry,
      this.cardMaterial,
      Math.max(1, this.cardCandidates.length)
    );
    this.glasses.name = 'eclipse-crowd-glasses';
    this.cards.name = 'eclipse-crowd-projection-cards';
    this.glasses.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glasses.frustumCulled = false;
    this.cards.frustumCulled = false;
    this.glasses.visible = false;
    this.cards.visible = false;
    scene.add(this.glasses, this.cards);
  }

  setQuality(level: QualityLevel): void {
    this.density = level === 'low' ? 0.4 : level === 'medium' ? 0.7 : 1;
  }

  update(reaction: EclipseWorldReactionState, separation: number): void {
    this.glassesMaterial.opacity = reaction.eyeProtection;
    this.cardMaterial.uniforms.uOpacity.value = reaction.projection;
    this.cardMaterial.uniforms.uSeparation.value = THREE.MathUtils.clamp(separation, -1, 1);
    this.glasses.count = this.updateInstances(
      this.glassesCandidates,
      this.localGlasses,
      reaction.eyeProtection
    );
    this.cards.count = this.updateInstances(
      this.cardCandidates,
      this.localCard,
      reaction.projection
    );
    this.glasses.visible = this.glasses.count > 0 && reaction.eyeProtection > PROP_VISIBILITY_GATE;
    this.cards.visible = this.cards.count > 0 && reaction.projection > PROP_VISIBILITY_GATE;
    if (this.glasses.visible) this.glasses.instanceMatrix.needsUpdate = true;
    if (this.cards.visible) this.cards.instanceMatrix.needsUpdate = true;
  }

  private updateInstances(
    candidates: readonly THREE.Object3D[],
    localTransform: THREE.Matrix4,
    strength: number
  ): number {
    if (strength <= PROP_VISIBILITY_GATE) return 0;
    /**
     * The density budget caps how many props are DRAWN, not how far down the list we look.
     *
     * It used to bound the loop index, so every candidate that was skipped for being faded
     * out or off-screen burned one of the budgeted slots and the visible figures further
     * down the list got nothing. The candidate order makes that systematic rather than
     * unlucky: the name sort puts all twenty bus-stop figures ahead of the twelve station
     * ones, and a bus-stop figure is invisible whenever it is riding the bus -- so the
     * reliably-visible station crowd sat past the cap and went bare-eyed. Same ceiling,
     * same instance capacity, same single draw call; it just fills.
     */
    const limit = Math.ceil(candidates.length * this.density);
    let count = 0;
    for (let index = 0; index < candidates.length && count < limit; index++) {
      const passenger = candidates[index];
      if (!isWorldVisible(passenger) || groupOpacity(passenger) < 0.15) continue;
      passenger.updateWorldMatrix(true, false);
      this.instanceMatrix.multiplyMatrices(passenger.matrixWorld, localTransform);
      if (localTransform === this.localCard) {
        const lift = 0.06 * Math.sin(index * 2.17);
        this.instanceMatrix.elements[13] += lift;
      }
      const mesh = localTransform === this.localCard ? this.cards : this.glasses;
      mesh.setMatrixAt(count, this.instanceMatrix);
      count += 1;
    }
    return count;
  }

  getDebugState(): { glasses: number; projectionCards: number } {
    return { glasses: this.glasses.count, projectionCards: this.cards.count };
  }

  dispose(): void {
    this.scene.remove(this.glasses, this.cards);
    this.glassesGeometry.dispose();
    this.cardGeometry.dispose();
    this.glassesMaterial.dispose();
    this.cardMaterial.dispose();
  }
}
