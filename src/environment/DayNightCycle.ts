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
  antisolarDirectionAt,
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

/** Where the Preetham sky writes its result; both sky patches hang off this line. */
const SKY_OUTPUT_MARKER = 'gl_FragColor = vec4( texColor, 1.0 );';

/**
 * The largest radiance the probe's sky is allowed to emit.
 *
 * A half-float render target -- which is what every PMREM target is -- holds 65504 and no
 * more. Preetham's solar disc is `vSunE * 19000 * Fex`, and after the shader's final
 * `* 0.04` that clears 65504 as soon as the sun is about twenty degrees up: measured
 * 44 926 at an elevation of 16.7 degrees and over the ceiling at 26.6.
 *
 * What happens next is not the same on every rasteriser, which is why this hid for so long.
 * Storing an over-range float as a half gives +Inf on an Apple M1 (measured: 4 texels
 * flagged over-range, zero NaN, scene renders) and NaN on SwiftShader (the same 4 texels,
 * all NaN). PMREM then convolves those 4 NaN texels into 10 126 of the atlas's 786 432, the
 * environment map poisons every physical material's IBL term, and the frame comes back
 * black -- 94.4 per cent of it under luminance 8, with 621k triangles still drawn.
 *
 * 60000 is under the ceiling, exactly representable as a half (the spacing up there is 32),
 * and above every radiance the sky has been measured to produce short of the disc itself.
 * Nothing is given up: the disc still reaches the probe, it simply stops overflowing. The
 * blur that follows is a weighted average, so no later stage can climb back over the limit.
 */
const ENVIRONMENT_RADIANCE_CEILING = 60000;

/**
 * Hold the probe sky's output inside what a half-float target can store.
 *
 * Exported for the test that pins the marker: if a Three.js upgrade renames that line the
 * patch would silently stop applying, and the failure it prevents is a black frame on one
 * class of GPU only -- exactly the kind that reaches CI and not a desk.
 */
export function withRadianceCeiling(fragmentShader: string): string {
  if (!fragmentShader.includes(SKY_OUTPUT_MARKER)) {
    throw new Error('Three.js Sky shader changed; environment radiance ceiling needs updating');
  }
  return fragmentShader.replace(
    SKY_OUTPUT_MARKER,
    `texColor = min( texColor, vec3( ${ENVIRONMENT_RADIANCE_CEILING}.0 ) );
    ${SKY_OUTPUT_MARKER}`
  );
}

/**
 * How much world one shadow-map texel covers, in metres.
 *
 * Worth having as a function because every number that matters downstream is derived
 * from it -- the bias that hides what the map cannot draw, and the grid the focus is
 * snapped to -- and because the value is not the one the constructor suggests: the
 * quality profile overrides the map size, and the frustum radius follows the camera.
 */
export function shadowTexelSize(radius: number, mapSize: number): number {
  return (radius * 2) / Math.max(1, mapSize);
}

/**
 * How far the normal bias has to push a shadow lookup off its surface.
 *
 * In texels, not metres, because that is what the artefact is measured in: a feature
 * thinner than a texel cannot be drawn at any map size, so the number that removes it
 * has to grow with the texel. 1.5 was photographed, not guessed -- see the call site.
 */
export function shadowNormalBias(texel: number): number {
  return texel * 1.5;
}

/** What a cloud deck does to daylight, as three multipliers on the clear-sky rig. */
export interface CloudDaylight {
  /** Multiplies the direct beam. 1 under a clear sky, 0 under full overcast. */
  beam: number;
  /** Multiplies the *daylight half* of both fill lights. 1 clear, 5/3 full overcast. */
  fill: number;
  /** `sunLight.shadow.radius`, in shadow-map texels. 1 clear, 3 full overcast. */
  penumbra: number;
}

