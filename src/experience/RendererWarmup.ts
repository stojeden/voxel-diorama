import * as THREE from 'three';
import type { RuntimeEnv } from '../bootstrap';
import type { UiHandle } from '../ui';
import type { DayNightCycle } from '../environment/DayNightCycle';
import type { Weather } from '../environment/Weather';
import type { DioramaTheme } from './Themes';
import type { EclipseTimelineState } from './EclipseTimeline';

interface RendererWarmupOptions {
  env: RuntimeEnv;
  ui: UiHandle;
  dayNight: DayNightCycle;
  weather: Weather;
  focusTarget: THREE.Vector3;
  eclipseViewTime: number;
  getTheme: () => DioramaTheme;
  getDayProgress: () => number;
  getEclipseState: () => EclipseTimelineState;
}

/** Compile representative shader variants without advancing temporal simulation state. */
export async function warmRenderer(options: RendererWarmupOptions): Promise<void> {
  const { env, ui, dayNight, weather, focusTarget, eclipseViewTime } = options;
  const visibility = new Map<THREE.Object3D, boolean>();
  env.scene.traverse((object) => {
    if (object instanceof THREE.Light) return;
    visibility.set(object, object.visible);
    object.visible = true;
  });

  const compileAt = async (progress: number, loading: number, label: string) => {
    ui.setLoadingProgress(loading, label);
    dayNight.update(progress, 0, 0, options.getTheme().nightFloor);
    await env.renderer.compileAsync(env.scene, env.camera);
    env.composer.render(0);
  };

  try {
    await compileAt(options.getDayProgress(), 24, 'KOMPILOWANIE PORANKA');
    await compileAt(0.5, 42, 'KOMPILOWANIE ŚWIATŁA DNIA');
    await compileAt(0.28, 56, 'KOMPILOWANIE ZŁOTEJ GODZINY');
    await compileAt(0.86, 70, 'KOMPILOWANIE NOCY');
    ui.setLoadingProgress(84, 'KOMPILOWANIE ZAĆMIENIA');
    dayNight.setCameraFocusDistance(148);
    dayNight.setEclipseState({
      active: true,
      coverage: 1,
      separation: 0,
      irradiance: 0.025,
      corona: 1,
      beads: 0,
      stars: 1,
      totality: 1,
    });
    dayNight.update(eclipseViewTime, 0, 0, options.getTheme().nightFloor);
    await env.renderer.compileAsync(env.scene, env.camera);
    env.composer.render(0);
    env.renderer.getContext().finish();
  } catch (error) {
    console.warn('[Preloader] shader warm-up fell back to first-frame compilation', error);
  } finally {
    for (const [object, visible] of visibility) object.visible = visible;
    const eclipse = options.getEclipseState();
    dayNight.setCameraFocusDistance(env.camera.position.distanceTo(focusTarget));
    dayNight.setEclipseState({
      active: eclipse.running || eclipse.phase !== 'complete' && eclipse.progress > 0,
      coverage: eclipse.coverage,
      separation: eclipse.separation,
      irradiance: eclipse.irradiance,
      corona: eclipse.corona,
      beads: eclipse.beads,
      stars: eclipse.stars,
      totality: eclipse.totality,
    });
    dayNight.update(
      options.getDayProgress(),
      0,
      weather.getCloudCover(),
      options.getTheme().nightFloor
    );
    env.composer.render(0);
    env.renderer.getContext().finish();
    ui.setLoadingProgress(96, 'PRZYGOTOWANIE PIERWSZEJ KLATKI');
  }
}
