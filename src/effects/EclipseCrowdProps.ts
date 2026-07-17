import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { EclipseWorldReactionState } from '../experience/EclipseWorldReaction';
import type { QualityLevel } from '../performance/QualityManager';

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
  private readonly localCard = new THREE.Matrix4()
    .makeRotationX(-Math.PI / 2)
    .premultiply(new THREE.Matrix4().makeTranslation(0, 1.48, -0.72));
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
    for (let index = 0; index < passengers.length; index++) {
      if (index % 3 === 1) {
        this.cardCandidates.push(passengers[index]);
      } else {
        this.glassesCandidates.push(
          passengers[index].getObjectByName('passenger-head') ?? passengers[index]
        );
      }
    }

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
    this.glasses.visible = this.glasses.count > 0 && reaction.eyeProtection > 0.03;
    this.cards.visible = this.cards.count > 0 && reaction.projection > 0.03;
    if (this.glasses.visible) this.glasses.instanceMatrix.needsUpdate = true;
    if (this.cards.visible) this.cards.instanceMatrix.needsUpdate = true;
  }

  private updateInstances(
    candidates: readonly THREE.Object3D[],
    localTransform: THREE.Matrix4,
    strength: number
  ): number {
    if (strength <= 0.03) return 0;
    const limit = Math.ceil(candidates.length * this.density);
    let count = 0;
    for (let index = 0; index < limit; index++) {
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