/**
 * Cloud cover moves three things, and before this it moved one.
 *
 * Measured on a running page (`document.hidden === false`, `elapsedSimulation` advancing),
 * classic theme, noon, sun at 61.21 degrees, clear (cover 0.12) against rain (cover 0.92):
 * `sunLight.intensity` 2.036 -> 0.945, `ambientLight.intensity` 0.660 -> 0.660,
 * `hemisphereLight.intensity` 0.720 -> 0.720, `castShadow` true -> true. The old beam term
 * was a flat `1 - cloudCover * 0.62`; neither fill light had a cloud term at all, and the
 * shadow gate was fed `sunStrength * eclipseIrradiance`, which does not mention cloud. So
 * an overcast noon was a darker copy of a sunny noon wearing the same hard shadows, which
 * is the one thing an overcast noon is not.
 *
 * The numbers below are one published relation plus two standard endpoints. None is taste.
 *
 * **The relation.** Kasten & Czeplak (1980), *Solar Energy* 24, 177-189, fit global
 * horizontal irradiance to cloud amount N in oktas as `G / G_clear = 1 - 0.75 (N/8)^3.4`.
 * At full overcast that is 0.25 of clear.
 *
 * **The endpoints.** Clear noon daylight is about 100 000 lux, of which the diffuse sky is
 * the standard clear-sky diffuse fraction of about 0.15 -- 85 000 lux of beam over 15 000
 * of sky. Full overcast is 10 000 to 25 000 lux and has **no solar disc in it at all**:
 * the CIE Standard Overcast Sky is a pure luminance distribution,
 * `L(theta) = L_zenith (1 + 2 cos theta) / 3`, with no sun term. Kasten & Czeplak's own
 * 0.25 puts overcast at 25 000 lux, the top of that band, so the two sources meet at the
 * endpoint and 25 000 is the figure used here.
 *
 * Interpolating both components on Kasten & Czeplak's own `u = (N/8)^3.4`, in klux:
 *
 *     G(u) = 100 - 75u          their relation
 *     D(u) =  15 + 10u          15 klux of clear sky -> 25 klux of overcast sky
 *     B(u) = G - D = 85 (1 - u)
 *
 * which is `beam = 1 - u` and `fill = 1 + (10/15) u = 1 + (2/3) u`. The beam reaches zero
 * because overcast is *defined* by the disc being gone, and the fill rises by two thirds
 * because a deck turns the beam into sky rather than swallowing it. That second number is
 * the whole point: the sky takes over as the source, so the scene loses its shadow without
 * simply going dark.
 *
 * **`u` is taken over this product's dial, not over oktas.** `WEATHER` in Weather.ts reads
 * clear 0.12, fog 0.55, cloudy 0.78, snow 0.85, rain 0.92 -- so 0.92 is the heaviest deck
 * this product can ask for, and it means a nimbostratus rain deck, not 7.4 oktas of
 * scattered cumulus. Read literally as oktas, 0.92 would give `u = 0.75`, leave 25 per
 * cent of the beam standing and keep the hard shadow -- the right answer for broken cloud
 * and the wrong one for rain. Mapping 0.12 to no cloud and 0.92 to full overcast is what
 * makes the dial mean what the product uses it for. It is deliberately *not* clamped at
 * the low end only: cover below 0.12 never occurs, and `clamp01` keeps both ends safe.
 *
 * **`penumbra` is an angle in disguise.** A shadow edge blurs over `d * theta` metres at
 * distance `d` under an occluder, where `theta` is the source's angular diameter. The sun
 * is 0.53 degrees, so a 10 m block casts a 0.0925 m penumbra. Measured live on the High
 * profile, the shadow frustum settles at 69.41 m of radius on a 1024 map -- 0.13557 m per
 * texel -- so the sun's own penumbra is 0.68 of one texel and is *below the grid*. That is
 * why clear sky keeps `radius = 1`: the rig is already as sharp as the sun is, and no
 * smaller number buys anything. Growing the radius is therefore the only direction that
 * means something, and in three r185 (`shadowmap_pars_fragment.glsl.js`) PCFShadowMap
 * spends it on five Vogel-disk samples, outermost at `sqrt(0.9) = 0.949` of the radius,
 * rotated per pixel by interleaved gradient noise. Five rotated samples over a wider disk
 * buy blur at the price of dither, not of banding, which is why this stops at 3 rather
 * than at the 5-to-10 degrees a real thick deck subtends: past there the deck is opaque
 * enough that `beam` takes the shadow off the gate entirely. Measured, at noon that
 * happens at cover 0.908, so the widest penumbra ever actually drawn is 2.9 texels.
 */
