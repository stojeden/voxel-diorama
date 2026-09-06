import * as THREE from 'three';

/**
 * A thin plume from the heating plant's chimney, in both styles.
 *
 * Every parcel's whole life is computed in the vertex shader from one instanced number,
 * its phase. Nothing is written per frame except a handful of uniforms: no matrices
 * rebuilt, no arrays reallocated, no particle objects. Switching profiles only moves
 * `instanceCount`, so Low is cheaper without a second implementation to keep in step.
 *
 * Determinism comes from the same place the rest of the world's does: the simulation
 * clock. A parcel's age is `fract(elapsed / life + phase)`, so the same second of the same
 * seed draws the same plume, and a checkpoint that pins the clock pins the smoke with it.
 * Nothing here draws from a global random source, at build time or after -- the phases come
 * from an integer hash of the index, and `Random.test.ts` guards the rest.
 *
 * What it is not: a simulation. The column rises, then leans downwind, spreads and fades.
 * Pressure, temperature and inversion layers are not modelled and are not pretended at.
 */

/** Parcels drawn at each profile. Small on purpose: this is a wisp, not a column of fire. */
export const SMOKE_PARCELS = { high: 26, low: 9 } as const;
/** Seconds a parcel lives before its phase wraps. Long enough to lean, short enough to stay near. */
export const SMOKE_LIFE_SECONDS = 9;

/**
 * Which way the plume leans, as a smooth function of the world clock.
 *
 * The shared wind uniform carries strength only, so the direction is derived here -- with
 * the same shape the weather's own gust uses: a couple of slow sines. Two consequences
 * matter. It never jumps, so the plume bends instead of snapping; and it is a pure
 * function of elapsed seconds, so it is reproducible from a seed and a clock rather than
 * from the state of a generator nobody can replay.
 *
 * Exported because a plume that lurches is the failure mode worth a test of its own.
 */
export function smokeWindDirection(elapsed: number): { x: number; z: number } {
  const angle = 0.9 + 0.55 * Math.sin(elapsed * 0.021) + 0.22 * Math.sin(elapsed * 0.053 + 1.3);
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

export interface ChimneySmokeHandle {
  readonly object: THREE.Mesh;
  /** Move the source: the ordinary chimney and the Cyberpunk stack vent at different heights. */
  setOutlet(x: number, y: number, z: number): void;
  setLow(low: boolean): void;
  /** `wind` is the shared world wind strength; `night` dims the plume with the sky. */
  update(elapsed: number, wind: number, night: number): void;
  dispose(): void;
}

export function createChimneySmoke(): ChimneySmokeHandle {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute('position', plane.getAttribute('position'));
  geometry.setAttribute('uv', plane.getAttribute('uv'));
  geometry.instanceCount = SMOKE_PARCELS.high;

  const phases = new Float32Array(SMOKE_PARCELS.high);
  const jitter = new Float32Array(SMOKE_PARCELS.high * 3);
  for (let index = 0; index < SMOKE_PARCELS.high; index++) {
    // Evenly spaced phases so the column is continuous rather than pulsing, with a
    // deterministic offset per parcel from a small integer hash -- no RNG, and the same
    // arrangement on every load.
    const hash = ((index * 2654435761) >>> 0) / 4294967295;
    phases[index] = index / SMOKE_PARCELS.high + hash * 0.012;
    jitter[index * 3] = (hash - 0.5) * 2;
    jitter[index * 3 + 1] = 0.75 + hash * 0.5;
    jitter[index * 3 + 2] = (((index * 40503) % 1000) / 1000 - 0.5) * 2;
  }
  geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  geometry.setAttribute('aJitter', new THREE.InstancedBufferAttribute(jitter, 3));
  // The plume lives in a known box above the stack; culling it by a unit plane's bounds
  // would drop it the moment the camera looked slightly away.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    // Ordinary blending, not additive: additive smoke glows, and a glowing plume over a
    // night city is a fire. This one only ever removes contrast, gently.
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uOutlet: { value: new THREE.Vector3() },
      uWind: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uLife: { value: SMOKE_LIFE_SECONDS },
      uOpacity: { value: 0.16 },
      uColor: { value: new THREE.Color(0xb9bec6) },
    },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      attribute vec3 aJitter;
      uniform float uTime;
      uniform float uLife;
      uniform float uWind;
      uniform vec2 uWindDir;
      uniform vec3 uOutlet;
      varying vec2 vUv;
      varying float vAge;

      void main() {
        float age = fract(uTime / uLife + aPhase);
        vAge = age;
        vUv = uv;

        // Rise: quick off the mouth, easing as the parcel loses its buoyancy.
        float rise = 13.0 * (1.0 - exp(-2.6 * age)) * aJitter.y;
        // Drift: the wind has been acting for the parcel's whole life, so the offset is
        // its integral rather than its instantaneous value. That is what bends the column
        // over instead of sliding all of it sideways at once.
        float drift = (1.4 + uWind * 5.5) * age * age;
        float spread = 0.6 + 2.6 * age;

        vec3 centre = uOutlet;
        centre.y += rise;
        centre.x += uWindDir.x * drift + aJitter.x * spread;
        centre.z += uWindDir.y * drift + aJitter.z * spread;

        // Billboard: the quad faces the camera in view space, so a thin plume never turns
        // edge-on and vanishes.
        float size = mix(1.6, 6.4, age) * (0.8 + aJitter.y * 0.4);
        vec4 view = viewMatrix * vec4(centre, 1.0);
        view.xy += position.xy * size;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vAge;

      void main() {
        float radius = length(vUv - 0.5) * 2.0;
        float soft = 1.0 - smoothstep(0.15, 1.0, radius);
        // In over a tenth of the life, out over the rest: nothing appears or leaves abruptly.
        float fade = smoothstep(0.0, 0.1, vAge) * (1.0 - smoothstep(0.3, 1.0, vAge));
        float alpha = soft * soft * fade * uOpacity;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });

  const object = new THREE.Mesh(geometry, material);
  object.name = 'chimney-smoke';
  object.frustumCulled = false;
  // Drawn after the city so it blends over solid surfaces rather than fighting them.
  object.renderOrder = 3;

  return {
    object,
    setOutlet(x, y, z) {
      material.uniforms.uOutlet.value.set(x, y, z);
    },
    setLow(low) {
      geometry.instanceCount = low ? SMOKE_PARCELS.low : SMOKE_PARCELS.high;
    },
    update(elapsed, wind, night) {
      material.uniforms.uTime.value = elapsed;
      material.uniforms.uWind.value = THREE.MathUtils.clamp(wind, 0, 3);
      const direction = smokeWindDirection(elapsed);
      material.uniforms.uWindDir.value.set(direction.x, direction.z);
      // Thinner after dark: at night the plume would otherwise read as a grey lid over
      // the lit city, which is the one thing it must not become.
      material.uniforms.uOpacity.value = 0.17 - 0.07 * THREE.MathUtils.clamp(night, 0, 1);
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      plane.dispose();
      material.dispose();
    },
  };
}
