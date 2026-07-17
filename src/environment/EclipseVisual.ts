import * as THREE from 'three';
import type { QualityLevel } from '../performance/QualityManager';
import { EclipseGroundEffects } from './EclipseGroundEffects';

export interface EclipseRenderState {
  active: boolean;
  coverage: number;
  separation: number;
  irradiance: number;
  corona: number;
  beads: number;
  stars: number;
  totality: number;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SOLAR_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSeparation;
  uniform float uCorona;
  uniform float uBeads;
  uniform float uTotality;
  uniform float uDetail;
  uniform float uProminences;
  uniform float uProminenceDetail;
  uniform float uTransmittance;

  const float SUN_RADIUS = 0.16;
  const float MOON_RADIUS = 0.163;

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  float prominenceLoop(vec2 p, float angle, float width, float height, float phase) {
    vec2 normal = vec2(cos(angle), sin(angle));
    vec2 tangent = vec2(-normal.y, normal.x);
    float radial = dot(p, normal) - SUN_RADIUS;
    float lateral = dot(p, tangent);
    float breathing = 1.0 + 0.035 * sin(uTime * 0.16 + phase);
    vec2 loopSpace = vec2(
      lateral / width,
      (radial - height * 0.34) / (height * breathing)
    );
    float ridge = exp(-pow((length(loopSpace) - 0.54) * 21.0, 2.0));
    float outsideLimb = smoothstep(-0.003, 0.006, radial);
    float localFade = 1.0 - smoothstep(width * 0.72, width, abs(lateral));
    return ridge * outsideLimb * localFade;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float moonOffset = uSeparation * (SUN_RADIUS + MOON_RADIUS);
    vec2 moonCenter = vec2(moonOffset, 0.018 * sin(uSeparation * 2.4));
    float sunDistance = length(p);
    float moonDistance = length(p - moonCenter);
    float sunMask = 1.0 - smoothstep(SUN_RADIUS - 0.005, SUN_RADIUS + 0.005, sunDistance);
    float moonMask = 1.0 - smoothstep(MOON_RADIUS - 0.003, MOON_RADIUS + 0.003, moonDistance);
    float visibleSun = sunMask * (1.0 - moonMask);

    float limb = sqrt(clamp(1.0 - pow(sunDistance / SUN_RADIUS, 2.0), 0.0, 1.0));
    vec3 sunColor = mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.9, 0.46), limb);
    vec3 color = sunColor * visibleSun * (0.9 + limb * 0.32);
    float alpha = visibleSun;

    float angle = atan(p.y, p.x);
    float radial = max(0.0, sunDistance - SUN_RADIUS);
    float coarseRays = 0.5 + 0.5 * sin(angle * 11.0 + sin(angle * 3.0) * 2.4);
    float fineRays = 0.5 + 0.5 * sin(angle * 37.0 - uTime * 0.11);
    float rayLength = mix(0.24, 0.46, coarseRays) * mix(0.72, 1.0, fineRays * uDetail);
    float coronaBody = exp(-radial * 17.0) * smoothstep(SUN_RADIUS - 0.01, SUN_RADIUS + 0.012, sunDistance);
    float rayContrast = 0.16 + pow(coarseRays, 1.7) * 0.84;
    float streamers = exp(-radial / max(rayLength, 0.01) * 3.7) * rayContrast;
    float outerFade = 1.0 - smoothstep(0.5, 0.68, sunDistance);
    float corona = max(coronaBody * 0.82, streamers * 1.22) * outerFade * uCorona;
    vec3 coronaColor = mix(vec3(0.52, 0.67, 1.0), vec3(1.0, 0.88, 0.64), coarseRays);
    color += coronaColor * corona * (1.3 + uTotality * 1.9);
    alpha = max(alpha, corona * 0.82);

    float chromosphere =
      exp(-pow((sunDistance - SUN_RADIUS) * 260.0, 2.0)) * uTotality;
    color += vec3(1.5, 0.12, 0.035) * chromosphere * 1.7;
    alpha = max(alpha, chromosphere);

    float prominence = prominenceLoop(p, 2.48, 0.052, 0.050, 0.3);
    prominence += prominenceLoop(p, -0.43, 0.044, 0.038, 2.1) *
      smoothstep(0.28, 0.58, uProminenceDetail);
    prominence += prominenceLoop(p, 0.92, 0.034, 0.030, 4.4) *
      smoothstep(0.7, 0.96, uProminenceDetail);
    prominence *= uProminences;
    vec3 prominenceColor = mix(
      vec3(1.45, 0.075, 0.018),
      vec3(2.15, 0.32, 0.045),
      clamp(prominence, 0.0, 1.0)
    );
    color += prominenceColor * prominence * 1.45;
    alpha = max(alpha, prominence * 0.92);

    float edgeContact = exp(-pow((moonDistance - MOON_RADIUS) * 260.0, 2.0));
    float solarEdge = exp(-pow((sunDistance - SUN_RADIUS) * 210.0, 2.0));
    float beadCells = step(0.69, hash(floor((angle + 3.14159265) * 15.0)));
    float beads = edgeContact * solarEdge * beadCells * uBeads;
    color += vec3(2.4, 1.75, 0.82) * beads * 5.0;
    alpha = max(alpha, beads);

    float contactSide = uSeparation >= 0.0 ? -1.0 : 1.0;
    vec2 diamondCenter = vec2(contactSide * SUN_RADIUS, 0.0);
    vec2 diamondDelta = p - diamondCenter;
    float diamondCore = exp(-dot(diamondDelta, diamondDelta) * 190.0);
    float diamondHorizontal = exp(-abs(diamondDelta.y) * 82.0 - abs(diamondDelta.x) * 11.0);
    float diamondVertical = exp(-abs(diamondDelta.x) * 82.0 - abs(diamondDelta.y) * 11.0);
    float diamond = (diamondCore + (diamondHorizontal + diamondVertical) * 0.42) * uBeads;
    color += vec3(4.5, 3.5, 1.8) * diamond * 9.0;
    alpha = max(alpha, clamp(diamond, 0.0, 1.0));

    color *= uTransmittance;
    alpha *= mix(0.16, 1.0, uTransmittance);
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

