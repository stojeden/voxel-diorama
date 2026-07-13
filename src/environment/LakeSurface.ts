import * as THREE from 'three';
import { LAKE } from '../world/WorldLayout';

const WATER_COLOR = new THREE.Color(0x145b78);
const ICE_COLOR = new THREE.Color(0xc7dfe9);

export class LakeSurface {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly surfaceMaterial: THREE.MeshPhysicalMaterial;
  private readonly mistMaterial: THREE.ShaderMaterial;
  private readonly uniforms = {
    time: { value: 0 },
    wind: { value: 0 },
    rain: { value: 0 },
    freeze: { value: 0 },
    detail: { value: 1 },
  };
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private freeze = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group.name = 'lake-surface';

    const bedGeometry = new THREE.CircleGeometry(1, 64);
    const bedMaterial = new THREE.MeshStandardMaterial({ color: 0x173d4a, roughness: 1, metalness: 0 });
    const bed = new THREE.Mesh(bedGeometry, bedMaterial);
    bed.scale.set(LAKE.radiusX * 0.98, LAKE.radiusZ * 0.98, 1);
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(LAKE.x, -0.54, LAKE.z);
    bed.receiveShadow = true;
    this.group.add(bed);
    this.disposables.push(bedGeometry, bedMaterial);

