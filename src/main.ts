import * as THREE from 'three';

import { bootstrap } from './bootstrap';
import { mountUi } from './ui';
import { CinematicTour } from './CinematicTour';
import { createWorld, type WindUniforms } from './world/WorldGenerator';
import { createTrain } from './world/Train';
import { createBus } from './world/Bus';
import { Birds } from './world/Birds';
import { PassengerCrowd } from './world/PassengerCrowd';
import { LakeLife } from './world/LakeLife';
import { LakesideCow } from './world/LakesideCow';
import { RailSignals } from './world/RailSignals';
import { DayNightCycle } from './environment/DayNightCycle';
import { Weather } from './environment/Weather';
import type { RealTimeSync } from './environment/RealTime';
import { PortalGlow } from './effects/PortalGlow';
import { Balloon } from './effects/Balloon';
import { Fisherman } from './world/Fisherman';
import { Postman } from './world/Postman';
import { chapterForProgress } from './experience/RouteChapters';
import { themeById, type DioramaTheme } from './experience/Themes';
import { DAY_SECONDS, TUNNEL_LENGTH, WORLD_HALF_SIZE } from './world/WorldLayout';
import { sceneBloomStrength, sceneExposure } from './environment/sky';
import {
  QualityManager,
  type QualityMode,
  type QualitySnapshot,
} from './performance/QualityManager';
import type { DevStatsHandle } from './performance/DevStats';

const quality = new QualityManager();
const env = bootstrap(quality.getProfile());
const ui = mountUi();

// Shared uniforms: Weather writes wind strength, tree foliage shader reads it.
const windUniforms: WindUniforms = { uTime: { value: 0 }, uWind: { value: 0 } };

// ─── World ───
const world = createWorld(env.scene, windUniforms);
const train = createTrain(env.scene);
const bus = createBus(env.scene);
const birds = new Birds(env.scene);
const passengerCrowd = new PassengerCrowd(env.scene);
const lakeLife = new LakeLife(env.scene, 4);
const lakesideCow = new LakesideCow(env.scene);
const fisherman = new Fisherman(env.scene);
const postman = new Postman(env.scene);
const balloon = new Balloon(env.scene);
const railSignals = new RailSignals(env.scene);
const weather = new Weather(env.scene, windUniforms);
const dayNight = new DayNightCycle(env.scene, env.renderer, {
  streetLights: world.streetLights,
  windowLights: world.windowLights,
  windowGlowMaterials: world.windowGlowMaterials,
});
const portalGlow = new PortalGlow(env.scene);
dayNight.camera = env.camera;
let realTime: RealTimeSync | null = null;
const tour = new CinematicTour(env.controls);

const unsubscribeQuality = quality.subscribe((profile, snapshot) => {
  env.setQuality(profile);
  dayNight.setQuality(profile);
  weather.setQuality(profile);
  birds.setDensity(profile.actorDensity);
  passengerCrowd.setDensity(profile.actorDensity);
  ui.setQuality(snapshot);
});

ui.onQualityCycle(() => {
  const mode = quality.cycleMode();
  ui.showToast(`JAKOŚĆ: ${mode.toUpperCase()}`);
});

// ─── Loading manager ───
env.loadingManager.onProgress = (_url, loaded, total) => {
  ui.setLoadingProgress(total > 0 ? (loaded / total) * 100 : 100);
};
ui.setLoadingProgress(0);

// ─── State ───
type CameraMode = 'free' | 'train' | 'bus';
let cameraMode: CameraMode = 'free';
let cameraJustSwitched = false;
const camDesiredPos = new THREE.Vector3();
const camDesiredTarget = new THREE.Vector3();
const camSmoothPos = new THREE.Vector3();
const camSmoothTarget = new THREE.Vector3();
const prevVehiclePos = new THREE.Vector3();
const FREE_CAM_POS = new THREE.Vector3(70, 48, 80);
const FREE_CAM_TARGET = new THREE.Vector3(0, 6, 0);

let paused = false;
let timeScale = 1;
/** Simulated clock, seconds within the DAY_SECONDS cycle. Starts at sunrise. */
let simTime = 0.262 * DAY_SECONDS;
/** Smoothed time actually rendered (tour / real-time overrides blend into it). */
let renderTime = simTime;
let simMoonPhase = 0.35; // waxing gibbous to start — photogenic
let auroraNight = Math.random() < 0.5;
// Solar eclipse: some days, around noon, the moon slides over the sun.
let eclipseDay = Math.random() < 0.45;
let eclipseDoneToday = false;
let eclipseProgress = -1; // -1 = inactive, otherwise 0..1 over ECLIPSE_SECONDS
const ECLIPSE_SECONDS = 30;

