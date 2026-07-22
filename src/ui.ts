/**
 * DOM/UI bindings for the diorama control panel.
 */

import type { TrainPublicState } from './world/Train';
import type { QualityMode, QualitySnapshot } from './performance/QualityManager';

export type CameraMode = 'free' | 'train' | 'bus';

export interface UiHandle {
  speedSetting: number;
  paused: boolean;
  tourActive: boolean;
  timeScale: number;
  setLoadingProgress: (progress: number, stage?: string) => void;
  hideLoadingScreen: () => void;
  setInfoText: (text: string) => void;
  setClock: (text: string) => void;
  setChapter: (text: string) => void;
  setStation: (state: TrainPublicState) => void;
  setTourActive: (active: boolean) => void;
  setWeatherLabel: (text: string) => void;
  setTimeScale: (scale: number) => void;
  setRealTime: (active: boolean, label?: string) => void;
  setQuality: (snapshot: QualitySnapshot) => void;
  setEclipseStatus: (visible: boolean, title?: string, detail?: string, progress?: number) => void;
  showToast: (text: string) => void;
  setCameraMode: (mode: CameraMode) => void;
  onCameraMode: (handler: (mode: 'train' | 'bus') => void) => void;
  setThemeActive: (id: string) => void;
  onThemeChange: (handler: (id: string) => void) => void;
  onTourButton: (handler: () => void) => void;
  onWeatherCycle: (handler: () => void) => void;
  onPauseToggle: (handler: () => void) => void;
  onTimeScale: (handler: (scale: number) => void) => void;
  onRealTimeToggle: (handler: () => void) => void;
  onQualityCycle: (handler: () => void) => void;
  onProfilerToggle: (handler: () => void) => void;
  onEclipseStart: (handler: () => void) => void;
  dispose: () => void;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`UI element #${id} not found in document`);
  return el as T;
}

