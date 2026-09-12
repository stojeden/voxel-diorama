import * as THREE from 'three';
import { clockFromSolarPhase } from '../environment/sky';
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

  const themeDeclination = () =>
    THREE.MathUtils.degToRad(options.getTheme().sunDeclinationDeg);

  const compileAt = async (clock: number, loading: number, label: string) => {
    ui.setLoadingProgress(loading, label);
    // A cloudless warm-up on purpose: these passes exist to compile shader permutations,
    // and the sky the world opens on is the last call in the `finally` below.
    dayNight.update(clock, 0, 0, themeDeclination(), options.getTheme().nightFloor, 0);
    await env.renderer.compileAsync(env.scene, env.camera);
    env.composer.render(0);
  };
  /**
   * The three labelled moments below are solar PHASES; the opening one is already a clock.
   *
   * They exist to walk the lighting across its range so every shader permutation is built
   * before the first frame. Written against a sun that always set at 18:00, they stopped
   * meaning what their labels say the moment the sun became seasonal: read as a clock, 0.86
   * is 2.4 degrees below the horizon in June rather than 22.9, so "KOMPILOWANIE NOCY"
   * compiled civil twilight and the night permutations were never built. That is the fifth
   * and sixth instance of this same mistake in this codebase; the axis is named at every
   * literal now precisely because naming it is what was missing each time.
   *
   * `getDayProgress()` is the director's own clock and must NOT be converted -- it is also
   * the call that seeds the smoothed lighting, so it has to seed it at the hour the world
   * actually opens.
   */
  const compileAtPhase = (phase: number, loading: number, label: string) =>
    compileAt(clockFromSolarPhase(phase, themeDeclination()), loading, label);

  try {
    await compileAt(options.getDayProgress(), 24, 'KOMPILOWANIE PORANKA');
    await compileAtPhase(0.5, 42, 'KOMPILOWANIE ŚWIATŁA DNIA');
    await compileAtPhase(0.28, 56, 'KOMPILOWANIE ZŁOTEJ GODZINY');
    await compileAtPhase(0.86, 70, 'KOMPILOWANIE NOCY');
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
    dayNight.update(eclipseViewTime, 0, 0, themeDeclination(), options.getTheme().nightFloor, 0);
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
      themeDeclination(),
      options.getTheme().nightFloor,
      weather.getCloudCover()
    );
    env.composer.render(0);
    env.renderer.getContext().finish();
    ui.setLoadingProgress(96, 'PRZYGOTOWANIE PIERWSZEJ KLATKI');
  }
}