const MOON_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uSeparation;
  uniform float uCoverage;
  uniform float uTotality;
  uniform float uTransmittance;

  const float SUN_RADIUS = 0.16;
  const float MOON_RADIUS = 0.163;

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float moonOffset = uSeparation * (SUN_RADIUS + MOON_RADIUS);
    vec2 moonCenter = vec2(moonOffset, 0.018 * sin(uSeparation * 2.4));
    float d = length(p - moonCenter);
    float moonMask = 1.0 - smoothstep(MOON_RADIUS - 0.003, MOON_RADIUS + 0.003, d);
    float sunMask = 1.0 - smoothstep(SUN_RADIUS - 0.003, SUN_RADIUS + 0.003, length(p));
    float mask = moonMask * max(sunMask, uTotality);
    if (mask < 0.002) discard;

    float rim = smoothstep(MOON_RADIUS * 0.62, MOON_RADIUS, d);
    vec3 earthshine = mix(vec3(0.003, 0.004, 0.008), vec3(0.015, 0.02, 0.034), rim);
    float visibility = smoothstep(0.0, 0.055, uCoverage);
    gl_FragColor = vec4(
      earthshine * (0.5 + uTotality * 0.8) * uTransmittance,
      mask * visibility * mix(0.35, 1.0, uTransmittance)
    );
  }
