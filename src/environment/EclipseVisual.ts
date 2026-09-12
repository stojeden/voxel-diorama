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

/**
 * Scene-linear radiance of the sky immediately beside the sun at the eclipse hour.
 *
 * Every magnitude the solar billboard draws is a ratio to this one number, because the
 * defect being fixed is a *comparison*, not a level. At 95.9 per cent coverage the drawn
 * disc measured luma 227.7 against a 250.5 sky and the billboard made **zero** pixels of
 * the centre row brighter: a dark blob on white, with no crescent in it. A disc authored at
 * an absolute radiance cannot say whether it beats the sky it sits on. A ratio can.
 *
 * 25 is inverted from a measurement rather than invented: the centre-row scan read the sky
 * beside the disc at luma 254.4/255 at this hour. sRGB-decoding that gives display-linear
 * 0.9947; inverting the ACES RRT+ODT fit gives a tone-mapper input of 19.5; dividing by the
 * pipeline's exposure/0.6 -- about 0.767 at this hour -- gives 25.4. Run forwards on the
 * *shipped* disc radiance of 1.22 the same chain predicts code 203 against the 190.6-227.7
 * the probe actually read, which is the only cross-check available without a renderer.
 *
 * So this is the line to edit when someone reads the scene buffer directly. Nothing else
 * below carries an absolute: re-measuring this retunes the whole billboard at once.
 */
const ECLIPSE_HOUR_SKY_RADIANCE = 25;

/**
 * How far above the sky the *dimmest* part of the photosphere is drawn -- three stops.
 *
 * A ratio TO `ECLIPSE_HOUR_SKY_RADIANCE`, and deliberately pinned to the extreme limb
 * (mu = 0, where the limb law bottoms out at 0.30) rather than to disc centre, because a
 * deep crescent is made entirely of limb. Pinning the *floor* is what makes the promise
 * hold at every partial phase: the sky can only darken as coverage grows, so 8:1 against
 * the uneclipsed sky is the worst case, not the typical one.
 *
 * The true ratio is about 1e5 -- the photosphere is 1.6e9 cd/m^2 at every coverage, because
 * the moon removes area and never surface brightness. One exposure cannot hold both, which
 * is why eclipse photographers publish exposure ladders instead. Three stops is the
 * compression: enough that the crescent is unambiguously a highlight and still clips the
 * tone curve at its own limb, little enough to leave 43x of half-float headroom for the
 * beads that have to outshine it later.
 */
const PHOTOSPHERE_LIMB_OVER_SKY = 8;

/**
 * Visible-light limb darkening: I(mu)/I(centre) = 0.3 + 0.93 mu - 0.23 mu^2 at 550 nm,
 * with mu = cos(theta) = sqrt(1 - (r/R)^2). Limb is 0.30 of centre, disc mean 0.805.
 *
 * The shader already had mu -- and then spent it on `0.9 + limb * 0.32`, a 1.36:1
 * centre-to-limb range against the real 3.33:1. That is a bigger error here than it would
 * be on a plain sun: a crescent is nothing but limb, so the ad-hoc factor drew the one part
 * of the disc this whole feature is about at 90 per cent of centre brightness instead of
 * 30, and flat across its width instead of falling toward its outer edge.
 *
 * Hestroffer & Magnan 1998, A&A 333, 338, Table 1 (550 nm quadratic).
 */
const LIMB_DARKENING = { a0: 0.3, a1: 0.93, a2: -0.23 } as const;

export function solarLimbIntensity(mu: number): number {
  const m = Math.min(1, Math.max(0, mu));
  return LIMB_DARKENING.a0 + LIMB_DARKENING.a1 * m + LIMB_DARKENING.a2 * m * m;
}

const LIMB_MINIMUM = solarLimbIntensity(0);
const LIMB_PEAK = solarLimbIntensity(1);

/** Radiance at disc centre. The limb law then takes it down to `* LIMB_MINIMUM`. */
const PHOTOSPHERE_RADIANCE =
  (ECLIPSE_HOUR_SKY_RADIANCE * PHOTOSPHERE_LIMB_OVER_SKY) / LIMB_MINIMUM;

/**
 * NASA RP-1318's eclipse exposure guide, as the ladder it is: brightness goes as 2^Q, so
 * one Q step is one stop. Beads Q=12, chromosphere Q=11, prominences Q=9, inner corona
 * (0.1 R_sun above the limb) Q=7.
 *
 * The shipped shader had these in the right order and far too flat -- beads at 12 against a
 * corona peaking near 3.2, a 3.8:1 where the table says 32:1 -- which is why the diamond
 * ring reads as a slightly brighter smudge instead of the blown-out star everybody who has
 * stood in an umbra describes.
 *
 * https://umbra.nascom.nasa.gov/eclipse/941103/tables/table.15
 */
