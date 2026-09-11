import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { GROUND_SURFACE_Y } from './world/WorldLayout';
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
  type Effect,
} from 'postprocessing';
import { CinematicGradeEffect } from './effects/CinematicGrade';
import { ColorLutPipeline } from './effects/ColorLuts';
import type { QualityProfile } from './performance/QualityManager';
import { farViewPixelRatio } from './performance/QualityManager';
import { TemporalResolvePass } from './effects/TemporalResolve';

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
  setAtmosphereEnabled: (enabled: boolean) => void;
  setEnvironmentGrade: (golden: number, night: number) => void;
  /** A theme's grade, or a point between two; `t` of 1 lands on `to` exactly. */
  setThemeGradeBlend: (
    fromId: string,
    toId: string,
    t: number,
    from: { sepia: number; saturation: number },
    to: { sepia: number; saturation: number }
  ) => void;
  setCinematicFocus: (active: boolean, target: THREE.Vector3) => void;
  setCameraFocusDistance: (distance: number) => void;
  setCameraPerformanceMode: (mode: 'free' | 'train' | 'bus') => void;
  /** Draw calls and triangles of the scene render alone, before post-processing passes. */
  getPrimaryPassInfo: () => { triangles: number; calls: number };
  setQuality: (profile: QualityProfile) => void;
  /** Throw away accumulated history. A no-op unless `?taa=1`. */
  resetTemporal: () => void;
  syncSize: () => void;
  dispose: () => void;
}

const SMAA_PRESETS = {
  low: SMAAPreset.LOW,
  medium: SMAAPreset.MEDIUM,
  high: SMAAPreset.HIGH,
} as const;

/** Where the frame is drawn and how big it is. The window is the default, not the assumption. */
export interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * The browser window, which is what every caller wanted until a camera feed turned up.
 *
 * A passthrough view is sized by its video frame, not by `innerWidth`, and lives inside a
 * container rather than at the end of `document.body`.
 */
export const windowViewport = (): Viewport => ({
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: window.devicePixelRatio,
});

export interface BootstrapOptions {
  temporalResolve?: boolean;
  /** Where the canvas and the label layer mount. Defaults to `document.body`. */
  container?: HTMLElement;
  /**
   * Transparent clear, so something behind the canvas can show through.
   *
   * **This cannot be turned on later.** `alpha` is a WebGL context attribute, fixed when the
   * context is created, so a renderer built without it can never composite over a camera
   * feed -- no amount of reordering the frame loop works around that. It is the reason this
   * option exists at all.
   */
  alpha?: boolean;
  /** Distance fog. A passthrough view wants none: the real world supplies its own depth. */
  fog?: boolean;
  /** Size source. Defaults to the browser window. */
  viewport?: () => Viewport;
}

