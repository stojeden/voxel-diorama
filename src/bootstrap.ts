import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  LambdaPass,
  NormalPass,
  RenderPass,
  SelectiveBloomEffect,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { CinematicGradeEffect } from './effects/GlitchTimeDilation';
import { ColorLutPipeline } from './effects/ColorLuts';
import type { QualityProfile } from './performance/QualityManager';

CameraControls.install({ THREE });

export interface RuntimeEnv {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: CameraControls;
  composer: EffectComposer;
  loadingManager: THREE.LoadingManager;
  gradeEffect: CinematicGradeEffect;
  setBloomSelection: (objects: Iterable<THREE.Object3D>) => void;
  setOcclusionExclusions: (objects: Iterable<THREE.Object3D>) => void;
  setBloomStrength: (strength: number) => void;
  setEnvironmentGrade: (golden: number, night: number) => void;
  setThemeGrade: (id: string, sepia: number, saturation: number) => void;
  setCinematicFocus: (active: boolean, target: THREE.Vector3) => void;
  setQuality: (profile: QualityProfile) => void;
  syncSize: () => void;
  dispose: () => void;
}

const SMAA_PRESETS = {
  low: SMAAPreset.LOW,
  medium: SMAAPreset.MEDIUM,
  high: SMAAPreset.HIGH,
} as const;

export function bootstrap(initialQuality: QualityProfile): RuntimeEnv {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(55, 42, 70);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialQuality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = initialQuality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  document.body.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.domElement.style.position = 'fixed';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.style.zIndex = '9';
  document.body.appendChild(labelRenderer.domElement);

  const controls = new CameraControls(camera, renderer.domElement);
  controls.smoothTime = 0.18;
  controls.draggingSmoothTime = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 240;
  controls.maxPolarAngle = Math.PI / 2.02;
  controls.dollyToCursor = true;
  controls.infinityDolly = false;
  controls.setTarget(0, 5, 0);

  const composer = new EffectComposer(renderer, {
    depthBuffer: true,
    stencilBuffer: false,
    multisampling: initialQuality.msaaSamples,
    frameBufferType: THREE.HalfFloatType,
  });
  composer.addPass(new RenderPass(scene, camera));

  let occlusionExclusions: THREE.Object3D[] = [];
  let occlusionVisibility: boolean[] = [];
  composer.addPass(new LambdaPass(() => {
    occlusionVisibility = occlusionExclusions.map((object) => object.visible);
    for (const object of occlusionExclusions) object.visible = false;
  }));

  const normalPass = new NormalPass(scene, camera, {
    resolutionScale: initialQuality.aoResolutionScale,
  });
  const aoEffect = new SSAOEffect(camera, normalPass.texture, {
    samples: 8,
    rings: 5,
    radius: 0.085,
    intensity: 0.82,
    bias: 0.035,
    fade: 0.025,
    luminanceInfluence: 0.78,
    worldDistanceThreshold: 32,
    worldDistanceFalloff: 18,
    worldProximityThreshold: 1.1,
    worldProximityFalloff: 0.75,
    resolutionScale: initialQuality.aoResolutionScale,
  });
  const aoPass = new EffectPass(camera, aoEffect);
  composer.addPass(normalPass);
  composer.addPass(new LambdaPass(() => {
    for (let i = 0; i < occlusionExclusions.length; i++) {
      occlusionExclusions[i].visible = occlusionVisibility[i] ?? true;
    }
  }));
  composer.addPass(aoPass);

  const bloomEffect = new SelectiveBloomEffect(scene, camera, {
    intensity: 0.22,
    luminanceThreshold: 0,
    luminanceSmoothing: 0.05,
    mipmapBlur: true,
    radius: 0.72,
    levels: 5,
  });
  bloomEffect.ignoreBackground = true;
  bloomEffect.luminancePass.enabled = false;
  const bloomPass = new EffectPass(camera, bloomEffect);
  composer.addPass(bloomPass);

  const depthOfField = new DepthOfFieldEffect(camera, {
    focusDistance: 58,
    focusRange: 34,
    bokehScale: 0.75,
    resolutionScale: 0.35,
  });
  const depthOfFieldPass = new EffectPass(camera, depthOfField);
  depthOfFieldPass.enabled = false;
  composer.addPass(depthOfFieldPass);

  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const colorLuts = new ColorLutPipeline();
  const gradeEffect = new CinematicGradeEffect();
  const smaaEffect = new SMAAEffect({ preset: SMAA_PRESETS[initialQuality.smaa] });
  const finalPass = new EffectPass(
    camera,
    toneMapping,
    colorLuts.goldenEffect,
    colorLuts.nightEffect,
    colorLuts.themeEffect,
    gradeEffect,
    smaaEffect
  );
  finalPass.dithering = true;
  composer.addPass(finalPass);

  const loadingManager = new THREE.LoadingManager();
  let quality = initialQuality;
  let cinematicActive = false;

  const syncSize = () => {
    const pixelRatio = Math.min(window.devicePixelRatio, quality.pixelRatio);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight, true);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
  };

  const setQuality = (profile: QualityProfile) => {
    quality = profile;
    renderer.shadowMap.enabled = profile.shadows;
    renderer.shadowMap.needsUpdate = true;
    composer.multisampling = profile.msaaSamples;
    normalPass.enabled = profile.ambientOcclusion;
    aoPass.enabled = profile.ambientOcclusion;
    normalPass.resolution.scale = profile.aoResolutionScale;
    aoEffect.resolution.scale = profile.aoResolutionScale;
    bloomPass.enabled = profile.bloom;
    depthOfFieldPass.enabled = cinematicActive && profile.cinematicDepthOfField;
    smaaEffect.applyPreset(SMAA_PRESETS[profile.smaa]);
    labelRenderer.domElement.style.display = profile.labels ? '' : 'none';
    syncSize();
  };

  const setCinematicFocus = (active: boolean, target: THREE.Vector3) => {
    cinematicActive = active;
    depthOfField.target = target;
    depthOfFieldPass.enabled = active && quality.cinematicDepthOfField;
  };

  window.addEventListener('resize', syncSize);
  setQuality(initialQuality);

  const dispose = () => {
    window.removeEventListener('resize', syncSize);
    colorLuts.dispose();
    composer.dispose();
    renderer.dispose();
    controls.dispose();
    renderer.domElement.remove();
    labelRenderer.domElement.remove();
  };

  return {
    scene,
    camera,
    renderer,
    labelRenderer,
    controls,
    composer,
    loadingManager,
    gradeEffect,
    setBloomSelection: (objects) => bloomEffect.selection.set(objects),
    setOcclusionExclusions: (objects) => {
      occlusionExclusions = [...objects];
      occlusionVisibility = new Array(occlusionExclusions.length).fill(true);
    },
    setBloomStrength: (strength) => {
      bloomEffect.intensity = strength;
    },
    setEnvironmentGrade: (golden, night) => colorLuts.setEnvironment(golden, night),
    setThemeGrade: (id, sepia, saturation) => {
      colorLuts.setTheme(id);
      gradeEffect.parameters.sepia.value = sepia;
      gradeEffect.parameters.saturation.value = saturation;
    },
    setCinematicFocus,
    setQuality,
    syncSize,
    dispose,
  };
}
