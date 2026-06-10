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
import { RealTimeSync } from './environment/RealTime';
import { PortalGlow } from './effects/PortalGlow';
import { Balloon } from './effects/Balloon';
import { Fisherman } from './world/Fisherman';
import { Postman } from './world/Postman';
import { chapterForProgress } from './experience/RouteChapters';
import { themeById, type DioramaTheme } from './experience/Themes';
import { DAY_SECONDS, TUNNEL_LENGTH, WORLD_HALF_SIZE } from './world/WorldLayout';

const env = bootstrap();
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
const realTime = new RealTimeSync();
const tour = new CinematicTour(env.controls);

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
  if (realTime.isActive()) {
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
  if (realTime.isActive()) return;
  timeScale = scale;
  ui.setTimeScale(scale);
});

let realTimePending = false;
ui.onRealTimeToggle(() => {
  if (realTimePending) return;
  if (realTime.isActive()) {
    realTime.disable();
    weather.setExternal(null);
    ui.setRealTime(false);
    ui.showToast('TRYB SYMULACJI');
    return;
  }
  realTimePending = true;
  ui.setRealTime(true, '…');
  void realTime
    .enable()
    .then((label) => {
      ui.setRealTime(true, label);
      ui.showToast(`CZAS RZECZYWISTY · ${label}`);
      // Snap the clock to the real sun immediately.
      renderTime = realTime.getCycleT() * DAY_SECONDS;
    })
    .finally(() => {
      realTimePending = false;
    });
});

// ─── Animation ───
const clock = new THREE.Clock();
let elapsed = 0;
let loadingHidden = false;
const trainPosition = new THREE.Vector3();
const boardingStations = new Set<string>();

function formatClock(t01: number): string {
  const hours = Math.floor(t01 * 24);
  const minutes = Math.floor((t01 * 24 * 60) % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function animate() {
  requestAnimationFrame(animate);
  const rawDelta = Math.min(clock.getDelta(), 0.1);
  const delta = paused ? 0 : rawDelta;
  elapsed += delta;

  env.controls.update(rawDelta);
  tour.update(rawDelta);

  // ── Clock: real time, tour override, or free-running simulation ──
  if (realTime.isActive()) {
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
  if (realTime.isActive()) {
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
  if (realTime.isActive()) {
    const live = realTime.getWeather();
    weather.setExternal(live ? live.kind : null, live?.windNorm ?? 0);
  }
  weather.update(delta * timeScale, rawDelta);

  // ── Lighting ──
  const skyCloud = Math.min(1, weather.getCloudCover() + currentTheme.turbidityAdd * 0.1);
  const light = dayNight.update(t01, rawDelta, skyCloud, currentTheme.nightFloor);
  env.renderer.toneMappingExposure =
    (0.36 + (1 - light.night) * 0.42 + light.golden * 0.2) *
    currentTheme.exposureMul *
    (1 - light.eclipse * 0.68);

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

  birds.update(delta, elapsed, weather.getWind(), light.night);
  lakeLife.update(delta, weather.getSnowCover() > 0.5);
  lakesideCow.update(delta, elapsed, light.night);
  fisherman.update(delta, elapsed, light.night, weather.getSnowCover());
  postman.update(delta, elapsed, t01);
  balloon.update(delta, elapsed, light.night, weather.getCloudCover(), weather.getWind());

  boardingStations.clear();
  const stationState = train.getStationState();
  if (stationState.kind === 'dwelling') boardingStations.add(stationState.stationLabel);
  passengerCrowd.update(delta, boardingStations);

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
  env.bloomPass.strength = (0.18 + light.night * 0.5 + light.golden * 0.12) * currentTheme.bloomMul;

  // ── HUD ──
  if (realTime.isActive()) {
    const now = new Date();
    ui.setClock(
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} · NA ŻYWO`
    );
  } else {
    ui.setClock(`${formatClock(t01)}${timeScale > 1 ? ` · ${timeScale}×` : ''}`);
  }
  if (!realTime.isActive() && weather.getSetting() === 'auto') {
    ui.setWeatherLabel(`POGODA: AUTO · ${weather.getLabel().replace('AUTO · ', '')}`);
  } else if (realTime.isActive()) {
    ui.setWeatherLabel(`POGODA: ${weather.getLabel()}`);
  }
  ui.setChapter(chapterForProgress(train.getRouteProgress()));
  ui.setStation(stationState);

  env.composer.render();
  env.labelRenderer.render(env.scene, env.camera);

  if (!loadingHidden) {
    ui.setLoadingProgress(100);
    ui.hideLoadingScreen();
    loadingHidden = true;
  }
}

animate();

// Debug/verification handle (harmless in production, handy in dev tools).
Object.assign(window as unknown as Record<string, unknown>, {
  __diorama: {
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
  },
});

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
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
    realTime.dispose();
    ui.dispose();
    env.dispose();
  });
}
