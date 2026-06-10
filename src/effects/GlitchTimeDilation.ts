/**
 * Cinematic grading pass: golden-hour warmth, cool night cast, film grain
 * and a gentle vignette. No geometric distortion — the diorama stays crisp.
 * (File keeps its historical name so imports stay stable.)
 */

export const GlitchTimeDilationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGolden: { value: 0 },
    uNight: { value: 0 },
    uSepia: { value: 0 },
    uSatMul: { value: 1 },
    uResolution: { value: new Float32Array([1920, 1080]) },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGolden;
    uniform float uNight;
    uniform float uSepia;
    uniform float uSatMul;
    uniform vec2 uResolution;

    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec3 color = texture2D(tDiffuse, uv).rgb;

      // ── Golden hour: warm highlights, slightly lifted shadows ──
      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 warm = color * vec3(1.10, 1.0, 0.86) + vec3(0.035, 0.012, 0.0);
      color = mix(color, warm, uGolden * smoothstep(0.15, 0.85, luma + 0.25));

      // ── Night: cool cast + mild desaturation ──
      vec3 cool = mix(vec3(luma), color, 0.78) * vec3(0.86, 0.92, 1.10);
      color = mix(color, cool, uNight * 0.55);

      // ── Vibrance (scaled per theme) ──
      float sat = (1.0 + 0.22 * (1.0 - uNight * 0.5)) * uSatMul;
      color = mix(vec3(dot(color, vec3(0.299, 0.587, 0.114))), color, sat);

      // ── Theme sepia grade ──
      vec3 sepia = vec3(
        dot(color, vec3(0.393, 0.769, 0.189)),
        dot(color, vec3(0.349, 0.686, 0.168)),
        dot(color, vec3(0.272, 0.534, 0.131))
      );
      color = mix(color, sepia, uSepia);

      // ── Film grain (fixed spatial scale, time-jittered) ──
      float grain = (hash(uv * uResolution * 0.5 + fract(uTime) * 43.7) - 0.5) * 0.022;
      color += grain * (0.6 + uNight * 0.8);

      // ── Vignette ──
      float vignette = 1.0 - length(uv - 0.5) * (0.34 + uNight * 0.12);
      vignette = smoothstep(0.0, 1.0, vignette);
      color *= vignette;

      // ── Gentle contrast ──
      color = (color - 0.5) * 1.06 + 0.5;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
