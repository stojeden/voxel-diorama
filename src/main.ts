import * as THREE from 'three';

import { bootstrap } from './bootstrap';
import { mountUi } from './ui';
import type { TourFrame } from './CinematicTour';
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
import { EclipseTimeline } from './experience/EclipseTimeline';
import { eclipseWorldReactionAt } from './experience/EclipseWorldReaction';
import { EclipseCrowdProps } from './effects/EclipseCrowdProps';
import { themeById, type DioramaTheme } from './experience/Themes';
import { DAY_SECONDS, LEVEL_CROSSING } from './world/WorldLayout';
import { createWorldRandom } from './core/Random';
import { createFrameContext } from './experience/FrameContext';
import { ExperienceDirector } from './experience/ExperienceDirector';
import { CameraDirector, type CameraMode } from './experience/CameraDirector';
import { warmRenderer } from './experience/RendererWarmup';
import { formatClock, updateEclipseHud } from './experience/Hud';
import {
  WORLD_LAYOUT_SEED,
  getCheckpoint,
  type CheckpointDefinition,
  type CheckpointId,
} from './experience/Checkpoints';
import { sceneBloomStrength, sceneExposure, sunDirectionAt } from './environment/sky';
import {
  QualityManager,
  type QualityMode,
} from './performance/QualityManager';
import type { DevStatsHandle } from './performance/DevStats';
import type { DioramaDebugHandle } from './debug/DioramaDebugTypes';

const query = new URLSearchParams(window.location.search);
const requestedCheckpoint = getCheckpoint(query.get('checkpoint'));
const worldRandom = createWorldRandom(query.get('seed') ?? undefined);
const qualityParam = query.get('quality');
const requestedQuality = qualityParam === 'low' || qualityParam === 'medium' || qualityParam === 'high'
  ? qualityParam
  : undefined;
// An explicit query parameter is a benchmark/debug override. Checkpoints only
// provide the default profile when the caller did not request one.
const quality = new QualityManager(undefined, requestedQuality ?? requestedCheckpoint?.quality);
const env = bootstrap(quality.getProfile());
const ui = mountUi();
ui.setLoadingProgress(4, 'RENDERER GOTOWY');

// Shared uniforms: Weather writes wind strength, tree foliage shader reads it.
const windUniforms: WindUniforms = { uTime: { value: 0 }, uWind: { value: 0 } };

// ─── World ───
const world = createWorld(env.scene, windUniforms);
ui.setLoadingProgress(10, 'MIASTO I KRAJOBRAZ');
const train = createTrain(env.scene);
const bus = createBus(env.scene, worldRandom.stream('bus'));
const birds = new Birds(env.scene, worldRandom.stream('birds'));
const passengerCrowd = new PassengerCrowd(env.scene, worldRandom.stream('station-crowd'));
const lakeLife = new LakeLife(env.scene, 4, worldRandom.stream('lake-life'));
const lakesideCow = new LakesideCow(env.scene, worldRandom.stream('cow'));
const fisherman = new Fisherman(env.scene, worldRandom.stream('fisherman'));
const postman = new Postman(env.scene);
const eclipseCrowdProps = new EclipseCrowdProps(env.scene);
const balloon = new Balloon(env.scene, worldRandom.stream('balloon'));
const railSignals = new RailSignals(env.scene);
ui.setLoadingProgress(16, 'POJAZDY I MIESZKAŃCY');
const weather = new Weather(env.scene, windUniforms, worldRandom.stream('weather'));
const dayNight = new DayNightCycle(env.scene, env.renderer, {
  streetLights: world.streetLights,
  streetGlowMesh: world.streetGlowMesh,
  streetGlowMaterial: world.streetGlowMaterial,
  busStopLights: world.busStopLights,
  busStopGlowMaterials: world.busStopGlowMaterials,
  stationLights: world.stationLights,
  stationGlowMaterials: world.stationGlowMaterials,
  stationGlowMesh: world.stationGlowMesh,
  stationGlowMaterial: world.stationGlowMaterial,
  windowLights: world.windowLights,
  windowGlowMaterials: world.windowGlowMaterials,
}, worldRandom.stream('day-night-stars'), worldRandom.stream('shooting-stars'));
ui.setLoadingProgress(20, 'OŚWIETLENIE I POGODA');
env.setOcclusionExclusions([
  ...weather.getOcclusionExclusions(),
  ...dayNight.getOcclusionExclusions(),
]);
const portalGlow = new PortalGlow(env.scene, worldRandom.stream('portal'));
dayNight.camera = env.camera;
let realTime: RealTimeSync | null = null;