`;

/**
 * Camera-relative solar billboard. Its angular size remains stable while the
 * user dollies away from the city, but normal depth testing still allows the
 * skyline to occlude a low Sun.
 */
export class EclipseVisual {
  private readonly geometry = new THREE.PlaneGeometry(120, 120);
  private readonly solarMaterial: THREE.ShaderMaterial;
  private readonly moonMaterial: THREE.ShaderMaterial;
  private readonly solarMesh: THREE.Mesh;
  private readonly moonMesh: THREE.Mesh;
  private readonly anchor = new THREE.Group();
  private readonly groundEffects: EclipseGroundEffects;
  private readonly tmpPosition = new THREE.Vector3();
  private elapsed = 0;

  constructor(scene: THREE.Scene) {
    this.solarMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSeparation: { value: 1.25 },
        uCorona: { value: 0 },
        uBeads: { value: 0 },
        uTotality: { value: 0 },
        uDetail: { value: 1 },
        uProminences: { value: 0 },
        uProminenceDetail: { value: 1 },
        uTransmittance: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: SOLAR_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      fog: false,
      toneMapped: false,
    });
    this.moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSeparation: { value: 1.25 },
        uCoverage: { value: 0 },
        uTotality: { value: 0 },
        uTransmittance: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: MOON_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });

    this.solarMesh = new THREE.Mesh(this.geometry, this.solarMaterial);
    this.moonMesh = new THREE.Mesh(this.geometry, this.moonMaterial);
    this.anchor.name = 'eclipse-celestial-anchor';
    this.solarMesh.name = 'eclipse-solar-layer';
    this.moonMesh.name = 'eclipse-moon-layer';
    this.solarMesh.renderOrder = -20;
    this.moonMesh.renderOrder = -19;
    this.anchor.add(this.solarMesh, this.moonMesh);
    this.anchor.visible = false;
    this.anchor.frustumCulled = false;
    this.solarMesh.frustumCulled = false;
    this.moonMesh.frustumCulled = false;
    scene.add(this.anchor);
    this.groundEffects = new EclipseGroundEffects(scene);
  }

  setQuality(level: QualityLevel): void {
    this.solarMaterial.uniforms.uDetail.value = level === 'low' ? 0 : level === 'medium' ? 0.55 : 1;
    this.groundEffects.setQuality(level);
  }

  update(
    camera: THREE.Camera | null,
    sunDirection: THREE.Vector3,
    state: EclipseRenderState,
    dt: number,
    cloudCover: number
  ): void {
    this.elapsed += Math.max(0, dt);
    const phenomena = this.groundEffects.update(camera, state, dt, cloudCover);
    this.anchor.visible = state.active && camera !== null;
    if (!this.anchor.visible || !camera) return;

    this.tmpPosition.copy(sunDirection).multiplyScalar(680).add(camera.position);
    this.anchor.position.copy(this.tmpPosition);
    this.anchor.lookAt(camera.position);

    this.solarMaterial.uniforms.uTime.value = this.elapsed;
    this.solarMaterial.uniforms.uSeparation.value = state.separation;
    this.solarMaterial.uniforms.uCorona.value = state.corona;
    this.solarMaterial.uniforms.uBeads.value = state.beads;
    this.solarMaterial.uniforms.uTotality.value = state.totality;
    this.solarMaterial.uniforms.uProminences.value = phenomena.prominences;
    this.solarMaterial.uniforms.uProminenceDetail.value = phenomena.prominenceDetail;
    this.moonMaterial.uniforms.uSeparation.value = state.separation;
    this.moonMaterial.uniforms.uCoverage.value = state.coverage;
    this.moonMaterial.uniforms.uTotality.value = state.totality;
    const transmittance = THREE.MathUtils.clamp(1 - cloudCover * 0.82, 0.08, 1);
    this.solarMaterial.uniforms.uTransmittance.value = transmittance;
    this.moonMaterial.uniforms.uTransmittance.value = transmittance;
  }

  getBloomObjects(): THREE.Object3D[] {
    return [this.solarMesh];
  }

  getOcclusionExclusions(): THREE.Object3D[] {
    return [
      this.solarMesh,
      this.moonMesh,
      ...this.groundEffects.getOcclusionExclusions(),
    ];
  }

  dispose(): void {
    this.anchor.removeFromParent();
    this.groundEffects.dispose();
    this.geometry.dispose();
    this.solarMaterial.dispose();
    this.moonMaterial.dispose();
  }
}
