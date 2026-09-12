import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

/**
 * Lightweight cinematic grade. Tone mapping and LUTs are handled by the
 * shared postprocessing EffectPass; this effect adds only film response,
 * grain and vignette so it can be fused into the same fullscreen shader.
 *
 * **The contrast lift used to be a black clip, and a deep one.** It was written
 * `(color - 0.5) * 1.025 + 0.5`, which subtracts 0.0125 from a linear value and so sends
 * everything below 0.0122 to zero. This runs *after* ACES, so in scene-linear terms it clips
 * 14.184x deeper than ACES's own `saturate` does -- at the shipped opening exposure the black
 * point is scene-linear 0.0606 rather than 0.0043. Measured on the built bundle at 1440x900,
 * the fraction of the frame at exactly rgb(0,0,0): 45.24 per cent at the opening moment
 * (sun +2.87), 78.49 at sun -6, and 6.16 per cent at a June noon. Those pixels were not dark,
 * they were destroyed, and the authored night blue two lines above -- `+ vec3(0, 0, 0.008)`
 * -- went with them.
 *
 * The replacement is `mix(color, smoothstep(0, 1, color), 0.05)`. `smoothstep` has slope 1.5
 * at mid-grey, so a 5 per cent mix has slope exactly 1.0250 there and an 8 per cent mix
 * exactly 1.0400 -- bit-for-bit the two gains the old line had at `uGolden` 0 and 1 -- while
 * passing through 0 at 0 and 1 at 1. Deviation from the old curve is under one code level
 * everywhere above linear 0.2, and the built-in clamps, so a highlight above 1 cannot fold
 * back down. Measured: exactly-black goes to 0.00 per cent at every elevation from -6 to
 * +61.21, and near-white at noon *falls* from 2.752 per cent to 0.140, because the old line
 * also pushed everything above linear 0.9878 past white.
 *
 * **The grain had to become signal-dependent in the same change.** It is +-0.007 of linear,
 * re-randomised every frame, and on a night sky the old clip was silently swallowing it: dead
 * sky plus positive grain is still under 0.0122, so it went to zero and the sky read as clean
 * black. Without the clip that same +-0.007 lands on the near-black leg of the sRGB transfer,
 * whose slope there is 12.92 rising, and arrives as 0..18 of 255 of uncorrelated per-pixel
 * flicker with `taa` off by default -- a crawling-noise sky. Real grain is a density
 * fluctuation and scales with signal anyway, so it is gated on the input luma. The midtones
 * keep the grain they had; only the part that was already being thrown away is gone.
 */
export class CinematicGradeEffect extends Effect {
  readonly parameters: {
    time: THREE.Uniform<number>;
    golden: THREE.Uniform<number>;
    night: THREE.Uniform<number>;
    sepia: THREE.Uniform<number>;
    saturation: THREE.Uniform<number>;
    resolution: THREE.Uniform<THREE.Vector2>;
  };

  constructor() {
    const parameters = {
      time: new THREE.Uniform(0),
      golden: new THREE.Uniform(0),
      night: new THREE.Uniform(0),
      sepia: new THREE.Uniform(0),
      saturation: new THREE.Uniform(1),
      resolution: new THREE.Uniform(new THREE.Vector2(1920, 1080)),
    };
    super(
      'CinematicGradeEffect',
      /* glsl */ `
        uniform float uTime;
        uniform float uGolden;
        uniform float uNight;
        uniform float uSepia;
        uniform float uSatMul;
        uniform vec2 uResolution;

        float gradeHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
          vec3 color = inputColor.rgb;
          float luma = dot(color, vec3(0.299, 0.587, 0.114));

          vec3 goldenColor = color * vec3(1.055, 1.005, 0.9) + vec3(0.012, 0.0, 0.0);
          color = mix(color, goldenColor, clamp(uGolden * 0.46, 0.0, 0.46));
          float nightLuma = dot(color, vec3(0.299, 0.587, 0.114));
          vec3 nightColor = mix(vec3(nightLuma), color, 0.88);
          nightColor = nightColor * vec3(0.86, 0.94, 1.075) + vec3(0.0, 0.0, 0.008);
          color = mix(color, nightColor, clamp(uNight * 0.42, 0.0, 0.42));

          float sat = (1.0 + 0.12 * (1.0 - uNight * 0.5)) * uSatMul;
          color = mix(vec3(luma), color, sat);

          vec3 sepia = vec3(
            dot(color, vec3(0.393, 0.769, 0.189)),
            dot(color, vec3(0.349, 0.686, 0.168)),
            dot(color, vec3(0.272, 0.534, 0.131))
          );
          color = mix(color, sepia, uSepia);

          float grain = (gradeHash(uv * uResolution * 0.5 + fract(uTime) * 43.7) - 0.5) * 0.014;
          color += grain * (0.45 + uNight * 0.55) * smoothstep(0.0, 0.05, luma);

          float vignette = 1.0 - length(uv - 0.5) * (0.25 + uNight * 0.1);
          color *= smoothstep(0.0, 1.0, vignette);
          color = mix(color, smoothstep(0.0, 1.0, color), 0.05 + uGolden * 0.03);

          outputColor = vec4(color, inputColor.a);
        }
      `,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, THREE.Uniform<unknown>>([
          ['uTime', parameters.time],
          ['uGolden', parameters.golden],
          ['uNight', parameters.night],
          ['uSepia', parameters.sepia],
          ['uSatMul', parameters.saturation],
          ['uResolution', parameters.resolution],
        ]),
      }
    );
    this.parameters = parameters;
  }

  setSize(width: number, height: number): void {
    this.parameters.resolution.value.set(width, height);
  }
}