const bloomTargets: THREE.Object3D[] = [];
env.scene.traverse((object) => {
  if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line)) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const glows = materials.some((material) => {
    if (material.blending === THREE.AdditiveBlending) return true;
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial)) {
      return false;
    }
    return material.emissiveIntensity > 0 &&
      material.emissive.r + material.emissive.g + material.emissive.b > 0.08;
  });
  if (glows) bloomTargets.push(object);
});
for (const object of dayNight.getBloomObjects()) {
  if (!bloomTargets.includes(object)) bloomTargets.push(object);
}
env.setBloomSelection(bloomTargets);

const unsubscribeQuality = quality.subscribe((profile, snapshot) => {
  env.setQuality(profile);
  dayNight.setQuality(profile);
  weather.setQuality(profile);
  world.setQuality(profile);
  birds.setDensity(profile.actorDensity);
  passengerCrowd.setDensity(profile.actorDensity);
  eclipseCrowdProps.setQuality(profile.level);
  ui.setQuality(snapshot);
});

ui.onQualityCycle(() => {
  interruptCameraForUi();
  const mode = quality.cycleMode();
  ui.showToast(`JAKOŚĆ: ${mode.toUpperCase()}`);
});

// ─── Loading manager ───
env.loadingManager.onProgress = (_url, loaded, total) => {
  if (total > 0) ui.setLoadingProgress(4 + (loaded / total) * 6, 'ZASOBY SCENY');
};

// ─── State ───
let cameraMode: CameraMode = 'free';
const ECLIPSE_VIEW_TIME = 0.715;
const eclipseTimeline = new EclipseTimeline({ durationSeconds: 96 });
let eclipseState = eclipseTimeline.getState();
let eclipseReaction = eclipseWorldReactionAt(0, 0);
let eclipseDebugStrength: number | null = null;
let eclipseCheckpointLocked = false;
let eclipseDay = true;
let eclipseDoneToday = false;
const eclipseViewSun = new THREE.Vector3();
const eclipseViewCamera = new THREE.Vector3();
const eclipseViewTarget = new THREE.Vector3(0, 36, 0);
const eclipseReflectionSun = new THREE.Vector3();
let previousDayProgress = 0.262;
let activeCheckpoint: CheckpointDefinition | null = null;

const experience = new ExperienceDirector({
  daySeconds: DAY_SECONDS,
  random: worldRandom.stream('experience'),
});

const cameraDirector = new CameraDirector({
  controls: env.controls,
  inputElement: env.renderer.domElement,
  onInterrupt: () => handleCameraInterrupt(),
  onModeChange: (mode) => {
    cameraMode = mode;
    ui.setCameraMode(mode);
  },
});

function endTourOverrides(): void {
  experience.stopTour();
  cameraDirector.stopTour();
  experience.setClockLocked(false);
  eclipseCheckpointLocked = false;
  eclipseState = eclipseTimeline.stop();
  weather.setExternal(null);
  ui.setTourActive(false);
  ui.setInfoText('PRZECIĄGNIJ — OBRÓT • PRAWY PRZYCISK — PRZESUŃ • SCROLL — ZOOM');
}

function releaseCheckpointState(interruptCamera: boolean): void {
  activeCheckpoint = null;
  experience.releaseCheckpoint();
  experience.setClockLocked(false);
  eclipseCheckpointLocked = false;
  weather.setExternal(null);
  if (interruptCamera) cameraDirector.interrupt('explicit');
}

function handleCameraInterrupt(): void {
  if (activeCheckpoint) releaseCheckpointState(false);
  if (experience.isTourActive()) endTourOverrides();
}

ui.setInfoText('PRZECIĄGNIJ — OBRÓT • PRAWY PRZYCISK — PRZESUŃ • SCROLL — ZOOM');
ui.setTimeScale(1);
ui.setWeatherLabel('POGODA: AUTO');

