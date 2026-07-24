import * as THREE from 'three';
import type { QualityProfile } from '../performance/QualityManager';
import { fallbackRandom, type RandomSource } from '../core/Random';
import { EclipseVisual, type EclipseRenderState } from './EclipseVisual';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  residentialWindowActivityAt,
  residentialWindowAverageAt,
  type ScheduledWindowMaterial,
} from './CityRhythm';
import {
  clamp01,
  directSunFactorAt,
  goldenFactorAt,
  nightFactorAt,
  skyColorAt,
  sunColorAt,
  sunDirectionAt,
  sunElevationAt,
} from './sky';

/**
 * Full day/night lighting rig:
 *  - physically-inspired atmosphere (three.js Sky — Rayleigh/Mie scattering,
 *    which is what makes the sunrise & golden hour actually glow),
 *  - sun + moon directional lights, ambient & hemisphere fill,
 *  - moon with real phases (shader-lit crescent),
 *  - star field, occasional shooting stars, optional aurora,
 *  - throttled PMREM environment map so glass/windows pick up real
 *    sky reflections as the light changes.
 */

export interface DayLightState {
  night: number;
  golden: number;
  sunElevation: number;
  /** 0..1 direct solar transmission after cloud/theme/eclipse attenuation. */
  directSun: number;
  /** 0..1 — current solar-eclipse strength (0 = no eclipse). */
  eclipse: number;
}

export interface DayNightHooks {
  streetLights: THREE.PointLight[];
  streetGlowMesh: THREE.InstancedMesh;
  streetGlowMaterial: THREE.ShaderMaterial;
  busStopLights: THREE.PointLight[];
  busStopGlowMaterials: THREE.MeshStandardMaterial[];
  stationLights: THREE.PointLight[];
  stationGlowMaterials: THREE.MeshStandardMaterial[];
  stationGlowMesh: THREE.InstancedMesh;
  stationGlowMaterial: THREE.ShaderMaterial;
  windowLights: THREE.PointLight[];
  /** Residential window groups controlled by the simulated city clock. */
  windowGlowMaterials: ScheduledWindowMaterial[];
}

const STAR_COUNT = 700;
const SHOOTING_STAR_POOL = 3;
const ENVIRONMENT_INTENSITY = 0.42;
const ENVIRONMENT_TRANSITION_SECONDS = 1.8;
const ENVIRONMENT_BLEND_CACHE_KEY = 'pmrem-crossfade-v1';

const ENVIRONMENT_BLEND_UNIFORMS = /* glsl */ `
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    uniform sampler2D environmentMapNext;
    uniform float environmentMapBlend;
  #endif
`;

function blendedEnvironmentShaderChunk(): string {
  const irradianceSample =
    'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );';
  const radianceSample =
    'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );';
  let chunk = THREE.ShaderChunk.envmap_physical_pars_fragment;

  if (!chunk.includes(irradianceSample) || !chunk.includes(radianceSample)) {
    throw new Error('Three.js environment shader changed; PMREM crossfade needs updating');
  }

  chunk = chunk.replace(
    irradianceSample,
    /* glsl */ `
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
      if ( environmentMapBlend > 0.0001 ) {
        vec4 nextEnvironmentColor = textureCubeUV(
          environmentMapNext,
          envMapRotation * worldNormal,
          1.0
        );
        envMapColor = mix( envMapColor, nextEnvironmentColor, environmentMapBlend );
      }
    `
  );
  return chunk.replace(
    radianceSample,
    /* glsl */ `
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
      if ( environmentMapBlend > 0.0001 ) {
        vec4 nextEnvironmentColor = textureCubeUV(
          environmentMapNext,
          envMapRotation * reflectVec,
          roughness
        );
        envMapColor = mix( envMapColor, nextEnvironmentColor, environmentMapBlend );
      }
    `
  );
}

const BLENDED_ENVIRONMENT_SHADER_CHUNK = blendedEnvironmentShaderChunk();

export function environmentTransitionAt(progress: number): {
  blend: number;
  intensity: number;
} {
  const clamped = clamp01(progress);
  return {
    blend: clamped * clamped * (3 - 2 * clamped),
    intensity: ENVIRONMENT_INTENSITY,
  };
}