ui.setInfoText('PRZECIĄGNIJ — OBRÓT • PRAWY PRZYCISK — PRZESUŃ • SCROLL — ZOOM');
ui.setTimeScale(1);
ui.setWeatherLabel('POGODA: AUTO');

function setCameraMode(mode: 'train' | 'bus'): void {
  if (tour.isActive()) {
    tour.stop();
    ui.setTourActive(false);
  }
  cameraMode = cameraMode === mode ? 'free' : mode;
  cameraJustSwitched = true;
  ui.setCameraMode(cameraMode);
  if (cameraMode === 'free') {
    env.controls.enabled = true;
    env.controls.setLookAt(
      FREE_CAM_POS.x, FREE_CAM_POS.y, FREE_CAM_POS.z,
      FREE_CAM_TARGET.x, FREE_CAM_TARGET.y, FREE_CAM_TARGET.z,
      true
    );
  }
}

ui.onCameraMode(setCameraMode);

// ─── Diorama themes ───
let currentTheme: DioramaTheme = themeById('classic');
/** 0..1 — animated cyberpunk morph (megatowers rise / sink). */
let cyberFactor = 0;
let cyberActorsOn = false;

function applyTheme(id: string): void {
  currentTheme = themeById(id);
  world.setTheme(currentTheme.palette, currentTheme.foliage);
  train.setLivery(currentTheme.livery ?? 'modern');
  env.glitchPass.uniforms.uSepia.value = currentTheme.sepia;
  env.glitchPass.uniforms.uSatMul.value = currentTheme.saturation;
  ui.setThemeActive(id);
  ui.showToast(`STYL: ${currentTheme.label.toUpperCase()}`);
}

ui.onThemeChange(applyTheme);

ui.onTourButton(() => {
  if (tour.isActive()) {
    tour.stop();
    ui.setTourActive(false);
  } else {
    cameraMode = 'free';
    ui.setCameraMode('free');
    tour.start(() => ui.setTourActive(false));
  }
});

ui.onWeatherCycle(() => {
  if (realTime?.isActive()) {
    ui.showToast('POGODA STEROWANA TRYBEM NA ŻYWO');
    return;
  }
  weather.cycle();
  ui.setWeatherLabel(`POGODA: ${weather.getSetting() === 'auto' ? 'AUTO' : weather.getLabel()}`);
  ui.showToast(`POGODA: ${weather.getSetting() === 'auto' ? 'AUTO' : weather.getLabel()}`);
});

ui.onPauseToggle(() => {
  paused = ui.paused;
});

ui.onTimeScale((scale) => {
  if (realTime?.isActive()) return;
  timeScale = scale;
  ui.setTimeScale(scale);
});

let realTimePending = false;
ui.onRealTimeToggle(() => {
  if (realTimePending) return;
  if (realTime?.isActive()) {
    realTime.disable();
    weather.setExternal(null);
    ui.setRealTime(false);
    ui.showToast('TRYB SYMULACJI');
    return;
  }
  realTimePending = true;
  ui.setRealTime(true, '…');
  void import('./environment/RealTime')
    .then(({ RealTimeSync }) => {
      realTime ??= new RealTimeSync();
      return realTime.enable();
    })
    .then((label) => {
      ui.setRealTime(true, label);
      ui.showToast(`CZAS RZECZYWISTY · ${label}`);
      // Snap the clock to the real sun immediately.
      renderTime = realTime!.getCycleT() * DAY_SECONDS;
    })
    .catch((error: unknown) => {
      console.error('[RealTime] activation failed', error);
      ui.setRealTime(false);
      ui.showToast('TRYB NA ŻYWO NIEDOSTĘPNY');
    })
    .finally(() => {
      realTimePending = false;
    });
});

let devStats: DevStatsHandle | null = null;
let profilerLoading = false;

async function toggleProfiler(): Promise<boolean> {
  const diagnosticsEnabled =
    import.meta.env.DEV || new URLSearchParams(window.location.search).has('profile');
  if (!diagnosticsEnabled) return false;
  if (devStats) {
    devStats.dispose();
    devStats = null;
    return false;
  }
  if (profilerLoading) return false;
  profilerLoading = true;
  try {
    const { mountDevStats } = await import('./performance/DevStats');
    devStats = await mountDevStats(env.renderer);
    return true;
  } finally {
    profilerLoading = false;
  }
}

ui.onProfilerToggle(() => {
  void toggleProfiler().then((active) => ui.showToast(active ? 'PROFILER: WŁĄCZONY' : 'PROFILER: WYŁĄCZONY'));
});