function setCameraMode(mode: 'train' | 'bus'): void {
  if (experience.isTourActive()) {
    endTourOverrides();
  }
  cameraDirector.toggleVehicleMode(mode);
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
  env.setThemeGrade(currentTheme.id, currentTheme.sepia, currentTheme.saturation);
  ui.setThemeActive(id);
  ui.showToast(`STYL: ${currentTheme.label.toUpperCase()}`);
}

function setCyberFactorImmediate(factor: number): void {
  cyberFactor = THREE.MathUtils.clamp(factor, 0, 1);
  world.setCyberRise(cyberFactor);
  bus.setCyberLook(cyberFactor);
  const cyberOn = cyberFactor > 0.5;
  if (cyberOn === cyberActorsOn) return;
  cyberActorsOn = cyberOn;
  birds.setHidden(cyberOn);
  fisherman.setHologram(cyberOn);
  lakesideCow.setSuppressed(cyberOn);
  balloon.setCyberMode(cyberOn);
}

function interruptCameraForUi(): void {
  if (cameraDirector.isAutomated()) cameraDirector.interrupt('explicit');
}

ui.onThemeChange((id) => {
  interruptCameraForUi();
  applyTheme(id);
});

function applyTourChapter(frame: TourFrame): void {
  const chapter = frame.chapter;
  if (chapter.trainProgress !== undefined) train.seekRouteProgress(chapter.trainProgress);
  if (chapter.busProgress !== undefined) bus.seekRouteProgress(chapter.busProgress);
  weather.debugSetImmediate(chapter.weather);
  if (currentTheme.id !== chapter.theme) applyTheme(chapter.theme);
  if (chapter.eclipseProgress === null) {
    eclipseState = eclipseTimeline.stop();
    eclipseCheckpointLocked = false;
    experience.setClockLocked(false);
  } else {
    experience.setTime(chapter.dayProgress);
    experience.setClockLocked(true);
    eclipseState = eclipseTimeline.seek(chapter.eclipseProgress, false);
    eclipseCheckpointLocked = true;
    eclipseDoneToday = true;
  }
  ui.setChapter(`TOUR · ${chapter.label}`);
}

ui.onTourButton(() => {
  if (experience.isTourActive()) {
    endTourOverrides();
  } else {
    if (realTime?.isActive()) {
      realTime.disable();
      weather.setExternal(null);
      ui.setRealTime(false);
    }
    activeCheckpoint = null;
    experience.releaseCheckpoint();
    const first = experience.startTour(() => endTourOverrides());
    applyTourChapter(first);
    cameraDirector.startTour(first);
    ui.setInfoText('PRZECIĄGNIJ, PRZEWIŃ LUB DOTKNIJ, ABY PRZEJĄĆ KAMERĘ');
  }
});

ui.onWeatherCycle(() => {
  interruptCameraForUi();
  if (realTime?.isActive()) {
    ui.showToast('POGODA STEROWANA TRYBEM NA ŻYWO');
    return;
  }
  weather.cycle();
  ui.setWeatherLabel(`POGODA: ${weather.getSetting() === 'auto' ? 'AUTO' : weather.getLabel()}`);
  ui.showToast(`POGODA: ${weather.getSetting() === 'auto' ? 'AUTO' : weather.getLabel()}`);
});

ui.onPauseToggle(() => {
  interruptCameraForUi();
  experience.setPaused(ui.paused);
});

ui.onTimeScale((scale) => {
  interruptCameraForUi();
  if (realTime?.isActive()) return;
  experience.setTimeScale(scale);
  ui.setTimeScale(scale);
});

let realTimePending = false;
ui.onRealTimeToggle(() => {
  interruptCameraForUi();
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
      experience.setTime(realTime!.getCycleT());
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
  interruptCameraForUi();
  void toggleProfiler().then((active) => ui.showToast(active ? 'PROFILER: WŁĄCZONY' : 'PROFILER: WYŁĄCZONY'));
});