interface ShootingStar {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

function buildMoonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPhaseAngle: { value: Math.PI }, // π = full moon
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      uniform float uPhaseAngle;
      uniform float uOpacity;
      void main() {
        // Phase light direction in VIEW space, so the crescent always faces
        // the camera the right way round.
        vec3 lightDir = normalize(vec3(sin(uPhaseAngle), 0.12, -cos(uPhaseAngle)));
        float lit = smoothstep(-0.08, 0.18, dot(vNormal, lightDir));
        vec3 bright = vec3(0.92, 0.93, 0.88);
        vec3 dark = vec3(0.055, 0.06, 0.085);
        gl_FragColor = vec4(mix(dark, bright, lit), uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

function buildAuroraMaterial(phaseOffset: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uPhase: { value: phaseOffset },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uPhase;
      void main() {
        vUv = uv;
        vec3 p = position;
        // Bend the curtain into an arc and let it drift like fabric.
        float arc = uv.x - 0.5;
        p.z -= arc * arc * 90.0;
        p.y += sin(uv.x * 6.0 + uTime * 0.35 + uPhase) * 2.6
             + sin(uv.x * 13.0 - uTime * 0.21 + uPhase * 2.0) * 1.3;
        p.z += sin(uv.x * 3.5 - uTime * 0.26 + uPhase) * 4.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uStrength;
      uniform float uPhase;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        // Slowly evolving large-scale structure + finer ray detail.
        float structure = noise(vec2(vUv.x * 5.0 + uPhase, uTime * 0.05));
        float rays = noise(vec2(vUv.x * 32.0 - uTime * 0.06 + uPhase, vUv.y * 2.0));

        float curtain = 0.5 + 0.5 * sin(vUv.x * 36.0 + structure * 11.0 + uTime * 0.45 + uPhase);
        curtain = pow(max(curtain, 0.0), 1.7) * (0.55 + 0.45 * rays);

        // Feather EVERY edge so the quad never reads as a rectangle.
        float vertical = smoothstep(0.02, 0.3, vUv.y) * (1.0 - smoothstep(0.4, 0.96, vUv.y));
        float horizontal = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
        // Ragged lower hem driven by noise.
        float hem = smoothstep(0.0, 0.16 + 0.2 * structure, vUv.y);

        vec3 green = vec3(0.16, 0.9, 0.42);
        vec3 teal = vec3(0.1, 0.7, 0.65);
        vec3 violet = vec3(0.5, 0.25, 0.85);
        vec3 color = mix(mix(green, teal, structure), violet, clamp(vUv.y * 1.5 - 0.15, 0.0, 1.0));

        float alpha = curtain * vertical * horizontal * hem * uStrength * 0.42;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export class DayNightCycle {
  private readonly random: RandomSource;
  private readonly eventRandom: RandomSource;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hooks: DayNightHooks;

  private readonly sky: Sky;
  private readonly envSky: Sky;
  private readonly envScene: THREE.Scene;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envPendingTarget: THREE.WebGLRenderTarget | null = null;
  private envTransitionProgress = 1;
  private envTransitionActive = false;
  private readonly envNextMapUniform: THREE.IUniform<THREE.Texture | null> = { value: null };
  private readonly envBlendUniform: THREE.IUniform<number> = { value: 0 };
  private envLastElevation = Number.POSITIVE_INFINITY;
  private envLastCloud = -1;
  private envCooldown = 0;
  private envInterval = 0.7;
  private shadowsEnabled = true;
  private shadowMapSize = 2048;
  private appliedShadowMapSize = 2048;
  private streetLightBudget = Number.POSITIVE_INFINITY;
  private busStopLightBudget = Number.POSITIVE_INFINITY;
  private stationLightBudget = Number.POSITIVE_INFINITY;
  private windowLightBudget = Number.POSITIVE_INFINITY;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly ambientLight: THREE.AmbientLight;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly moonMesh: THREE.Mesh;
  private readonly moonMaterial: THREE.ShaderMaterial;
  private readonly starField: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly auroraMeshes: THREE.Mesh[] = [];
  private readonly auroraMaterials: THREE.ShaderMaterial[] = [];
  private auroraTarget = 0;
  private auroraStrength = 0;

  private readonly shootingStars: ShootingStar[] = [];
  private elapsed = 0;
  private moonIllumination = 1;

  // ── Solar eclipse ──
  private eclipseState: EclipseRenderState = {
    active: false,
    coverage: 0,
    separation: 1.25,
    irradiance: 1,
    corona: 0,
    beads: 0,
    stars: 0,
    totality: 0,
  };
  private lightingInitialized = false;
  private smoothedNight = 1;
  private smoothedGolden = 0;
  private smoothedSunStrength = 0;
  private readonly eclipseVisual: EclipseVisual;

  private readonly tmpSunDir = new THREE.Vector3();
  private readonly tmpMoonDir = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpSunColor = new THREE.Color();
  private readonly tmpWhite = new THREE.Color(0xffffff);
  private readonly shadowFocus = new THREE.Vector3();
  private shadowRadius = 95;
  private lightSelectionCooldown = 0;
  private wideView = false;
  private cameraMode: 'free' | 'train' | 'bus' = 'free';

  /** Set by main — the eclipse disc is positioned relative to the camera
   * so it stays optically aligned with the (infinitely far) shader sun. */
  camera: THREE.Camera | null = null;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    hooks: DayNightHooks,
    random = fallbackRandom('day-night-stars'),
    eventRandom = fallbackRandom('shooting-stars')
  ) {
    this.random = random;
    this.eventRandom = eventRandom;
    this.scene = scene;
    this.renderer = renderer;
    this.hooks = hooks;

    // ── Atmosphere ──
    this.sky = new Sky();
    this.sky.scale.setScalar(2000);
    this.installEclipseSkyShader();
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(2000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // ── Lights ──
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -95;
    this.sunLight.shadow.camera.right = 95;
    this.sunLight.shadow.camera.top = 95;
    this.sunLight.shadow.camera.bottom = -95;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 320;
    this.sunLight.shadow.bias = -0.0008;
    this.sunLight.shadow.normalBias = 0.05;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x7d92c9, 0);
    scene.add(this.moonLight);

    this.ambientLight = new THREE.AmbientLight(0x404060, 0.3);
    scene.add(this.ambientLight);

    this.hemisphereLight = new THREE.HemisphereLight(0x87ceeb, 0x32502a, 0.4);
    scene.add(this.hemisphereLight);

    // ── Moon ──
    this.moonMaterial = buildMoonMaterial();
    const moonGeo = new THREE.SphereGeometry(7, 24, 24);
    this.moonMesh = new THREE.Mesh(moonGeo, this.moonMaterial);
    scene.add(this.moonMesh);
    this.disposables.push(moonGeo, this.moonMaterial);

    // ── Stars ──
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(random() * 0.95); // upper hemisphere
      const r = 620;
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi) + 4;
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xeef2ff,
      size: 1.7,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.starField = new THREE.Points(starGeo, this.starMaterial);
    this.starField.visible = false;
    scene.add(this.starField);
    this.disposables.push(starGeo, this.starMaterial);

    // ── Shooting stars ──
    for (let i = 0; i < SHOOTING_STAR_POOL; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(-7, 1.6, 0),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        fog: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      scene.add(line);
      this.shootingStars.push({
        line,
        material: mat,
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
      });
      this.disposables.push(geo, mat);
    }

    this.eclipseVisual = new EclipseVisual(scene);

    // ── Aurora: two curved curtains with independent phases ──
    for (let i = 0; i < 2; i++) {
      const material = buildAuroraMaterial(i * 3.7);
      this.auroraMaterials.push(material);
      this.disposables.push(material);
      const geo = new THREE.PlaneGeometry(320, 52, 128, 8);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(i === 0 ? -20 : 35, 58 + i * 14, -110 - i * 30);
      mesh.rotation.y = (i === 0 ? 1 : -1) * 0.16;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this.auroraMeshes.push(mesh);
      this.disposables.push(geo);
    }

    this.installEnvironmentBlending();
  }

  private installEclipseSkyShader(): void {
    const material = this.sky.material;
    material.uniforms.eclipseDarkness = { value: 0 };
    material.uniforms.eclipseTotality = { value: 0 };

    const outputMarker = 'gl_FragColor = vec4( texColor, 1.0 );';
    if (!material.fragmentShader.includes(outputMarker)) {
      throw new Error('Three.js Sky shader changed; eclipse atmosphere patch needs updating');
    }
    material.fragmentShader = material.fragmentShader
      .replace(
        'uniform float time;',
        `uniform float time;
        uniform float eclipseDarkness;
        uniform float eclipseTotality;`
      )
      .replace(
        outputMarker,
        `float eclipseHorizon = pow( 1.0 - clamp( direction.y, 0.0, 1.0 ), 3.0 );
        vec3 eclipseZenith = vec3( 0.004, 0.009, 0.035 );
        vec3 eclipseHorizonColor = vec3( 0.24, 0.065, 0.025 );
        vec3 eclipseSky = mix(
          eclipseZenith,
          eclipseHorizonColor,
          eclipseHorizon * eclipseTotality
        );
        float eclipseBlend = eclipseDarkness * mix( 0.68, 0.88, eclipseTotality );
        texColor = mix( texColor, eclipseSky, eclipseBlend );
        gl_FragColor = vec4( texColor, 1.0 );`
      );
    material.needsUpdate = true;
  }

  private installEnvironmentBlending(): void {
    const patched = new Set<THREE.MeshStandardMaterial>();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const candidate of materials) {
        if (!(candidate instanceof THREE.MeshStandardMaterial) || patched.has(candidate)) continue;
        patched.add(candidate);

        const previousCompile = candidate.onBeforeCompile.bind(candidate);
        const previousCacheKey = candidate.customProgramCacheKey.bind(candidate);
        candidate.onBeforeCompile = (shader, renderer) => {
          previousCompile(shader, renderer);
          if (!shader.fragmentShader.includes('#include <envmap_physical_pars_fragment>')) return;

          shader.uniforms.environmentMapNext = this.envNextMapUniform;
          shader.uniforms.environmentMapBlend = this.envBlendUniform;
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <envmap_common_pars_fragment>',
              `#include <envmap_common_pars_fragment>\n${ENVIRONMENT_BLEND_UNIFORMS}`
            )
            .replace(
              '#include <envmap_physical_pars_fragment>',
              BLENDED_ENVIRONMENT_SHADER_CHUNK
            );
        };
        candidate.customProgramCacheKey = () =>
          `${previousCacheKey()}|${ENVIRONMENT_BLEND_CACHE_KEY}`;
        candidate.needsUpdate = true;
      }
    });
  }

  setMoonPhase(phase01: number, illuminationFraction: number): void {
    // phase 0 = new moon, 0.5 = full moon (SunCalc convention).
    this.moonMaterial.uniforms.uPhaseAngle.value = phase01 * Math.PI * 2;
    this.moonIllumination = clamp01(illuminationFraction);
  }

  /** 0..1 — typically (clear-sky && deep-night && "aurora night") gate. */
  setAuroraStrength(strength: number): void {
    this.auroraTarget = clamp01(strength);
  }

  /** Compatibility helper for diagnostics that directly set eclipse coverage. */
  setEclipse(strength: number): void {
    const coverage = clamp01(strength);
    this.setEclipseState({
      active: coverage > 0.001,
      coverage,
      separation: 1.25 * (1 - coverage),
      irradiance: 1 - coverage * 0.985,
      corona: Math.pow(coverage, 4),
      beads: Math.pow(coverage, 10),
      stars: Math.pow(coverage, 7),
      totality: THREE.MathUtils.smoothstep(coverage, 0.985, 1),
    });
  }

  setEclipseState(state: EclipseRenderState): void {
    this.eclipseState = {
      active: state.active,
      coverage: clamp01(state.coverage),
      separation: THREE.MathUtils.clamp(state.separation, -1.35, 1.35),
      irradiance: clamp01(state.irradiance),
      corona: clamp01(state.corona),
      beads: clamp01(state.beads),
      stars: clamp01(state.stars),
      totality: clamp01(state.totality),
    };
  }

  getBloomObjects(): THREE.Object3D[] {
    return this.eclipseVisual.getBloomObjects();
  }

  getOcclusionExclusions(): THREE.Object3D[] {
    return this.eclipseVisual.getOcclusionExclusions();
  }

  /** Focuses the directional shadow budget around the currently viewed area. */
  setShadowFocus(target: THREE.Vector3, radius: number): void {
    this.shadowFocus.copy(target);
    const nextRadius = THREE.MathUtils.clamp(radius, 42, 95);
    if (Math.abs(nextRadius - this.shadowRadius) < 1) return;
    this.shadowRadius = nextRadius;
    const shadowCamera = this.sunLight.shadow.camera;
    shadowCamera.left = -nextRadius;
    shadowCamera.right = nextRadius;
    shadowCamera.top = nextRadius;
    shadowCamera.bottom = -nextRadius;
    shadowCamera.updateProjectionMatrix();
  }

  setCameraFocusDistance(distance: number): void {
    if (!Number.isFinite(distance)) return;
    const nextWideView = this.wideView ? distance > 102 : distance > 112;
    if (nextWideView === this.wideView) return;
    this.wideView = nextWideView;
    this.syncShadowMapResolution();
  }

  setCameraMode(mode: 'free' | 'train' | 'bus'): void {
    this.cameraMode = mode;
  }

  private syncShadowMapResolution(force = false): void {
    const targetSize = this.wideView ? Math.min(512, this.shadowMapSize) : this.shadowMapSize;
    if (!force && targetSize === this.appliedShadowMapSize) return;
    this.appliedShadowMapSize = targetSize;
    this.sunLight.shadow.mapSize.set(targetSize, targetSize);
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null;
  }

  setQuality(profile: QualityProfile): void {
    const shadowConfigChanged =
      this.shadowsEnabled !== profile.shadows || this.shadowMapSize !== profile.shadowMapSize;
    this.eclipseVisual.setQuality(profile.level);
    this.envInterval = profile.pmremInterval;
    this.shadowsEnabled = profile.shadows;
    this.shadowMapSize = profile.shadowMapSize;
    this.streetLightBudget = profile.streetLightBudget;
    this.busStopLightBudget = profile.busStopLightBudget;
    this.stationLightBudget = profile.stationLightBudget;
    this.windowLightBudget = profile.windowLightBudget;
    this.syncShadowMapResolution(shadowConfigChanged);
    this.sunLight.castShadow = profile.shadows && this.smoothedSunStrength > 0.002;
  }

  update(t: number, dtReal: number, cloudCover: number, nightFloor = 0): DayLightState {
    this.elapsed += dtReal;
    const eclipseState = this.eclipseState;
    const eclipse = eclipseState.coverage;
    const eclipseDarkness = 1 - eclipseState.irradiance;
    const elevation = sunElevationAt(t);
    // Themes like Neon Noir keep the city in eternal dusk via nightFloor;
    // a solar eclipse pushes the world toward night for half a minute.
    const targetNight = Math.max(
      nightFactorAt(t),
      nightFloor,
      eclipseDarkness * 0.52 + eclipseState.totality * 0.12
    );
    const targetGolden = goldenFactorAt(t);
    const targetSunStrength = directSunFactorAt(t);
    const lightingBlend = this.lightingInitialized ? 1 - Math.exp(-Math.max(0, dtReal) * 3.2) : 1;
    this.smoothedNight += (targetNight - this.smoothedNight) * lightingBlend;
    this.smoothedGolden += (targetGolden - this.smoothedGolden) * lightingBlend;
    this.smoothedSunStrength += (targetSunStrength - this.smoothedSunStrength) * lightingBlend;
    this.lightingInitialized = true;
    const night = this.smoothedNight;
    const golden = this.smoothedGolden;
    const day = 1 - night;
    const sunDir = sunDirectionAt(t, this.tmpSunDir);

    // ── Sky shader ──
    const uniforms = this.sky.material.uniforms;
    // An eclipse chokes the scattered light: the whole sky dims with the sun.
    const turbidity = 2.0 + cloudCover * 11 + golden * 1.6;
    const rayleigh = (2.4 + golden * 1.4) * (1 - eclipseDarkness * 0.82);
    const mie =
      (0.0035 + golden * 0.014 + cloudCover * 0.008) * (1 - eclipseDarkness * 0.94);
    uniforms.turbidity.value = turbidity;
    uniforms.rayleigh.value = rayleigh;
    uniforms.mieCoefficient.value = mie;
    uniforms.mieDirectionalG.value = 0.82;
    uniforms.sunPosition.value.copy(sunDir);
    uniforms.showSunDisc.value = eclipseState.active ? 0 : 1;
    uniforms.eclipseDarkness.value = eclipseDarkness;
    uniforms.eclipseTotality.value = eclipseState.totality;

    // ── Sun light ──
    const sunStrength = this.smoothedSunStrength;
    this.sunLight.position.copy(sunDir).multiplyScalar(140).add(this.shadowFocus);
    this.sunLight.target.position.copy(this.shadowFocus);
    // nightFloor (eternal-dusk themes) and an eclipse both mute the sun.
    const directSun =
      sunStrength *
      (1 - cloudCover * 0.62) *
      (1 - nightFloor * 0.8) *
      eclipseState.irradiance;
    this.sunLight.intensity = directSun * 2.2;
    sunColorAt(t, this.tmpSunColor);
    this.sunLight.color.copy(this.tmpSunColor);
    const directShadowStrength = sunStrength * eclipseState.irradiance;
    this.sunLight.castShadow = this.shadowsEnabled && directShadowStrength > 0.05;

    // ── Moon (opposite side of the sky) ──
    const moonDir = sunDirectionAt((t + 0.5) % 1, this.tmpMoonDir);
    this.moonMesh.position.copy(moonDir).multiplyScalar(540);
    const moonOpacity = THREE.MathUtils.smoothstep(moonDir.y, -0.08, 0.08);
    this.moonMaterial.uniforms.uOpacity.value = moonOpacity;
    this.moonMesh.visible = moonOpacity > 0.001;
    this.moonLight.position.copy(moonDir).multiplyScalar(120);
    this.moonLight.intensity =
      night * (0.06 + this.moonIllumination * 0.5) * (1 - cloudCover * 0.8) * clamp01(moonDir.y * 4);

    this.eclipseVisual.update(this.camera, sunDir, eclipseState, dtReal, cloudCover);

    // ── Fill lights ──
    this.ambientLight.intensity =
      (0.16 + day * 0.5 + golden * 0.1) * (1 - eclipseDarkness * 0.38) +
      eclipseState.totality * 0.1;
    skyColorAt(t, this.tmpColor);
    this.ambientLight.color.copy(this.tmpColor).lerp(this.tmpWhite, 0.35);
    this.hemisphereLight.intensity =
      (0.22 + day * 0.5) * (1 - eclipseDarkness * 0.42) + eclipseState.totality * 0.08;
    this.hemisphereLight.color.copy(this.tmpColor);

    // ── Fog colour tracks the horizon (density owned by Weather) ──
    if (this.scene.fog) {
      const fogGrey = 0.35 + cloudCover * 0.35;
      this.scene.fog.color
        .copy(this.tmpColor)
        .lerp(new THREE.Color(0x9aa3ad), cloudCover * fogGrey * day);
      if (eclipseDarkness > 0.001) {
        this.scene.fog.color.lerp(
          new THREE.Color(0x171d36),
          eclipseDarkness * (0.5 + eclipseState.totality * 0.28)
        );
      }
    }

    // ── Stars ──
    const starAlpha = Math.max(
      clamp01((night - 0.45) / 0.5),
      eclipseState.stars * 0.88
    ) * (1 - cloudCover);
    this.starMaterial.opacity = starAlpha * 0.95;
    this.starField.visible = starAlpha > 0.02;
    this.starField.rotation.y = this.elapsed * 0.004;

    // ── Shooting stars ──
    this.updateShootingStars(dtReal, starAlpha);

    // ── Aurora ──
    const auroraVisible = this.auroraTarget * clamp01((night - 0.6) / 0.3) * (1 - cloudCover);
    this.auroraStrength += (auroraVisible - this.auroraStrength) * Math.min(1, dtReal * 0.6);
    for (const material of this.auroraMaterials) {
      material.uniforms.uTime.value = this.elapsed;
      material.uniforms.uStrength.value = this.auroraStrength;
    }
    for (const mesh of this.auroraMeshes) mesh.visible = this.auroraStrength > 0.015;

    // ── Street / window lights ──
    this.lightSelectionCooldown -= dtReal;
    if (this.camera && this.lightSelectionCooldown <= 0) {
      const eye = this.camera.position;
      this.hooks.streetLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.busStopLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.stationLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.windowLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.lightSelectionCooldown = 0.5;
    }
    // Point/spot lights are evaluated by every physical fragment. In the low
    // bus chase camera, a dozen city lights overlap most of the screen and
    // become substantially more expensive than their draw-call count suggests.
    // Keep the nearest street and shelter pools; emissive fixtures and glow
    // meshes preserve the rest of the city lighting without global shader cost.
    const busChaseView = this.cameraMode === 'bus';
    const streetLightBudget = this.wideView
      ? 0
      : busChaseView ? Math.min(1, this.streetLightBudget) : this.streetLightBudget;
    const busStopLightBudget = this.wideView
      ? 0
      : busChaseView ? Math.min(1, this.busStopLightBudget) : this.busStopLightBudget;
    const stationLightBudget = this.wideView
      ? Math.min(1, this.stationLightBudget)
      : busChaseView ? 0 : this.stationLightBudget;
    const windowLightBudget = this.wideView || busChaseView ? 0 : this.windowLightBudget;
    const physicalLightThreshold = this.wideView ? 0.28 : 0.001;
    for (let i = 0; i < this.hooks.streetLights.length; i++) {
      const light = this.hooks.streetLights[i];
      light.visible = night > physicalLightThreshold && i < streetLightBudget;
      // A small urban LED luminaire is several thousand lumens. The point-light
      // approximation needs enough candela to reach pavement and nearby walls.
      light.intensity = light.visible ? night * 135 : 0;
      light.distance = 30;
    }
    const streetGlow = clamp01((night - 0.04) / 0.72);
    this.hooks.streetGlowMesh.visible = streetGlow > 0.01;
    this.hooks.streetGlowMaterial.uniforms.uNight.value = streetGlow;
    for (let i = 0; i < this.hooks.busStopLights.length; i++) {
      const light = this.hooks.busStopLights[i];
      light.visible = night > physicalLightThreshold && i < busStopLightBudget;
      light.intensity = light.visible ? night * 48 : 0;
    }
    for (const material of this.hooks.busStopGlowMaterials) {
      material.emissiveIntensity = 0.08 + night * 1.05;
    }
    for (let i = 0; i < this.hooks.stationLights.length; i++) {
      const light = this.hooks.stationLights[i];
      light.visible = night > physicalLightThreshold && i < stationLightBudget;
      // Railway platforms stay brighter than bus shelters for visibility and safety.
      light.intensity = light.visible ? night * 145 : 0;
      light.distance = 28;
    }
    for (const material of this.hooks.stationGlowMaterials) {
      material.emissiveIntensity = 0.1 + night * 1.8;
    }
    const stationGlow = clamp01((night - 0.015) / 0.72);
    this.hooks.stationGlowMesh.visible = stationGlow > 0.01;
    this.hooks.stationGlowMaterial.uniforms.uNight.value = stationGlow;
    const residentialActivity = residentialWindowAverageAt(t);
    for (let i = 0; i < this.hooks.windowLights.length; i++) {
      const light = this.hooks.windowLights[i];
      light.visible =
        night > physicalLightThreshold && residentialActivity > 0.001 && i < windowLightBudget;
      light.intensity = light.visible ? night * residentialActivity * 32 : 0;
      light.distance = 20;
    }
    for (const schedule of this.hooks.windowGlowMaterials) {
      const activity = residentialWindowActivityAt(t, schedule.cohort);
      schedule.activity = activity;
      schedule.material.color.copy(schedule.darkColor).lerp(schedule.litColor, activity);
      schedule.material.emissive.copy(schedule.litColor);
      schedule.material.emissiveIntensity = activity * (0.02 + night * 1.23);
    }

    // ── Environment map (reflections in glass) — throttled regeneration ──
    this.updateEnvironmentTransition(dtReal);
    this.scene.environmentIntensity =
      ENVIRONMENT_INTENSITY * (1 - eclipseDarkness * 0.72);
    // PMREM generation is synchronous and a two-map crossfade doubles the
    // environment lookup cost on every physical material. Build the neutral
    // reflection probe once during preload; continuous sky/light/weather
    // changes stay in their dedicated shaders and material parameters.
    if (!this.envTarget && !this.envTransitionActive) {
      this.regenerateEnvironment(uniforms);
      this.envLastElevation = elevation;
      this.envLastCloud = cloudCover;
    }

    return { night, golden, sunElevation: elevation, directSun, eclipse };
  }

  private regenerateEnvironment(skyUniforms: Record<string, THREE.IUniform>): void {
    const envUniforms = this.envSky.material.uniforms;
    envUniforms.turbidity.value = skyUniforms.turbidity.value;
    envUniforms.rayleigh.value = skyUniforms.rayleigh.value;
    envUniforms.mieCoefficient.value = skyUniforms.mieCoefficient.value;
    envUniforms.mieDirectionalG.value = skyUniforms.mieDirectionalG.value;
    envUniforms.sunPosition.value.copy(skyUniforms.sunPosition.value);

    const next = this.pmrem.fromScene(this.envScene, 0.03);
    if (!this.envTarget) {
      this.envTarget = next;
      this.scene.environment = next.texture;
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.envNextMapUniform.value = next.texture;
      this.envBlendUniform.value = 0;
      return;
    }

    this.envPendingTarget?.dispose();
    this.envPendingTarget = next;
    this.envNextMapUniform.value = next.texture;
    this.envTransitionProgress = 0;
    this.envTransitionActive = true;
  }

  private updateEnvironmentTransition(dtReal: number): void {
    if (!this.envTransitionActive) return;

    this.envTransitionProgress = clamp01(
      this.envTransitionProgress + Math.max(0, dtReal) / ENVIRONMENT_TRANSITION_SECONDS
    );
    const transition = environmentTransitionAt(this.envTransitionProgress);
    this.scene.environmentIntensity = transition.intensity;
    this.envBlendUniform.value = transition.blend;
    if (this.envTransitionProgress >= 1) {
      const old = this.envTarget;
      this.envTarget = this.envPendingTarget;
      this.envPendingTarget = null;
      if (this.envTarget) {
        this.scene.environment = this.envTarget.texture;
        this.envNextMapUniform.value = this.envTarget.texture;
      }
      this.envBlendUniform.value = 0;
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.envTransitionActive = false;
      old?.dispose();
    }
  }

  private updateShootingStars(dt: number, starAlpha: number): void {
    for (const star of this.shootingStars) {
      if (star.life > 0) {
        star.life -= dt;
        star.line.position.addScaledVector(star.velocity, dt);
        const fade = clamp01(star.life / star.maxLife);
        star.material.opacity = fade * 0.9;
        if (star.life <= 0) star.line.visible = false;
      } else if (dt > 0 && starAlpha > 0.6 && this.eventRandom() < dt * 0.12) {
        star.maxLife = 0.7 + this.eventRandom() * 0.6;
        star.life = star.maxLife;
        star.line.position.set(
          (this.eventRandom() - 0.5) * 360,
          120 + this.eventRandom() * 120,
          (this.eventRandom() - 0.5) * 360
        );
        star.velocity.set(
          -(60 + this.eventRandom() * 80),
          -(18 + this.eventRandom() * 22),
          (this.eventRandom() - 0.5) * 30
        );
        star.line.visible = true;
      }
    }
  }

  dispose(): void {
    this.eclipseVisual.dispose();
    for (const item of this.disposables) item.dispose();
    this.envTarget?.dispose();
    this.envPendingTarget?.dispose();
    this.pmrem.dispose();
    this.scene.environment = null;
    this.scene.remove(this.sky, this.starField, this.moonMesh, this.sunLight, this.moonLight);
    for (const mesh of this.auroraMeshes) this.scene.remove(mesh);
    for (const star of this.shootingStars) this.scene.remove(star.line);
    (this.sky.material as THREE.ShaderMaterial).dispose();
    this.sky.geometry.dispose();
    (this.envSky.material as THREE.ShaderMaterial).dispose();
    this.envSky.geometry.dispose();
  }
}
