import type * as THREE from 'three';

/**
 * What a series of GPU timings came back as. Only `complete` may be quoted.
 *
 * - `idle`        nothing has been asked for yet
 * - `measuring`   a series is open and still collecting
 * - `complete`    every requested sample arrived
 * - `timeout`     the frame budget ran out with fewer samples than requested
 * - `disjoint`    the driver reported a disjoint interval, so the whole series is void
 * - `unsupported` this context has no `EXT_disjoint_timer_query_webgl2`
 * - `cancelled`   the series was abandoned before it finished
 */
export type FrameTimingStatus =
  | 'idle'
  | 'measuring'
  | 'complete'
  | 'timeout'
  | 'disjoint'
  | 'unsupported'
  | 'cancelled';

export interface FrameTimingReading {
  /** Identity of the series these samples belong to. Nothing else may be mixed in. */
  series: number;
  status: FrameTimingStatus;
  requested: number;
  samples: number[];
  /** Queries begun and not yet resolved. */
  pending: number;
  /** Queries abandoned because their result never became available. */
  dropped: number;
  /** Frames timed since this series started. */
  frames: number;
  disjoint: boolean;
  /** True only when `status === 'complete'`: `requested` samples, no disjoint interval. */
  usable: boolean;
}

/** Token handed from `begin` to `end`, carrying the series it belongs to. */
export interface FrameQuery {
  query: WebGLQuery;
  series: number;
}

export interface FrameTiming {
  begin(): FrameQuery | null;
  end(token: FrameQuery | null): void;
  /** Open a series of `count` samples. Throws if one is still open -- cancel it first. */
  start(count: number, maxFrames?: number): number;
  /** Abandon an open series and release every query it owns. */
  cancel(): void;
  read(): FrameTimingReading;
  dispose(): void;
}

/** Anything that can hand out a WebGL context: the renderer in the app, a stub in tests. */
export interface GlSource {
  getContext(): unknown;
}

interface Timer {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** A result is only asked for a few frames after the query closed, so nothing stalls. */
const HARVEST_DELAY_FRAMES = 3;
/** After this many frames an unresolved query is abandoned and deleted. */
const ABANDON_AFTER_FRAMES = 60;

/**
 * GPU timing of the real animation frame, one disjoint timer query per frame, read back
 * a few frames later so nothing stalls the pipeline.
 *
 * Diagnostics only, so it lives outside the entry chunk: the render loop holds a
 * nullable handle and `main.ts` imports this module when a benchmark asks for samples.
 * `TIME_ELAPSED_EXT` spans a command range including pipeline waits, so a sample is an
 * upper bound on the render's own GPU cost, not an exact figure.
 *
 * Every query is owned by exactly one series and is deleted on every path out --
 * harvested, abandoned, cancelled or disposed. The version this replaces cleared its
 * samples on `start()` but kept the previous series' pending queries, so a late result
 * from an old variant landed in the next measurement, and queries abandoned for age
 * were dropped from the list without `deleteQuery`. `frameTiming.test.ts` runs that
 * algorithm against the same fake context and shows both faults.
 */
export function createFrameTiming(source: GlSource | THREE.WebGLRenderer): FrameTiming {
  interface PendingQuery {
    query: WebGLQuery;
    series: number;
    frame: number;
  }

  let series = 0;
  let status: FrameTimingStatus = 'idle';
  let requested = 0;
  let frames = 0;
  let deadline = 0;
  let samples: number[] = [];
  let pending: PendingQuery[] = [];
  let active: PendingQuery | null = null;
  let dropped = 0;
  let disjoint = false;

  const context = (): { gl: WebGL2RenderingContext; timer: Timer } | null => {
    const gl = (source as GlSource).getContext() as WebGL2RenderingContext | null;
    if (!gl || typeof gl.createQuery !== 'function') return null;
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as Timer | null;
    return timer ? { gl, timer } : null;
  };

  /**
   * Delete queries. The active one is ended first: deleting a query that is still
   * recording is undefined behaviour and hides the samples that were in flight.
   */
  const release = (gl: WebGL2RenderingContext, timer: Timer, which: (entry: PendingQuery) => boolean): void => {
    if (active && which(active)) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      gl.deleteQuery(active.query);
      active = null;
    }
    const keep: PendingQuery[] = [];
    for (const entry of pending) {
      if (which(entry)) gl.deleteQuery(entry.query);
      else keep.push(entry);
    }
    pending = keep;
  };