export function cloudDaylightAt(cloudCover: number): CloudDaylight {
  // Weather.ts: WEATHER.clear.cloud = 0.12 is the dial's floor, WEATHER.rain.cloud = 0.92
  // its ceiling. Kasten & Czeplak's exponent is applied to that span, not to raw cover.
  const u = clamp01((cloudCover - 0.12) / 0.8) ** 3.4;
  // 2/3, not 0.667: it is 10/15 klux exactly, and only the exact value puts the
  // reconstructed global back on `1 - 0.75u` to the last digit -- which the test checks.
  return { beam: 1 - u, fill: 1 + (u * 2) / 3, penumbra: 1 + u * 2 };
}

/**
 * The shadow focus, rounded to whole texels in the light's own basis.
 *
 * Pure and exported so the property can be tested without a renderer: a focus that
 * drifts continuously must come back quantised, or the shadow grid slides through the
 * world and every stepped edge swims. The component along the light is left alone, so
 * the frustum still covers what the camera is looking at.
 *
 * `right`, `up` and `out` are scratch vectors owned by the caller: this runs every frame.
 */
export function snapShadowFocus(
  focus: THREE.Vector3,
  sunDir: THREE.Vector3,
  texel: number,
  right: THREE.Vector3,
  up: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  // With the sun overhead the usual world-up reference degenerates, so fall back to
  // another axis rather than normalising a zero.
  right.set(0, 1, 0).cross(sunDir);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0).cross(sunDir);
  right.normalize();
  up.copy(sunDir).cross(right).normalize();
  const grid = Math.max(1e-6, texel);
  const alongRight = Math.round(focus.dot(right) / grid) * grid;
  const alongUp = Math.round(focus.dot(up) / grid) * grid;
  const alongLight = focus.dot(sunDir);
  return out
    .copy(right)
    .multiplyScalar(alongRight)
    .addScaledVector(up, alongUp)
    .addScaledVector(sunDir, alongLight);
}

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

/**
 * Where the night sky is dark enough to be starry, and where an eclipse is dark enough.
 *
 * The threshold is written against `nightFactorAt`, which is a smoothstep between
 * `FULL_NIGHT_ELEVATION_DEG` and `FULL_DAY_ELEVATION_DEG` in `sky.ts`, so the honest way to
 * choose it is to say what solar depression it means and then measure that back. The pair
 * here means: **first star at 4.03 degrees of depression, fully starry at 9.90.**
 *
 * Which is the twilight definition, not a taste. The eye picks up the first naked-eye stars
 * during *civil* twilight (0 to -6) and the sky is properly starry by *nautical* twilight
 * (-6 to -12) -- so first light lands partway through civil, and full strength partway
 * through nautical. The upper anchor is deliberately not -12 itself: at 52.23 north a June
 * sun bottoms out at -14.33, and pinning full stars to the end of nautical twilight would
 * leave a Polish June with a hair's width of properly starry sky.
 *
 * The pair it replaces was `(night - 0.45) / 0.5`, which is **+1.33 degrees** -- the first
 * stars came out with the sun still above the horizon, every day of the year. (Before the
 * 2026-09-12 ramp retune the same constants meant +4.93, in broad daylight; the retune
 * moved the number without fixing it.) Measured over a 200 000-step day, star visibility
 * goes from 7.79 h to 6.21 h in June and 13.93 h to 12.74 h in autumn, and both seasons
 * still reach full strength. The shooting-star gate rides on this alpha too -- it needs
 * 0.6, which moves from -3.84 degrees to -6.90, leaving 5.25 h of June and 12.13 h of
 * autumn to fall in.
 *
 * **An eclipse gets its own arm, and this is the correction the review forced.** Raising the
 * twilight threshold deleted 20.02 s of starfield from every 90 s eclipse: `eclipseStars` is
 * `smootherStep(corona)` and the corona is exactly 0 below progress 0.36, so through the
 * partial phases the only term carrying stars was the *night an eclipse synthesises*
 * (0.4943-0.5048), which cleared the old 0.45 threshold at alpha 0.11 and clears 0.76 at
 * nothing. Worst point measured at progress 0.3665, coverage 0.9852: alpha 0.1098 to 0.
 *
 * So the eclipse keeps the old curve on its own quantity instead of riding the twilight one
 * by accident. That is not a workaround: a sky darkened by the moon crossing the sun and a
 * sky darkened by the earth turning away reach the same brightness by different paths, and
 * the threshold for "a star is visible" belongs to the brightness, not to the cause. What
 * changed is that the eclipse path is now written down rather than inherited.
 */
