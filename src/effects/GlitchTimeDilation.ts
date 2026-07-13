import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

/**
 * Lightweight cinematic grade. Tone mapping and LUTs are handled by the
 * shared postprocessing EffectPass; this effect adds only film response,
 * grain and vignette so it can be fused into the same fullscreen shader.
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

          float sat = (1.0 + 0.12 * (1.0 - uNight * 0.5)) * uSatMul;
          color = mix(vec3(luma), color, sat);

          vec3 sepia = vec3(
            dot(color, vec3(0.393, 0.769, 0.189)),
            dot(color, vec3(0.349, 0.686, 0.168)),
            dot(color, vec3(0.272, 0.534, 0.131))
          );
          color = mix(color, sepia, uSepia);

          float grain = (gradeHash(uv * uResolution * 0.5 + fract(uTime) * 43.7) - 0.5) * 0.014;
          color += grain * (0.45 + uNight * 0.55);

          float vignette = 1.0 - length(uv - 0.5) * (0.25 + uNight * 0.1);
          color *= smoothstep(0.0, 1.0, vignette);
          color = (color - 0.5) * (1.025 + uGolden * 0.015) + 0.5;

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
