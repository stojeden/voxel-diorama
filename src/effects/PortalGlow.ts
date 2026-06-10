import * as THREE from 'three';
import { TUNNEL_LENGTH, WORLD_HALF_SIZE } from '../world/WorldLayout';

/**
 * "Quantum portal" dressing for the two tunnel mouths: a softly swirling
 * energy ring + a handful of orbiting spark voxels. The effect breathes
 * gently all the time and PULSES when the train is close — selling the idea
 * that the two tunnels are entangled ends of the same wormhole.
 */

const MOUTH_X = WORLD_HALF_SIZE - TUNNEL_LENGTH + 1; // inner face of each tunnel
const SPARKS_PER_PORTAL = 14;

interface Portal {
  ring: THREE.Mesh;
  ringMaterial: THREE.ShaderMaterial;
  sparks: THREE.Points;
  sparkPhases: Float32Array;
  sparkGeometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  pulse: number;
}

function buildRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uPulse;
      void main() {
        float swirl = 0.6 + 0.4 * sin(vUv.x * 28.0 - uTime * (2.0 + uPulse * 7.0));
        vec3 base = mix(vec3(0.25, 0.55, 1.0), vec3(0.75, 0.35, 1.0), 0.5 + 0.5 * sin(uTime * 0.7 + vUv.x * 6.283));
        float strength = 0.35 + uPulse * 1.4;
        gl_FragColor = vec4(base * swirl * strength, swirl * (0.35 + uPulse * 0.6));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export class PortalGlow {
  private readonly portals: Portal[] = [];
  private readonly ringGeometry: THREE.TorusGeometry;
  private readonly sparkMaterial: THREE.PointsMaterial;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ringGeometry = new THREE.TorusGeometry(3.5, 0.15, 8, 48);
    this.sparkMaterial = new THREE.PointsMaterial({
      color: 0x9fc4ff,
      size: 0.35,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    for (const side of [-1, 1] as const) {
      // Slightly on the city side of the mouth so the ring reads clearly.
      const center = new THREE.Vector3(side * (MOUTH_X - 0.7), 2.6, 0);
      const ringMaterial = buildRingMaterial();
      const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
      ring.position.copy(center);
      ring.rotation.y = Math.PI / 2; // stand in the YZ plane, axis along X
      scene.add(ring);

      const sparkPositions = new Float32Array(SPARKS_PER_PORTAL * 3);
      const sparkPhases = new Float32Array(SPARKS_PER_PORTAL);
      for (let i = 0; i < SPARKS_PER_PORTAL; i++) {
        sparkPhases[i] = Math.random() * Math.PI * 2;
      }
      const sparkGeometry = new THREE.BufferGeometry();
      sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
      const sparks = new THREE.Points(sparkGeometry, this.sparkMaterial);
      sparks.frustumCulled = false;
      scene.add(sparks);

      this.portals.push({ ring, ringMaterial, sparks, sparkPhases, sparkGeometry, center, pulse: 0 });
    }
  }

  update(elapsed: number, delta: number, trainPosition: THREE.Vector3): void {
    for (const portal of this.portals) {
      const dist = portal.center.distanceTo(trainPosition);
      const targetPulse = Math.max(0, 1 - dist / 22);
      portal.pulse += (targetPulse - portal.pulse) * Math.min(1, delta * 4);

      portal.ringMaterial.uniforms.uTime.value = elapsed;
      portal.ringMaterial.uniforms.uPulse.value = portal.pulse;
      const scale = 1 + portal.pulse * 0.12 + Math.sin(elapsed * 2.2) * 0.015;
      portal.ring.scale.setScalar(scale);

      const positions = portal.sparkGeometry.attributes.position as THREE.BufferAttribute;
      const arr = positions.array as Float32Array;
      for (let i = 0; i < SPARKS_PER_PORTAL; i++) {
        const angle = elapsed * (0.8 + portal.pulse * 2.5) + portal.sparkPhases[i];
        const radius = 3.1 + Math.sin(elapsed * 1.7 + portal.sparkPhases[i] * 3) * 0.5;
        arr[i * 3] = portal.center.x + Math.sin(elapsed * 0.9 + portal.sparkPhases[i]) * 0.4;
        arr[i * 3 + 1] = portal.center.y + Math.sin(angle) * radius;
        arr[i * 3 + 2] = portal.center.z + Math.cos(angle) * radius;
      }
      positions.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const portal of this.portals) {
      this.scene.remove(portal.ring, portal.sparks);
      portal.ringMaterial.dispose();
      portal.sparkGeometry.dispose();
    }
    this.ringGeometry.dispose();
    this.sparkMaterial.dispose();
  }
}
