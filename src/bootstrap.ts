import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GlitchTimeDilationShader } from './effects/GlitchTimeDilation';
import type { QualityProfile } from './performance/QualityManager';

CameraControls.install({ THREE });

export interface RuntimeEnv {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labelRenderer: CSS2DRenderer;
  controls: CameraControls;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  glitchPass: ShaderPass;
  loadingManager: THREE.LoadingManager;
  setQuality: (profile: QualityProfile) => void;
  syncSize: () => void;
  dispose: () => void;
}

export function bootstrap(initialQuality: QualityProfile): RuntimeEnv {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

  // Far plane must reach past the sky dome (scale 2000 → corners ~1700).
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(55, 42, 70);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialQuality.pixelRatio));
  renderer.shadowMap.enabled = initialQuality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // EffectComposer renders several passes. Manual reset keeps renderer.info
  // representative of the whole frame instead of only the final OutputPass.
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

  // Half-float + 4× MSAA render target: HDR survives the post chain and the
  // voxel edges stop shimmering ("pixelating") in motion.
  const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: initialQuality.msaaSamples,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.22,
    0.35,
    1.08
  );
  composer.addPass(bloomPass);

  const glitchPass = new ShaderPass(GlitchTimeDilationShader);
  glitchPass.uniforms.uResolution.value = new Float32Array([window.innerWidth, window.innerHeight]);
  composer.addPass(glitchPass);

  // Applies tone mapping (ACES) + sRGB conversion — without it the HDR sky
  // clips to pure white inside the composer's half-float buffers.
  composer.addPass(new OutputPass());

  const loadingManager = new THREE.LoadingManager();

  let quality = initialQuality;

  const syncSize = () => {
    const pixelRatio = Math.min(window.devicePixelRatio, quality.pixelRatio);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(window.innerWidth, window.innerHeight);
    glitchPass.uniforms.uResolution.value = new Float32Array([
      Math.round(window.innerWidth * pixelRatio),
      Math.round(window.innerHeight * pixelRatio),
    ]);
  };

  const setQuality = (profile: QualityProfile) => {
    quality = profile;
    renderer.shadowMap.enabled = profile.shadows;
    renderer.shadowMap.needsUpdate = true;
    composer.renderTarget1.samples = profile.msaaSamples;
    composer.renderTarget2.samples = profile.msaaSamples;
    bloomPass.enabled = profile.bloom;
    labelRenderer.domElement.style.display = profile.labels ? '' : 'none';
    syncSize();
  };

  window.addEventListener('resize', syncSize);
  setQuality(initialQuality);

  const dispose = () => {
    window.removeEventListener('resize', syncSize);
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
    bloomPass,
    glitchPass,
    loadingManager,
    setQuality,
    syncSize,
    dispose,
  };
}
