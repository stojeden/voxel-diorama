import * as THREE from 'three';
import {
  BlendFunction,
  Effect,
  EffectAttribute,
} from 'postprocessing';
import type { RandomSource } from '../core/Random';
import { fallbackRandom } from '../core/Random';
import type { QualityLevel } from '../performance/QualityManager';
import { RAINBOW_MOISTURE_ZONES, WORLD_HALF_SIZE } from '../world/WorldLayout';
import {
  PRIMARY_RAINBOW_MAX_ANGLE_RAD,
  RAINBOW_SPECTRAL_SAMPLES,
  SECONDARY_RAINBOW_SUPPORT_MAX_ANGLE_RAD,
  rainbowRayAtImpact,
  type RainbowOrder,
} from './RainbowOptics';

const SPECTRAL_LUT_WIDTH = 1024;
const SPECTRAL_LUT_HEIGHT = 2;
const SPECTRAL_LUT_MIN_ANGLE_RAD = 0;
const SPECTRAL_LUT_MAX_ANGLE_RAD = Math.PI * 0.5;
const SPECTRAL_LUT_MIN_MU = Math.cos(SPECTRAL_LUT_MAX_ANGLE_RAD);
const SPECTRAL_LUT_MAX_MU = Math.cos(SPECTRAL_LUT_MIN_ANGLE_RAD);
const HISTOGRAM_MIN_ANGLE_RAD = SPECTRAL_LUT_MIN_ANGLE_RAD;
const HISTOGRAM_MAX_ANGLE_RAD = SPECTRAL_LUT_MAX_ANGLE_RAD;
const HISTOGRAM_BINS = 2048;
const IMPACT_PARAMETER_SAMPLES = 8192;
const SOLAR_DISC_RADIUS_RAD = THREE.MathUtils.degToRad(0.2666);
// Relative phase-function energy is physical; absolute scene radiometry is not.
// This single shared exposure maps that energy into the existing HDR pipeline.
const RAINBOW_EXPOSURE_CALIBRATION = 7;

export interface RainbowFrameInput {
  camera: THREE.PerspectiveCamera;
  sunDirection: THREE.Vector3;
  sunElevation: number;
  sunColor: THREE.Color;
  directSun: number;
  cloudCover: number;
  rainIntensity: number;
  airborneMoisture: number;
  wind: number;
  realDelta: number;
  elapsed: number;
}

