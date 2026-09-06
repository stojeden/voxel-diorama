import * as THREE from 'three';

/**
 * What the bus's under-sill LEDs put on the road.
 *
 * The strips themselves are emissive geometry and light nothing — that was the brief, and
 * a dynamic light per strip would spend the night light budget on something nobody can
 * point at. This is the other half: the mark they leave on the asphalt, and the reflection
 * they leave in it once it rains.
 *
 * One additive plane under the chassis, the same idiom the street lamps' pools use
 * (`buildStreetLightPools`): no lights, no shadows, no depth writes, discarded where it
 * would contribute nothing. Two things keep it from reading as a vehicle hovering over a
 * glowing puddle. It is shaped as two narrow runs under the sill line rather than one blob
 * under the middle, and it is scaled by night, so in daylight there is next to nothing
 * there.
 *
 * The wet component is a separate, narrower streak sitting just OUTBOARD of the sills,
 * because that is where a strip's reflection appears on a wet road — under the vehicle you
 * see the light it spills, outside it you see the light itself. It exists only with water
 * on the road and grows with it.
 *
 * Honest about what it is: it paints the road. It does not illuminate other geometry, and
 * nothing else in the scene is lit by it.
 */

/**
 * Plane size in metres, and why it is this and not wider.
 *
 * The avenue's carriageway is five metres and the bus runs down the middle of it, so
 * anything past 1.8 m from the centre line is painting the kerb and the pavement. The
 * first version was 5.2 m wide and did exactly that -- and `clearance.test.ts` caught it,
 * because a plane parented to the bus counts as the bus until something says otherwise.
 */
const GLOW_WIDTH = 3.6;
/** Where the strips are, across the bus: `BUS_WIDTH / 2 - 0.16`. */
const SILL_OFFSET = 0.99;
/** Where their reflection lands on wet asphalt: just outside the body line. */
const MIRROR_OFFSET = 1.34;

export interface BusUnderGlowHandle {
  readonly object: THREE.Mesh;
  /** `cyber` is the morph factor, `night` the day-night factor, `wet` the road's wetness. */
  set(cyber: number, night: number, wet: number): void;
  dispose(): void;
}

export function createBusUnderGlow(busLength: number, roadOffsetY: number): BusUnderGlowHandle {
  // Shorter than the bus plus its margins for the same reason: a mark that overhangs the
  // vehicle by more than a metre at each end reads as a projection, not as spill.
  const geometry = new THREE.PlaneGeometry(GLOW_WIDTH, busLength + 0.8);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCyber: { value: 0 },
      uNight: { value: 0 },
      uWet: { value: 0 },
      uHalfWidth: { value: GLOW_WIDTH / 2 },
      uSill: { value: SILL_OFFSET },
      uMirror: { value: MIRROR_OFFSET },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uCyber;
      uniform float uNight;
      uniform float uWet;
      uniform float uHalfWidth;
      uniform float uSill;
      uniform float uMirror;
      varying vec2 vUv;

      void main() {
        // Metres, not texture coordinates: the sill and its reflection are physical
        // positions on the bus, and reading them in metres is what keeps them there.
        float across = abs(vUv.x - 0.5) * 2.0 * uHalfWidth;
        float alongEdge = abs(vUv.y - 0.5) * 2.0;

        // Spill: a soft run under each sill, fading before the ends of the bus. Wide and
        // weak rather than narrow and bright -- this is the light the strips throw down,
        // and on dry asphalt it should be visible as a glow without becoming a puddle.
        float spillAcross = exp(-pow((across - uSill) / 0.52, 2.0));
        float spillAlong = 1.0 - smoothstep(0.42, 1.0, alongEdge);
        float spill = spillAcross * spillAlong;

        // Reflection: narrower, longer, just outboard, and only with water on the road.
        float mirrorAcross = exp(-pow((across - uMirror) / 0.16, 2.0));
        float mirrorAlong = 1.0 - smoothstep(0.10, 0.96, alongEdge);
        float mirror = mirrorAcross * mirrorAlong * uWet;

        // Daylight leaves almost nothing: LEDs do not mark a sunlit road.
        float darkness = 0.18 + 0.82 * uNight;
        float alpha = uCyber * darkness * (spill * 0.3 + mirror * 0.55);
        if (alpha < 0.002) discard;

        vec3 colour = vec3(0.21, 0.90, 1.0);
        gl_FragColor = vec4(colour * (0.55 + 0.45 * uWet), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const object = new THREE.Mesh(geometry, material);
  object.name = 'bus-under-glow';
  object.rotation.x = -Math.PI / 2;
  object.position.y = roadOffsetY;
  object.castShadow = false;
  object.receiveShadow = false;
  object.visible = false;
  // After the road, so it adds to asphalt already drawn rather than fighting it.
  object.renderOrder = 2;

  return {
    object,
    set(cyber, night, wet) {
      const morph = THREE.MathUtils.clamp(cyber, 0, 1);
      object.visible = morph > 0.01;
      material.uniforms.uCyber.value = morph;
      material.uniforms.uNight.value = THREE.MathUtils.clamp(night, 0, 1);
      material.uniforms.uWet.value = THREE.MathUtils.clamp(wet, 0, 1);
    },
    dispose() {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