const Q_INNER_CORONA = 7;
const stopsAboveInnerCorona = (q: number): number => 2 ** (q - Q_INNER_CORONA);

const BEADS_OVER_INNER_CORONA = stopsAboveInnerCorona(12);
const CHROMOSPHERE_OVER_INNER_CORONA = stopsAboveInnerCorona(11);
const PROMINENCE_OVER_INNER_CORONA = stopsAboveInnerCorona(9);

/**
 * The diamond ring has no Q of its own in the table: it is the last bead plus the aureole
 * around it, so it is drawn a quarter-stop over a bead. That lands it at 40x the inner
 * corona, inside the 30-60x the study asks for.
 */
const DIAMOND_OVER_BEADS = 1.25;
const DIAMOND_OVER_INNER_CORONA = BEADS_OVER_INNER_CORONA * DIAMOND_OVER_BEADS;

/**
 * The inner corona, closing the chain: a bead is exposed photosphere seen through a lunar
 * valley, so it is drawn at limb radiance, and the Q ladder then puts the corona 32x below
 * it. Nothing here is chosen -- the photosphere ratio above and the Q table fix it.
 *
 * It lands at 1/100 of disc centre where the physical figure is 1e-6, i.e. a compression of
 * about 1e4. That is the gain a dark-adapting eye applies between partial phase and
 * totality, and it is the same admission the Q ladder itself makes: a corona and a
 * photosphere have never been photographed in one exposure either.
 */
const INNER_CORONA_RADIANCE =
  (PHOTOSPHERE_RADIANCE * LIMB_MINIMUM) / BEADS_OVER_INNER_CORONA;

/**
 * Corona brightness as a power law in r = distance from disc *centre* in solar radii,
 * anchored where the Q table's inner corona is quoted (0.1 R_sun above the limb, r = 1.1).
 *
 * `exp(-radial * 17.0)` is 4-8x too flat near the limb: in this shader's uv units it gives
 * 0.257 at r = 1.5 where the ladder gives 0.059, which is exactly why the shipped corona
 * reads as a uniform halo rather than a bright rim with long faint streamers. The K term
 * (Thomson scattering off free electrons) carries r = 1-2, the F term (sunlight off
 * interplanetary dust) takes over beyond 2 and is what makes the streamers reach.
 *
 * Cross-check against the ladder: this profile falls 52.8x from r = 1.1 to r = 2.0 where
 * Q7 -> Q1 says 64x, and is 1.9x bright at r = 1.5. A single exponent cannot also hold the
 * r^-15.9 slope inside r = 1.2; being slightly bright in the rim is the cheap side to err
 * on for a 1.6-degree drawn sun.
 */
const CORONA_ANCHOR_RADII = 1.1;
const CORONA_K_EXPONENT = -7;
const CORONA_F_EXPONENT = -2.5;
const CORONA_F_FRACTION = 0.018;

export function coronaRadialProfile(solarRadii: number): number {
  const r = Math.max(1, solarRadii) / CORONA_ANCHOR_RADII;
  return r ** CORONA_K_EXPONENT + CORONA_F_FRACTION * r ** CORONA_F_EXPONENT;
}

/**
 * Where the drawn corona ends, as a ratio of SUN_RADIUS rather than a uv distance.
 *
 * Naked-eye corona reaches about 2 R_sun from centre. The shipped `smoothstep(0.5, 0.68)`
 * is 3.1-4.25 R_sun of the drawn disc, which is most of the cartoon-halo complaint against
 * the 3x sun -- and it is recoverable here without touching SUN_RADIUS, which is the one
 * thing that must not move.
 */
const CORONA_OUTER_START_RADII = 1.9;
const CORONA_OUTER_END_RADII = 2.6;

/** Solar-minimum coronae are flattened; this keeps the drawn one off a perfect circle. */
const CORONA_EQUATORIAL_STRETCH = 1.22;

const BEAD_RADIANCE = INNER_CORONA_RADIANCE * BEADS_OVER_INNER_CORONA;
const DIAMOND_RADIANCE = INNER_CORONA_RADIANCE * DIAMOND_OVER_INNER_CORONA;
const CHROMOSPHERE_RADIANCE = INNER_CORONA_RADIANCE * CHROMOSPHERE_OVER_INNER_CORONA;
const PROMINENCE_RADIANCE = INNER_CORONA_RADIANCE * PROMINENCE_OVER_INNER_CORONA;