export interface RainbowDebugState {
  visible: boolean;
  effectActive: boolean;
  strength: number;
  extinction: number;
  source: string;
  sourceIndex: number;
  sourceCenter: [number, number, number];
  sourceRadii: [number, number, number];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

interface SpectralLut {
  texture: THREE.DataTexture;
  muRange: THREE.Vector2;
}

function depositLinear(
  histogram: Float64Array,
  row: number,
  angleRad: number,
  red: number,
  green: number,
  blue: number
): void {
  const unit = (
    angleRad - HISTOGRAM_MIN_ANGLE_RAD
  ) / (
    HISTOGRAM_MAX_ANGLE_RAD - HISTOGRAM_MIN_ANGLE_RAD
  );
  const position = unit * (HISTOGRAM_BINS - 1);
  const lower = Math.floor(position);
  if (lower < 0 || lower >= HISTOGRAM_BINS) return;
  const upper = Math.min(HISTOGRAM_BINS - 1, lower + 1);
  const fraction = position - lower;
  const rowOffset = row * HISTOGRAM_BINS * 3;
  const lowerOffset = rowOffset + lower * 3;
  const upperOffset = rowOffset + upper * 3;
  const lowerWeight = 1 - fraction;
  histogram[lowerOffset] += red * lowerWeight;
  histogram[lowerOffset + 1] += green * lowerWeight;
  histogram[lowerOffset + 2] += blue * lowerWeight;
  histogram[upperOffset] += red * fraction;
  histogram[upperOffset + 1] += green * fraction;
  histogram[upperOffset + 2] += blue * fraction;
}

function blurBySolarDisc(phase: Float64Array): Float64Array {
  const angleStep = (
    HISTOGRAM_MAX_ANGLE_RAD - HISTOGRAM_MIN_ANGLE_RAD
  ) / (HISTOGRAM_BINS - 1);
  const kernelRadius = Math.ceil(SOLAR_DISC_RADIUS_RAD / angleStep);
  const kernel = new Float64Array(kernelRadius * 2 + 1);
  let kernelSum = 0;
  for (let offset = -kernelRadius; offset <= kernelRadius; offset++) {
    const delta = offset * angleStep;
    const weight = Math.abs(delta) <= SOLAR_DISC_RADIUS_RAD
      ? 2 * Math.sqrt(
        SOLAR_DISC_RADIUS_RAD ** 2 - delta ** 2
      ) / (Math.PI * SOLAR_DISC_RADIUS_RAD ** 2)
      : 0;
    kernel[offset + kernelRadius] = weight;
    kernelSum += weight;
  }
  for (let index = 0; index < kernel.length; index++) {
    kernel[index] /= kernelSum;
  }

  const blurred = new Float64Array(phase.length);
  for (let row = 0; row < SPECTRAL_LUT_HEIGHT; row++) {
    const rowOffset = row * HISTOGRAM_BINS * 3;
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      for (let offset = -kernelRadius; offset <= kernelRadius; offset++) {
        const sourceBin = bin + offset;
        if (sourceBin < 0 || sourceBin >= HISTOGRAM_BINS) continue;
        const weight = kernel[offset + kernelRadius];
        const sourceOffset = rowOffset + sourceBin * 3;
        const targetOffset = rowOffset + bin * 3;
        blurred[targetOffset] += phase[sourceOffset] * weight;
        blurred[targetOffset + 1] += phase[sourceOffset + 1] * weight;
        blurred[targetOffset + 2] += phase[sourceOffset + 2] * weight;
      }
    }
  }
  // Convolution on a uniform angular axis slightly changes the spherical
  // integral because annuli scale with sin(alpha). Preserve the signed energy
  // of every linear-RGB channel before the later common display calibration.
  for (let row = 0; row < SPECTRAL_LUT_HEIGHT; row++) {
    for (let channel = 0; channel < 3; channel++) {
      let before = 0;
      let after = 0;
      for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
        const angle = HISTOGRAM_MIN_ANGLE_RAD + bin * angleStep;
        const solidAngleWeight = 2 * Math.PI * Math.sin(angle) * angleStep;
        const offset = (row * HISTOGRAM_BINS + bin) * 3 + channel;
        before += phase[offset] * solidAngleWeight;
        after += blurred[offset] * solidAngleWeight;
      }
      if (Math.abs(after) <= 1e-12) continue;
      const correction = before / after;
      for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
        const offset = (row * HISTOGRAM_BINS + bin) * 3 + channel;
        blurred[offset] *= correction;
      }
    }
  }
  return blurred;
}

function sampleHistogram(
  histogram: Float64Array,
  row: number,
  angleRad: number,
  channel: number
): number {
  const unit = THREE.MathUtils.clamp(
    (
      angleRad - HISTOGRAM_MIN_ANGLE_RAD
    ) / (
      HISTOGRAM_MAX_ANGLE_RAD - HISTOGRAM_MIN_ANGLE_RAD
    ),
    0,
    1
  );
  const position = unit * (HISTOGRAM_BINS - 1);
  const lower = Math.floor(position);
  const upper = Math.min(HISTOGRAM_BINS - 1, lower + 1);
  const fraction = position - lower;
  const rowOffset = row * HISTOGRAM_BINS * 3;
  const lowerValue = histogram[rowOffset + lower * 3 + channel];
  const upperValue = histogram[rowOffset + upper * 3 + channel];
  return THREE.MathUtils.lerp(lowerValue, upperValue, fraction);
}

/**
 * CPU-baked phase-function table. Uniform samples in squared impact parameter
 * provide the physical 2b db cross-sectional measure. Depositing complete
 * spherical-drop rays into solid-angle bins recovers the caustic Jacobian,
 * both ray branches and Alexander's dark interval without a singular formula.
 * The finite uniform solar disc then regularizes the geometrical caustics.
 */
