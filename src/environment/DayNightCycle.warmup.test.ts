import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { DayNightCycle, type DayNightHooks } from './DayNightCycle';
import { QUALITY_PROFILES } from '../performance/QualityManager';
import { clock01, radians } from '../units.testing';
import { warmRenderer } from '../experience/RendererWarmup';
import { THEMES } from '../experience/Themes';
import { EclipseTimeline } from '../experience/EclipseTimeline';
import type { RuntimeEnv } from '../bootstrap';
import type { UiHandle } from '../ui';
import type { Weather } from './Weather';

// Keep real geometry, materials and lighting logic; only replace the GPU reflection probe.
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return {
    ...actual,
    PMREMGenerator: class {
      fromScene() { return new actual.WebGLRenderTarget(1, 1); }
      dispose() {}
    },
  };
});

function fixture() {
  const scene = new THREE.Scene();
  const lights = (count: number) => Array.from({ length: count }, () => new THREE.PointLight());
  const glow = () => new THREE.ShaderMaterial({ uniforms: { uNight: { value: 0 } } });
  const glowMesh = () => new THREE.InstancedMesh(new THREE.BufferGeometry(), glow(), 0);
  const hooks: DayNightHooks = {
    streetLights: lights(8), streetGlowMesh: glowMesh(), streetGlowMaterial: glow(),
    busStopLights: lights(3), busStopGlowMaterials: [],
    stationLights: lights(3), stationGlowMaterials: [],
    stationGlowMesh: glowMesh(), stationGlowMaterial: glow(),
    windowLights: [], windowGlowMaterials: [],
  };
  const events = vi.fn(() => 0.5);
  const cycle = new DayNightCycle(scene, {} as THREE.WebGLRenderer, hooks, () => 0.5, events);
  cycle.setQuality(QUALITY_PROFILES.high);
  const sun = scene.children.find(
    (child) => child instanceof THREE.DirectionalLight && child.castShadow
  ) as THREE.DirectionalLight;
  const sample = (clock: number, delta = 0) => cycle.update(clock01(clock), delta, 0, radians(0), 0, 0);
  const visibleLights = () => [...hooks.streetLights, ...hooks.busStopLights, ...hooks.stationLights]
    .filter((light) => light.visible).length;
  return { cycle, scene, events, sun, sample, visibleLights };
}

describe('exact renderer lighting warm-up', () => {
  test('actually activates night budgets at zero delta and restores the live filter', () => {
    const { cycle, sample, visibleLights, events } = fixture();
    const day = sample(0.5);
    expect(day.night).toBe(0);
    expect(sample(0).night).toBe(0); // Normal zero-delta updates deliberately stay smoothed.
    const restore = cycle.beginRendererWarmup();
    expect(sample(0).night).toBe(1);
    expect(visibleLights()).toBe(10);
    cycle.setCameraMode('bus');
    sample(0);
    expect(visibleLights()).toBe(2);
    cycle.setCameraFocusDistance(148);
    sample(0);
    expect(visibleLights()).toBe(1);
    sample(0, 50); // Even an accidental nonzero warm-up delta cannot trigger events.
    expect(events).not.toHaveBeenCalled();
    restore();
    restore(); // Cleanup is idempotent.
    expect(sample(0.5)).toEqual(day);
    expect(visibleLights()).toBe(0);
    // The restored view must be near/free, not the last compiled night overview.
    sample(0, 20);
    expect(visibleLights()).toBe(10);
    cycle.dispose();
  });

  test('does not seed an uninitialized opening filter from the last compiled moment', () => {
    const { cycle, sample } = fixture();
    const restore = cycle.beginRendererWarmup();
    sample(0);
    expect(() => cycle.beginRendererWarmup()).toThrow(/already active/);
    restore();
    expect(sample(0.5).night).toBe(0);
    cycle.dispose();
  });
});

describe('renderer warm-up orchestration', () => {
  test.each([
    { fail: false, theme: THEMES[0] },
    { fail: false, theme: THEMES.find((theme) => theme.id === 'autumn')! },
    { fail: true, theme: THEMES[0] },
  ])('restores the opening scene (failure=$fail, theme=$theme.id)', async ({ fail, theme }) => {
    const { cycle, scene, sun, sample, visibleLights } = fixture();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 80);
    cycle.camera = camera;
    const hidden = new THREE.Object3D();
    hidden.visible = false;
    scene.add(hidden);
    const variants: Array<{ points: number; shadow: boolean }> = [];
    const compileAsync = vi.fn(async () => {
      variants.push({ points: visibleLights(), shadow: sun.castShadow });
      if (fail && variants.length === 6) throw new Error('deliberate compile failure');
    });
    const finish = vi.fn();
    const render = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      scene, camera, renderer: { compileAsync, getContext: () => ({ finish }) },
      composer: { render },
    } as unknown as RuntimeEnv;
    const opening = sample(0.5);
    await warmRenderer({
      env,
      ui: { setLoadingProgress: vi.fn() } as unknown as UiHandle,
      dayNight: cycle,
      weather: { getCloudCover: () => 0.12 } as Weather,
      focusTarget: new THREE.Vector3(),
      eclipseViewTime: clock01(0.5),
      getTheme: () => theme,
      getDayProgress: () => clock01(0.5),
      getEclipseState: () => new EclipseTimeline().getState(),
    });
    expect(hidden.visible).toBe(false);
    expect(visibleLights()).toBe(0);
    expect(sample(0.5)).toEqual(opening);
    expect(render).toHaveBeenCalled();
    if (fail) {
      expect(warn).toHaveBeenCalledOnce();
    } else {
      for (const points of [1, 2, 10]) {
        expect(variants).toContainEqual({ points, shadow: false });
        expect(variants).toContainEqual({ points, shadow: true });
      }
      expect(compileAsync).toHaveBeenCalledTimes(9);
    }
    warn.mockRestore();
    cycle.dispose();
  });
});

describe('camera shadow target reuse', () => {
  test('reuses both PCF resolutions and disposes them once on quality change', () => {
    const { cycle, sun } = fixture();
    const near = new THREE.WebGLRenderTarget(1024, 1024);
    const far = new THREE.WebGLRenderTarget(512, 512);
    const nearDispose = vi.spyOn(near, 'dispose');
    const farDispose = vi.spyOn(far, 'dispose');
    sun.shadow.map = near;
    cycle.setCameraFocusDistance(148);
    expect(sun.shadow.map).toBeNull();
    sun.shadow.map = far; // The renderer's lazy allocation on the first wide render.
    cycle.setCameraFocusDistance(80);
    expect(sun.shadow.map).toBe(near);
    cycle.setCameraFocusDistance(148);
    expect(sun.shadow.map).toBe(far);
    expect(nearDispose).not.toHaveBeenCalled();
    expect(farDispose).not.toHaveBeenCalled();
    cycle.setQuality(QUALITY_PROFILES.low);
    expect(nearDispose).toHaveBeenCalledTimes(1);
    expect(farDispose).toHaveBeenCalledTimes(1);
    expect(sun.shadow.map).toBeNull();
    cycle.dispose();
    expect(nearDispose).toHaveBeenCalledTimes(1);
    expect(farDispose).toHaveBeenCalledTimes(1);
  });
});
