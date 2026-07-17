import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4174;
const URL = `http://${HOST}:${PORT}`;
const HEADFUL = process.env.BENCH_HEADFUL === '1';
const REQUIRED_FPS = Number(process.env.BENCH_MIN_FPS ?? 58);

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
      slowFrameRatio: deltas.filter((value) => value > 20.5).length / deltas.length,
    };
  }, seconds);
}

const scenarios = [
  { name: 'golden-clear-overview', time: 0.28, weather: 'clear', camera: 'overview' },
  { name: 'noon-rain-overview', time: 0.5, weather: 'rain', camera: 'overview' },
  { name: 'night-snow-train', time: 0.02, weather: 'snow', camera: 'train' },
  {
    name: 'eclipse-totality-overview',
    time: 0.715,
    weather: 'clear',
    camera: 'overview',
    eclipseProgress: 0.5,
  },
];

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let previewLog = '';
preview.stdout.on('data', (chunk) => { previewLog += chunk.toString(); });
preview.stderr.on('data', (chunk) => { previewLog += chunk.toString(); });

let browser;
try {
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
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 20_000 });
  await page.evaluate(() => window.__diorama.setQuality('high'));

  const identity = await page.evaluate(() => window.__diorama.getMetrics().renderer);
  const softwareRenderer = /swiftshader|software|llvmpipe/i.test(identity.gpu);
  assert.equal(softwareRenderer, false, `hardware GPU required, received: ${identity.gpu}`);

  const results = [];
  for (const scenario of scenarios) {
    await page.evaluate(({ time, weather, eclipseProgress }) => {
      window.__diorama.setTime(time);
      window.__diorama.setWeather(weather);
      if (eclipseProgress !== undefined) window.__diorama.setEclipseProgress(eclipseProgress);
    }, scenario);
    if (scenario.camera === 'train') await page.keyboard.press('t');
    else {
      await page.evaluate(() => window.__diorama.controls.setLookAt(70, 48, 80, 0, 6, 0, false));
    }
    await page.waitForTimeout(2_000);
    // Discard a short state-local sample so lazy shader variants, shadow maps,
    // and post-processing targets are not counted as sustained animation cost.
    await measureFrames(page, 1);
    const timing = await measureFrames(page);
    const metrics = await page.evaluate(() => window.__diorama.getMetrics());
    results.push({ ...scenario, timing, renderer: metrics.renderer });
    if (scenario.camera === 'train') await page.keyboard.press('t');
  }

  console.log(JSON.stringify({ headful: HEADFUL, gpu: identity.gpu, vendor: identity.vendor, results }, null, 2));
  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
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
    if (preview.pid && process.platform !== 'win32') process.kill(-preview.pid, 'SIGTERM');
    else preview.kill('SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