function bakeSpectralLutData(): Uint16Array {
  const histogram = new Float64Array(
    HISTOGRAM_BINS * SPECTRAL_LUT_HEIGHT * 3
  );
  for (let spectralIndex = 0; spectralIndex < RAINBOW_SPECTRAL_SAMPLES.length; spectralIndex++) {
    const sample = RAINBOW_SPECTRAL_SAMPLES[spectralIndex];
    const wavelengthWeight =
      spectralIndex === 0 || spectralIndex === RAINBOW_SPECTRAL_SAMPLES.length - 1
        ? 0.5
        : 1;
    for (let impactIndex = 0; impactIndex < IMPACT_PARAMETER_SAMPLES; impactIndex++) {
      const impactParameter = Math.sqrt(
        (impactIndex + 0.5) / IMPACT_PARAMETER_SAMPLES
      );
      for (const order of [1, 2] as readonly RainbowOrder[]) {
        const ray = rainbowRayAtImpact(
          sample.wavelengthNm,
          order,
          impactParameter
        );
        if (!ray) continue;
        const weight =
          wavelengthWeight * ray.throughput / IMPACT_PARAMETER_SAMPLES;
        depositLinear(
          histogram,
          order - 1,
          ray.angularRadiusRad,
          sample.spectralLinearRgb[0] * weight,
          sample.spectralLinearRgb[1] * weight,
          sample.spectralLinearRgb[2] * weight
        );
      }
    }
  }

  // Uniform alpha bins do not subtend equal solid angle. Division by the
  // annular solid angle turns deposited energy into radiance per steradian.
  const angleStep = (
    HISTOGRAM_MAX_ANGLE_RAD - HISTOGRAM_MIN_ANGLE_RAD
  ) / (HISTOGRAM_BINS - 1);
  for (let row = 0; row < SPECTRAL_LUT_HEIGHT; row++) {
    for (let bin = 0; bin < HISTOGRAM_BINS; bin++) {
      const center = HISTOGRAM_MIN_ANGLE_RAD + bin * angleStep;
      const lower = Math.max(HISTOGRAM_MIN_ANGLE_RAD, center - angleStep * 0.5);
      const upper = Math.min(HISTOGRAM_MAX_ANGLE_RAD, center + angleStep * 0.5);
      const solidAngle = 2 * Math.PI * (Math.cos(lower) - Math.cos(upper));
      const offset = (row * HISTOGRAM_BINS + bin) * 3;
      histogram[offset] /= solidAngle;
      histogram[offset + 1] /= solidAngle;
      histogram[offset + 2] /= solidAngle;
    }
  }
  const blurred = blurBySolarDisc(histogram);
  const radiance = new Float32Array(
    SPECTRAL_LUT_WIDTH * SPECTRAL_LUT_HEIGHT * 3
  );
  let positivePeak = 0;
  for (let row = 0; row < SPECTRAL_LUT_HEIGHT; row++) {
    for (let x = 0; x < SPECTRAL_LUT_WIDTH; x++) {
      const unit = x / (SPECTRAL_LUT_WIDTH - 1);
      const mu = THREE.MathUtils.lerp(
        SPECTRAL_LUT_MIN_MU,
        SPECTRAL_LUT_MAX_MU,
        unit
      );
      const angle = Math.acos(mu);
      for (let channel = 0; channel < 3; channel++) {
        const value = sampleHistogram(blurred, row, angle, channel);
        radiance[(row * SPECTRAL_LUT_WIDTH + x) * 3 + channel] = value;
        positivePeak = Math.max(positivePeak, value);
      }
    }
  }
  const commonScale = positivePeak > 0 ? 1 / positivePeak : 1;
  const halfFloatData = new Uint16Array(
    SPECTRAL_LUT_WIDTH * SPECTRAL_LUT_HEIGHT * 4
  );
  for (let texel = 0; texel < SPECTRAL_LUT_WIDTH * SPECTRAL_LUT_HEIGHT; texel++) {
    const radianceOffset = texel * 3;
    const textureOffset = texel * 4;
    halfFloatData[textureOffset] = THREE.DataUtils.toHalfFloat(
      radiance[radianceOffset] * commonScale
    );
    halfFloatData[textureOffset + 1] = THREE.DataUtils.toHalfFloat(
      radiance[radianceOffset + 1] * commonScale
    );
    halfFloatData[textureOffset + 2] = THREE.DataUtils.toHalfFloat(
      radiance[radianceOffset + 2] * commonScale
    );
    halfFloatData[textureOffset + 3] = THREE.DataUtils.toHalfFloat(1);
  }

  return halfFloatData;
}