export function starAlphaAt(
  night: number,
  eclipseStars: number,
  eclipseNight: number,
  cloudCover: number
): number {
  return (
    Math.max(
      clamp01((night - 0.76) / 0.22),
      clamp01((eclipseNight - 0.45) / 0.5),
      eclipseStars * 0.88
    ) * (1 - cloudCover)
  );
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
  /** Reused for snapping the shadow focus to whole texels; nothing here allocates per frame. */
  private readonly shadowRight = new THREE.Vector3();
  private readonly shadowUp = new THREE.Vector3();
  private readonly snappedFocus = new THREE.Vector3();
  private shadowRadius = 95;
  private lightSelectionCooldown = 0;
  /**
   * Diagnostic only. `update()` reassigns `visible` on every street, bus-stop,
   * station and window light each frame, so a one-shot `visible = false` from a
   * benchmark is undone on the next frame. This gate is checked inside those loops
   * so a diagnostic disable survives the whole measurement window.
   */
  private localLightsEnabled = true;

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
    /**
     * The same ceiling the reflection probe needs, for the same reason and a different buffer.
     *
     * `bootstrap` builds the composer's frame buffer as `HalfFloatType` too, so the solar disc
     * overflows there as well: aimed at the sun on a software rasteriser that buffer holds 294
     * NaN texels and the sun draws as a black DOT. It does not black out the frame the way the
     * probe did -- mean luminance stays at 228 -- which is exactly why it outlived the
     * investigation that found the probe.
     *
     * Applied before `installEclipseSkyShader`, because both patch the same output write and
     * the eclipse patch must see the clamped expression rather than replace it.
     */
    this.sky.material.fragmentShader = withRadianceCeiling(this.sky.material.fragmentShader);
    this.installEclipseSkyShader();
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(2000);
    this.envSky.material.fragmentShader = withRadianceCeiling(
      this.envSky.material.fragmentShader
    );
    this.envSky.material.needsUpdate = true;
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
    // Only the first frame uses this: `update` replaces it every frame with a value tied
    // to the map's texel size, which is what the artefact scales with.
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

    const outputMarker = SKY_OUTPUT_MARKER;
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
  /** Diagnostic only: hold every local light off for a whole measurement window. */
  setLocalLightsEnabled(enabled: boolean): void {
    this.localLightsEnabled = enabled;
  }

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

  update(
    t: number,
    dtReal: number,
    cloudCover: number,
    /** Solar declination: the season, in radians. Sets noon altitude and day length together. */
    declination: number,
    /**
     * Required, and deliberately not optional.
     *
     * `declination` was inserted ahead of a `nightFloor = 0`, which left every existing
     * four-argument call compiling unchanged while silently feeding the night floor into the
     * season. Three of them in `RendererWarmup` then seeded the smoothed sun with a
     * declination of zero, which at the rainbow checkpoint's hour is an elevation of 0.43
     * degrees instead of 18.7 -- near-zero direct sunlight instead of most of it, and no
     * rainbow. (The two figures this once quoted, 6e-5 and 0.54, were `directSunFactorAt`
     * before the 2026-09-12 ramp retune replaced its double cosine with an air-mass beam;
     * the shape of the failure is unchanged, the numbers are not, so they are gone rather
     * than left to rot.)
     * A default here is what let the compiler stay quiet; there is not one any more.
     */
    nightFloor: number,
    /**
     * What the **weather** put in the sky, which is not what `cloudCover` carries.
     *
     * `cloudCover` arrives as `skyCloud` -- the weather's cover plus the theme's
     * `turbidityAdd * 0.1` -- because a theme's haze genuinely belongs in the dome's
     * turbidity and mie terms. It does not belong in occlusion: haze is not a cloud deck, and
     * feeding it to `cloudDaylightAt` made a **clear** cyberpunk sky (turbidityAdd 5, so cover
     * 0.62) brighten its sun by 19.9 per cent and blur its shadow, with autumn and retro
     * moved a little too. Measured by a reviewer, on three of the five shipped themes.
     *
     * Deliberately the last parameter rather than sitting beside `cloudCover`: two adjacent
     * numbers that both mean "cloud" is the shape of mistake this file has already paid for
     * twice.
     */
    weatherCloud: number
  ): DayLightState {
    this.elapsed += dtReal;
    const eclipseState = this.eclipseState;
    const eclipse = eclipseState.coverage;
    const eclipseDarkness = 1 - eclipseState.irradiance;
    const elevation = sunElevationAt(t, declination);
    // Themes like Neon Noir keep the city in eternal dusk via nightFloor;
    // a solar eclipse pushes the world toward night for half a minute.
    const targetNight = Math.max(
      nightFactorAt(t, declination),
      nightFloor,
      eclipseDarkness * 0.52 + eclipseState.totality * 0.12
    );
    const targetGolden = goldenFactorAt(t, declination);
    const targetSunStrength = directSunFactorAt(t, declination);
    const lightingBlend = this.lightingInitialized ? 1 - Math.exp(-Math.max(0, dtReal) * 3.2) : 1;
    this.smoothedNight += (targetNight - this.smoothedNight) * lightingBlend;
    this.smoothedGolden += (targetGolden - this.smoothedGolden) * lightingBlend;
    this.smoothedSunStrength += (targetSunStrength - this.smoothedSunStrength) * lightingBlend;
    this.lightingInitialized = true;
    const night = this.smoothedNight;
    const golden = this.smoothedGolden;
    const day = 1 - night;
    const sunDir = sunDirectionAt(t, declination, this.tmpSunDir);

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
    const cloudLight = cloudDaylightAt(weatherCloud);
    /**
     * The shadow map's grid is pinned to whole texels, so it stops crawling.
     *
     * `setShadowFocus` slides the whole shadow frustum along with whatever the camera is
     * looking at. The map is a fixed number of texels across that frustum, and the numbers
     * are worse than the constructor above suggests: the quality profile overrides the map
     * to 1024 on High, the frustum settles around 69 m of radius in a street view, and a
     * wide view drops the map to 512. That is 0.14 m of world per texel up close and
     * 0.27 m in a wide view. Every shadow edge is quantised to that grid, and while the
     * grid itself moves continuously the quantisation lands somewhere new every frame.
     *
     * Rounding the focus to whole texels in the light's own basis freezes the grid to the
     * world, so an edge that is stepped stays stepped in the same place instead of
     * swimming across the wall as the camera moves.
     */
    const texel = shadowTexelSize(this.shadowRadius, this.appliedShadowMapSize);
    /**
     * The bias that removes what the map cannot draw, sized in texels rather than metres.
     *
     * A window sill is 0.07 m thick and stands 0.26 m off the wall. Its shadow is a third
     * of a texel wide, so the map cannot represent it: what reached the screen was a row
     * of detached diagonal teeth on the wall below every window, which is what was
     * reported. Photographed at a 0.136 m texel, 0.05 m of normal bias left them at full
     * strength, 0.12 m left them faint, and 0.2 m removed them; the big shadows -- the
     * trees, the blocks on the grass -- were unchanged, moving 2.1% of the street view's
     * pixels and lifting its mean luminance by 0.24 of 255.
     *
     * Expressed as 1.5 texels it holds as the frustum tightens and as a wide view drops
     * the map to 512, because the artefact scales with the texel and not with the metre.
     * This removes an unresolvable shadow rather than paying for the resolution to draw
     * it: no budget moves, and nothing else in the picture is given up for it.
     */
    this.sunLight.shadow.normalBias = shadowNormalBias(texel);
    snapShadowFocus(
      this.shadowFocus,
      sunDir,
      texel,
      this.shadowRight,
      this.shadowUp,
      this.snappedFocus
    );
    this.sunLight.position.copy(sunDir).multiplyScalar(140).add(this.snappedFocus);
    this.sunLight.target.position.copy(this.snappedFocus);
    // nightFloor (eternal-dusk themes) and an eclipse both mute the sun; a cloud deck
    // takes the beam apart and hands it to the sky — see {@link cloudDaylightAt}.
    const directSun =
      sunStrength * cloudLight.beam * (1 - nightFloor * 0.8) * eclipseState.irradiance;
    /**
     * 2.0363, not 2.2, so that a clear day renders exactly as it did.
     *
     * The old beam term was `1 - cloudCover * 0.62`, and this product's clear sky is cover
     * 0.12 -- so it quietly took 7.4 per cent off the beam on a cloudless noon as well.
     * Kasten & Czeplak put the loss at one okta at 0.06 per cent, so that 7.4 was never
     * cloud; it was part of the rig's calibration wearing a cloud term's clothes. The beam
     * no longer spends it, so the gain absorbs it: `2.2 * (1 - 0.62 * 0.12) = 2.0363`.
     * Measured on a running page at noon, cover 0.12: `sunLight.intensity` 2.036 before
     * this change and 2.036 after it. The defect was rain, and rain is the only thing that
     * moves.
     */
    this.sunLight.intensity = directSun * 2.0363;
    sunColorAt(t, declination, this.tmpSunColor);
    this.sunLight.color.copy(this.tmpSunColor);
    /**
     * The shadow gate reads the beam, which is the only thing that casts one.
     *
     * `nightFloor` is still left out on purpose -- an eternal-dusk theme dims the world
     * without putting a deck over it, and its shadows stay. `cloudLight.beam` is the term
     * that was missing: without it this expression never mentioned cloud, so rain kept a
     * hard shadow at full strength. Measured at noon, the gate now opens at cover 0.908,
     * so rain (0.92) is shadowless and snow (0.85) still casts, softened.
     */
    const directShadowStrength = sunStrength * eclipseState.irradiance * cloudLight.beam;
    this.sunLight.castShadow = this.shadowsEnabled && directShadowStrength > 0.05;
    this.sunLight.shadow.radius = cloudLight.penumbra;

    // ── Moon (opposite side of the sky) ──
    /**
     * The moon rides the **real** antisolar point, declination mirrored and all.
     *
     * It used to ride `sunDirectionAt(t + 0.5, +declination)`, which turns the hour angle
     * without turning the declination: a half-mirror that put the moon at the sun's own noon
     * altitude at midnight. Measured, that was 61.21 degrees in June and 28.27 in October --
     * the exact inverse of the sky, where a midsummer full moon crawls and an autumn one
     * rides high. {@link antisolarDirectionAt} fixes the sign; the numbers become 14.33 and
     * 47.27, and the azimuth mirrors too (a June moonrise moves from 49.50 degrees
     * east-of-north, the sun's own bearing, to 130.50).
     *
     * **This is a visible change to every June night, and it is meant to be.** Both gates
     * below read `moonDir.y`, so a moon that no longer climbs is dimmer and up for less of
     * the night. Sampled over a full day at 200 000 steps, full moon and clear sky: the mesh
     * is drawn for 8.67 h of a June day instead of 17.89, the moonlight is above 0.01 for
     * 7.33 h instead of 10.31, and its 24-hour mean falls from 0.1746 to 0.1093. October is
     * the other side of the same trade and gains: 14.68 h of mesh against 11.32, 13.56 h of
     * light against 10.28, mean 0.2792 against 0.2014. Peak intensity is untouched in
     * October (0.5600) and clipped by one per cent in June (0.5544 -- `moonDir.y * 4` no
     * longer saturates, because 14.33 degrees is a sine of 0.2475).
     *
     * `uPhaseAngle` is set from SunCalc in {@link setMoonPhase} and is a separate axis: the
     * crescent's shape never depended on this sign and is unchanged.
     */
    const moonDir = antisolarDirectionAt(t, declination, this.tmpMoonDir);
    this.moonMesh.position.copy(moonDir).multiplyScalar(540);
    const moonOpacity = THREE.MathUtils.smoothstep(moonDir.y, -0.08, 0.08);
    this.moonMaterial.uniforms.uOpacity.value = moonOpacity;
    this.moonMesh.visible = moonOpacity > 0.001;
    this.moonLight.position.copy(moonDir).multiplyScalar(120);
    this.moonLight.intensity =
      night * (0.06 + this.moonIllumination * 0.5) * (1 - cloudCover * 0.8) * clamp01(moonDir.y * 4);

    this.eclipseVisual.update(this.camera, sunDir, eclipseState, dtReal, cloudCover);

    // ── Fill lights ──
    /**
     * `cloudLight.fill` multiplies the `day * 0.5` term and nothing else, which is the
     * only term that is skylight.
     *
     * The 0.16 and 0.22 floors are not sky: they are what the rig leaves lit when the sky
     * has gone, and an overcast *night* is darker than a clear one, not brighter -- the
     * moon above already pays that with its own `(1 - cloudCover * 0.8)`. Scaling the
     * whole expression would have lifted the night floor by two thirds under rain for no
     * reason. `golden * 0.1` is the low-sun warm-up and belongs to the beam's hour, not to
     * the deck. Both eclipse terms keep their place around the outside, so an eclipse
     * under a clear sky is arithmetically unchanged: measured at totality, clear, the
     * fills read 0.315 and 0.317 before and after this change.
     */
    this.ambientLight.intensity =
      (0.16 + day * 0.5 * cloudLight.fill + golden * 0.1) * (1 - eclipseDarkness * 0.38) +
      eclipseState.totality * 0.1;
    skyColorAt(t, declination, this.tmpColor);
    this.ambientLight.color.copy(this.tmpColor).lerp(this.tmpWhite, 0.35);
    this.hemisphereLight.intensity =
      (0.22 + day * 0.5 * cloudLight.fill) * (1 - eclipseDarkness * 0.42) +
      eclipseState.totality * 0.08;
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
    const starAlpha = starAlphaAt(
      night,
      eclipseState.stars,
      eclipseDarkness * 0.52 + eclipseState.totality * 0.12,
      cloudCover
    );
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
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < streetLightBudget;
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
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < busStopLightBudget;
      light.intensity = light.visible ? night * 48 : 0;
    }
    for (const material of this.hooks.busStopGlowMaterials) {
      material.emissiveIntensity = 0.08 + night * 1.05;
    }
    for (let i = 0; i < this.hooks.stationLights.length; i++) {
      const light = this.hooks.stationLights[i];
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < stationLightBudget;
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
        this.localLightsEnabled &&
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