/** The lens-flare cross on the diamond ring, as a fraction of its core. Shipped value. */
const DIAMOND_SPIKE_WEIGHT = 0.42;
/** Three prominence loops can overlap, and `prominenceLoop` is bounded by 1 each. */
const PROMINENCE_LOOP_COUNT = 3;

/**
 * The largest per-channel radiance `SOLAR_FRAGMENT_SHADER` can emit, summing every term at
 * its own peak with every tint normalised to a maximum component of 1.
 *
 * Pinned because a half-float render target holds 65504 and no more, and because going over
 * it is invisible on a dev GPU: Metal stores +Inf, SwiftShader stores NaN, and the frame
 * comes back black in CI only. This billboard raises radiance by 546x, so it is exactly the
 * kind of change that ceiling was written for.
 */
/**
 * The whole ladder, in one place, for the test and for whoever retunes it against a
 * measured exposure. Every entry is `ECLIPSE_HOUR_SKY_RADIANCE` times a stated ratio.
 */
export const SOLAR_RADIANCE = {
  sky: ECLIPSE_HOUR_SKY_RADIANCE,
  limbOverSky: PHOTOSPHERE_LIMB_OVER_SKY,
  photosphere: PHOTOSPHERE_RADIANCE,
  innerCorona: INNER_CORONA_RADIANCE,
  beads: BEAD_RADIANCE,
  diamond: DIAMOND_RADIANCE,
  chromosphere: CHROMOSPHERE_RADIANCE,
  prominence: PROMINENCE_RADIANCE,
} as const;

export const MAX_SOLAR_RADIANCE =
  PHOTOSPHERE_RADIANCE * LIMB_PEAK +
  INNER_CORONA_RADIANCE * coronaRadialProfile(1) +
  CHROMOSPHERE_RADIANCE +
  PROMINENCE_RADIANCE * PROMINENCE_LOOP_COUNT +
  BEAD_RADIANCE +
  DIAMOND_RADIANCE * (1 + 2 * DIAMOND_SPIKE_WEIGHT);