let cachedSpectralLutData: Uint16Array | undefined;

function createSpectralLut(): SpectralLut {
  cachedSpectralLutData ??= bakeSpectralLutData();
  const texture = new THREE.DataTexture(
    cachedSpectralLutData.slice(),
    SPECTRAL_LUT_WIDTH,
    SPECTRAL_LUT_HEIGHT,
    THREE.RGBAFormat,
    THREE.HalfFloatType
  );
  texture.name = 'RainbowSpectralLut';
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return {
    texture,
    muRange: new THREE.Vector2(SPECTRAL_LUT_MIN_MU, SPECTRAL_LUT_MAX_MU),
  };
}

const FRAGMENT_SHADER = /* glsl */ `
  uniform mat4 uInverseProjection;
  uniform mat4 uCameraWorld;
  uniform vec3 uCameraPosition;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSourceCenter;
  uniform vec3 uSourceRadii;
  uniform float uSourceBaseY;
  uniform sampler2D uSpectralLut;
  uniform vec2 uSpectralMuRange;
  uniform float uStrength;
  uniform float uExtinction;
  uniform float uRadianceScale;
  uniform float uSecondary;
  uniform float uTime;

  void mainImage(
    const in vec4 inputColor,
    const in vec2 uv,
    const in float depth,
    out vec4 outputColor
  ) {
    if (uStrength <= 0.0005 && uExtinction <= 0.0005) {
      outputColor = inputColor;
      return;
    }

    vec2 ndc = uv * 2.0 - 1.0;
    vec4 viewFar = uInverseProjection * vec4(ndc, 1.0, 1.0);
    viewFar /= viewFar.w;
    vec3 viewRay = normalize((uCameraWorld * vec4(viewFar.xyz, 0.0)).xyz);

    vec3 rayOrigin = (uCameraPosition - uSourceCenter) / uSourceRadii;
    vec3 rayDirection = viewRay / uSourceRadii;
    float qa = dot(rayDirection, rayDirection);
    float qb = dot(rayOrigin, rayDirection);
    float qc = dot(rayOrigin, rayOrigin) - 1.0;
    float discriminant = qb * qb - qa * qc;
    if (discriminant <= 0.0) {
      outputColor = inputColor;
      return;
    }

    float root = sqrt(discriminant);
    float entry = max((-qb - root) / qa, 0.0);
    float exit = (-qb + root) / qa;
    if (exit <= 0.0) {
      outputColor = inputColor;
      return;
    }

    // Clip the illuminated chord to the first opaque surface from the current
    // frame. Droplets behind buildings, terrain or the lake never contribute.
    vec4 sceneView = uInverseProjection * vec4(ndc, depth * 2.0 - 1.0, 1.0);
    sceneView /= sceneView.w;
    float sceneDistance = length(sceneView.xyz);
    exit = min(exit, max(sceneDistance - 0.04, 0.0));

    // The local volume is a rain curtain, never a subterranean aerosol.
    if (viewRay.y < -0.0001) {
      exit = min(exit, (uSourceBaseY - uCameraPosition.y) / viewRay.y);
    } else if (viewRay.y > 0.0001 && uCameraPosition.y < uSourceBaseY) {
      entry = max(entry, (uSourceBaseY - uCameraPosition.y) / viewRay.y);
    } else if (uCameraPosition.y < uSourceBaseY) {
      outputColor = inputColor;
      return;
    }

    float pathLength = max(0.0, exit - entry);
    if (pathLength <= 0.001) {
      outputColor = inputColor;
      return;
    }

    float transmission = exp(
      -pathLength * 0.006 * uExtinction
    );
    if (uStrength <= 0.0005) {
      outputColor = vec4(inputColor.rgb * transmission, inputColor.a);
      return;
    }

    float mu = dot(viewRay, -uSunDirection);
    float spectralU = clamp(
      (mu - uSpectralMuRange.x) /
        max(uSpectralMuRange.y - uSpectralMuRange.x, 0.00001),
      0.0,
      1.0
    );
    float spectralMask =
      step(uSpectralMuRange.x, mu) *
      step(mu, uSpectralMuRange.y);
    vec3 primaryColor = vec3(0.0);
    vec3 secondaryColor = vec3(0.0);
    primaryColor = texture2D(
      uSpectralLut,
      vec2(spectralU, 0.25)
    ).rgb * spectralMask;
    if (uSecondary > 0.5) {
      secondaryColor = texture2D(
        uSpectralLut,
        vec2(spectralU, 0.75)
      ).rgb * spectralMask;
    }

    vec3 hitPosition = uCameraPosition + viewRay * entry;
    float structure = 0.94 + 0.06 * sin(
      dot(hitPosition.xz, vec2(0.071, 0.113)) +
      hitPosition.y * 0.083 +
      uTime * 0.018
    );
    float scatteredFraction = 1.0 - transmission;
    vec3 spectralRadiance = max(
      primaryColor + secondaryColor * uSecondary,
      vec3(0.0)
    );
    spectralRadiance *= uSunColor * (
      scatteredFraction * uRadianceScale * structure *
      ${RAINBOW_EXPOSURE_CALIBRATION.toFixed(1)}
    );

    // Alexander's band is the naturally unlit interval between the two ray
    // families. We do not fake it by absorbing or darkening the background.
    outputColor = vec4(
      inputColor.rgb * transmission + spectralRadiance,
      inputColor.a
    );
  }
`;

