import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  clamp01,
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
  /** 0..1 — current solar-eclipse strength (0 = no eclipse). */
  eclipse: number;
}

export interface DayNightHooks {
  streetLights: THREE.PointLight[];
  windowLights: THREE.PointLight[];
  /** Materials whose emissive should glow at night (lit building windows). */
  windowGlowMaterials: THREE.MeshStandardMaterial[];
}

const STAR_COUNT = 700;
const SHOOTING_STAR_POOL = 3;

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
      void main() {
        // Phase light direction in VIEW space, so the crescent always faces
        // the camera the right way round.
        vec3 lightDir = normalize(vec3(sin(uPhaseAngle), 0.12, -cos(uPhaseAngle)));
        float lit = smoothstep(-0.08, 0.18, dot(vNormal, lightDir));
        vec3 bright = vec3(0.92, 0.93, 0.88);
        vec3 dark = vec3(0.055, 0.06, 0.085);
        gl_FragColor = vec4(mix(dark, bright, lit), 1.0);
      }
    `,
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
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hooks: DayNightHooks;

  private readonly sky: Sky;
  private readonly envSky: Sky;
  private readonly envScene: THREE.Scene;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envLastElevation = Number.POSITIVE_INFINITY;
  private envLastCloud = -1;
  private envCooldown = 0;

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
  private eclipseStrength = 0;
  private readonly eclipseDisc: THREE.Mesh;
  private readonly eclipseDiscMaterial: THREE.MeshBasicMaterial;
  private readonly eclipseCorona: THREE.Mesh;
  private readonly eclipseCoronaMaterial: THREE.MeshBasicMaterial;

  private readonly tmpSunDir = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpSunColor = new THREE.Color();

  /** Set by main — the eclipse disc is positioned relative to the camera
   * so it stays optically aligned with the (infinitely far) shader sun. */
  camera: THREE.Camera | null = null;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer, hooks: DayNightHooks) {
    this.scene = scene;
    this.renderer = renderer;
    this.hooks = hooks;

    // ── Atmosphere ──
    this.sky = new Sky();
    this.sky.scale.setScalar(2000);
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(2000);
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
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.95); // upper hemisphere
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

    // ── Eclipse: dark moon disc + additive corona, placed along the sun ray ──
    this.eclipseDiscMaterial = new THREE.MeshBasicMaterial({ color: 0x05060a, fog: false });
    const discGeo = new THREE.CircleGeometry(24, 40);
    this.eclipseDisc = new THREE.Mesh(discGeo, this.eclipseDiscMaterial);
    this.eclipseDisc.visible = false;
    scene.add(this.eclipseDisc);
    this.disposables.push(discGeo, this.eclipseDiscMaterial);

    this.eclipseCoronaMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff4dd,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    const coronaGeo = new THREE.RingGeometry(24, 36, 48);
    this.eclipseCorona = new THREE.Mesh(coronaGeo, this.eclipseCoronaMaterial);
    this.eclipseCorona.visible = false;
    scene.add(this.eclipseCorona);
    this.disposables.push(coronaGeo, this.eclipseCoronaMaterial);

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

  /** 0..1 — solar eclipse: the moon slides over the sun, the world darkens. */
  setEclipse(strength: number): void {
    this.eclipseStrength = clamp01(strength);
  }

  update(t: number, dtReal: number, cloudCover: number, nightFloor = 0): DayLightState {
    this.elapsed += dtReal;
    const eclipse = this.eclipseStrength;
    const elevation = sunElevationAt(t);
    // Themes like Neon Noir keep the city in eternal dusk via nightFloor;
    // a solar eclipse pushes the world toward night for half a minute.
    const night = Math.max(nightFactorAt(t), nightFloor, eclipse * 0.72);
    const golden = goldenFactorAt(t);
    const day = 1 - night;
    const sunDir = sunDirectionAt(t, this.tmpSunDir);

    // ── Sky shader ──
    const uniforms = this.sky.material.uniforms;
    // An eclipse chokes the scattered light: the whole sky dims with the sun.
    const turbidity = 2.0 + cloudCover * 11 + golden * 1.6;
    const rayleigh = (2.4 + golden * 1.4) * (1 - eclipse * 0.8);
    const mie = (0.0035 + golden * 0.014 + cloudCover * 0.008) * (1 - eclipse * 0.92);
    uniforms.turbidity.value = turbidity;
    uniforms.rayleigh.value = rayleigh;
    uniforms.mieCoefficient.value = mie;
    uniforms.mieDirectionalG.value = 0.82;
    uniforms.sunPosition.value.copy(sunDir);

    // ── Sun light ──
    const sunStrength = Math.pow(clamp01(Math.sin(elevation) * 1.5), 0.85);
    this.sunLight.position.copy(sunDir).multiplyScalar(140);
    this.sunLight.target.position.set(0, 0, 0);
    // nightFloor (eternal-dusk themes) and an eclipse both mute the sun.
    this.sunLight.intensity =
      sunStrength * 3.4 * (1 - cloudCover * 0.62) * (1 - nightFloor * 0.8) * (1 - eclipse * 0.96);
    sunColorAt(t, this.tmpSunColor);
    this.sunLight.color.copy(this.tmpSunColor);
    this.sunLight.castShadow = this.sunLight.intensity > 0.04;

    // ── Moon (opposite side of the sky) ──
    const moonDir = sunDirectionAt((t + 0.5) % 1, new THREE.Vector3());
    this.moonMesh.position.copy(moonDir).multiplyScalar(540);
    this.moonMesh.visible = moonDir.y > -0.08;
    this.moonLight.position.copy(moonDir).multiplyScalar(120);
    this.moonLight.intensity =
      night * (0.06 + this.moonIllumination * 0.5) * (1 - cloudCover * 0.8) * clamp01(moonDir.y * 4);

    // ── Eclipse visuals: black disc + corona sliding over the sun ──
    if (eclipse > 0.01) {
      this.eclipseDisc.visible = true;
      this.eclipseCorona.visible = true;
      // The disc slides across the sun: offset shrinks to 0 at totality.
      const slide = (1 - eclipse) * 60;
      const eye = this.camera?.position;
      this.eclipseDisc.position.copy(sunDir).multiplyScalar(490);
      if (eye) this.eclipseDisc.position.add(eye);
      this.eclipseDisc.position.x -= slide;
      this.eclipseDisc.lookAt(eye ?? new THREE.Vector3());
      this.eclipseCorona.position.copy(this.eclipseDisc.position);
      this.eclipseCorona.lookAt(eye ?? new THREE.Vector3());
      this.eclipseCoronaMaterial.opacity = Math.pow(eclipse, 2) * 0.85;
    } else {
      this.eclipseDisc.visible = false;
      this.eclipseCorona.visible = false;
    }

    // ── Fill lights ──
    this.ambientLight.intensity = (0.16 + day * 0.5 + golden * 0.1) * (1 - eclipse * 0.55);
    skyColorAt(t, this.tmpColor);
    this.ambientLight.color.copy(this.tmpColor).lerp(new THREE.Color(0xffffff), 0.35);
    this.hemisphereLight.intensity = (0.22 + day * 0.5) * (1 - eclipse * 0.6);
    this.hemisphereLight.color.copy(this.tmpColor);

    // ── Fog colour tracks the horizon (density owned by Weather) ──
    if (this.scene.fog) {
      const fogGrey = 0.35 + cloudCover * 0.35;
      this.scene.fog.color
        .copy(this.tmpColor)
        .lerp(new THREE.Color(0x9aa3ad), cloudCover * fogGrey * day);
    }

    // ── Stars ──
    const starAlpha = clamp01((night - 0.45) / 0.5) * (1 - cloudCover);
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
    for (const light of this.hooks.streetLights) {
      light.intensity = night * 9;
      light.distance = 28;
    }
    for (let i = 0; i < this.hooks.windowLights.length; i++) {
      const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const isOn = h - Math.floor(h) > 0.3;
      this.hooks.windowLights[i].intensity = isOn ? night * 5.5 : 0;
      this.hooks.windowLights[i].distance = 22;
    }
    for (const mat of this.hooks.windowGlowMaterials) {
      mat.emissiveIntensity = 0.1 + night * 1.15;
    }

    // ── Environment map (reflections in glass) — throttled regeneration ──
    this.envCooldown -= dtReal;
    const elevationDelta = Math.abs(elevation - this.envLastElevation);
    const cloudDelta = Math.abs(cloudCover - this.envLastCloud);
    if (this.envCooldown <= 0 && (elevationDelta > 0.012 || cloudDelta > 0.08)) {
      this.regenerateEnvironment(uniforms);
      this.envLastElevation = elevation;
      this.envLastCloud = cloudCover;
      this.envCooldown = 0.7;
    }

    return { night, golden, sunElevation: elevation, eclipse };
  }

  private regenerateEnvironment(skyUniforms: Record<string, THREE.IUniform>): void {
    const envUniforms = this.envSky.material.uniforms;
    envUniforms.turbidity.value = skyUniforms.turbidity.value;
    envUniforms.rayleigh.value = skyUniforms.rayleigh.value;
    envUniforms.mieCoefficient.value = skyUniforms.mieCoefficient.value;
    envUniforms.mieDirectionalG.value = skyUniforms.mieDirectionalG.value;
    envUniforms.sunPosition.value.copy(skyUniforms.sunPosition.value);

    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.03);
    this.scene.environment = this.envTarget.texture;
    old?.dispose();
  }

  private updateShootingStars(dt: number, starAlpha: number): void {
    for (const star of this.shootingStars) {
      if (star.life > 0) {
        star.life -= dt;
        star.line.position.addScaledVector(star.velocity, dt);
        const fade = clamp01(star.life / star.maxLife);
        star.material.opacity = fade * 0.9;
        if (star.life <= 0) star.line.visible = false;
      } else if (starAlpha > 0.6 && Math.random() < dt * 0.12) {
        star.maxLife = 0.7 + Math.random() * 0.6;
        star.life = star.maxLife;
        star.line.position.set(
          (Math.random() - 0.5) * 360,
          120 + Math.random() * 120,
          (Math.random() - 0.5) * 360
        );
        star.velocity.set(-(60 + Math.random() * 80), -(18 + Math.random() * 22), (Math.random() - 0.5) * 30);
        star.line.visible = true;
      }
    }
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.envTarget?.dispose();
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