export function bootstrap(
  initialQuality: QualityProfile,
  atmosphereEffect?: Effect,
  options: BootstrapOptions = {}
): RuntimeEnv {
  const {
    container = document.body,
    alpha = false,
    fog = true,
    viewport = windowViewport,
  } = options;
  const scene = new THREE.Scene();
  if (fog) scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

  const size = viewport();
  const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 3000);
  camera.position.set(55, 42, 70);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha });
  // A transparent clear is not the default even with `alpha`: three still clears to opaque
  // black unless the clear alpha is zeroed as well.
  if (alpha) renderer.setClearAlpha(0);
  renderer.setPixelRatio(Math.min(size.pixelRatio, initialQuality.pixelRatio));
  renderer.setSize(size.width, size.height);
  renderer.shadowMap.enabled = initialQuality.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(size.width, size.height);
  labelRenderer.domElement.style.position = 'fixed';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  labelRenderer.domElement.style.zIndex = '9';
  container.appendChild(labelRenderer.domElement);

  const controls = new CameraControls(camera, renderer.domElement);
  controls.smoothTime = 0.18;
  controls.draggingSmoothTime = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 240;
  controls.maxPolarAngle = Math.PI / 2.02;
  controls.dollyToCursor = true;
  controls.infinityDolly = false;
  controls.setTarget(0, 5, 0);
  /**
   * The camera stops at the ground. It does not go under the diorama.
   *
   * `maxPolarAngle` already kept the camera from dipping below its own target, but the
   * target is not fixed: panning moves it, and once it is under the ground the camera
   * follows it down. From there you see the model from below -- the underside of the
   * ground plate, buildings open at the bottom, everything that was never built to be
   * looked at.
   *
   * `setBoundary` with `boundaryEnclosesCamera` is the library's own answer, and it holds
   * both: the pivot cannot leave the box and neither can the eye. Only the floor is a real
   * limit here. The horizontal and upper bounds are far outside anything reachable --
   * `maxDistance` is what actually caps the orbit -- so this adds one constraint rather
   * than quietly reshaping how the camera moves.
   *
   * The floor sits a little above the walkable surface rather than on it, because a camera
   * exactly at ground level still has a near plane 0.1 m in front of it, and that is enough
   * to slice under the road.
   */
  const CAMERA_FLOOR_Y = GROUND_SURFACE_Y + 0.4;
  const CAMERA_REACH = 600;
  controls.setBoundary(new THREE.Box3(
    new THREE.Vector3(-CAMERA_REACH, CAMERA_FLOOR_Y, -CAMERA_REACH),
    new THREE.Vector3(CAMERA_REACH, CAMERA_REACH, CAMERA_REACH)
  ));
  controls.boundaryEnclosesCamera = true;

  const composer = new EffectComposer(renderer, {
    depthBuffer: true,
    stencilBuffer: false,
    multisampling: initialQuality.msaaSamples,
    frameBufferType: THREE.HalfFloatType,
  });
  /**
   * Temporal accumulation, behind `?taa=1`.
   *
   * Off by default: it steadies sub-pixel geometry, which nothing else measured could, and
   * it does that by blending in the previous frame -- which smears whatever moved on its
   * own. That trade has to be looked at before it becomes the default for everybody.
   *
   * The nudge has to be applied before the scene is rasterised, so it rides in a pass ahead
   * of the render rather than in the frame loop.
   */
  const temporal = options.temporalResolve ? new TemporalResolvePass(camera) : null;
  if (temporal) {
    composer.addPass(
      new LambdaPass(() => {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        temporal.beginFrame(size.x, size.y);
      })
    );
  }
  composer.addPass(new RenderPass(scene, camera));
  // renderer.info accumulates every pass of the frame; snapshot it right after the
  // scene render so metrics can split primary from multipass work.
  const primaryPass = { triangles: 0, calls: 0 };
  composer.addPass(new LambdaPass(() => {
    primaryPass.triangles = renderer.info.render.triangles;
    primaryPass.calls = renderer.info.render.calls;
  }));

  let occlusionExclusions: THREE.Object3D[] = [];
  let occlusionVisibility: boolean[] = [];
  composer.addPass(new LambdaPass(() => {
    for (let index = 0; index < occlusionExclusions.length; index++) {
      occlusionVisibility[index] = occlusionExclusions[index].visible;
      occlusionExclusions[index].visible = false;
    }
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
  if (temporal) {
    composer.addPass(temporal);
    // Put the projection back here rather than at the end of the chain: the composer gives
    // `renderToScreen` to whichever pass is last, and a LambdaPass cannot render, so a pass
    // appended after the final effect would quietly swallow the picture.
    composer.addPass(new LambdaPass(() => temporal.endFrame()));
  }

  // Ownership transfers to EffectPass/EffectComposer. Its single dispose path
  // also releases resources owned directly by the effect (the spectral LUT).
  const atmospherePass = atmosphereEffect
    ? new EffectPass(camera, atmosphereEffect)
    : null;
  if (atmospherePass) composer.addPass(atmospherePass);

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
    colorLuts.themeEffect,
    gradeEffect,
    smaaEffect
  );
  finalPass.dithering = true;
  composer.addPass(finalPass);

  const loadingManager = new THREE.LoadingManager();
  let quality = initialQuality;
  let cinematicActive = false;
  let ambientOcclusionNear = true;
  let cameraPerformanceMode: 'free' | 'train' | 'bus' = 'free';

  const syncDistanceEffects = () => {
    // The low, fast-moving bus camera sees far more overlapping city geometry
    // than the train or overview. Its full-scene normal+SSAO pass duplicated
    // the visible draw workload and made High fall to every-other-vblank on M1.
    // SMAA, bloom, grading and shadows remain active, so this is a targeted LOD
    // rather than a wholesale quality downgrade.
    const aoEnabled =
      quality.ambientOcclusion && ambientOcclusionNear && cameraPerformanceMode !== 'bus';
    normalPass.enabled = aoEnabled;
    aoPass.enabled = aoEnabled;
    bloomPass.enabled = quality.bloom && ambientOcclusionNear;
  };

  const syncSize = () => {
    const cameraScale = cameraPerformanceMode === 'bus' ? 0.87 : 1;
    /**
     * The far view supersamples; the near view does not. See `farPixelRatio`.
     *
     * The near ratio is capped at the display, because rendering more pixels than the
     * screen shows only pays for itself if they are averaged down, and the near frame has
     * nothing left to spend either way. The far ratio is deliberately allowed past the
     * display, and bounded by `farViewPixelRatio` instead -- by 1.3x the display and by the
     * largest buffer anybody has measured, whichever is smaller.
     */
    // One read per resize, shared by all five users below. Reading the window five times was
    // harmless; reading a video frame five times is five different answers.
    const current = viewport();
    const nearPixelRatio = Math.min(
      current.pixelRatio,
      Math.max(1, quality.pixelRatio * cameraScale)
    );
    const farPixelRatio = farViewPixelRatio(
      quality.farPixelRatio,
      current.pixelRatio,
      current.width,
      current.height
    );
    const pixelRatio = ambientOcclusionNear ? nearPixelRatio : farPixelRatio;
    camera.aspect = current.width / current.height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio);
    composer.setSize(current.width, current.height, true);
    labelRenderer.setSize(current.width, current.height);
    temporal?.reset();
  };

  const setQuality = (profile: QualityProfile) => {
    quality = profile;
    renderer.shadowMap.enabled = profile.shadows;
    renderer.shadowMap.needsUpdate = true;
    composer.multisampling = profile.msaaSamples;
    syncDistanceEffects();
    normalPass.resolution.scale = profile.aoResolutionScale;
    aoEffect.resolution.scale = profile.aoResolutionScale;
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

  const setCameraFocusDistance = (distance: number) => {
    if (!Number.isFinite(distance)) return;
    const nextNear = ambientOcclusionNear ? distance < 112 : distance < 102;
    if (nextNear === ambientOcclusionNear) return;
    ambientOcclusionNear = nextNear;
    syncDistanceEffects();
    syncSize();
  };

  const setCameraPerformanceMode = (mode: 'free' | 'train' | 'bus') => {
    if (mode === cameraPerformanceMode) return;
    cameraPerformanceMode = mode;
    syncDistanceEffects();
    syncSize();
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
    setAtmosphereEnabled: (enabled) => {
      if (atmospherePass) atmospherePass.enabled = enabled;
    },
    setEnvironmentGrade: (golden, night) => {
      gradeEffect.parameters.golden.value = golden;
      gradeEffect.parameters.night.value = night;
    },
    setThemeGradeBlend: (fromId, toId, t, from, to) => {
      const mix = Math.min(Math.max(t, 0), 1);
      colorLuts.setThemeBlend(fromId, toId, mix);
      gradeEffect.parameters.sepia.value = from.sepia + (to.sepia - from.sepia) * mix;
      gradeEffect.parameters.saturation.value =
        from.saturation + (to.saturation - from.saturation) * mix;
    },
    setCinematicFocus,
    setCameraFocusDistance,
    setCameraPerformanceMode,
    getPrimaryPassInfo: () => primaryPass,
    setQuality,
    resetTemporal: () => temporal?.reset(),
    syncSize,
    dispose,
  };
}