class RainbowRenderEffect extends Effect {
  readonly inverseProjection: THREE.Matrix4;
  readonly cameraWorld: THREE.Matrix4;
  readonly cameraPosition: THREE.Vector3;
  readonly sunDirection: THREE.Vector3;
  readonly sunColor: THREE.Color;
  readonly sourceCenter: THREE.Vector3;
  readonly sourceRadii: THREE.Vector3;
  /**
   * Direct property ownership is deliberate: Effect.dispose() discovers and
   * disposes owned textures. EffectPass is the sole owner of this Effect.
   */
  readonly spectralLut: THREE.DataTexture;
  readonly spectralMuRange: THREE.Vector2;

  constructor(sourceCenter: THREE.Vector3, sourceRadii: THREE.Vector3) {
    const inverseProjection = new THREE.Matrix4();
    const cameraWorld = new THREE.Matrix4();
    const cameraPosition = new THREE.Vector3();
    const sunDirection = new THREE.Vector3(0, 1, 0);
    const sunColor = new THREE.Color(1, 1, 1);
    const spectralLut = createSpectralLut();
    super('RainbowAtmosphereEffect', FRAGMENT_SHADER, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uInverseProjection', new THREE.Uniform(inverseProjection)],
        ['uCameraWorld', new THREE.Uniform(cameraWorld)],
        ['uCameraPosition', new THREE.Uniform(cameraPosition)],
        ['uSunDirection', new THREE.Uniform(sunDirection)],
        ['uSunColor', new THREE.Uniform(sunColor)],
        ['uSourceCenter', new THREE.Uniform(sourceCenter)],
        ['uSourceRadii', new THREE.Uniform(sourceRadii)],
        ['uSourceBaseY', new THREE.Uniform(0)],
        ['uSpectralLut', new THREE.Uniform(spectralLut.texture)],
        ['uSpectralMuRange', new THREE.Uniform(spectralLut.muRange)],
        ['uStrength', new THREE.Uniform(0)],
        ['uExtinction', new THREE.Uniform(0)],
        ['uRadianceScale', new THREE.Uniform(0)],
        ['uSecondary', new THREE.Uniform(1)],
        ['uTime', new THREE.Uniform(0)],
      ]),
    });
    this.inverseProjection = inverseProjection;
    this.cameraWorld = cameraWorld;
    this.cameraPosition = cameraPosition;
    this.sunDirection = sunDirection;
    this.sunColor = sunColor;
    this.sourceCenter = sourceCenter;
    this.sourceRadii = sourceRadii;
    this.spectralLut = spectralLut.texture;
    this.spectralMuRange = spectralLut.muRange;
  }
}

