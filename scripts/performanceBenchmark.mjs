import assert from 'node:assert/strict';
import { access, open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4174;
const URL = `http://${HOST}:${PORT}`;
const HEADFUL = process.env.BENCH_HEADFUL === '1';
const REQUIRED_FPS = Number(process.env.BENCH_MIN_FPS ?? 58);
const MAX_TTI_MS = Number(process.env.BENCH_MAX_TTI_MS ?? 20_000);
const QUALITY = process.env.BENCH_QUALITY ?? 'high';
const SIMULATION_SEED = Number(process.env.BENCH_SEED ?? 20260722);
const SCENARIO_FILTER = process.env.BENCH_SCENARIO;
const DISABLE_SHADOWS = process.env.BENCH_DISABLE_SHADOWS === '1';
const DISABLE_LOCAL_LIGHTS = process.env.BENCH_DISABLE_LOCAL_LIGHTS === '1';
const LOCK_PATH = join(tmpdir(), 'voxel-diorama-performance-benchmark.lock');

async function acquireBenchmarkLock() {
  try {
    const handle = await open(LOCK_PATH, 'wx');
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    const ownerPid = Number.parseInt(await readFile(LOCK_PATH, 'utf8'), 10);
    if (Number.isInteger(ownerPid)) {
      try {
        process.kill(ownerPid, 0);
        throw new Error(
          `performance benchmark is already running (PID ${ownerPid}); ` +
          'only one Diorama browser instance is allowed'
        );
      } catch (ownerError) {
        if (ownerError.code !== 'ESRCH') throw ownerError;
      }
    }

    await unlink(LOCK_PATH);
    return acquireBenchmarkLock();
  }
}

async function releaseBenchmarkLock(handle) {
  await handle.close();
  try {
    await unlink(LOCK_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function round(value, precision = 1) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
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

async function applyDiagnosticOverrides(page) {
  const state = await page.evaluate(({ disableShadows, disableLocalLights }) => {
    if (disableShadows) window.__diorama.renderer.shadowMap.enabled = false;
    let visibleLocalLights = 0;
    window.__diorama.scene.traverse((object) => {
      if (!object.isPointLight && !object.isSpotLight) return;
      if (disableLocalLights) object.visible = false;
      if (object.visible) visibleLocalLights++;
    });
    return {
      shadowsEnabled: window.__diorama.renderer.shadowMap.enabled,
      visibleLocalLights,
    };
  }, { disableShadows: DISABLE_SHADOWS, disableLocalLights: DISABLE_LOCAL_LIGHTS });
  if (DISABLE_SHADOWS) assert.equal(state.shadowsEnabled, false, 'shadow diagnostic override was not applied');
  if (DISABLE_LOCAL_LIGHTS) assert.equal(state.visibleLocalLights, 0, 'local-light diagnostic override was not applied');
  return state;
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

async function measureGpuFrame(page, sampleCount = 3) {
  return page.evaluate(async (count) => {
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
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      window.__diorama.captureFrame(320, 0.5);
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
    return {
      available: true,
      method: 'EXT_disjoint_timer_query_webgl2 around an explicit composer frame',
      sampleCount: samples.length,
      medianRenderMs: Math.round(samples[Math.floor(samples.length / 2)] * 10) / 10,
      minRenderMs: Math.round(samples[0] * 10) / 10,
      maxRenderMs: Math.round(samples.at(-1) * 10) / 10,
    };
  }, sampleCount);
}

const allScenarios = [
  { name: 'golden-clear-overview', checkpoint: 'golden-clear-overview', camera: 'overview' },
  { name: 'noon-rain-overview', checkpoint: 'noon-rain-overview', camera: 'overview' },
  { name: 'night-snow-train', checkpoint: 'night-snow-train', camera: 'train' },
  { name: 'evening-rain-bus', checkpoint: 'evening-rain-bus', camera: 'bus' },
  { name: 'eclipse-totality-overview', checkpoint: 'eclipse-totality-overview', camera: 'overview' },
];
const scenarios = SCENARIO_FILTER
  ? allScenarios.filter((scenario) => scenario.name === SCENARIO_FILTER)
  : allScenarios;
assert.ok(scenarios.length > 0, `unknown benchmark scenario: ${SCENARIO_FILTER}`);
assert.ok(['low', 'medium', 'high'].includes(QUALITY), `unknown benchmark quality: ${QUALITY}`);

const benchmarkLock = await acquireBenchmarkLock();
let preview;
let previewLog = '';
let browser;
try {
  preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
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
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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
  for (const scenario of scenarios) {
    await page.goto(
      `${URL}/?seed=${SIMULATION_SEED}&checkpoint=${scenario.checkpoint}&quality=${QUALITY}`,
      { waitUntil: 'networkidle' }
    );
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: MAX_TTI_MS });
    const diagnostics = await applyDiagnosticOverrides(page);
    const { checkpointState, qualityLevel } = await page.evaluate(() => ({
      checkpointState: window.__diorama.getState(),
      qualityLevel: window.__diorama.getMetrics().quality.level,
    }));
    assert.equal(checkpointState.simulationSeed, SIMULATION_SEED);
    assert.equal(checkpointState.checkpoint?.id, scenario.checkpoint);
    assert.equal(qualityLevel, QUALITY, `checkpoint ${scenario.checkpoint} ignored BENCH_QUALITY`);
    await page.evaluate(() => window.__diorama.releaseCheckpoint());
    if (scenario.camera === 'train') await page.keyboard.press('t');
    else if (scenario.camera === 'bus') await page.keyboard.press('b');
    else {
      await page.evaluate(() => window.__diorama.controls.setLookAt(70, 48, 80, 0, 6, 0, false));
    }
    await page.waitForTimeout(2_000);
    // Discard a short state-local sample so lazy shader variants, shadow maps,
    // and post-processing targets are not counted as sustained animation cost.
    await measureFrames(page, 1);
    const cpuBefore = await cdp.send('Performance.getMetrics');
    const timing = await measureFrames(page);
    const cpuAfter = await cdp.send('Performance.getMetrics');
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
    const metrics = await page.evaluate(() => window.__diorama.getMetrics());
    results.push({
      ...scenario,
      simulationSeed: metrics.simulationSeed,
      layoutSeed: metrics.layoutSeed,
      checkpointRevision: checkpointState.checkpoint.revision,
      diagnostics,
      timing,
      cpu,
      gpu,
      renderer: metrics.renderer,
    });
    if (scenario.camera === 'train') await page.keyboard.press('t');
    else if (scenario.camera === 'bus') await page.keyboard.press('b');
  }

  console.log(JSON.stringify({
    headful: HEADFUL,
    quality: QUALITY,
    simulationSeed: SIMULATION_SEED,
    isolation: 'exclusive process lock, one browser context, one page',
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
    results,
  }, null, 2));
  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
  assert.ok(
    readiness.timeToInteractiveMs <= MAX_TTI_MS,
    `TTI ${readiness.timeToInteractiveMs.toFixed(1)} ms exceeds ${MAX_TTI_MS} ms`
  );
  for (const result of results) {
    assert.ok(
      result.timing.averageFps >= REQUIRED_FPS,
      `${result.name}: ${result.timing.averageFps.toFixed(1)} FPS, required ${REQUIRED_FPS}`
    );
    assert.ok(result.timing.p95FrameMs <= 20.5, `${result.name}: p95 ${result.timing.p95FrameMs.toFixed(1)} ms`);
  }
} catch (error) {
  console.error(previewLog);
  throw error;
} finally {
  await browser?.close();
  try {
    if (preview?.pid && process.platform !== 'win32') process.kill(-preview.pid, 'SIGTERM');
    else preview?.kill('SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await releaseBenchmarkLock(benchmarkLock);
}