/** `32` is an int in GLSL and `32.0` is not; every interpolated constant goes through here. */
const glslFloat = (value: number): string => {
  const rounded = Number(value.toFixed(4));
  return Number.isInteger(rounded) ? `${rounded}.0` : `${rounded}`;
};

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

    float mu = sqrt(clamp(1.0 - pow(sunDistance / SUN_RADIUS, 2.0), 0.0, 1.0));
    float limbI = ${glslFloat(LIMB_DARKENING.a0)}
      + mu * (${glslFloat(LIMB_DARKENING.a1)} + mu * (${glslFloat(LIMB_DARKENING.a2)}));
    // Limb darkening is stronger in blue, so the crescent is genuinely redder than the disc.
    vec3 sunColor = mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.9, 0.46), mu);
    vec3 color = sunColor * visibleSun * limbI * ${glslFloat(PHOTOSPHERE_RADIANCE)};
    float alpha = visibleSun;

    float angle = atan(p.y, p.x);
    vec2 q = vec2(p.x, p.y * ${glslFloat(CORONA_EQUATORIAL_STRETCH)});
    float coronaRadii = length(q) / SUN_RADIUS;
    float r = max(coronaRadii, 1.0) / ${glslFloat(CORONA_ANCHOR_RADII)};
    float coarseRays = 0.5 + 0.5 * sin(angle * 11.0 + sin(angle * 3.0) * 2.4);
    float fineRays = 0.5 + 0.5 * sin(angle * 37.0 - uTime * 0.11);
    float rayGain = 0.35 + 0.65 * pow(coarseRays, 1.7) * mix(0.75, 1.0, fineRays * uDetail);
    float kCorona = pow(r, ${glslFloat(CORONA_K_EXPONENT)}) * rayGain;
    float fCorona = ${glslFloat(CORONA_F_FRACTION)} * pow(r, ${glslFloat(CORONA_F_EXPONENT)})
      * mix(0.6, 1.0, coarseRays);
    float limbGate = smoothstep(SUN_RADIUS - 0.01, SUN_RADIUS + 0.012, sunDistance);
    float outerFade = 1.0 - smoothstep(
      ${glslFloat(CORONA_OUTER_START_RADII)}, ${glslFloat(CORONA_OUTER_END_RADII)}, coronaRadii);
    float corona = (kCorona + fCorona) * limbGate * outerFade * uCorona;
    // Near-neutral: the K corona is a touch bluer than the photosphere and the F corona a
    // touch warmer. Brightness carries the structure, not hue.
    vec3 coronaColor = mix(vec3(0.92, 0.95, 1.0), vec3(1.0, 0.97, 0.92), coarseRays);
    color += coronaColor * corona * ${glslFloat(INNER_CORONA_RADIANCE)};
    alpha = max(alpha, clamp(corona, 0.0, 1.0));

    float chromosphere =
      exp(-pow((sunDistance - SUN_RADIUS) * 260.0, 2.0)) * uTotality;
    color += vec3(1.0, 0.08, 0.023) * chromosphere * ${glslFloat(CHROMOSPHERE_RADIANCE)};
    alpha = max(alpha, chromosphere);

    float prominence = prominenceLoop(p, 2.48, 0.052, 0.050, 0.3);
    prominence += prominenceLoop(p, -0.43, 0.044, 0.038, 2.1) *
      smoothstep(0.28, 0.58, uProminenceDetail);
    prominence += prominenceLoop(p, 0.92, 0.034, 0.030, 4.4) *
      smoothstep(0.7, 0.96, uProminenceDetail);
    prominence *= uProminences;
    vec3 prominenceColor = mix(
      vec3(0.674, 0.035, 0.008),
      vec3(1.0, 0.149, 0.021),
      clamp(prominence, 0.0, 1.0)
    );
    color += prominenceColor * prominence * ${glslFloat(PROMINENCE_RADIANCE)};
    alpha = max(alpha, prominence * 0.92);

    float edgeContact = exp(-pow((moonDistance - MOON_RADIUS) * 260.0, 2.0));
    float solarEdge = exp(-pow((sunDistance - SUN_RADIUS) * 210.0, 2.0));
    float beadCells = step(0.69, hash(floor((angle + 3.14159265) * 15.0)));
    float beads = edgeContact * solarEdge * beadCells * uBeads;
    // A bead is limb, so it carries the limb's own gradient: dimmer on the sun-limb side,
    // brighter on the side still facing open photosphere.
    float beadShade = mix(0.62, 1.0, smoothstep(0.0, 0.35, mu));
    color += vec3(1.0, 0.73, 0.34) * beads * beadShade * ${glslFloat(BEAD_RADIANCE)};
    alpha = max(alpha, beads);

    float contactSide = uSeparation >= 0.0 ? -1.0 : 1.0;
    vec2 diamondCenter = vec2(contactSide * SUN_RADIUS, 0.0);
    vec2 diamondDelta = p - diamondCenter;
    float diamondCore = exp(-dot(diamondDelta, diamondDelta) * 190.0);
    float diamondHorizontal = exp(-abs(diamondDelta.y) * 82.0 - abs(diamondDelta.x) * 11.0);
    float diamondVertical = exp(-abs(diamondDelta.x) * 82.0 - abs(diamondDelta.y) * 11.0);
    float diamond = (diamondCore
      + (diamondHorizontal + diamondVertical) * ${glslFloat(DIAMOND_SPIKE_WEIGHT)}) * uBeads;
    color += vec3(1.0, 0.78, 0.4) * diamond * ${glslFloat(DIAMOND_RADIANCE)};
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
    // Against the photosphere the moon is BLACK; the old flat 0.5x grey painted earthshine
    // over the bite at every coverage, which is half of why there was no bite to see.
    // uTotality is 0 below coverage 0.985, and 1.3 is the 0.5 + 0.8 the old term reached.
    float visibility = smoothstep(0.0, 0.055, uCoverage);
    gl_FragColor = vec4(
      earthshine * uTotality * 1.3 * uTransmittance,
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
    /**
     * `depthWrite` stays false, and raising radiance 546x is not the change that gets to
     * flip it. The selective bloom the disc is handed to discards it (`keep = !isMaxDepth`,
     * and with both this material and the Sky at depthWrite false the depth under the sun is
     * the cleared 1.0), so the obvious move is to write depth. Three things have to be
     * measured before that, in this order: (1) the null test -- paired captures at fixed
     * world state with `bloomPass.enabled` true and false, scoring masked mean|delta| on the
     * disc minus a surrounding ring, to confirm the mask really is what discards it rather
     * than something downstream; (2) the moon layer, which is the SAME geometry at the SAME
     * anchor drawn after this one and survives only on the default LessEqual depth func --
     * a z-fight there lands precisely on the bite; (3) the composer's depth texture, which
     * also feeds the depth-reading atmosphere pass, the NormalPass override and the
     * DepthOfFieldEffect at focusDistance 58, any of which would newly see a surface at 680.
     */
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