/**
 * Observer-relative rainbow caustic, spatially limited by a deterministic,
 * depth-clipped rain curtain selected from natural zones in WorldLayout.
 */
export class RainbowAtmosphere {
  readonly effect: Effect;
  private readonly renderEffect: RainbowRenderEffect;
  private readonly random: RandomSource;
  private readonly sourceCenter = new THREE.Vector3();
  private readonly sourceRadii = new THREE.Vector3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly viewFrustum = new THREE.Frustum();
  private strength = 0;
  private extinctionStrength = 0;
  private sourceIndex = 0;
  private rainEventLatched = false;
  private debugLocked = false;
  private quality: QualityLevel = 'high';
  private geometryCanContribute = false;
  private rainbowGeometryCanContribute = false;

  constructor(random: RandomSource = fallbackRandom('rainbow-source')) {
    this.random = random;
    this.selectSource(0, false);
    this.renderEffect = new RainbowRenderEffect(this.sourceCenter, this.sourceRadii);
    this.effect = this.renderEffect;
  }

  setQuality(level: QualityLevel): void {
    this.quality = level;
    this.renderEffect.uniforms.get('uSecondary')!.value = level === 'high' ? 1 : 0;
  }

  update(input: RainbowFrameInput): void {
    if (!this.debugLocked) {
      if (input.rainIntensity > 0.42 && !this.rainEventLatched) {
        this.rainEventLatched = true;
        this.selectSource(undefined, true);
      } else if (input.rainIntensity < 0.08) {
        this.rainEventLatched = false;
      }
    }

    if (
      !this.debugLocked &&
      Math.max(this.strength, this.extinctionStrength) > 0.001 &&
      input.realDelta > 0
    ) {
      this.sourceCenter.x = THREE.MathUtils.clamp(
        this.sourceCenter.x + input.wind * input.realDelta * 0.24,
        -WORLD_HALF_SIZE + 8,
        WORLD_HALF_SIZE - 8
      );
    }

    const clearing = 1 - smoothstep(0.08, 0.5, input.rainIntensity);
    const cloudOpening = 1 - smoothstep(0.68, 0.96, input.cloudCover);
    const extinction = THREE.MathUtils.clamp(
      input.airborneMoisture * clearing,
      0,
      1
    );
    const irradiance = THREE.MathUtils.clamp(
      input.directSun * cloudOpening,
      0,
      1
    );
    const target = input.sunElevation > 0
      ? extinction * irradiance
      : 0;
    const response = 1 - Math.exp(
      -Math.max(0, input.realDelta) * (target > this.strength ? 0.75 : 0.32)
    );
    this.strength += (target - this.strength) * response;
    const extinctionResponse = 1 - Math.exp(
      -Math.max(0, input.realDelta) * (
        extinction > this.extinctionStrength ? 0.75 : 0.32
      )
    );
    this.extinctionStrength += (
      extinction - this.extinctionStrength
    ) * extinctionResponse;
    if (this.debugLocked && input.realDelta === 0) {
      this.strength = target;
      this.extinctionStrength = extinction;
    }

    const effect = this.renderEffect;
    effect.uniforms.get('uExtinction')!.value = this.extinctionStrength;
    if (
      this.strength <= 0.0015 &&
      this.extinctionStrength <= 0.0015
    ) {
      this.geometryCanContribute = false;
      this.rainbowGeometryCanContribute = false;
      effect.uniforms.get('uStrength')!.value = 0;
      effect.uniforms.get('uRadianceScale')!.value = 0;
      return;
    }

    effect.cameraPosition.setFromMatrixPosition(input.camera.matrixWorld);
    const sourceBaseY = this.sourceCenter.y - this.sourceRadii.y;
    const maximumSupportedAngle = this.quality === 'high'
      ? SECONDARY_RAINBOW_SUPPORT_MAX_ANGLE_RAD
      : Math.min(
        Math.PI * 0.5,
        PRIMARY_RAINBOW_MAX_ANGLE_RAD +
          SOLAR_DISC_RADIUS_RAD +
          0.5 * (
            SPECTRAL_LUT_MAX_ANGLE_RAD - SPECTRAL_LUT_MIN_ANGLE_RAD
          ) / (SPECTRAL_LUT_WIDTH - 1)
      );
    // At the curtain base a cone entirely below the local horizon cannot hit
    // illuminated drops. Elevated cameras remain valid: they can see downward
    // portions of the same observer-relative cone.
    this.geometryCanContribute = this.sourceIntersectsFrustum(input.camera);
    this.rainbowGeometryCanContribute =
      (
        effect.cameraPosition.y > sourceBaseY + 0.05 ||
        input.sunElevation < maximumSupportedAngle
      );
    const renderStrength = this.rainbowGeometryCanContribute
      ? this.strength
      : 0;
    effect.uniforms.get('uStrength')!.value = renderStrength;
    effect.uniforms.get('uRadianceScale')!.value =
      this.extinctionStrength > 1e-5
        ? renderStrength / this.extinctionStrength
        : 0;
    if (!this.geometryCanContribute) return;

    effect.inverseProjection.copy(input.camera.projectionMatrixInverse);
    effect.cameraWorld.copy(input.camera.matrixWorld);
    effect.sunDirection.copy(input.sunDirection).normalize();
    effect.sunColor.copy(input.sunColor);
    effect.uniforms.get('uSourceBaseY')!.value = sourceBaseY;
    effect.uniforms.get('uTime')!.value = input.elapsed;
  }

