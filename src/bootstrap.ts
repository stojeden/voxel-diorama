import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GlitchTimeDilationShader } from './effects/GlitchTimeDilation';

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
  syncSize: () => void;
  dispose: () => void;
}

export function bootstrap(): RuntimeEnv {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

  // Far plane must reach past the sky dome (scale 2000 → corners ~1700).
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 3000);
  camera.position.set(55, 42, 70);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
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
    samples: 4,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.22,
    0.35,
    0.82
  );
  composer.addPass(bloomPass);

  const glitchPass = new ShaderPass(GlitchTimeDilationShader);
  glitchPass.uniforms.uResolution.value = new Float32Array([window.innerWidth, window.innerHeight]);
  composer.addPass(glitchPass);

  // Applies tone mapping (ACES) + sRGB conversion — without it the HDR sky
  // clips to pure white inside the composer's half-float buffers.
  composer.addPass(new OutputPass());

  const loadingManager = new THREE.LoadingManager();

  const syncSize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.setSize(window.innerWidth, window.innerHeight);
    glitchPass.uniforms.uResolution.value = new Float32Array([window.innerWidth, window.innerHeight]);
  };

  window.addEventListener('resize', syncSize);

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
    syncSize,
    dispose,
  };
}
