import * as THREE from 'three';
import type { QualityLevel } from '../performance/QualityManager';
import { GROUND_SURFACE_Y, TREE_POSITIONS } from '../world/WorldLayout';
import type { EclipseRenderState } from './EclipseVisual';
import { eclipsePhenomenaAt, type EclipsePhenomenaSignals } from './EclipsePhenomena';

const GROUND_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vUv = uv;
    vec3 transformed = position;
    #ifdef USE_INSTANCING
      transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
    #endif
    vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const CRESCENT_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  uniform float uIntensity;
  uniform float uSeparation;
  uniform float uPatternDensity;
  uniform float uTransmittance;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec2 tileUv = vUv * uPatternDensity;
    vec2 cell = floor(tileUv);
    vec2 local = fract(tileUv) - 0.5;
    vec2 seed = cell + floor(vWorldPosition.xz * 0.2);
    local += (vec2(hash(seed), hash(seed + 17.3)) - 0.5) * 0.18;

    float direction = uSeparation < 0.0 ? -1.0 : 1.0;
    float outer = 1.0 - smoothstep(0.16, 0.23, length(local));
    float inner = 1.0 - smoothstep(
      0.145,
      0.215,
      length(local - vec2(direction * 0.105, 0.0))
    );
    float crescent = max(0.0, outer - inner);
    float irregularity = mix(0.48, 1.0, hash(seed + 41.7));
    float edgeFade = smoothstep(0.0, 0.18, vUv.x) *
      smoothstep(0.0, 0.18, vUv.y) *
      smoothstep(0.0, 0.18, 1.0 - vUv.x) *
      smoothstep(0.0, 0.18, 1.0 - vUv.y);
    float alpha = crescent * irregularity * edgeFade * uIntensity * uTransmittance * 0.42;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(vec3(1.0, 0.76, 0.34), alpha);
  }
`;

const BAND_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uTransmittance;

  void main() {
    vec2 direction = normalize(vec2(0.86, 0.51));
    float along = dot(vWorldPosition.xz, direction);
    float across = dot(vWorldPosition.xz, vec2(-direction.y, direction.x));
    float refraction = sin(across * 0.19 + uTime * 0.42) * 1.35;
    float carrier = 0.5 + 0.5 * sin(along * 3.8 + refraction + uTime * 5.2);
    float bands = smoothstep(0.46, 0.76, carrier);
    vec2 centered = (vUv - 0.5) * 2.0;
    float edgeFade = 1.0 - smoothstep(0.72, 1.0, max(abs(centered.x), abs(centered.y)));
    float alpha = bands * edgeFade * uIntensity * uTransmittance * 0.075;
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(vec3(0.002, 0.004, 0.009), alpha);
  }
`;

/**
 * One instanced draw for all tree pinhole patterns and one High-only draw for
 * atmospheric shadow bands. No render targets, textures or per-frame objects.
 */
export class EclipseGroundEffects {
  private readonly group = new THREE.Group();
  private readonly crescentGeometry = new THREE.PlaneGeometry(5.4, 5.4);
  private readonly bandGeometry = new THREE.PlaneGeometry(180, 180);
  private readonly crescentMaterial: THREE.ShaderMaterial;
  private readonly bandMaterial: THREE.ShaderMaterial;
  private readonly crescents: THREE.InstancedMesh;
  private readonly bands: THREE.Mesh;
  private quality: QualityLevel = 'high';
  private elapsed = 0;
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.crescentGeometry.rotateX(-Math.PI / 2);
    this.bandGeometry.rotateX(-Math.PI / 2);

    this.crescentMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uIntensity: { value: 0 },
        uSeparation: { value: -1 },
        uPatternDensity: { value: 8 },
        uTransmittance: { value: 1 },
      },
      vertexShader: GROUND_VERTEX_SHADER,
      fragmentShader: CRESCENT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      toneMapped: false,
    });

    this.bandMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uTransmittance: { value: 1 },
      },
      vertexShader: GROUND_VERTEX_SHADER,
      fragmentShader: BAND_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });

    const orderedTrees = [...TREE_POSITIONS].sort(
      ([ax, az], [bx, bz]) => Math.hypot(ax, az) - Math.hypot(bx, bz)
    );
    this.crescents = new THREE.InstancedMesh(
      this.crescentGeometry,
      this.crescentMaterial,
      orderedTrees.length
    );
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < orderedTrees.length; index++) {
      const [x, z] = orderedTrees[index];
      matrix.makeTranslation(x, GROUND_SURFACE_Y + 0.025, z);
      this.crescents.setMatrixAt(index, matrix);
    }
    this.crescents.instanceMatrix.needsUpdate = true;
    this.crescents.name = 'eclipse-tree-crescents';
    this.crescents.frustumCulled = false;
    this.crescents.visible = false;
    this.crescents.renderOrder = 4;

    this.bands = new THREE.Mesh(this.bandGeometry, this.bandMaterial);
    this.bands.name = 'eclipse-shadow-bands';
    this.bands.frustumCulled = false;
    this.bands.visible = false;
    this.bands.renderOrder = 3;

    this.group.name = 'eclipse-ground-effects';
    this.group.add(this.bands, this.crescents);
    scene.add(this.group);
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
  }

  update(
    camera: THREE.Camera | null,
    state: EclipseRenderState,
    dt: number,
    cloudCover: number
  ): EclipsePhenomenaSignals {
    this.elapsed += Math.max(0, dt);
    const signals = eclipsePhenomenaAt(state, this.quality);
    const cloudTransmittance = Math.pow(THREE.MathUtils.clamp(1 - cloudCover, 0, 1), 2);

    this.crescents.count = Math.min(signals.crescentInstances, TREE_POSITIONS.length);
    this.crescents.visible = signals.groundCrescents * cloudTransmittance > 0.002;
    this.crescentMaterial.uniforms.uIntensity.value = signals.groundCrescents;
    this.crescentMaterial.uniforms.uSeparation.value = state.separation;
    this.crescentMaterial.uniforms.uPatternDensity.value = signals.crescentPatternDensity;
    this.crescentMaterial.uniforms.uTransmittance.value = cloudTransmittance;

    this.bands.visible =
      camera !== null && signals.shadowBands * cloudTransmittance > 0.002;
    if (camera) {
      this.bands.position.set(camera.position.x, GROUND_SURFACE_Y + 0.035, camera.position.z);
    }
    this.bandMaterial.uniforms.uTime.value = this.elapsed;
    this.bandMaterial.uniforms.uIntensity.value = signals.shadowBands;
    this.bandMaterial.uniforms.uTransmittance.value = cloudTransmittance;

    this.group.visible = this.crescents.visible || this.bands.visible;
    return signals;
  }

  getOcclusionExclusions(): THREE.Object3D[] {
    return [this.crescents, this.bands];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.crescentGeometry.dispose();
    this.bandGeometry.dispose();
    this.crescentMaterial.dispose();
    this.bandMaterial.dispose();
    this.crescents.dispose();
  }
}