  isVisible(): boolean {
    return (
      this.geometryCanContribute &&
      this.rainbowGeometryCanContribute &&
      this.strength > 0.0015
    );
  }

  /**
   * The wet curtain can still attenuate the scene when direct sunlight is
   * blocked. Keep the post-process alive without reporting a visible rainbow.
   */
  isEffectActive(): boolean {
    return (
      this.geometryCanContribute &&
      this.extinctionStrength > 0.0015
    );
  }

  /** Freeze only the natural source selection; irradiance remains physical. */
  debugSetSource(index: number): void {
    this.debugLocked = true;
    this.selectSource(Number.isFinite(index) ? index : 0, false);
  }

  releaseDebugSource(): void {
    this.debugLocked = false;
  }

  getDebugState(): RainbowDebugState {
    const zone = RAINBOW_MOISTURE_ZONES[this.sourceIndex];
    return {
      visible: this.isVisible(),
      effectActive: this.isEffectActive(),
      strength: this.strength,
      extinction: this.extinctionStrength,
      source: zone.id,
      sourceIndex: this.sourceIndex,
      sourceCenter: this.sourceCenter.toArray(),
      sourceRadii: this.sourceRadii.toArray(),
    };
  }

  private selectSource(requestedIndex?: number, jitter = true): void {
    const count = RAINBOW_MOISTURE_ZONES.length;
    const index = requestedIndex === undefined
      ? Math.min(count - 1, Math.floor(this.random() * count))
      : ((Math.round(requestedIndex) % count) + count) % count;
    const zone = RAINBOW_MOISTURE_ZONES[index];
    const jitterX = jitter ? (this.random() - 0.5) * zone.jitterX * 2 : 0;
    const jitterZ = jitter ? (this.random() - 0.5) * zone.jitterZ * 2 : 0;
    const height = jitter ? 26 + this.random() * 4 : 27;
    this.sourceIndex = index;
    this.sourceCenter.set(zone.x + jitterX, height, zone.z + jitterZ);
    this.sourceRadii.set(
      jitter ? 46 + this.random() * 17 : 62,
      height - zone.baseY,
      jitter ? 25 + this.random() * 13 : 30
    );
  }

  private sourceIntersectsFrustum(camera: THREE.PerspectiveCamera): boolean {
    this.viewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    this.viewFrustum.setFromProjectionMatrix(this.viewProjection);
    for (let index = 0; index < this.viewFrustum.planes.length; index++) {
      const plane = this.viewFrustum.planes[index];
      const normal = plane.normal;
      const projectedRadius = Math.sqrt(
        (normal.x * this.sourceRadii.x) ** 2 +
        (normal.y * this.sourceRadii.y) ** 2 +
        (normal.z * this.sourceRadii.z) ** 2
      );
      if (plane.distanceToPoint(this.sourceCenter) < -projectedRadius) {
        return false;
      }
    }
    return true;
  }
}
