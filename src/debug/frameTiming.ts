import type * as THREE from 'three';

export type FrameTimingReading = { samples: number[]; disjoint: boolean; pending: number };

export type FrameTiming = {
  begin(): WebGLQuery | null;
  end(query: WebGLQuery | null): void;
  start(count: number): void;
  read(): FrameTimingReading;
};

/**
 * GPU timing of the real animation frame, using one disjoint timer query per frame
 * and reading results back a few frames later so nothing stalls the pipeline.
 *
 * Diagnostics only, so it lives outside the entry chunk: the render loop holds a
 * nullable handle and `main.ts` imports this module when a benchmark asks for
 * samples. `TIME_ELAPSED_EXT` spans a command range including pipeline waits, so a
 * sample is an upper bound on the render's own GPU cost, not an exact figure.
 */
export function createFrameTiming(renderer: THREE.WebGLRenderer): FrameTiming {
  type Pending = { query: WebGLQuery; frame: number };
  let want = 0;
  let pending: Pending[] = [];
  let samples: number[] = [];
  let disjoint = false;
  let counter = 0;
  const ext = () => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    return {
      gl,
      timer: gl.getExtension('EXT_disjoint_timer_query_webgl2') as
        | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
        | null,
    };
  };
  return {
    begin(): WebGLQuery | null {
      if (want <= 0) return null;
      const { gl, timer } = ext();
      if (!timer) { want = 0; return null; }
      const query = gl.createQuery();
      if (!query) return null;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      return query;
    },
    end(query: WebGLQuery | null): void {
      if (!query) return;
      const { gl, timer } = ext();
      if (!timer) return;
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      counter++;
      pending.push({ query, frame: counter });
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) disjoint = true;
      pending = pending.filter(({ query: q, frame }) => {
        if (counter - frame < 3) return true;
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) return counter - frame < 60;
        samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1_000_000);
        gl.deleteQuery(q);
        if (samples.length >= want) want = 0;
        return false;
      });
    },
    start(count: number): void {
      samples = []; disjoint = false; want = count;
    },
    read(): FrameTimingReading {
      return { samples: [...samples], disjoint, pending: pending.length };
    },
  };
}

/**
 * Ground truth for a light diagnostic: walk the finished scene instead of trusting the
 * switch that was flipped. Counts every point and spot light that is visible with a
 * non-zero intensity, so the bus and train headlamps are included.
 */
export function countVisibleLocalLights(scene: THREE.Scene): number {
  let visible = 0;
  scene.traverse((object) => {
    const light = object as THREE.PointLight | THREE.SpotLight;
    if (!(light as THREE.PointLight).isPointLight && !(light as THREE.SpotLight).isSpotLight) return;
    if (light.visible && light.intensity > 0) visible++;
  });
  return visible;
}
