import * as THREE from 'three';
import { WINDOW_COHORT_COUNT } from '../../environment/CityRhythm';
import { PALETTE_SIZE, resolveEmissive, resolvePalette, resolveParams, resolveSnowTints } from './palette';

/** Per-vertex surface style read by the shader. */
export const STYLE = { plain: 0, seams: 1, pavement: 2, asphalt: 3, glass: 4 } as const;

export interface HybridUniforms {
  uPalette: THREE.IUniform<Float32Array>;
  uSnowTint: THREE.IUniform<Float32Array>;
  uParams: THREE.IUniform<Float32Array>;
  uEmissive: THREE.IUniform<Float32Array>;
  uCohort: THREE.IUniform<Float32Array>;
  uSnow: THREE.IUniform<number>;
  uWet: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uLit: THREE.IUniform<THREE.Color>;
}

export function createHybridUniforms(): HybridUniforms {
  return {
    uPalette: { value: resolvePalette({}) },
    uSnowTint: { value: resolveSnowTints() },
    uParams: { value: resolveParams() },
    uEmissive: { value: resolveEmissive() },
    uCohort: { value: new Float32Array(WINDOW_COHORT_COUNT) },
    uSnow: { value: 0 },
    uWet: { value: 0 },
    uNight: { value: 0 },
    uLit: { value: new THREE.Color(0xffdd88) },
  };
}

const NOISE = /* glsl */ `
  float hbHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float hbNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hbHash(i), hbHash(i + vec3(1,0,0)), f.x), mix(hbHash(i + vec3(0,1,0)), hbHash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hbHash(i + vec3(0,0,1)), hbHash(i + vec3(1,0,1)), f.x), mix(hbHash(i + vec3(0,1,1)), hbHash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

/**
 * One MeshStandardMaterial for every hybrid layer. Colour, roughness, metalness,
 * snow and wetness come from palette uniforms indexed per vertex; lit windows read
 * the same cohort activity that `DayNightCycle` applies to voxel windows. Because
 * every LOD layer shares this material and attribute contract, LOD switches cannot
 * change semantics.
 */
export function createHybridMaterial(
  uniforms: HybridUniforms,
  options: { transparent?: boolean; envMapIntensity?: number } = {}
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: !!options.transparent,
    opacity: options.transparent ? 0.42 : 1,
    depthWrite: !options.transparent,
  });
  // Glass reads as glass because it reflects the sky: the product gives its windows
  // envIntensity 2.0 and the fragment has the same throttled PMREM environment.
  material.envMapIntensity = options.envMapIntensity ?? 1;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute float aPalette; attribute float aCohort; attribute float aAo; attribute float aStyle;
        varying float vPalette; varying float vCohort; varying float vAo; varying float vStyle;
        varying vec3 vWPos; varying vec3 vWNormal;`
      )
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
        vPalette = aPalette; vCohort = aCohort; vAo = aAo; vStyle = aStyle;
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * objectNormal);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform vec3 uPalette[${PALETTE_SIZE}];
        uniform vec3 uSnowTint[${PALETTE_SIZE}];
        uniform vec4 uParams[${PALETTE_SIZE}];
        uniform float uEmissive[${PALETTE_SIZE}];
        uniform float uCohort[${WINDOW_COHORT_COUNT}];
        uniform float uSnow; uniform float uWet; uniform float uNight; uniform vec3 uLit;
        varying float vPalette; varying float vCohort; varying float vAo; varying float vStyle;
        varying vec3 vWPos; varying vec3 vWNormal;
        ${NOISE}`
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        int hbIdx = int(vPalette + 0.5);
        vec4 hbPrm = uParams[hbIdx];
        vec3 hbCol = uPalette[hbIdx];
        float hbUp = clamp(vWNormal.y, 0.0, 1.0);
        float hbActivity = 0.0;
        if (vStyle > 3.5) {
          if (vCohort > -0.5) { hbActivity = uCohort[int(vCohort + 0.5)]; }
          hbCol = mix(hbCol, uLit, hbActivity);
        } else {
          float hbN = hbNoise(vWPos * 0.9) * 0.55 + hbNoise(vWPos * 4.1) * 0.3 + hbNoise(vWPos * 15.0) * 0.15;
          hbCol *= 1.0 + (hbN - 0.5) * 0.08;
          if (vStyle < 1.5) hbCol *= 1.0 - 0.16 * (1.0 - smoothstep(-0.5, 1.6, vWPos.y)) * (1.0 - hbUp);
          if (vStyle > 0.5 && vStyle < 1.5) {
            float vc = abs(vWNormal.x) > 0.5 ? vWPos.z : vWPos.x;
            float fy = abs(fract((vWPos.y + 0.5) / 2.8 + 0.5) - 0.5) * 2.8;
            float fx = abs(fract(vc / 3.0 + 0.5) - 0.5) * 3.0;
            hbCol *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.05, min(fy, fx))) * (1.0 - hbUp);
          }
          if (vStyle > 1.5 && vStyle < 2.5 && hbUp > 0.5) {
            vec2 g = abs(fract(vWPos.xz * 2.0 + 0.5) - 0.5) * 0.5;
            hbCol *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.02, min(g.x, g.y)));
          }
          if (vStyle > 2.5 && vStyle < 3.5 && hbUp > 0.5) {
            hbCol *= 1.0 - 0.09 * smoothstep(0.55, 0.75, hbNoise(vWPos * 0.35 + 7.0));
          }
          hbCol = mix(hbCol, uSnowTint[hbIdx], uSnow * hbPrm.w * smoothstep(0.35, 0.8, hbUp));
          hbCol *= 1.0 - uWet * hbPrm.z * 0.38;
        }
        diffuseColor.rgb = hbCol * vAo;`
      )
      // A lit pane has to read as lit, and a metallic surface has almost no diffuse
      // to read it with. The product solves this by swapping the window material
      // outright (COLORS.window 0.08/0.65 -> COLORS.windowLit 0.18/0.40); one shared
      // material cannot swap, so it interpolates to the same two ends by activity.
      // Glassiness therefore comes from colour, reflection and roughness, and stops
      // competing with legibility.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `float hbRough = vStyle > 3.5 ? mix(hbPrm.x, 0.18, hbActivity) : hbPrm.x;
        float roughnessFactor = mix(hbRough, 0.12, uWet * hbPrm.z);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `float hbMetal = vStyle > 3.5 ? mix(hbPrm.y, 0.40, hbActivity) : hbPrm.y;
        float metalnessFactor = mix(hbMetal, 0.45, uWet * hbPrm.z);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += uLit * hbActivity * (0.02 + uNight * 1.23);
        totalEmissiveRadiance += uPalette[hbIdx] * uEmissive[hbIdx];`
      );
  };
  material.customProgramCacheKey = () => `hybrid-${options.transparent ? 'clear' : 'opaque'}`;
  return material;
}