  const finish = (gl: WebGL2RenderingContext, timer: Timer, outcome: FrameTimingStatus): void => {
    status = outcome;
    release(gl, timer, () => true);
  };

  return {
    begin(): FrameQuery | null {
      if (status !== 'measuring') return null;
      const ctx = context();
      if (!ctx) {
        status = 'unsupported';
        return null;
      }
      // One query per target at a time. A second `begin` without an `end` would leave
      // the first recording forever, so it is refused rather than silently nested.
      if (active) return null;
      const query = ctx.gl.createQuery();
      if (!query) return null;
      ctx.gl.beginQuery(ctx.timer.TIME_ELAPSED_EXT, query);
      active = { query, series, frame: frames };
      return { query, series };
    },

    end(token: FrameQuery | null): void {
      if (!token) return;
      const ctx = context();
      if (!ctx) return;
      const { gl, timer } = ctx;
      // The query has to be closed whatever happens next, including when the series it
      // belonged to is already gone.
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      active = null;
      if (token.series !== series || status !== 'measuring') {
        gl.deleteQuery(token.query);
        return;
      }

      frames += 1;
      pending.push({ query: token.query, series, frame: frames });
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) disjoint = true;

      const keep: PendingQuery[] = [];
      for (const entry of pending) {
        if (entry.series !== series) {
          // Cannot happen while `start` releases the previous series, and is deleted
          // rather than trusted if it ever does.
          gl.deleteQuery(entry.query);
          continue;
        }
        const age = frames - entry.frame;
        if (age < HARVEST_DELAY_FRAMES) {
          keep.push(entry);
          continue;
        }
        if (gl.getQueryParameter(entry.query, gl.QUERY_RESULT_AVAILABLE)) {
          samples.push(gl.getQueryParameter(entry.query, gl.QUERY_RESULT) / 1_000_000);
          gl.deleteQuery(entry.query);
          continue;
        }
        if (age >= ABANDON_AFTER_FRAMES) {
          dropped += 1;
          gl.deleteQuery(entry.query);
          continue;
        }
        keep.push(entry);
      }
      pending = keep;

      if (disjoint) finish(gl, timer, 'disjoint');
      else if (samples.length >= requested) finish(gl, timer, 'complete');
      else if (frames >= deadline) finish(gl, timer, 'timeout');
    },

    start(count: number, maxFrames?: number): number {
      if (status === 'measuring') {
        throw new Error(
          `frame timing series ${series} is still measuring (${samples.length}/${requested} samples); `
          + 'cancel it before starting another'
        );
      }
      const ctx = context();
      // A previous series can still own queries after a complete or timed-out run only
      // if the context vanished; release whatever is left before taking a new identity.
      if (ctx) release(ctx.gl, ctx.timer, () => true);
      series += 1;
      requested = count;
      samples = [];
      pending = [];
      dropped = 0;
      frames = 0;
      disjoint = false;
      deadline = maxFrames ?? count * 4 + 240;
      status = ctx ? 'measuring' : 'unsupported';
      return series;
    },

    cancel(): void {
      const ctx = context();
      if (ctx) release(ctx.gl, ctx.timer, () => true);
      if (status === 'measuring') status = 'cancelled';
    },

    read(): FrameTimingReading {
      return {
        series,
        status,
        requested,
        samples: [...samples],
        pending: pending.length,
        dropped,
        frames,
        disjoint,
        usable: status === 'complete',
      };
    },

    dispose(): void {
      const ctx = context();
      if (ctx) release(ctx.gl, ctx.timer, () => true);
      status = 'idle';
      samples = [];
      requested = 0;
      frames = 0;
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

/**
 * Physical lights the renderer will compile into its shader: `visible` decides that,
 * intensity does not. Counting both separately is what showed that zeroing eight of
 * sixteen intensities changed no cost at all -- the shader still looped sixteen.
 */
export function countCompiledLocalLights(scene: THREE.Scene): number {
  let compiled = 0;
  scene.traverse((object) => {
    const light = object as THREE.PointLight | THREE.SpotLight;
    if (!(light as THREE.PointLight).isPointLight && !(light as THREE.SpotLight).isSpotLight) return;
    if (light.visible) compiled++;
  });
  return compiled;
}
