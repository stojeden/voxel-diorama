import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';
import { stopPreview } from './previewServer.mjs';
import { releaseLock, verifyBuild } from './buildProvenance.mjs';

const HOST = '127.0.0.1';
const PORT = 4174;
const URL = `http://${HOST}:${PORT}`;
const HEADFUL = process.env.BENCH_HEADFUL === '1';
const REQUIRED_FPS = Number(process.env.BENCH_MIN_FPS ?? 58);
const MAX_TTI_MS = Number(process.env.BENCH_MAX_TTI_MS ?? 1_800);
const QUALITY = process.env.BENCH_QUALITY ?? 'high';
// Reversible hybrid spike: `voxel` is the product; hybrid modes add the spike frames.
const WORLD = process.env.BENCH_WORLD ?? 'voxel';
/**
 * Worlds measured in ONE process, alternating scenario by scenario.
 *
 * This is the isolation fix that mattered. The voxel/hybrid comparison used to run as
 * two processes minutes apart, so the machine's own state between them -- other
 * applications on the same GPU, clocks, whatever the desktop was doing -- landed
 * entirely on the difference being measured. The night street measured 48.3 FPS three
 * times in one cluster of runs and 60.0 FPS five times in another, same revision, same
 * recipe. Measured as a pair inside one browser session, minutes apart becomes seconds
 * apart and the state is shared by both sides of the comparison.
 */
const WORLDS = (process.env.BENCH_WORLDS ?? WORLD).split(',').map((name) => name.trim()).filter(Boolean);
const SIMULATION_SEED = Number(process.env.BENCH_SEED ?? 20260722);
const GPU_SAMPLE_COUNT = Number(process.env.BENCH_GPU_SAMPLES ?? 15);
/**
 * TTI is a cold-load measurement and the most contention-sensitive number here: a run
 * started while a smoke render was still finishing reported 1855 ms for a scenario that
 * measures 1260-1343 ms on a quiet machine. Rather than loosen the budget, each scenario
 * is loaded a few times, every attempt is recorded, and the gate applies to the median.
 */
const TTI_SAMPLES = Number(process.env.BENCH_TTI_SAMPLES ?? 3);
/**
 * The page the product is measured in. `deviceScaleFactor` is not cosmetic: the High
 * profile asks for a 1.15 pixel ratio and the renderer takes
 * min(devicePixelRatio, 1.15 * distance * camera), so at 2 the near cameras render
 * 1655x1035 and at 1 they render 1440x900 -- 32% fewer pixels. Two harnesses that
 * differed only here reported 48 FPS and 60 FPS for the same night street, which is
 * why this is one constant, and why it is written into every result file.
 */
/**
 * The revision this run measured, read from git rather than from an environment
 * variable: a result whose provenance depends on the operator remembering to export
 * BENCH_REVISION has no provenance. A dirty tree is recorded too, because a number
 * measured on uncommitted code cannot be reproduced from the revision alone.
 */
/**
 * Before the preview server and before any frame: the shared render lock, and proof that
 * `dist/` is the signed bundle built from this commit. This replaces the benchmark's own
 * lock file -- one gate now covers the build and every harness, so a build can no longer
 * slip in beside a measurement.
 */
const CODE_REVISION = verifyBuild();

const PAGE_SETUP = (() => {
  const [width, height] = (process.env.BENCH_VIEWPORT ?? '1440x900').split('x').map(Number);
  assert.ok(width > 0 && height > 0, `BENCH_VIEWPORT must be WxH, received ${process.env.BENCH_VIEWPORT}`);
  return { viewport: { width, height }, deviceScaleFactor: Number(process.env.BENCH_DEVICE_SCALE ?? 2) };
})();
const requestedScenarioFilters = process.env.BENCH_SCENARIO
  ?.split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const rainbowPair = ['post-rain-clear-lake', 'post-rain-rainbow-lake'];