function focusEclipseView(): void {
  if (experience.isTourActive()) {
    endTourOverrides();
  }

  sunDirectionAt(ECLIPSE_VIEW_TIME, eclipseViewSun);
  eclipseViewCamera.set(-eclipseViewSun.x, 0, -eclipseViewSun.z).normalize().multiplyScalar(148);
  eclipseViewCamera.y = 46;
  cameraDirector.focusEclipse(eclipseViewCamera, eclipseViewTarget);
}

function startEclipse(focusView = true): void {
  if (realTime?.isActive()) {
    realTime.disable();
    weather.setExternal(null);
    ui.setRealTime(false);
  }
  experience.setTime(ECLIPSE_VIEW_TIME);
  experience.setClockLocked(true);
  eclipseState = eclipseTimeline.start();
  eclipseDebugStrength = null;
  eclipseCheckpointLocked = false;
  eclipseDoneToday = true;
  if (focusView) focusEclipseView();
  ui.showToast('ZAĆMIENIE SŁOŃCA · CZAS ZJAWISKA SKOMPRESOWANY');
}

ui.onEclipseStart(() => {
  interruptCameraForUi();
  startEclipse(true);
});

if (import.meta.env.DEV && !requestedCheckpoint) {
  const eclipseCheckpoint = query.get('eclipse');
  const checkpoints: Record<string, number> = {
    c1: 0.18,
    c2: 0.39,
    totality: 0.5,
    c3: 0.61,
    c4: 0.82,
  };
  const checkpoint = eclipseCheckpoint ? checkpoints[eclipseCheckpoint] : undefined;
  if (checkpoint !== undefined) {
    experience.setTime(ECLIPSE_VIEW_TIME);
    eclipseState = eclipseTimeline.seek(checkpoint, false);
    eclipseCheckpointLocked = true;
    eclipseDoneToday = true;
    focusEclipseView();
  }
}

const checkpointCameraPosition = new THREE.Vector3();
const checkpointCameraTarget = new THREE.Vector3();

function applyBootCheckpoint(checkpoint: CheckpointDefinition): void {
  experience.stopTour();
  cameraDirector.stopTour();
  ui.setTourActive(false);
  activeCheckpoint = checkpoint;
  experience.lockCheckpoint(checkpoint.timeOfDay);
  weather.debugSetImmediate(checkpoint.weather);
  applyTheme(checkpoint.theme);
  setCyberFactorImmediate(checkpoint.theme === 'cyberpunk' ? 1 : 0);
  if (checkpoint.trainProgress !== undefined) train.seekRouteProgress(checkpoint.trainProgress);
  if (checkpoint.busProgress !== undefined) bus.seekRouteProgress(checkpoint.busProgress);
  eclipseDebugStrength = null;
  if (checkpoint.eclipseProgress === null) {
    eclipseState = eclipseTimeline.stop();
    eclipseCheckpointLocked = false;
  } else {
    eclipseState = eclipseTimeline.seek(checkpoint.eclipseProgress, false);
    eclipseCheckpointLocked = true;
    eclipseDoneToday = true;
  }
  experience.setClockLocked(checkpoint.eclipseProgress !== null);
  checkpointCameraPosition.fromArray(checkpoint.camera.position);
  checkpointCameraTarget.fromArray(checkpoint.camera.target);
  cameraDirector.frameAbsolute(checkpointCameraPosition, checkpointCameraTarget, false, 'overview');
  ui.setChapter(`CHECKPOINT · ${checkpoint.id.toUpperCase()}`);
}

function releaseCheckpoint(): void {
  releaseCheckpointState(true);
}

if (requestedCheckpoint) applyBootCheckpoint(requestedCheckpoint);

// ─── Animation ───
const timer = new THREE.Timer();
timer.connect(document);
const frame = createFrameContext();
let rafId = 0;
let running = true;
let loadingHidden = false;
let loadingCompletedAt = -1;
let optionalActorAccumulator = 0;
let hudAccumulator = 0;
let shadowFocusAccumulator = 0;
let rendererWarm = false;
const trainPosition = new THREE.Vector3();
const trainDirection = new THREE.Vector3();
const busPosition = new THREE.Vector3();
const busDirection = new THREE.Vector3();
const cameraSubjects = { trainPosition, trainDirection, busPosition, busDirection };
const postFocusTarget = new THREE.Vector3();
const boardingStations = new Set<string>();