// ─── Animation ───
const clock = new THREE.Clock();
let elapsed = 0;
let loadingHidden = false;
let optionalActorAccumulator = 0;
const trainPosition = new THREE.Vector3();
const boardingStations = new Set<string>();

function formatClock(t01: number): string {
  const hours = Math.floor(t01 * 24);
  const minutes = Math.floor((t01 * 24 * 60) % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function animate() {
  requestAnimationFrame(animate);
  const measuredDelta = clock.getDelta();
  const rawDelta = Math.min(measuredDelta, 0.1);
  if (!document.hidden) quality.sampleFrame(measuredDelta);
  const delta = paused ? 0 : rawDelta;
  elapsed += delta;

  env.controls.update(rawDelta);
  tour.update(rawDelta);

  // ── Clock: real time, tour override, or free-running simulation ──
  if (realTime?.isActive()) {
    const target = realTime.getCycleT() * DAY_SECONDS;
    let diff = target - renderTime;
    if (Math.abs(diff) > DAY_SECONDS / 2) diff -= Math.sign(diff) * DAY_SECONDS;
    renderTime = (renderTime + diff * Math.min(1, rawDelta * 0.8) + DAY_SECONDS) % DAY_SECONDS;
    simTime = renderTime;
  } else {
    simTime += delta * timeScale;
    if (simTime >= DAY_SECONDS) {
      simTime -= DAY_SECONDS;
      // New simulated day — advance the moon phase noticeably.
      simMoonPhase = (simMoonPhase + 0.125) % 1;
      auroraNight = Math.random() < 0.5;
      eclipseDay = Math.random() < 0.45;
      eclipseDoneToday = false;
    }
    const dayOverride = tour.getDayTimeTarget();
    if (dayOverride !== null) {
      const blend = 1 - Math.exp(-0.6 * Math.max(rawDelta, 0.0001));
      renderTime += (dayOverride - renderTime) * blend;
    } else {
      renderTime = simTime;
    }
  }
  const t01 = ((renderTime / DAY_SECONDS) % 1 + 1) % 1;

  // ── Moon & aurora ──
  if (realTime?.isActive()) {
    const moon = realTime.getMoon();
    dayNight.setMoonPhase(moon.phase, moon.fraction);
  } else {
    const illumination = 0.5 - 0.5 * Math.cos(simMoonPhase * Math.PI * 2);
    dayNight.setMoonPhase(simMoonPhase, illumination);
  }
  dayNight.setAuroraStrength(auroraNight && weather.isClearNight() ? 0.85 : 0);

  // ── Solar eclipse: triggers around noon on "eclipse days" ──
  if (eclipseProgress < 0 && eclipseDay && !eclipseDoneToday && Math.abs(t01 - 0.5) < 0.01) {
    eclipseProgress = 0;
    eclipseDoneToday = true;
    ui.showToast('☀️🌑 ZAĆMIENIE SŁOŃCA');
  }
  if (eclipseProgress >= 0) {
    eclipseProgress += rawDelta / ECLIPSE_SECONDS;
    if (eclipseProgress >= 1) {
      eclipseProgress = -1;
      dayNight.setEclipse(0);
    } else {
      dayNight.setEclipse(Math.sin(eclipseProgress * Math.PI));
    }
  }

  // ── Weather (live override or auto machine) ──
  if (realTime?.isActive()) {
    const live = realTime.getWeather();
    weather.setExternal(live ? live.kind : null, live?.windNorm ?? 0);
  }
  weather.update(delta * timeScale, rawDelta);

  // ── Lighting ──
  const skyCloud = Math.min(1, weather.getCloudCover() + currentTheme.turbidityAdd * 0.1);
  const light = dayNight.update(t01, rawDelta, skyCloud, currentTheme.nightFloor);
  env.renderer.toneMappingExposure = sceneExposure(
    light.night,
    light.golden,
    currentTheme.exposureMul,
    light.eclipse
  );

  // ── Vehicles & life ──
  const speedMultiplier = 0.5 + ui.speedSetting * 1.3;
  train.update(delta, elapsed, light.night, speedMultiplier);
  trainPosition.copy(train.getPosition());
  bus.update(delta, light.night, trainPosition);
  world.setSnowCover(weather.getSnowCover());
  world.setWetness(weather.getWetness());

  railSignals.update(trainPosition);
  portalGlow.update(elapsed, rawDelta, trainPosition);

  // ── Cyberpunk morph: towers rise/sink, actors swap at the midpoint ──
  const cyberTarget = currentTheme.cyber ? 1 : 0;
  if (Math.abs(cyberTarget - cyberFactor) > 0.001) {
    cyberFactor += Math.sign(cyberTarget - cyberFactor) * Math.min(rawDelta * 0.45, Math.abs(cyberTarget - cyberFactor));
    world.setCyberRise(cyberFactor);
    bus.setCyberLook(cyberFactor);
  }
  const cyberOn = cyberFactor > 0.5;
  if (cyberOn !== cyberActorsOn) {
    cyberActorsOn = cyberOn;
    birds.setHidden(cyberOn);
    fisherman.setHologram(cyberOn);
    lakesideCow.setSuppressed(cyberOn);
    balloon.setCyberMode(cyberOn);
  }

  optionalActorAccumulator += delta;
  const actorInterval = 1 / quality.getProfile().optionalActorHz;
  const stationState = train.getStationState();
  if (optionalActorAccumulator >= actorInterval) {
    const actorDelta = optionalActorAccumulator;
    optionalActorAccumulator = 0;
    birds.update(actorDelta, elapsed, weather.getWind(), light.night);
    lakeLife.update(actorDelta, weather.getSnowCover() > 0.5);
    lakesideCow.update(actorDelta, elapsed, light.night);
    fisherman.update(actorDelta, elapsed, light.night, weather.getSnowCover());
    postman.update(actorDelta, elapsed, t01);
    balloon.update(actorDelta, elapsed, light.night, weather.getCloudCover(), weather.getWind());

    boardingStations.clear();
    if (stationState.kind === 'dwelling') boardingStations.add(stationState.stationLabel);
    passengerCrowd.update(actorDelta, boardingStations);
  }

  // ── Onboard cab cameras (train / bus) ──
  if (cameraMode !== 'free' && !tour.isActive()) {
    env.controls.enabled = false;
    const pos = cameraMode === 'train' ? trainPosition : bus.getPosition();
    const dir = cameraMode === 'train' ? train.getDirection() : bus.getDirection();
    // Third-person game camera: behind and above the vehicle, looking ahead.
    const behind = cameraMode === 'train' ? 13 : 10.5;
    let height = cameraMode === 'train' ? 7 : 5.5;
    let targetLift = 0;
    if (cameraMode === 'train') {
      // Near the portals the camera climbs OVER the tunnel embankment
      // instead of clipping through the hill while the train dives in.
      const tunnelZoneStart = WORLD_HALF_SIZE - TUNNEL_LENGTH - 18;
      const intoZone = Math.max(0, Math.abs(pos.x) - tunnelZoneStart);
      const lift = Math.min(1, intoZone / 12);
      height += lift * 10;
      targetLift = lift * 4;
    } else {
      // Bus camera soars OVER the viaduct (and the train on it) when the
      // bus drives through the underpass on the east cross street.
      const d = Math.hypot(pos.x - 34, pos.z - 9.8);
      const lift = Math.max(0, 1 - d / 24);
      height += lift * 11;
      targetLift = lift * 5;
    }
    camDesiredPos.copy(pos).addScaledVector(dir, -behind);
    camDesiredPos.y += height;
    camDesiredTarget.copy(pos).addScaledVector(dir, 11);
    camDesiredTarget.y += 2.2 + targetLift;

    // Hard cut on the portal teleport; smooth follow otherwise.
    const jumped = cameraJustSwitched || prevVehiclePos.distanceTo(pos) > 25;
    if (jumped) {
      camSmoothPos.copy(camDesiredPos);
      camSmoothTarget.copy(camDesiredTarget);
      cameraJustSwitched = false;
    } else {
      const camLerp = 1 - Math.exp(-7 * Math.max(rawDelta, 0.0001));
      camSmoothPos.lerp(camDesiredPos, camLerp);
      camSmoothTarget.lerp(camDesiredTarget, camLerp);
    }
    env.controls.setLookAt(
      camSmoothPos.x, camSmoothPos.y, camSmoothPos.z,
      camSmoothTarget.x, camSmoothTarget.y, camSmoothTarget.z,
      false
    );
    prevVehiclePos.copy(pos);
  }

  // ── Post FX ──
  env.glitchPass.uniforms.uTime.value = elapsed;
  env.glitchPass.uniforms.uGolden.value = light.golden;
  env.glitchPass.uniforms.uNight.value = light.night;
  env.bloomPass.strength = sceneBloomStrength(light.night, light.golden, currentTheme.bloomMul);

  // ── HUD ──
  if (realTime?.isActive()) {
    const now = new Date();
    ui.setClock(
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · NA ŻYWO`
    );
  } else {
    ui.setClock(`${formatClock(t01)}${timeScale > 1 ? ` · ${timeScale}×` : ''}`);
  }
  if (!realTime?.isActive() && weather.getSetting() === 'auto') {
    ui.setWeatherLabel(`POGODA: AUTO · ${weather.getLabel().replace('AUTO · ', '')}`);
  } else if (realTime?.isActive()) {
    ui.setWeatherLabel(`POGODA: ${weather.getLabel()}`);
  }
  ui.setChapter(chapterForProgress(train.getRouteProgress()));
  ui.setStation(stationState);

  env.renderer.info.reset();
  env.composer.render();
  if (quality.getProfile().labels) env.labelRenderer.render(env.scene, env.camera);
  devStats?.update();

  if (!loadingHidden) {
    ui.setLoadingProgress(100);
    ui.hideLoadingScreen();
    loadingHidden = true;
    debugHandle.ready = true;
    window.dispatchEvent(new CustomEvent('diorama-ready'));
  }
}

interface DioramaMetrics {
  ready: boolean;
  quality: QualitySnapshot;
  renderer: {
    gpu: string;
    vendor: string;
    calls: number;
    triangles: number;
    lines: number;
    points: number;
    geometries: number;
    textures: number;
    programs: number;
    pixelRatio: number;
    canvasWidth: number;
    canvasHeight: number;
  };
}

interface DioramaDebugHandle {
  ready: boolean;
  setTime: (t01: number) => void;
  getState: () => Record<string, unknown>;
  getMetrics: () => DioramaMetrics;
  setQuality: (mode: QualityMode) => void;
  toggleProfiler: () => Promise<boolean>;
  setWeather: (kind: 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog') => void;
  clearWeather: () => void;
  captureFrame: (width?: number, jpegQuality?: number) => string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __diorama: DioramaDebugHandle;
  }
}

const debugHandle: DioramaDebugHandle = {
  ready: false,
  setTime: (t01: number) => {
    simTime = t01 * DAY_SECONDS;
    renderTime = simTime;
  },
  getState: () => ({
    t01: renderTime / DAY_SECONDS,
    weather: weather.getKind(),
    cloud: weather.getCloudCover(),
    wind: weather.getWind(),
    trainProgress: train.getRouteProgress(),
  }),
  getMetrics: () => {
    const info = env.renderer.info;
    const gl = env.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ready: debugHandle.ready,
      quality: quality.getSnapshot(),
      renderer: {
        gpu: debugInfo
          ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER)),
        vendor: debugInfo
          ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
          : String(gl.getParameter(gl.VENDOR)),
        calls: info.render.calls,
        triangles: info.render.triangles,
        lines: info.render.lines,
        points: info.render.points,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        pixelRatio: env.renderer.getPixelRatio(),
        canvasWidth: env.renderer.domElement.width,
        canvasHeight: env.renderer.domElement.height,
      },
    };
  },
  setQuality: (mode: QualityMode) => quality.setMode(mode),
  toggleProfiler,
  setWeather: (kind: 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog') => {
    weather.setExternal(kind);
  },
  clearWeather: () => weather.setExternal(null),
  scene: env.scene,
  renderer: env.renderer,
  controls: env.controls,
  summonUfo: (event?: 'abduct' | 'return' | 'kioskRaid') => lakesideCow.debugSummonUfo(event),
  farmerPhase: () => lakesideCow.getFarmerPhase(),
  cowController: lakesideCow as unknown,
  applyTheme,
  startEclipse: () => {
    eclipseProgress = 0;
    eclipseDoneToday = true;
  },
  setEclipseStrength: (s: number) => dayNight.setEclipse(s),
  /** Render one frame synchronously and return it as a JPEG data URL
   * (the WebGL buffer isn't preserved, so render+read must share a tick). */
  captureFrame: (width = 960, jpegQuality = 0.82) => {
    env.composer.render();
    const source = env.renderer.domElement;
    const scale = width / source.width;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(source.height * scale);
    canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', jpegQuality);
  },
};

window.__diorama = debugHandle;
animate();

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeQuality();
    devStats?.dispose();
    train.dispose();
    bus.dispose();
    birds.dispose();
    passengerCrowd.dispose();
    lakeLife.dispose();
    lakesideCow.dispose();
    fisherman.dispose();
    postman.dispose();
    balloon.dispose();
    railSignals.dispose();
    portalGlow.dispose();
    dayNight.dispose();
    world.dispose();
    weather.dispose();
    realTime?.dispose();
    ui.dispose();
    env.dispose();
    delete (window as Partial<Window>).__diorama;
  });
}