    const surfaceGeometry = new THREE.PlaneGeometry(
      LAKE.radiusX * 2,
      LAKE.radiusZ * 2,
      48,
      32
    );
    this.surfaceMaterial = new THREE.MeshPhysicalMaterial({
      color: WATER_COLOR,
      roughness: 0.16,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.11,
      envMapIntensity: 1.8,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    this.surfaceMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uLakeTime = this.uniforms.time;
      shader.uniforms.uLakeWind = this.uniforms.wind;
      shader.uniforms.uLakeRain = this.uniforms.rain;
      shader.uniforms.uLakeFreeze = this.uniforms.freeze;
      shader.uniforms.uLakeDetail = this.uniforms.detail;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uLakeTime;
          uniform float uLakeWind;
          uniform float uLakeRain;
          uniform float uLakeFreeze;
          uniform float uLakeDetail;
          varying vec2 vLakeUv;
          float lakeHeight(vec2 p) {
            float amplitude = (1.0 - uLakeFreeze) * uLakeDetail;
            float broad = sin(p.x * 0.42 + uLakeTime * 1.1) * 0.055;
            broad += sin(p.y * 0.68 - uLakeTime * 0.82 + p.x * 0.16) * 0.035;
            float rain = sin(p.x * 2.7 + uLakeTime * 8.0) *
              sin(p.y * 3.1 - uLakeTime * 7.2) * uLakeRain * 0.018;
            return (broad * (0.45 + uLakeWind * 0.8) + rain) * amplitude;
          }`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `vLakeUv = uv;
          float lakeEpsilon = 0.08;
          float lakeDx = lakeHeight(position.xy + vec2(lakeEpsilon, 0.0)) -
            lakeHeight(position.xy - vec2(lakeEpsilon, 0.0));
          float lakeDy = lakeHeight(position.xy + vec2(0.0, lakeEpsilon)) -
            lakeHeight(position.xy - vec2(0.0, lakeEpsilon));
          vec3 objectNormal = normalize(vec3(-lakeDx, -lakeDy, lakeEpsilon * 2.0));`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          transformed.z += lakeHeight(position.xy);`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLakeUv;')
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          vec2 lakeEllipse = (vLakeUv - 0.5) * 2.0;
          if (dot(lakeEllipse, lakeEllipse) > 1.0) discard;`
        );
    };
    this.surfaceMaterial.customProgramCacheKey = () => 'lake-surface-p1';

    const surface = new THREE.Mesh(surfaceGeometry, this.surfaceMaterial);
    surface.rotation.x = -Math.PI / 2;
    surface.position.set(LAKE.x, -0.4, LAKE.z);
    surface.receiveShadow = true;
    surface.castShadow = false;
    this.group.add(surface);
    this.disposables.push(surfaceGeometry, this.surfaceMaterial);

    // A sparse, instanced reed belt breaks up the geometric shoreline without
    // bringing back the old ring of metre-wide voxel markers.
    const reedCount = 42;
    const reedGeometry = new THREE.BoxGeometry(0.13, 1, 0.13);
    const reedMaterial = new THREE.MeshStandardMaterial({
      color: 0x66752f,
      roughness: 0.92,
      metalness: 0,
    });
    const cattailGeometry = new THREE.BoxGeometry(0.2, 0.32, 0.2);
    const cattailMaterial = new THREE.MeshStandardMaterial({
      color: 0x5a351f,
      roughness: 1,
      metalness: 0,
    });
    const reeds = new THREE.InstancedMesh(reedGeometry, reedMaterial, reedCount);
    const cattails = new THREE.InstancedMesh(cattailGeometry, cattailMaterial, reedCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < reedCount; i++) {
      const angle = (i / reedCount) * Math.PI * 2 + Math.sin(i * 19.17) * 0.09;
      const scatter = 0.94 + (Math.sin(i * 31.73) * 0.5 + 0.5) * 0.08;
      const x = LAKE.x + Math.cos(angle) * LAKE.radiusX * scatter;
      const z = LAKE.z + Math.sin(angle) * LAKE.radiusZ * scatter;
      const height = 0.72 + (Math.sin(i * 47.11) * 0.5 + 0.5) * 0.75;
      dummy.position.set(x, -0.38 + height * 0.5, z);
      dummy.scale.set(1, height, 1);
      dummy.rotation.y = angle;
      dummy.updateMatrix();
      reeds.setMatrixAt(i, dummy.matrix);

      dummy.position.y = -0.3 + height + 0.1;
      dummy.scale.set(1, 0.7 + (i % 3) * 0.12, 1);
      dummy.updateMatrix();
      cattails.setMatrixAt(i, dummy.matrix);
    }
    reeds.castShadow = false;
    reeds.receiveShadow = true;
    cattails.castShadow = false;
    this.group.add(reeds, cattails);
    this.disposables.push(
      reedGeometry,
      reedMaterial,
      cattailGeometry,
      cattailMaterial
    );

    this.mistMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uniforms.time,
        uStrength: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uStrength;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(41.7, 289.3))) * 43758.5453); }
        void main() {
          vec2 p = vUv;
          float drift = sin((p.x + uTime * 0.018) * 13.0) * 0.08;
          float noise = hash(floor(vec2(p.x * 14.0 + uTime * 0.08, p.y * 5.0)));
          float edge = smoothstep(0.0, 0.28, p.y) * smoothstep(1.0, 0.62, p.y);
          edge *= smoothstep(0.0, 0.15, p.x) * smoothstep(1.0, 0.85, p.x);
          gl_FragColor = vec4(vec3(0.76, 0.84, 0.86), edge * (0.12 + noise * 0.08 + drift) * uStrength);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mistGeometry = new THREE.PlaneGeometry(LAKE.radiusX * 1.75, 3.2, 1, 1);
    for (let i = 0; i < 3; i++) {
      const mist = new THREE.Mesh(mistGeometry, this.mistMaterial);
      mist.position.set(LAKE.x + (i - 1) * 1.7, 1 + i * 0.34, LAKE.z + (i - 1) * 1.8);
      mist.rotation.y = i * Math.PI / 3;
      mist.renderOrder = 3;
      this.group.add(mist);
    }
    const tunnelMistGeometry = new THREE.PlaneGeometry(5.6, 3.4, 1, 1);
    for (const side of [-1, 1]) {
      const mist = new THREE.Mesh(tunnelMistGeometry, this.mistMaterial);
      mist.position.set(side * 68.7, 2.15, 0);
      mist.rotation.y = Math.PI / 2;
      mist.renderOrder = 3;
      this.group.add(mist);
    }
    this.disposables.push(mistGeometry, tunnelMistGeometry, this.mistMaterial);

    scene.add(this.group);
  }

  setQuality(detail: number): void {
    this.uniforms.detail.value = THREE.MathUtils.clamp(detail, 0.25, 1);
    this.surfaceMaterial.envMapIntensity = THREE.MathUtils.lerp(1.1, 2, detail);
  }

  update(elapsed: number, wind: number, rain: number, freeze: number, mist: number): void {
    this.uniforms.time.value = elapsed;
    this.uniforms.wind.value = wind;
    this.uniforms.rain.value = rain;
    this.uniforms.freeze.value = freeze;
    this.mistMaterial.uniforms.uStrength.value = mist * (1 - freeze * 0.65);

    if (Math.abs(freeze - this.freeze) > 0.01) {
      this.freeze = freeze;
      this.surfaceMaterial.color.copy(WATER_COLOR).lerp(ICE_COLOR, freeze);
      this.surfaceMaterial.roughness = THREE.MathUtils.lerp(0.16, 0.42, freeze);
      this.surfaceMaterial.clearcoatRoughness = THREE.MathUtils.lerp(0.11, 0.28, freeze);
      this.surfaceMaterial.opacity = THREE.MathUtils.lerp(0.9, 0.98, freeze);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const item of this.disposables) item.dispose();
  }
}