function animate(timestamp?: number) {
  if (!running) return;
  rafId = requestAnimationFrame(animate);
  timer.update(timestamp);
  const measuredDelta = timer.getDelta();
  const rawDelta = Math.min(measuredDelta, 0.1);
  if (!document.hidden) quality.sampleFrame(measuredDelta);
  const presentationDelta = experience.isCheckpointLocked() ? 0 : rawDelta;
  const delta = experience.isPaused() ? 0 : presentationDelta;
  frame.frameIndex++;
  frame.timestampMs = timestamp ?? performance.now();
  frame.realDelta = rawDelta;
  frame.simulationDelta = delta;
  frame.elapsedSimulation += delta;

  env.controls.update(presentationDelta);
  shadowFocusAccumulator += presentationDelta;
  if (shadowFocusAccumulator >= 0.2) {
    env.controls.getTarget(postFocusTarget);
    const shadowRadius = env.camera.position.distanceTo(postFocusTarget) * 0.72;
    dayNight.setShadowFocus(postFocusTarget, shadowRadius);
    shadowFocusAccumulator = 0;
  }

  // ── Clock: one owner for simulation, real time and tour overrides ──
  let experienceState = experience.update(
    frame,
    realTime?.isActive() ? realTime.getCycleT() : null
  );
  if (eclipseState.running) {
    experience.setTime(ECLIPSE_VIEW_TIME);
    experienceState = experience.getState();
  }
  const t01 = experienceState.t01;
  if (!realTime?.isActive() && t01 < previousDayProgress && !experience.isCheckpointLocked()) {
    eclipseDay = false;
    eclipseDoneToday = false;
  }
  previousDayProgress = t01;
  if (experienceState.tour?.entered) applyTourChapter(experienceState.tour);

  // ── Moon & aurora ──
  if (realTime?.isActive()) {
    const moon = realTime.getMoon();
    dayNight.setMoonPhase(moon.phase, moon.fraction);
  } else {
    dayNight.setMoonPhase(experienceState.moonPhase, experienceState.moonIllumination);
  }
  dayNight.setAuroraStrength(experienceState.auroraEnabled && weather.isClearNight() ? 0.85 : 0);

  // ── Eclipse 2.0: deterministic, compressed event with explicit phases ──
  if (
    !eclipseState.running &&
    !eclipseCheckpointLocked &&
    eclipseDay &&
    !eclipseDoneToday &&
    Math.abs(t01 - ECLIPSE_VIEW_TIME) < 0.008
  ) {
    startEclipse(true);
  }
  eclipseState = eclipseTimeline.update(eclipseState.running ? delta : 0);
  if (eclipseState.phase === 'complete' && !activeCheckpoint) {
    experience.setClockLocked(false);
  }
  eclipseReaction = eclipseWorldReactionAt(eclipseState.coverage, eclipseState.totality);
  passengerCrowd.setEclipseReaction(eclipseReaction);
  bus.setEclipseReaction(eclipseReaction);
  postman.setEclipseReaction(eclipseReaction);
  const eclipseActive = eclipseState.running || eclipseState.phase !== 'complete' && eclipseState.progress > 0;
  if (eclipseDebugStrength === null) {
    dayNight.setEclipseState({
      active: eclipseActive,
      coverage: eclipseState.coverage,
      separation: eclipseState.separation,
      irradiance: eclipseState.irradiance,
      corona: eclipseState.corona,
      beads: eclipseState.beads,
      stars: eclipseState.stars,
      totality: eclipseState.totality,
    });
  } else {
    dayNight.setEclipse(eclipseDebugStrength);
  }

  // ── Weather (live override or auto machine) ──
  if (realTime?.isActive()) {
    const live = realTime.getWeather();
    weather.setExternal(live ? live.kind : null, live?.windNorm ?? 0);
  }
  weather.update(delta * experience.getTimeScale(), presentationDelta);

  // ── Lighting ──
  const skyCloud = Math.min(1, weather.getCloudCover() + currentTheme.turbidityAdd * 0.1);
  dayNight.setCameraMode(cameraMode);
  const light = dayNight.update(t01, presentationDelta, skyCloud, currentTheme.nightFloor);
  env.renderer.toneMappingExposure = sceneExposure(
    light.night,
    light.golden,
    currentTheme.exposureMul,
    light.eclipse
  );

  // ── Vehicles & life ──
  const speedMultiplier = 0.5 + ui.speedSetting * 1.3;
  train.update(delta, frame.elapsedSimulation, light.night, speedMultiplier);
  train.getPosition(trainPosition);
  bus.update(
    delta,
    light.night,
    train.isGroundPointOccupied(LEVEL_CROSSING.x, LEVEL_CROSSING.z, 5),
    t01
  );
  const activeCameraRig = experienceState.tour?.chapter.cameraRig;
  const cameraAutomation = cameraDirector.getAutomation();
  if (cameraAutomation === 'train' || cameraAutomation === 'tour' && activeCameraRig === 'train') {
    train.getDirection(trainDirection);
  }
  if (cameraAutomation === 'bus' || cameraAutomation === 'tour' && activeCameraRig === 'bus') {
    bus.getPosition(busPosition);
    bus.getDirection(busDirection);
  }
  // Do not pay the global fragment-shader cost of the other vehicle's spotlights
  // in a chase camera. The followed vehicle keeps its physical headlights.
  train.setHeadlightsEnabled(cameraMode !== 'bus');
  bus.setHeadlightsEnabled(cameraMode !== 'train');
  world.setSnowCover(weather.getSnowCover());
  world.setWetness(weather.getWetness());
  sunDirectionAt(t01, eclipseReflectionSun);
  world.setEclipseReflection(
    eclipseState.corona * (0.45 + eclipseState.totality * 0.55),
    eclipseReflectionSun
  );
  world.updateEnvironment(
    frame.elapsedSimulation,
    weather.getWind(),
    weather.getKind() === 'rain' ? 1 : 0,
    THREE.MathUtils.smoothstep(weather.getSnowCover(), 0.42, 0.82),
    Math.max(weather.getKind() === 'fog' ? 1 : 0, light.golden * (1 - skyCloud) * 0.38)
  );

  railSignals.update(trainPosition);
  portalGlow.update(frame.elapsedSimulation, presentationDelta, trainPosition);

  // ── Cyberpunk morph: towers rise/sink, actors swap at the midpoint ──
  const cyberTarget = currentTheme.cyber ? 1 : 0;
  if (Math.abs(cyberTarget - cyberFactor) > 0.001) {
    setCyberFactorImmediate(
      cyberFactor + Math.sign(cyberTarget - cyberFactor) *
      Math.min(presentationDelta * 0.45, Math.abs(cyberTarget - cyberFactor))
    );
  }

  optionalActorAccumulator += delta;
  const actorInterval = 1 / quality.getProfile().optionalActorHz;
  const stationState = train.getStationState();
  birds.setEclipseState(
    eclipseState.coverage,
    eclipseState.progress < 0.5 ? 'increasing' : 'decreasing'
  );
  if (optionalActorAccumulator >= actorInterval) {
    const actorDelta = optionalActorAccumulator;
    optionalActorAccumulator = 0;
    birds.update(actorDelta, frame.elapsedSimulation, weather.getWind(), light.night);
    lakeLife.update(actorDelta, weather.getSnowCover() > 0.5);
    lakesideCow.update(actorDelta, frame.elapsedSimulation, light.night);
    fisherman.update(actorDelta, frame.elapsedSimulation, light.night, weather.getSnowCover());
    postman.update(actorDelta, frame.elapsedSimulation, t01);
    balloon.update(actorDelta, frame.elapsedSimulation, light.night, weather.getCloudCover(), weather.getWind());

    boardingStations.clear();
    if (stationState.kind === 'dwelling') boardingStations.add(stationState.stationLabel);
    passengerCrowd.update(actorDelta, boardingStations);
  }
  eclipseCrowdProps.update(eclipseReaction, eclipseState.separation);

  cameraDirector.update(frame, experienceState.tour, cameraSubjects);

  // ── Post FX ──
  const gradeNight = light.eclipse > 0.001 ? Math.min(light.night, 0.25) : light.night;
  env.gradeEffect.parameters.time.value = frame.elapsedSimulation;
  env.gradeEffect.parameters.golden.value = light.golden;
  env.gradeEffect.parameters.night.value = gradeNight;
  env.setEnvironmentGrade(light.golden, gradeNight);
  env.setBloomStrength(sceneBloomStrength(light.night, light.golden, currentTheme.bloomMul));
  env.controls.getTarget(postFocusTarget);
  const cameraFocusDistance = env.camera.position.distanceTo(postFocusTarget);
  env.setCameraFocusDistance(cameraFocusDistance);
  env.setCameraPerformanceMode(cameraMode);
  dayNight.setCameraFocusDistance(cameraFocusDistance);
  env.setCinematicFocus(experience.isTourActive(), postFocusTarget);

  // ── HUD: DOM does not need a 60 Hz update cadence. ──
  // UI cadence may advance while a checkpoint freezes every visual simulation delta.
  hudAccumulator += rawDelta;
  if (hudAccumulator >= 0.1) {
    hudAccumulator = 0;
    if (realTime?.isActive()) {
      const now = new Date();
      ui.setClock(
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · NA ŻYWO`
      );
    } else {
      const timeScale = experience.getTimeScale();
      ui.setClock(`${formatClock(t01)}${timeScale > 1 ? ` · ${timeScale}×` : ''}`);
    }
    if (!realTime?.isActive() && weather.getSetting() === 'auto') {
      ui.setWeatherLabel(`POGODA: AUTO · ${weather.getLabel().replace('AUTO · ', '')}`);
    } else if (realTime?.isActive()) {
      ui.setWeatherLabel(`POGODA: ${weather.getLabel()}`);
    }
    if (!experience.isTourActive() && !activeCheckpoint) {
      ui.setChapter(chapterForProgress(train.getRouteProgress()));
    }
    ui.setStation(stationState);
    updateEclipseHud(ui, eclipseState, eclipseActive);
  }

  env.renderer.info.reset();
  env.composer.render(presentationDelta);
  if (quality.getProfile().labels) env.labelRenderer.render(env.scene, env.camera);
  devStats?.update();

  if (!loadingHidden && rendererWarm) {
    if (loadingCompletedAt < 0) {
      loadingCompletedAt = performance.now();
      ui.setLoadingProgress(100, 'GOTOWE');
    } else if (performance.now() - loadingCompletedAt >= 140) {
      ui.hideLoadingScreen();
      loadingHidden = true;
      debugHandle.ready = true;
      window.dispatchEvent(new CustomEvent('diorama-ready'));
    }
  }
}

const debugHandle: DioramaDebugHandle = {
  ready: false,
  setTime: (t01: number) => experience.setTime(t01),
  getState: () => ({
    t01: experience.getState().t01,
    simulationSeed: worldRandom.seed,
    layoutSeed: WORLD_LAYOUT_SEED,
    checkpoint: activeCheckpoint
      ? { id: activeCheckpoint.id, revision: activeCheckpoint.revision }
      : null,
    cameraMode: cameraDirector.getMode(),
    cameraAutomation: cameraDirector.getAutomation(),
    tourChapter: experience.getState().tour?.chapter.id ?? null,
    theme: currentTheme.id,
    cyberFactor,
    weather: weather.getKind(),
    cloud: weather.getCloudCover(),
    wind: weather.getWind(),
    trainProgress: train.getRouteProgress(),
    busProgress: bus.getRouteProgress(),
    eclipse: eclipseState,
    eclipseReaction,
  }),
  getMetrics: () => {
    const info = env.renderer.info;
    const gl = env.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ready: debugHandle.ready,
      quality: quality.getSnapshot(),
      simulationSeed: worldRandom.seed,
      layoutSeed: WORLD_LAYOUT_SEED,
      checkpoint: activeCheckpoint
        ? { id: activeCheckpoint.id, revision: activeCheckpoint.revision }
        : null,
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
    weather.debugSetImmediate(kind);
  },
  clearWeather: () => weather.setExternal(null),
  loadCheckpoint: (id: CheckpointId) => {
    const checkpoint = getCheckpoint(id);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
    const url = new URL(window.location.href);
    url.searchParams.set('seed', String(worldRandom.seed));
    url.searchParams.set('checkpoint', checkpoint.id);
    url.searchParams.set('quality', checkpoint.quality);
    window.location.assign(url);
  },
  releaseCheckpoint,
  scene: env.scene,
  renderer: env.renderer,
  controls: env.controls,
  cameraPose: () => {
    env.controls.getTarget(postFocusTarget, false);
    return {
      position: env.camera.position.toArray(),
      target: postFocusTarget.toArray(),
      distance: env.camera.position.distanceTo(postFocusTarget),
    };
  },
  summonUfo: (event?: 'abduct' | 'return' | 'kioskRaid') => lakesideCow.debugSummonUfo(event),
  placeCowAtMeadow: () => lakesideCow.debugPlaceCowAtMeadow(),
  farmerPhase: () => lakesideCow.getFarmerPhase(),
  cowController: lakesideCow as unknown,
  debugWinterFisherman: () => {
    weather.setExternal('snow');
    weather.debugSetSnowCover(1);
    fisherman.debugSetWinterFishing();
  },
  debugShoreFisherman: () => fisherman.debugSetShoreFishing(),
  debugSetSnowCover: (cover: number) => weather.debugSetSnowCover(cover),
  fishermanState: () => fisherman.getDebugState(),
  debugBusStop: (label: string) => bus.debugStartDwell(label),
  busPassengers: () => bus.getPassengerDebugState(),
  busService: () => bus.getServiceDebugState(),
  windowRhythm: () =>
    world.windowGlowMaterials.map((entry) => ({
      cohort: entry.cohort,
      activity: entry.activity,
      emissiveIntensity: entry.material.emissiveIntensity,
    })),
  debugTrainStation: (label: string) => passengerCrowd.debugStartDwell(label),
  stationPassengers: () => passengerCrowd.getPassengerDebugState(),
  eclipseCrowdProps: () => eclipseCrowdProps.getDebugState(),
  postmanState: () => postman.getDebugState(),
  applyTheme,
  startEclipse: () => {
    startEclipse(true);
  },
  setEclipseProgress: (progress: number, running = false) => {
    experience.setTime(ECLIPSE_VIEW_TIME);
    experience.setClockLocked(true);
    eclipseDebugStrength = null;
    eclipseState = eclipseTimeline.seek(progress, running);
    eclipseCheckpointLocked = !running;
  },
  focusEclipseView,
  startTour: () => {
    if (experience.isTourActive()) return;
    const first = experience.startTour(() => endTourOverrides());
    applyTourChapter(first);
    cameraDirector.startTour(first);
    ui.setTourActive(true);
  },
  stopTour: () => {
    endTourOverrides();
  },
  seekTourChapter: (id: Parameters<ExperienceDirector['seekTour']>[0], progress = 0) => {
    const tourFrame = experience.seekTour(id, progress);
    applyTourChapter(tourFrame);
    cameraDirector.startTour(tourFrame);
  },
  setEclipseStrength: (s: number) => {
    eclipseState = eclipseTimeline.stop();
    eclipseCheckpointLocked = false;
    experience.setClockLocked(false);
    eclipseDebugStrength = s > 0 ? THREE.MathUtils.clamp(s, 0, 1) : null;
    if (eclipseDebugStrength === null) dayNight.setEclipse(0);
  },
  /** Render one frame synchronously and return it as a JPEG data URL
   * (the WebGL buffer isn't preserved, so render+read must share a tick). */
  captureFrame: (width = 960, jpegQuality = 0.82) => {
    env.composer.render(0);
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
void warmRenderer({
  env,
  ui,
  dayNight,
  weather,
  focusTarget: postFocusTarget,
  eclipseViewTime: ECLIPSE_VIEW_TIME,
  getTheme: () => currentTheme,
  getDayProgress: () => experience.getState().t01,
  getEclipseState: () => eclipseState,
}).finally(() => {
  rendererWarm = true;
  timer.reset();
  animate();
});

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    running = false;
    cancelAnimationFrame(rafId);
    unsubscribeQuality();
    cameraDirector.dispose();
    timer.dispose();
    devStats?.dispose();
    train.dispose();
    bus.dispose();
    birds.dispose();
    passengerCrowd.dispose();
    eclipseCrowdProps.dispose();
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