const scenarioFilterSet = new Set(requestedScenarioFilters);
if (rainbowPair.some((name) => scenarioFilterSet.has(name))) {
  for (const name of rainbowPair) scenarioFilterSet.add(name);
}
const SCENARIO_FILTERS = [...scenarioFilterSet];
const RAINBOW_REPETITIONS = Number(
  process.env.BENCH_REPETITIONS ?? 5
);
const DISABLE_SHADOWS = process.env.BENCH_DISABLE_SHADOWS === '1';
const DISABLE_LOCAL_LIGHTS = process.env.BENCH_DISABLE_LOCAL_LIGHTS === '1';
function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function metricValue(metrics, name) {
  return metrics.metrics.find((metric) => metric.name === name)?.value ?? 0;
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next browser path.
    }
  }
  return undefined;
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview did not start within ${timeoutMs} ms`);
}

/**
 * Diagnostic overrides that survive the measurement window.
 *
 * The previous version walked the scene once and set `visible = false` on every
 * point and spot light. That does nothing: `DayNightCycle.update` reassigns
 * `visible` on every street, bus-stop, station and window light on each frame, and
 * Bus and Train reset their headlamps from their own flags, so the lights were back
 * one frame later and every "local lights off" number taken with it was meaningless.
 * The disable now goes through a durable gate inside those loops, and the state is
 * read back from the scene rather than assumed.
 */
async function applyDiagnosticOverrides(page) {
  const state = await page.evaluate(async ({ disableShadows, disableLocalLights }) => {
    if (disableShadows) window.__diorama.renderer.shadowMap.enabled = false;
    if (disableLocalLights) window.__diorama.debugSetLocalLightsEnabled(false);
    // Let frames run before reading back: the gate is applied inside the update, so
    // asserting in the same tick reports the state from before it took effect.
    for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      shadowsEnabled: window.__diorama.renderer.shadowMap.enabled,
      visibleLocalLights: (() => {
      let n = 0;
      window.__diorama.scene.traverse((node) => {
        if ((node.isPointLight || node.isSpotLight) && node.visible && node.intensity > 0) n += 1;
      });
      return n;
    })(),
    };
  }, { disableShadows: DISABLE_SHADOWS, disableLocalLights: DISABLE_LOCAL_LIGHTS });
  if (DISABLE_SHADOWS) assert.equal(state.shadowsEnabled, false, 'shadow diagnostic override was not applied');
  if (DISABLE_LOCAL_LIGHTS) assert.equal(state.visibleLocalLights, 0, 'local-light diagnostic override was not applied');
  return state;
}

/** Read the overrides back mid-window and again afterwards: applied once is not applied. */
async function confirmDiagnosticOverrides(page, when) {
  const state = await page.evaluate(async () => ({
    shadowsEnabled: window.__diorama.renderer.shadowMap.enabled,
    visibleLocalLights: (() => {
      let n = 0;
      window.__diorama.scene.traverse((node) => {
        if ((node.isPointLight || node.isSpotLight) && node.visible && node.intensity > 0) n += 1;
      });
      return n;
    })(),
  }));
  if (DISABLE_SHADOWS) {
    assert.equal(state.shadowsEnabled, false, `shadows came back ${when}`);
  }
  if (DISABLE_LOCAL_LIGHTS) {
    assert.equal(state.visibleLocalLights, 0, `local lights came back ${when}: ${state.visibleLocalLights} visible`);
  }
  return state;
}

/** Put the world back the way it was, so one experiment cannot colour the next. */
async function clearDiagnosticOverrides(page) {
  await page.evaluate(() => {
    window.__diorama.debugSetLocalLightsEnabled(true);
  });
}

/**
 * GPU cost of the frames the animation actually presents. One disjoint timer query
 * per real frame inside the render loop, read back a few frames later, with no second
 * render and no framebuffer read. `conclusive` is false when the extension is missing,
 * the driver reported a disjoint interval, too few samples came back, or the samples
 * disagree with each other by more than a quarter of their median -- in which case the
 * figure must not be used to grant a PASS or to attribute cost to a feature.
 */
async function measureAnimationGpu(page, frames) {
  const raw = await page.evaluate(async (count) => {
    const series = await window.__diorama.debugStartFrameTiming(count);
    const deadline = performance.now() + 12_000;
    let read = window.__diorama.debugReadFrameTiming();
    // The probe decides when a series is done; this loop only keeps frames coming.
    while (read && read.status === 'measuring' && performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      read = window.__diorama.debugReadFrameTiming();
    }
    if (read && read.status === 'measuring') window.__diorama.debugCancelFrameTiming();
    return { ...(window.__diorama.debugReadFrameTiming() ?? { status: 'unavailable', samples: [], usable: false, requested: count, dropped: 0, disjoint: false }), series };
  }, frames);
  const samples = [...raw.samples].sort((a, b) => a - b);
  // Only a series the probe itself calls complete may be read as a measurement. The
  // rule this replaces accepted five samples out of ninety, so a run that timed out
  // after five frames was quoted as if it had measured the whole window.
  if (!raw.usable) {
    return {
      available: false,
      conclusive: false,
      status: raw.status,
      series: raw.series,
      requested: raw.requested,
      sampleCount: samples.length,
      dropped: raw.dropped,
      disjoint: raw.disjoint,
      reason: `series ${raw.series} ended as ${raw.status} with ${samples.length} of ${raw.requested} samples`,
      samples,
    };
  }
  const median = samples[Math.floor(samples.length / 2)];
  const spread = samples.at(-1) - samples[0];
  /**
   * The threshold is a quarter of the 16.7 ms frame budget, not a fraction of the
   * median. The question this number answers is "where does a frame's time go", so
   * the scale that matters is the frame, not the size of the reading: a spread of
   * 12 ms is useless whether the median is 10 ms or 40 ms, because it is most of a
   * frame either way. Justified, not tuned to make readings pass.
   */
  const tolerance = 16.7 / 4;
  return {
    available: true,
    status: raw.status,
    series: raw.series,
    requested: raw.requested,
    method: 'EXT_disjoint_timer_query_webgl2 around the animation frame in the render loop',
    sampleCount: samples.length,
    medianMs: Math.round(median * 100) / 100,
    p90Ms: Math.round(samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))] * 100) / 100,
    minMs: Math.round(samples[0] * 100) / 100,
    maxMs: Math.round(samples.at(-1) * 100) / 100,
    spreadMs: Math.round(spread * 100) / 100,
    disjoint: raw.disjoint,
    toleranceMs: Math.round(tolerance * 100) / 100,
    /** True only when this one run's samples agree closely enough to localise cost
     *  inside a frame. Never sufficient on its own -- see `attribution`. */
    conclusive: !raw.disjoint && spread <= tolerance,
    /**
     * A single run never certifies an attribution, however tight its samples. What
     * did hold up in practice is the run median: across three alternating
     * repetitions it repeated to about a third of a millisecond while individual
     * samples inside each run scattered by six to fifteen. So attribute cost only
     * from medians of at least three alternating repetitions, recorded in
     * docs/superpowers/spike/night-experiment.tsv, and never from one run.
     */
    attribution: 'requires >=3 alternating repetitions; compare run medians, not single samples',
    samples: samples.map((value) => Math.round(value * 100) / 100),
  };
}

async function readMeasuredState(page) {
  return page.evaluate(() => {
    const state = window.__diorama.getState();
    return {
      t01: state.t01,
      theme: state.theme,
      weather: state.weather,
      cloud: state.cloud,
      wind: state.wind,
      rain: state.rain,
      eclipse: state.eclipse,
      trainProgress: state.trainProgress,
      busProgress: state.busProgress,
      camera: window.__diorama.cameraPose(),
      rainbow: state.rainbow,
      quality: window.__diorama.getMetrics().quality.level,
    };
  });
}

/**
 * What else the machine was doing while this scenario was measured.
 *
 * The benchmark shares a GPU with whatever the desktop is running -- a compositor, a
 * browser rendering a conversation, a design tool repainting -- and the hybrid night
 * frame has so little headroom that a competing application can flip it over the
 * vsync cliff. That was the difference between two clusters of runs that agreed on
 * everything else, so the load is recorded next to every number instead of being
 * offered afterwards as an explanation.
 *
 * Sampled with `ps`, which needs no privileges; our own node, Chrome and vite
 * processes are excluded so that the figure is about foreign load.
 */
/**
 * What else the machine was doing while this scenario was measured.
 *
 * Read honestly, and with its limits on the label. This is CPU occupancy from `ps`,
 * which needs no privileges; **it is not a GPU-load measurement**. macOS exposes no
 * per-process GPU utilisation without privileged tooling, so when a run and a
 * competing application share the GPU this sampler cannot say so, and a difference
 * between runs must not be attributed to GPU contention on the strength of it.
 *
 * Our own headless Chrome is separated by process tree, not by name: the browser's own
 * pid comes from Playwright, and rows whose pid or parent is that process are marked
 * `ours`. A Chrome the user is running is therefore still visible as foreign load,
 * which the previous version hid by excluding every process called "Google Chrome".
 */
async function machineState() {
  const rows = await new Promise((resolve) => {
    const ps = spawn('ps', ['-Ao', 'pid,ppid,pcpu,command', '-r'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (chunk) => { out += chunk.toString(); });
    ps.on('close', () => {
      const parsed = out.split('\n').slice(1)
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/))
        .filter(Boolean)
        .map((match) => ({
          pid: Number(match[1]),
          ppid: Number(match[2]),
          cpu: Number(match[3]),
          command: match[4],
        }))
        .filter((row) => row.cpu >= 1);
      resolve(parsed);
    });
    ps.on('error', () => resolve([]));
  });

  // Our own browser is identified by the profile directory Playwright gives it, which
  // is in its command line. Naming it by process name would also swallow a Chrome the
  // user is running -- which is exactly what the previous version did.
  const OURS = /playwright[_-]chromium|--remote-debugging-pipe/;
  const mine = new Set([process.pid]);
  for (const row of rows) if (OURS.test(row.command) || mine.has(row.ppid)) mine.add(row.pid);
  for (const row of rows) if (mine.has(row.ppid)) mine.add(row.pid);
  const tagged = rows.map((row) => ({
    command: row.command.split(/\s/)[0].split('/').pop(),
    cpu: row.cpu,
    ours: mine.has(row.pid),
  }));
  const foreign = tagged.filter((row) => !row.ours);
  return {
    method: 'ps -Ao pid,ppid,pcpu,command; CPU occupancy only',
    ownership: "our browser identified by Playwright's profile flag in its command line, not by process name",
    limitation: 'no per-process GPU utilisation without privileged tools: GPU contention cannot be measured here',
    loadAverage: loadavg().map((value) => round(value, 2)),
    ownCpuPercent: round(tagged.filter((row) => row.ours).reduce((total, row) => total + row.cpu, 0), 1),
    foreignCpuPercent: round(foreign.reduce((total, row) => total + row.cpu, 0), 1),
    busiest: tagged.slice(0, 6),
    foreignBusiest: foreign.slice(0, 4),
  };
}

async function measureFrames(page, seconds = 3) {
  return page.evaluate(async (durationSeconds) => {
    const deltas = [];
    let previous = 0;
    const deadline = performance.now() + durationSeconds * 1000;
    await new Promise((resolve) => {
      const sample = (now) => {
        if (previous > 0) deltas.push(now - previous);
        previous = now;
        if (now >= deadline) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    deltas.sort((a, b) => a - b);
    const sum = deltas.reduce((total, value) => total + value, 0);
    const percentile = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))];
    return {
      frames: deltas.length,
      averageFps: deltas.length / (sum / 1000),
      averageFrameMs: sum / deltas.length,
      p95FrameMs: percentile(0.95),
      p99FrameMs: percentile(0.99),
      maxFrameMs: deltas.at(-1),
      hitchCount: deltas.filter((value) => value > 50).length,
      slowFrameRatio: deltas.filter((value) => value > 20.5).length / deltas.length,
    };
  }, seconds);
}

async function measureGpuFrame(page, sampleCount = GPU_SAMPLE_COUNT) {
  return page.evaluate(async ({ count, percentile }) => {
    const renderer = window.__diorama?.renderer;
    const gl = renderer?.getContext();
    const extension = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!gl || !extension || typeof gl.createQuery !== 'function') {
      return {
        available: false,
        method: 'EXT_disjoint_timer_query_webgl2',
        reason: 'GPU timer query is unavailable',
      };
    }

    const samples = [];
    for (let index = 0; index < count; index++) {
      const query = gl.createQuery();
      if (!query) {
        return { available: false, method: 'EXT_disjoint_timer_query_webgl2', reason: 'Could not allocate GPU query' };
      }
      // Bracket the composer frame only. Using captureFrame here folded a full-surface
      // readback and a JPEG encode into the number, which is why the night scenario
      // reported four to six times the frame time in every world.
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      window.__diorama.renderFrame();
      gl.endQuery(extension.TIME_ELAPSED_EXT);

      const deadline = performance.now() + 2_000;
      let available = false;
      while (!available && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      }
      const disjoint = gl.getParameter(extension.GPU_DISJOINT_EXT);
      if (!available || disjoint) {
        gl.deleteQuery(query);
        return {
          available: false,
          method: 'EXT_disjoint_timer_query_webgl2',
          reason: disjoint ? 'GPU timing became disjoint' : 'GPU query timed out',
        };
      }
      samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1_000_000);
      gl.deleteQuery(query);
    }
    samples.sort((a, b) => a - b);
    const middle = Math.floor(samples.length / 2);
    const medianRenderMsRaw = samples.length % 2 === 0
      ? (samples[middle - 1] + samples[middle]) / 2
      : samples[middle];
    const nearestRankIndex = Math.max(
      0,
      Math.min(
        samples.length - 1,
        Math.ceil(samples.length * percentile) - 1
      )
    );
    const p90RenderMsRaw = samples[nearestRankIndex];
    return {
      available: true,
      method: 'EXT_disjoint_timer_query_webgl2 around an explicit composer frame',
      sampleCount: samples.length,
      medianRenderMsRaw,
      p90RenderMsRaw,
      medianRenderMs: Math.round(medianRenderMsRaw * 10) / 10,
      p90RenderMs: Math.round(p90RenderMsRaw * 10) / 10,
      minRenderMs: Math.round(samples[0] * 10) / 10,
      maxRenderMs: Math.round(samples.at(-1) * 10) / 10,
      /**
       * Whether this figure may be quoted at all. The timer brackets one forced
       * composer frame, so it picks up anything else contending for the GPU: on a
       * loaded machine the same build measured 9.8, 15.4 and 16.0 ms for one
       * scenario, a spread wider than any difference it was being used to attribute.
       * On a quiet machine the same measurement repeats to a tenth of a millisecond.
       * `stable` false means: do not report this number, re-run on a quiet machine.
       */
      spreadMs: Math.round((samples.at(-1) - samples[0]) * 10) / 10,
      stable: samples.at(-1) - samples[0] <= Math.max(2, medianRenderMsRaw * 0.25),
    };
  }, { count: sampleCount, percentile: 0.9 });
}

const allScenarios = [
  { name: 'golden-clear-overview', checkpoint: 'golden-clear-overview', camera: 'overview' },
  { name: 'noon-rain-overview', checkpoint: 'noon-rain-overview', camera: 'overview' },
  { name: 'post-rain-clear-lake', checkpoint: 'post-rain-clear-lake', camera: 'checkpoint' },
  { name: 'post-rain-rainbow-lake', checkpoint: 'post-rain-rainbow-lake', camera: 'checkpoint' },
  { name: 'night-snow-train', checkpoint: 'night-snow-train', camera: 'train' },
  { name: 'evening-rain-bus', checkpoint: 'evening-rain-bus', camera: 'bus' },
  { name: 'eclipse-totality-overview', checkpoint: 'eclipse-totality-overview', camera: 'overview' },
];
if (WORLDS.some((world) => world !== 'voxel') || SCENARIO_FILTERS.some((name) => name.startsWith('spike-'))) {
  allScenarios.push(
    { name: 'spike-overview', checkpoint: 'spike-overview', camera: 'checkpoint' },
    { name: 'spike-street', checkpoint: 'spike-street', camera: 'checkpoint' },
    { name: 'spike-golden', checkpoint: 'spike-golden', camera: 'checkpoint' },
    { name: 'spike-night-street', checkpoint: 'spike-night-street', camera: 'checkpoint' }
  );
}
const filteredScenarios = SCENARIO_FILTERS.length
  ? allScenarios.filter((scenario) => SCENARIO_FILTERS.includes(scenario.name))
  : allScenarios;
assert.equal(
  filteredScenarios.length,
  SCENARIO_FILTERS.length || allScenarios.length,
  `unknown or duplicate benchmark scenario: ${SCENARIO_FILTERS?.join(',')}`
);
assert.ok(
  Number.isInteger(RAINBOW_REPETITIONS) &&
  RAINBOW_REPETITIONS >= 1 &&
  RAINBOW_REPETITIONS <= 10,
  `BENCH_REPETITIONS must be an integer in 1..10, received ${RAINBOW_REPETITIONS}`
);
assert.ok(
  Number.isInteger(GPU_SAMPLE_COUNT) && GPU_SAMPLE_COUNT >= 3 && GPU_SAMPLE_COUNT <= 31,
  `BENCH_GPU_SAMPLES must be an integer in 3..31, received ${GPU_SAMPLE_COUNT}`
);
const nonRainbowScenarios = filteredScenarios.filter(
  (scenario) => !rainbowPair.includes(scenario.name)
);
const rainbowScenarios = rainbowPair
  .map((name) => filteredScenarios.find((scenario) => scenario.name === name))
  .filter(Boolean);
/**
 * Everything a result file has to carry to be worth reading later, returned as a list
 * of problems rather than thrown -- an incomplete run is still written down, as a
 * diagnostic artefact, never over the canonical file.
 */
function completenessProblems(report, expected) {
  const problems = [];
  const say = (ok, message) => { if (!ok) problems.push(message); };

  say(typeof report.revision === 'string' && report.revision.length > 0, 'no code revision recorded');
  say(typeof report.recordedAt === 'string', 'no timestamp recorded');
  say(typeof report.conditions?.vsync === 'string', 'no vsync/uncapped mode recorded');
  say(typeof report.isolation?.order === 'string', 'no measurement order recorded');
  say(Array.isArray(report.isolation?.series), 'no measurement series recorded');
  say(typeof report.diagnosticShadowsDisabled === 'boolean', 'no shadow diagnostic switch recorded');
  say(typeof report.diagnosticLocalLightsDisabled === 'boolean', 'no light diagnostic switch recorded');
  say(report.diagnosticsAfter !== undefined && report.diagnosticsRestored !== undefined,
    'diagnostic overrides were not read back after the run');
  if (Array.isArray(report.isolation?.series) && report.isolation.series.length > 1) {
    say(report.isolation.canary !== null && report.isolation.canary !== undefined,
      'a multi-scenario run recorded no canary');
  }

  const got = report.results.map((result) => result.name);
  for (const name of expected) say(got.includes(name), `missing scenario ${name}`);
  for (const result of report.results) {
    const where = result.name;
    say(Array.isArray(result.timeToInteractiveSamples) && result.timeToInteractiveSamples.length === TTI_SAMPLES,
      `${where}: ${result.timeToInteractiveSamples?.length} of ${TTI_SAMPLES} TTI attempts`);
    say(result.timing && Number.isFinite(result.timing.averageFps), `${where}: no frame timing`);
    say(Number.isFinite(result.timing?.frames) && result.timing.frames > 0, `${where}: no frames counted`);
    say(typeof result.world === 'string' && result.world.length > 0, `${where}: no world recorded`);
    say(result.measuredState?.quality === QUALITY,
      `${where}: quality ${result.measuredState?.quality} is not ${QUALITY}`);
    say(Number.isFinite(result.renderer?.pixelRatio) && result.renderer.pixelRatio > 0, `${where}: no pixel ratio`);
    say(result.renderer?.canvasWidth > 0 && result.renderer?.canvasHeight > 0, `${where}: no canvas size`);
    say(Number.isFinite(result.positionInSeries), `${where}: no position in the series`);
    say(result.machine?.after !== undefined, `${where}: no machine state`);
    // Raw attempts, not just the summary: a median with no samples behind it is a claim.
    say(Array.isArray(result.animationGpu?.samples), `${where}: no raw GPU samples array`);
  }
  return problems;
}

/**
 * Write the run.
 *
 * A run that passed every check replaces the canonical file, atomically. A run that
 * failed anything is still written -- failures are evidence -- but to its own
 * `.failed.json`, and an uncapped run to `.uncapped.json`, so the last good result
 * stays the last good result. This used to run before the canary and the gates, so a
 * run could overwrite a good file and only then discover it had failed.
 */
function writeRun(report, verdict, problems) {
  const out = process.env.BENCH_OUT;
  const serialised = JSON.stringify({ ...report, verdict, problems }, null, 2);
  JSON.parse(serialised);
  if (!out) return null;
  const suffix = verdict === 'passed' ? '' : verdict === 'inconclusive' ? '.uncapped.json' : '.failed.json';
  const target = suffix ? out.replace(/\.json$/, '') + suffix : out;
  writeFileSync(`${target}.partial`, serialised);
  renameSync(`${target}.partial`, target);
  return target;
}

/**
 * Order of the series, and a drift control around it.
 *
 * A run measures a dozen scenarios back to back in one browser process, so anything
 * that changes over a run -- clocks, caches, the GPU warming up, another application
 * arriving -- lands on whichever scenario happens to sit late in the list, and a fixed
 * order makes "this scenario is expensive" indistinguishable from "this scenario ran
 * last". Two things address that: `BENCH_ORDER` can reverse or shuffle the series, and
 * the same cheap scenario is measured first and last in every world as a canary. A run
 * whose canary moved is not evidence, so it cannot grant a PASS.
 */
const UNCAPPED = process.env.BENCH_UNCAPPED === '1';
const ORDER = process.env.BENCH_ORDER ?? 'given';
assert.ok(['given', 'reverse', 'shuffle'].includes(ORDER), `BENCH_ORDER must be given|reverse|shuffle, received ${ORDER}`);
const CANARY_NAME = 'golden-clear-overview';
/** Drift the canary is allowed between the start and the end of one run. */
const CANARY_TOLERANCE = { fps: 2, p95Ms: 2, frameMs: 0.5 };

function orderSeries(list) {
  if (ORDER === 'reverse') return [...list].reverse();
  if (ORDER === 'shuffle') {
    // Seeded from BENCH_SEED so a shuffled order is reproducible and reportable.
    const out = [...list];
    let state = SIMULATION_SEED >>> 0;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  return [...list];
}

const canarySource = allScenarios.find((scenario) => scenario.name === CANARY_NAME);

const scenarios = orderSeries(nonRainbowScenarios);
if (rainbowScenarios.length === 2) {
  for (let repetition = 0; repetition < RAINBOW_REPETITIONS; repetition++) {
    const ordered = repetition % 2 === 0
      ? rainbowScenarios
      : [...rainbowScenarios].reverse();
    for (const scenario of ordered) scenarios.push({ ...scenario, repetition });
  }
} else {
  scenarios.push(...rainbowScenarios);
}
/**
 * Pair the series across worlds: each scenario is measured in every world before the
 * series moves on, and which world goes first alternates so that neither side always
 * pays for being second.
 */
if (WORLDS.length > 1) {
  const paired = [];
  for (const [index, scenario] of scenarios.entries()) {
    const worlds = index % 2 === 0 ? WORLDS : [...WORLDS].reverse();
    for (const world of worlds) {
      paired.push({ ...scenario, world, name: `${scenario.name}@${world}` });
    }
  }
  scenarios.length = 0;
  scenarios.push(...paired);
}

// The canary brackets the whole series, including the rainbow repetitions.
if (canarySource && scenarios.length > 1) {
  // One canary pair per world: a run that compares two worlds has to bound the drift
  // of both, not of whichever happened to be listed first.
  const suffix = (world) => (WORLDS.length > 1 ? `@${world}` : '');
  for (const world of [...WORLDS].reverse()) {
    scenarios.unshift({ ...canarySource, world, name: `canary-start${suffix(world)}`, canary: 'start' });
  }
  for (const world of WORLDS) {
    scenarios.push({ ...canarySource, world, name: `canary-end${suffix(world)}`, canary: 'end' });
  }
}
assert.ok(['low', 'medium', 'high'].includes(QUALITY), `unknown benchmark quality: ${QUALITY}`);

let preview;
let previewLog = '';
let browser;
try {
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
    detached: process.platform !== 'win32',
  });
  preview.stdout.on('data', (chunk) => { previewLog += chunk.toString(); });
  preview.stderr.on('data', (chunk) => { previewLog += chunk.toString(); });

  await waitForServer();
  const executablePath = await firstExisting([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
  browser = await chromium.launch({
    headless: !HEADFUL,
    executablePath,
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--use-angle=metal',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // Headroom mode. With vsync on, a frame time is quantised to multiples of
      // 16.7 ms, so FPS says only "inside the budget" or "outside it" and cannot say
      // by how much -- which is why the night street reads either 60.0 or 48.3 and
      // nothing between. Uncapped, the frame time is continuous and two builds can be
      // compared by cost instead of by which side of the cliff they landed on. Never
      // used for a gate run: the product ships with vsync.
      ...(UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    ],
  });
  const page = await browser.newPage({ viewport: PAGE_SETUP.viewport, deviceScaleFactor: PAGE_SETUP.deviceScaleFactor });
  assert.equal(browser.contexts().length, 1, 'benchmark must use exactly one browser context');
  assert.equal(page.context().pages().length, 1, 'benchmark must use exactly one browser page');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__benchmarkReadyAt = null;
    window.addEventListener('diorama-ready', () => {
      window.__benchmarkReadyAt = performance.now();
    }, { once: true });
  });
  await page.goto(`${URL}/?seed=${SIMULATION_SEED}&quality=${QUALITY}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: MAX_TTI_MS });
  const readiness = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const firstContentfulPaint = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      timeToInteractiveMs: window.__benchmarkReadyAt ?? performance.now(),
      definition: 'diorama-ready after preload, shader warm-up, first interactive animation frame and loader dismissal',
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      firstContentfulPaintMs: firstContentfulPaint?.startTime ?? null,
    };
  });
  await applyDiagnosticOverrides(page);

  const identity = await page.evaluate(() => window.__diorama.getMetrics().renderer);
  const softwareRenderer = /swiftshader|software|llvmpipe/i.test(identity.gpu);
  assert.equal(softwareRenderer, false, `hardware GPU required, received: ${identity.gpu}`);

  const results = [];
  for (const [position, scenario] of scenarios.entries()) {
    const startedAt = new Date().toISOString();
    const ttiSamples = [];
    for (let attempt = 0; attempt < TTI_SAMPLES; attempt++) {
      await page.goto(
        `${URL}/?seed=${SIMULATION_SEED}&checkpoint=${scenario.checkpoint}&quality=${QUALITY}&world=${scenario.world ?? WORLD}`,
        { waitUntil: 'networkidle' }
      );
      // Waiting exactly MAX_TTI_MS turned a marginal load into an aborted run with no
      // JSON at all. The wait is generous; the budget is enforced by the assertion below,
      // which needs the measurement to exist in order to fail on it.
      await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: MAX_TTI_MS * 5 });
      const readyAt = await page.evaluate(() => window.__benchmarkReadyAt);
      if (readyAt !== null) ttiSamples.push(round(readyAt));
    }
    const diagnostics = await applyDiagnosticOverrides(page);
    const { checkpointState, qualityLevel } = await page.evaluate(() => ({
      checkpointState: window.__diorama.getState(),
      qualityLevel: window.__diorama.getMetrics().quality.level,
    }));
    // `readiness` above is measured on a load without ?world=, so it never sees the hybrid
    // spike attach. These do, which is what the spike's TTI gate needs.
    const ttiSorted = [...ttiSamples].sort((a, b) => a - b);
    const scenarioReadyAtMs = ttiSorted.length ? ttiSorted[Math.floor(ttiSorted.length / 2)] : null;
    assert.equal(checkpointState.simulationSeed, SIMULATION_SEED);
    assert.equal(checkpointState.checkpoint?.id, scenario.checkpoint);
    assert.equal(qualityLevel, QUALITY, `checkpoint ${scenario.checkpoint} ignored BENCH_QUALITY`);
    if (scenario.camera !== 'checkpoint') {
      await page.evaluate(() => window.__diorama.releaseCheckpoint());
      if (scenario.camera === 'train') await page.keyboard.press('t');
      else if (scenario.camera === 'bus') await page.keyboard.press('b');
      else {
        await page.evaluate(() => window.__diorama.controls.setLookAt(70, 48, 80, 0, 6, 0, false));
      }
    }
    await page.waitForTimeout(2_000);
    const measuredState = await readMeasuredState(page);
    if (scenario.name === 'post-rain-clear-lake') {
      assert.equal(measuredState.rainbow.visible, false, 'OFF checkpoint rendered a rainbow');
    } else if (scenario.name === 'post-rain-rainbow-lake') {
      assert.equal(measuredState.rainbow.visible, true, 'ON checkpoint did not render a rainbow');
      assert.ok(measuredState.rainbow.strength > 0.05, 'ON checkpoint has negligible rainbow strength');
    }
    // Discard a short state-local sample so lazy shader variants, shadow maps,
    // and post-processing targets are not counted as sustained animation cost.
    await measureFrames(page, 1);
    const machineBefore = await machineState();
    const cpuBefore = await cdp.send('Performance.getMetrics');
    const timing = await measureFrames(page);
    const cpuAfter = await cdp.send('Performance.getMetrics');
    const machineAfter = await machineState();
    const wallSeconds = timing.averageFrameMs * timing.frames / 1_000;
    const mainThreadTaskSeconds = metricValue(cpuAfter, 'TaskDuration') - metricValue(cpuBefore, 'TaskDuration');
    const scriptSeconds = metricValue(cpuAfter, 'ScriptDuration') - metricValue(cpuBefore, 'ScriptDuration');
    const layoutSeconds = metricValue(cpuAfter, 'LayoutDuration') - metricValue(cpuBefore, 'LayoutDuration');
    const cpu = {
      scope: 'Chromium renderer main thread; not total system CPU',
      taskMs: round(mainThreadTaskSeconds * 1_000),
      busyPercent: round((mainThreadTaskSeconds / wallSeconds) * 100),
      scriptMs: round(scriptSeconds * 1_000),
      layoutMs: round(layoutSeconds * 1_000),
    };
    const gpu = await measureGpuFrame(page);
    const finalState = await readMeasuredState(page);
    if (scenario.camera === 'checkpoint') {
      assert.deepEqual(
        finalState,
        measuredState,
        `${scenario.name}: frozen checkpoint drifted during measurement`
      );
    } else {
      for (const field of ['theme', 'weather', 'quality']) {
        assert.equal(
          finalState[field],
          measuredState[field],
          `${scenario.name}: dynamic scenario changed invariant ${field}`
        );
      }
      for (const field of ['t01', 'trainProgress', 'busProgress']) {
        assert.ok(
          Number.isFinite(finalState[field]) &&
          finalState[field] >= 0 &&
          finalState[field] <= 1,
          `${scenario.name}: invalid dynamic ${field}`
        );
      }
      const cyclicDistance = (a, b) => {
        const distance = Math.abs(a - b);
        return Math.min(distance, 1 - distance);
      };
      assert.ok(
        cyclicDistance(finalState.t01, measuredState.t01) > 1e-7,
        `${scenario.name}: simulation time did not advance`
      );
      if (scenario.camera === 'train') {
        assert.ok(
          cyclicDistance(
            finalState.trainProgress,
            measuredState.trainProgress
          ) > 1e-7,
          `${scenario.name}: tracked train did not advance`
        );
      } else if (scenario.camera === 'bus') {
        assert.ok(
          cyclicDistance(
            finalState.busProgress,
            measuredState.busProgress
          ) > 1e-7,
          `${scenario.name}: tracked bus did not advance`
        );
      }
      for (const value of [
        ...finalState.camera.position,
        ...finalState.camera.target,
        finalState.camera.distance,
      ]) {
        assert.ok(Number.isFinite(value), `${scenario.name}: non-finite dynamic camera`);
      }
    }
    const metrics = await page.evaluate(() => window.__diorama.getMetrics());
    // Two separate numbers, never mixed: the animation frame the user sees, and the
    // forced capture render kept only for continuity with older results.
    const animationGpu = await measureAnimationGpu(page, 90);
    const diagnosticsDuring = await confirmDiagnosticOverrides(page, `during ${scenario.name}`);
    const jsHeapBytes = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    results.push({
      // Where in the series this was measured, so an order effect is visible in the
      // file rather than reconstructed from the order of the array.
      positionInSeries: position,
      startedAt,
      canary: scenario.canary ?? null,
      machine: { before: machineBefore, after: machineAfter },
      animationGpu,
      diagnosticsDuring,
      ...scenario,
      world: metrics.world ?? 'voxel',
      hybrid: metrics.hybrid ?? null,
      jsHeapBytes,
      simulationSeed: metrics.simulationSeed,
      layoutSeed: metrics.layoutSeed,
      checkpointRevision: checkpointState.checkpoint.revision,
      timeToInteractiveMs: scenarioReadyAtMs,
      timeToInteractiveSamples: ttiSamples,
      timeToInteractiveWorstMs: ttiSorted.length ? ttiSorted[ttiSorted.length - 1] : null,
      diagnostics,
      timing,
      cpu,
      /** Legacy probe: brackets a forced extra render plus a framebuffer read and a
       *  JPEG encode, so it is not the cost of an animation frame. Kept for
       *  continuity only; `animationGpu` is the one to read. */
      captureFrameGpu: gpu,
      measuredState,
      finalState,
      renderer: metrics.renderer,
    });
    if (scenario.camera === 'train') await page.keyboard.press('t');
    else if (scenario.camera === 'bus') await page.keyboard.press('b');
  }

  const diagnosticsAfter = await confirmDiagnosticOverrides(page, 'after the measurement window');
  await clearDiagnosticOverrides(page);
  const diagnosticsRestored = await page.evaluate(async () => {
    // The gate is read inside the light update, so the restore lands on a later frame.
    for (let i = 0; i < 4; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return { visibleLocalLights: (() => {
      let n = 0;
      window.__diorama.scene.traverse((node) => {
        if ((node.isPointLight || node.isSpotLight) && node.visible && node.intensity > 0) n += 1;
      });
      return n;
    })() };
  });

  /**
   * What the canary did between the start and the end of the series. A run whose
   * cheap reference scenario moved cannot separate a scenario's own cost from the
   * machine's drift, so it is not allowed to grant a PASS.
   */
  /**
   * What the canary did between the start and the end of the series, per world.
   *
   * Two things this had wrong. It only bracketed the first world, so a run comparing
   * two worlds bounded the drift of one of them; and it compared FPS and p95, which
   * under vsync are quantised and under `BENCH_UNCAPPED` mean nothing at all. Now
   * every world gets its own canary pair, the compared quantity is the one the mode
   * can actually resolve -- FPS and p95 for a vsync gate run, the continuous frame
   * time for an uncapped headroom run -- and any world drifting fails the run.
   */
  const canaryDrift = (() => {
    const pairs = [];
    for (const world of WORLDS) {
      const first = results.find((result) => result.canary === 'start' && result.world === world);
      const last = results.find((result) => result.canary === 'end' && result.world === world);
      if (!first || !last) continue;
      const frameMs = round(last.timing.averageFrameMs - first.timing.averageFrameMs, 2);
      const fps = round(last.timing.averageFps - first.timing.averageFps);
      const p95Ms = round(last.timing.p95FrameMs - first.timing.p95FrameMs);
      const drifted = UNCAPPED
        ? Math.abs(frameMs) > Math.max(CANARY_TOLERANCE.frameMs, first.timing.averageFrameMs * 0.1)
        : Math.abs(fps) > CANARY_TOLERANCE.fps || Math.abs(p95Ms) > CANARY_TOLERANCE.p95Ms;
      pairs.push({
        world,
        startFps: round(first.timing.averageFps),
        endFps: round(last.timing.averageFps),
        startP95Ms: round(first.timing.p95FrameMs),
        endP95Ms: round(last.timing.p95FrameMs),
        startFrameMs: round(first.timing.averageFrameMs, 2),
        endFrameMs: round(last.timing.averageFrameMs, 2),
        fps,
        p95Ms,
        frameMs,
        drifted,
      });
    }
    if (!pairs.length) return null;
    return {
      scenario: CANARY_NAME,
      kind: UNCAPPED ? 'headroom (continuous frame time, vsync off)' : 'gate (FPS and p95 under vsync)',
      tolerance: CANARY_TOLERANCE,
      pairs,
      drifted: pairs.some((pair) => pair.drifted),
      report: pairs.map((pair) => (
        UNCAPPED
          ? `${pair.world} ${pair.startFrameMs.toFixed(2)} -> ${pair.endFrameMs.toFixed(2)} ms/frame`
          : `${pair.world} ${pair.startFps.toFixed(1)} -> ${pair.endFps.toFixed(1)} FPS, p95 ${pair.startP95Ms.toFixed(1)} -> ${pair.endP95Ms.toFixed(1)} ms`
      )).join('; '),
    };
  })();

  const report = {
    revision: CODE_REVISION.revision,
    revisionFull: CODE_REVISION.revisionFull,
    workingTreeDirty: CODE_REVISION.workingTreeDirty,
    // The bundle that actually served this run, not only what git says HEAD is.
    build: CODE_REVISION.build,
    recordedAt: new Date().toISOString(),
    conditions: {
      viewport: `${PAGE_SETUP.viewport.width}x${PAGE_SETUP.viewport.height}`,
      deviceScaleFactor: PAGE_SETUP.deviceScaleFactor,
      ttiSamples: TTI_SAMPLES,
      gpuSampleCount: GPU_SAMPLE_COUNT,
      animationFramesTimed: 90,
      rainbowRepetitions: RAINBOW_REPETITIONS,
      order: ORDER,
      vsync: UNCAPPED ? 'disabled (headroom mode, not a gate run)' : 'on, as shipped',
      diagnosticShadowsDisabled: DISABLE_SHADOWS,
      diagnosticLocalLightsDisabled: DISABLE_LOCAL_LIGHTS,
      note: 'one world and one tab per run; a benchmark must not share the GPU with builds, renders or other agents',
    },
    headful: HEADFUL,
    quality: QUALITY,
    world: WORLDS.length > 1 ? WORLDS.join(',') : WORLD,
    simulationSeed: SIMULATION_SEED,
    isolation: {
      processLock: 'exclusive; a second benchmark cannot start while this one holds it',
      browser: 'one browser context, one page, a fresh document per TTI attempt',
      order: ORDER,
      series: scenarios.map((scenario) => scenario.name),
      canary: canaryDrift,
      note: canaryDrift
        ? 'the canary scenario was measured first and last; its drift bounds what this run can claim'
        : 'no canary in this run (single-scenario run), so nothing bounds drift here',
    },
    diagnosticShadowsDisabled: DISABLE_SHADOWS,
    diagnosticLocalLightsDisabled: DISABLE_LOCAL_LIGHTS,
    readiness: {
      ...readiness,
      timeToInteractiveMs: round(readiness.timeToInteractiveMs),
      domContentLoadedMs: readiness.domContentLoadedMs === null ? null : round(readiness.domContentLoadedMs),
      firstContentfulPaintMs: readiness.firstContentfulPaintMs === null ? null : round(readiness.firstContentfulPaintMs),
    },
    gpu: identity.gpu,
    vendor: identity.vendor,
    diagnosticsAfter,
    diagnosticsRestored,
    results,
  };
  console.log(JSON.stringify(report, null, 2));

  /**
   * Checks are collected, not thrown, so the run is written down before the process
   * exits. The order is fixed by what each check is worth: the result has to be
   * complete before its diagnostics mean anything, the diagnostics have to have held
   * before the canary means anything, and the canary has to be stable before a gate
   * verdict means anything at all.
   */
  const problems = [];
  const check = (ok, message) => { if (!ok) problems.push(message); return ok; };
  const checkSame = (actual, expected, message) => check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  );

  // 1-2. the result itself: complete, with its provenance.
  problems.push(...completenessProblems(report, scenarios.map((scenario) => scenario.name)));
  check(errors.length === 0, `browser errors: ${errors.join(' | ')}`);

  // 3. diagnostics: asked for, held for the whole run, and put back afterwards.
  if (DISABLE_LOCAL_LIGHTS) {
    check(diagnosticsAfter.visibleLocalLights === 0, 'local lights came back during the run');
    check(diagnosticsRestored.visibleLocalLights > 0, 'local lights were not restored after the run');
    for (const result of results) {
      check(result.diagnosticsDuring?.visibleLocalLights === 0, `${result.name}: local lights on mid-scenario`);
    }
  }
  if (DISABLE_SHADOWS) check(diagnosticsAfter.shadowsEnabled === false, 'shadows came back during the run');
  const contended = results.filter((result) => result.machine.after.foreignCpuPercent > 120);
  if (contended.length) {
    console.log(
      `foreign CPU above 120% during: ${contended.map((result) => `${result.name} (${result.machine.after.foreignCpuPercent}%)`).join(', ')}`
    );
  }
  for (const result of results) {
    console.log(
      `${String(result.positionInSeries).padStart(2)} ${result.name.padEnd(30)}`
      + `${result.timing.averageFps.toFixed(1).padStart(5)} fps  p95 ${result.timing.p95FrameMs.toFixed(1).padStart(5)}  `
      + `slow ${(result.timing.slowFrameRatio * 100).toFixed(1).padStart(5)}%  `
      + `pxr ${result.renderer.pixelRatio.toFixed(2)} ${result.renderer.canvasWidth}x${result.renderer.canvasHeight}  `
      + `load ${result.machine.after.loadAverage[0]}  foreign ${result.machine.after.foreignCpuPercent}%`
    );
  }
  // 4. the canary, which bounds what this run may claim at all.
  if (canaryDrift) {
    console.log(`canary ${CANARY_NAME}: ${canaryDrift.report} `
      + `(${canaryDrift.drifted ? 'DRIFTED, this run is not evidence' : 'stable'}), order ${ORDER}`);
    check(
      canaryDrift.drifted === false,
      `the canary drifted between the start and the end of this run (${canaryDrift.report}), `
      + 'so nothing measured in it can be attributed to a scenario'
    );
  }

  // 5. gates, and only the ones this mode can judge. An uncapped run measures cost,
  // not compliance: its frames are not vsync-paced, so FPS, p95, p99 and hitches say
  // nothing about the product's budget and are not evaluated. Such a run is never
  // canonical either -- see the verdict at the end.
  check(
    readiness.timeToInteractiveMs <= MAX_TTI_MS,
    `TTI ${readiness.timeToInteractiveMs.toFixed(1)} ms exceeds ${MAX_TTI_MS} ms`
  );
  for (const result of results) {
    // The readiness above is measured on a load without ?world=, so on its own it
    // cannot fail a world that is slow to attach. Every scenario load is a real
    // first paint of that world and is held to the same budget.
    check(
      result.timeToInteractiveMs !== null && result.timeToInteractiveMs <= MAX_TTI_MS,
      `${result.name}: median TTI ${result.timeToInteractiveMs} ms of ${JSON.stringify(result.timeToInteractiveSamples)} exceeds ${MAX_TTI_MS} ms in world ${result.world}`
    );
    if (!UNCAPPED) {
      check(
        result.timing.averageFps >= REQUIRED_FPS,
        `${result.name}: ${result.timing.averageFps.toFixed(1)} FPS, required ${REQUIRED_FPS}`
      );
      check(result.timing.p95FrameMs <= 20.5, `${result.name}: p95 ${result.timing.p95FrameMs.toFixed(1)} ms`);
      check(result.timing.p99FrameMs <= 20.5, `${result.name}: p99 ${result.timing.p99FrameMs.toFixed(1)} ms`);
      check(result.timing.hitchCount === 0, `${result.name}: animation hitch detected`);
    }
  }
  const rainbowOffResults = results.filter(
    (result) => result.name === 'post-rain-clear-lake'
  );
  const rainbowOnResults = results.filter(
    (result) => result.name === 'post-rain-rainbow-lake'
  );
  if (rainbowOffResults.length || rainbowOnResults.length) {
    check(
      rainbowOffResults.length === rainbowOnResults.length,
      'rainbow benchmark requires an equal number of OFF and ON samples'
    );
    const pairDeltas = [];
    for (let repetition = 0; repetition < rainbowOffResults.length; repetition++) {
      const rainbowOff = rainbowOffResults.find(
        (result) => (result.repetition ?? 0) === repetition
      );
      const rainbowOn = rainbowOnResults.find(
        (result) => (result.repetition ?? 0) === repetition
      );
      if (!check(Boolean(rainbowOff && rainbowOn), `missing rainbow pair repetition ${repetition}`)) continue;
      const comparableState = (result) => ({
        t01: result.measuredState.t01,
        theme: result.measuredState.theme,
        weather: result.measuredState.weather,
        cloud: result.measuredState.cloud,
        wind: result.measuredState.wind,
        rain: result.measuredState.rain,
        eclipse: result.measuredState.eclipse,
        trainProgress: result.measuredState.trainProgress,
        busProgress: result.measuredState.busProgress,
        camera: result.measuredState.camera,
        sourceCenter: result.measuredState.rainbow.sourceCenter,
        sourceRadii: result.measuredState.rainbow.sourceRadii,
        quality: result.measuredState.quality,
        pixelRatio: result.renderer.pixelRatio,
        canvasWidth: result.renderer.canvasWidth,
        canvasHeight: result.renderer.canvasHeight,
      });
      checkSame(
        comparableState(rainbowOn),
        comparableState(rainbowOff),
        `rainbow OFF/ON repetition ${repetition} differs outside atmospheric state`
      );
      check(
        rainbowOn.renderer.calls - rainbowOff.renderer.calls === 1,
        `rainbow repetition ${repetition} must cost exactly one draw call`
      );
      check(
        rainbowOn.renderer.triangles - rainbowOff.renderer.triangles === 1,
        `rainbow repetition ${repetition} must cost exactly one fullscreen triangle`
      );
      for (const field of ['geometries', 'textures', 'programs']) {
        check(
          rainbowOn.renderer[field] - rainbowOff.renderer[field] === 0,
          `rainbow repetition ${repetition} changed renderer ${field}`
        );
      }
      check(rainbowOff.captureFrameGpu.available === true, 'OFF GPU timer query is required');
      check(rainbowOn.captureFrameGpu.available === true, 'ON GPU timer query is required');
      if (rainbowOn.captureFrameGpu.available) {
        check(
          rainbowOn.captureFrameGpu.medianRenderMsRaw < 16.7,
          `rainbow repetition ${repetition} GPU median ${rainbowOn.captureFrameGpu.medianRenderMs} ms lacks 60 Hz headroom`
        );
        check(
          rainbowOn.captureFrameGpu.p90RenderMsRaw <= 20.5,
          `rainbow repetition ${repetition} GPU p90 ${rainbowOn.captureFrameGpu.p90RenderMs} ms exceeds frame budget`
        );
      }
      pairDeltas.push({
        repetition,
        order: repetition % 2 === 0 ? 'AB' : 'BA',
        p95FrameMs: rainbowOn.timing.p95FrameMs - rainbowOff.timing.p95FrameMs,
        cpuBusyPercent: rainbowOn.cpu.busyPercent - rainbowOff.cpu.busyPercent,
        // Both sides come from the forced-capture probe, so this delta is a
        // comparison of two identical measurements, not an animation-frame cost.
        gpuMedianMs: rainbowOn.captureFrameGpu.medianRenderMsRaw - rainbowOff.captureFrameGpu.medianRenderMsRaw,
      });
    }
    const medianP95Delta = median(pairDeltas.map((pair) => pair.p95FrameMs));
    const medianCpuDelta = median(pairDeltas.map((pair) => pair.cpuBusyPercent));
    const medianGpuDelta = median(pairDeltas.map((pair) => pair.gpuMedianMs));
    check(medianP95Delta <= 2, `rainbow median p95 regression ${medianP95Delta.toFixed(1)} ms`);
    check(medianCpuDelta <= 5, `rainbow median CPU regression ${medianCpuDelta.toFixed(1)} pp`);
    check(medianGpuDelta <= 2, `rainbow median GPU regression ${medianGpuDelta.toFixed(1)} ms`);
    console.log(JSON.stringify({
      rainbowPairSummary: {
        repetitions: pairDeltas.length,
        order: pairDeltas.map((pair) => pair.order),
        medianP95DeltaMs: round(medianP95Delta),
        medianCpuDeltaPercentagePoints: round(medianCpuDelta),
        medianGpuDeltaMs: round(medianGpuDelta),
        pairs: pairDeltas.map((pair) => ({
          ...pair,
          p95FrameMs: round(pair.p95FrameMs),
          cpuBusyPercent: round(pair.cpuBusyPercent),
          gpuMedianMs: round(pair.gpuMedianMs),
        })),
      },
    }, null, 2));
  }

  /**
   * 6. Only now is anything written. An uncapped run is never canonical: it cannot
   * judge the gates it would have to satisfy, so it lands as `inconclusive` beside the
   * last good file instead of on top of it.
   */
  const verdict = problems.length > 0 ? 'failed' : UNCAPPED ? 'inconclusive' : 'passed';
  const written = writeRun(report, verdict, problems);
  console.log(
    `verdict ${verdict}${written ? ` written to ${written}` : ' (BENCH_OUT unset, nothing written)'}`
    + `${problems.length ? `\n  - ${problems.join('\n  - ')}` : ''}`
  );
  assert.deepEqual(problems, [], `run rejected:\n  - ${problems.join('\n  - ')}`);
} catch (error) {
  console.error(previewLog);
  throw error;
} finally {
  /**
   * The lock is released last, and only once this run's renderer is really gone.
   *
   * It used to be released first, which meant the next harness could take it and start
   * a browser while this one's Chrome and Vite were still alive -- the lock guaranteed
   * that no two *measurements* overlapped, not that no two renderers did, which is the
   * thing that actually corrupts a frame time. `stopPreview` has a bounded timeout and
   * escalates to SIGKILL, so waiting for it cannot wedge the batch; the outer `finally`
   * releases even if the shutdown throws.
   */
  try {
    await browser?.close();
    console.log(`preview: ${await stopPreview(preview)}`);
  } finally {
    releaseLock();
  }
}