export function mountUi(): UiHandle {
  const loadingEl = requireEl<HTMLDivElement>('loading-screen');
  const loadingBarTrackEl = loadingEl.querySelector<HTMLDivElement>('[role="progressbar"]');
  if (!loadingBarTrackEl) throw new Error('Loading progressbar is missing');
  const loadingBarEl = requireEl<HTMLDivElement>('loading-progress-bar');
  const loadingStageEl = requireEl<HTMLDivElement>('loading-stage');
  const loadingProgressEl = requireEl<HTMLDivElement>('loading-progress');
  const speedControlEl = requireEl<HTMLInputElement>('speed-control');
  const chapterEl = requireEl<HTMLDivElement>('chapter');
  const stationEl = requireEl<HTMLDivElement>('station-status');
  const stationLabelEl = requireEl<HTMLSpanElement>('station-label');
  const stationDwellEl = requireEl<HTMLSpanElement>('station-dwell');
  const infoEl = requireEl<HTMLDivElement>('info');
  const timeDisplay = requireEl<HTMLDivElement>('time-display');
  const tourButtonEl = requireEl<HTMLButtonElement>('tour-button');
  const weatherToastEl = requireEl<HTMLDivElement>('weather-toast');
  const weatherButtonEl = requireEl<HTMLButtonElement>('weather-button');
  const realtimeButtonEl = requireEl<HTMLButtonElement>('realtime-button');
  const qualityButtonEl = requireEl<HTMLButtonElement>('quality-button');
  const trainCamButtonEl = requireEl<HTMLButtonElement>('traincam-button');
  const busCamButtonEl = requireEl<HTMLButtonElement>('buscam-button');
  const themeButtonEl = requireEl<HTMLButtonElement>('theme-button');
  const themePanelEl = requireEl<HTMLDivElement>('theme-panel');
  const timeSpeedEl = requireEl<HTMLDivElement>('time-speed');
  const panelEl = requireEl<HTMLDivElement>('control-panel');
  const panelToggleEl = requireEl<HTMLButtonElement>('panel-toggle');
  const eclipseButtonEl = requireEl<HTMLButtonElement>('eclipse-button');
  const eclipseStatusEl = requireEl<HTMLDivElement>('eclipse-status');
  const eclipseTitleEl = requireEl<HTMLDivElement>('eclipse-title');
  const eclipseDetailEl = requireEl<HTMLDivElement>('eclipse-detail');
  const eclipseProgressEl = requireEl<HTMLDivElement>('eclipse-progress');

  const togglePanel = () => {
    const collapsed = panelEl.classList.toggle('is-collapsed');
    panelToggleEl.setAttribute('aria-expanded', String(!collapsed));
  };
  panelToggleEl.addEventListener('click', togglePanel);

  let toastTimer: number | null = null;
  let loadingProgress = 0;

  const handle: UiHandle = {
    speedSetting: Number(speedControlEl.value) / 100,
    paused: false,
    tourActive: false,
    timeScale: 1,
    setLoadingProgress(progress, stage) {
      if (!Number.isFinite(progress)) return;
      const clampedProgress = Math.min(100, Math.max(0, progress));
      if (clampedProgress < loadingProgress) return;
      const nextProgress = clampedProgress;
      loadingProgress = nextProgress;
      const roundedProgress = Math.round(nextProgress);
      loadingBarEl.style.transform = `scaleX(${nextProgress / 100})`;
      loadingBarTrackEl.setAttribute('aria-valuenow', String(roundedProgress));
      loadingProgressEl.textContent = `${roundedProgress}%`;
      if (stage) loadingStageEl.textContent = stage;
    },
    hideLoadingScreen() {
      loadingEl.classList.add('is-hidden');
    },
    setInfoText(text) {
      infoEl.textContent = text;
    },
    setClock(text) {
      timeDisplay.textContent = text;
    },
    setChapter(text) {
      chapterEl.textContent = text;
    },
    setStation(state) {
      stationEl.hidden = false;
      stationLabelEl.textContent = state.stationLabel;
      stationEl.classList.toggle('is-stopped', state.kind === 'dwelling');
      switch (state.kind) {
        case 'cruising':
          stationDwellEl.textContent = 'następna stacja';
          break;
        case 'braking':
          stationDwellEl.textContent = 'wjazd na peron';
          break;
        case 'dwelling':
          stationDwellEl.textContent =
            state.dwellRemaining > 0.4
              ? `postój ${Math.ceil(state.dwellRemaining)} s`
              : 'odjazd…';
          break;
        case 'leaving':
          stationDwellEl.textContent = 'odjeżdża…';
          break;
      }
    },
    setTourActive(active) {
      handle.tourActive = active;
      tourButtonEl.classList.toggle('is-active', active);
      tourButtonEl.textContent = active ? 'Zatrzymaj tour' : 'Pokaż dioramę';
    },
    setWeatherLabel(text) {
      weatherButtonEl.textContent = text;
    },
    setTimeScale(scale) {
      handle.timeScale = scale;
      timeSpeedEl.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('is-active', Number(btn.dataset.scale) === scale);
      });
    },
    setRealTime(active, label) {
      realtimeButtonEl.classList.toggle('is-active', active);
      realtimeButtonEl.textContent = active ? `⏱ NA ŻYWO${label ? ` · ${label}` : ''}` : '⏱ REAL TIME';
      timeSpeedEl.classList.toggle('is-disabled', active);
    },
    setQuality(snapshot) {
      const modeLabel: Record<QualityMode, string> = {
        auto: `AUTO · ${snapshot.level.toUpperCase()}`,
        low: 'LOW',
        medium: 'MED',
        high: 'HIGH',
      };
      qualityButtonEl.textContent = `JAKOŚĆ: ${modeLabel[snapshot.mode]}`;
      qualityButtonEl.dataset.mode = snapshot.mode;
      qualityButtonEl.title = `Profil renderingu: ${snapshot.level}`;
    },
    setEclipseStatus(visible, title = '', detail = '', progress = 0) {
      eclipseStatusEl.hidden = !visible;
      if (!visible) return;
      eclipseTitleEl.textContent = title;
      eclipseDetailEl.textContent = detail;
      eclipseProgressEl.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    },
    showToast(text) {
      weatherToastEl.textContent = text;
      weatherToastEl.hidden = false;
      weatherToastEl.style.opacity = '1';
      if (toastTimer !== null) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        weatherToastEl.style.opacity = '0';
        toastTimer = window.setTimeout(() => {
          weatherToastEl.hidden = true;
        }, 600);
      }, 1800);
    },
    setCameraMode(mode) {
      trainCamButtonEl.classList.toggle('is-active', mode === 'train');
      busCamButtonEl.classList.toggle('is-active', mode === 'bus');
    },
    onCameraMode(handler) {
      keyHandlers.cameraMode = handler;
      trainCamButtonEl.addEventListener('click', () => handler('train'));
      busCamButtonEl.addEventListener('click', () => handler('bus'));
    },
    setThemeActive(id) {
      themePanelEl.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.theme === id);
      });
    },
    onThemeChange(handler) {
      themeButtonEl.addEventListener('click', () => {
        themePanelEl.hidden = !themePanelEl.hidden;
      });
      themePanelEl.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = (btn as HTMLButtonElement).dataset.theme ?? 'classic';
          handle.setThemeActive(id);
          handler(id);
        });
      });
    },
    onTourButton(handler) {
      tourButtonEl.addEventListener('click', () => {
        handle.setTourActive(!handle.tourActive);
        handler();
      });
    },
    onWeatherCycle(handler) {
      keyHandlers.weather = handler;
      weatherButtonEl.addEventListener('click', handler);
    },
    onPauseToggle(handler) {
      keyHandlers.pause = () => {
        handle.paused = !handle.paused;
        handler();
      };
    },
    onTimeScale(handler) {
      keyHandlers.timeScale = handler;
      timeSpeedEl.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const scale = Number((btn as HTMLButtonElement).dataset.scale) || 1;
          handler(scale);
        });
      });
    },
    onRealTimeToggle(handler) {
      keyHandlers.realtime = handler;
      realtimeButtonEl.addEventListener('click', handler);
    },
    onQualityCycle(handler) {
      keyHandlers.quality = handler;
      qualityButtonEl.addEventListener('click', handler);
    },
    onProfilerToggle(handler) {
      keyHandlers.profiler = handler;
    },
    onEclipseStart(handler) {
      keyHandlers.eclipse = handler;
      eclipseButtonEl.addEventListener('click', handler);
    },
    dispose() {
      speedControlEl.removeEventListener('input', onSpeed);
      window.removeEventListener('keydown', onKey);
      panelToggleEl.removeEventListener('click', togglePanel);
    },
  };

  const keyHandlers: {
    cameraMode?: (mode: 'train' | 'bus') => void;
    weather?: () => void;
    pause?: () => void;
    timeScale?: (scale: number) => void;
    realtime?: () => void;
    quality?: () => void;
    profiler?: () => void;
    eclipse?: () => void;
  } = {};

  const onSpeed = () => {
    handle.speedSetting = Number(speedControlEl.value) / 100;
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (e.key === 't' || e.key === 'T') {
      keyHandlers.cameraMode?.('train');
    } else if (e.key === 'b' || e.key === 'B') {
      keyHandlers.cameraMode?.('bus');
    } else if (e.key === 'w' || e.key === 'W') {
      keyHandlers.weather?.();
    } else if (e.key === 'r' || e.key === 'R') {
      keyHandlers.realtime?.();
    } else if (e.key === 'q' || e.key === 'Q') {
      keyHandlers.quality?.();
    } else if ((e.key === 'p' || e.key === 'P') && import.meta.env.DEV) {
      keyHandlers.profiler?.();
    } else if (e.key === 'e' || e.key === 'E') {
      keyHandlers.eclipse?.();
    } else if (e.key === '1' || e.key === '2' || e.key === '3') {
      keyHandlers.timeScale?.(Number(e.key));
    } else if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      keyHandlers.pause?.();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -5 : 5;
      const newVal = Math.min(100, Math.max(0, Number(speedControlEl.value) + dir));
      speedControlEl.value = String(newVal);
      handle.speedSetting = newVal / 100;
    }
  };

  speedControlEl.addEventListener('input', onSpeed);
  window.addEventListener('keydown', onKey);

  return handle;
}
