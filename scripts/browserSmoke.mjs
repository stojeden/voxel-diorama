import assert from 'node:assert/strict';
import { access, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4173;
const URL = `http://${HOST}:${PORT}`;

async function assertBundleBudgets() {
  const assetNames = await readdir('dist/assets');
  const entry = assetNames.find((name) => /^index-.*\.js$/.test(name));
  const three = assetNames.find((name) => /^three-.*\.js$/.test(name));
  assert.ok(entry, 'application entry chunk is missing');
  assert.ok(three, 'Three.js vendor chunk is missing');
  const entryBytes = (await stat(`dist/assets/${entry}`)).size;
  const threeBytes = (await stat(`dist/assets/${three}`)).size;
  assert.ok(entryBytes <= 200_000, `application chunk budget exceeded: ${entryBytes} bytes`);
  assert.ok(threeBytes <= 800_000, `Three.js chunk budget exceeded: ${threeBytes} bytes`);
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next system browser path.
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

async function sampleRenderedFrame(page) {
  return page.evaluate(async () => {
    const image = new Image();
    image.src = window.__diorama.captureFrame(320, 0.8);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minLuminance = 255;
    let maxLuminance = 0;
    let visibleSamples = 0;
    let clippedSamples = 0;
    let totalSamples = 0;
    let sceneClippedSamples = 0;
    let sceneSamples = 0;
    for (let y = 0; y < canvas.height; y += 8) {
      for (let x = 0; x < canvas.width; x += 8) {
        const index = (y * canvas.width + x) * 4;
        const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
        minLuminance = Math.min(minLuminance, luminance);
        maxLuminance = Math.max(maxLuminance, luminance);
        if (luminance > 4) visibleSamples += 1;
        if (luminance >= 250) clippedSamples += 1;
        totalSamples += 1;
        if (y >= canvas.height * 0.35) {
          if (luminance >= 250) sceneClippedSamples += 1;
          sceneSamples += 1;
        }
      }
    }
    return {
      minLuminance,
      maxLuminance,
      visibleSamples,
      clippedSamples,
      totalSamples,
      sceneClippedSamples,
      sceneSamples,
    };
  });
}

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
  await assertBundleBudgets();
  await waitForServer();
  const executablePath = await firstExisting([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${URL}/?profile=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 20_000 });
  await page.waitForTimeout(4_500);

  const initial = await page.evaluate(() => ({
    state: window.__diorama.getState(),
    metrics: window.__diorama.getMetrics(),
    frameLength: window.__diorama.captureFrame(640, 0.75).length,
  }));
  assert.equal(initial.metrics.ready, true);
  assert.ok(initial.metrics.renderer.calls > 0, 'renderer must issue draw calls');
  assert.ok(initial.metrics.renderer.calls <= 1_000, `high-quality draw-call budget exceeded: ${initial.metrics.renderer.calls}`);
  assert.ok(initial.metrics.renderer.geometries <= 500, `geometry budget exceeded: ${initial.metrics.renderer.geometries}`);
  assert.ok(initial.metrics.renderer.textures <= 80, `texture budget exceeded: ${initial.metrics.renderer.textures}`);
  assert.ok(initial.frameLength > 20_000, 'captured frame appears blank or incomplete');
  const desktopPixels = await sampleRenderedFrame(page);
  assert.ok(desktopPixels.visibleSamples > 200, 'desktop canvas is blank');
  assert.ok(desktopPixels.maxLuminance - desktopPixels.minLuminance > 25, 'desktop canvas lacks visual contrast');
  assert.ok(
    desktopPixels.sceneClippedSamples / desktopPixels.sceneSamples < 0.12,
    'desktop scene highlights are overexposed'
  );
  await page.screenshot({ path: '/tmp/voxel-diorama-desktop.png' });

  const exposureSamples = {};
  for (const [label, time] of [['sunrise', 0.28], ['noon', 0.5], ['sunset', 0.72]]) {
    await page.evaluate((t) => window.__diorama.setTime(t), time);
    await page.waitForTimeout(350);
    const sample = await sampleRenderedFrame(page);
    await page.screenshot({ path: `/tmp/voxel-diorama-${label}.png` });
    exposureSamples[label] = sample;
    const clippedRatio = sample.sceneClippedSamples / sample.sceneSamples;
    assert.ok(
      clippedRatio < 0.12,
      `${label} highlights are overexposed (${(clippedRatio * 100).toFixed(1)}%)`
    );
  }

  const progressBefore = Number(initial.state.trainProgress);
  await page.waitForFunction(
    (before) => Math.abs(Number(window.__diorama.getState().trainProgress) - before) > 0.00001,
    progressBefore,
    { timeout: 12_000 }
  );
  const progressAfter = await page.evaluate(() => Number(window.__diorama.getState().trainProgress));
  assert.notEqual(progressAfter, progressBefore, 'train simulation must advance');

  await page.evaluate(() => window.__diorama.setQuality('low'));
  await page.waitForTimeout(250);
  const low = await page.evaluate(() => window.__diorama.getMetrics());
  assert.equal(low.quality.level, 'low');
  assert.ok(low.renderer.pixelRatio <= 1);
  assert.ok(
    low.renderer.calls < initial.metrics.renderer.calls,
    `low quality must reduce draw calls (${low.renderer.calls} vs ${initial.metrics.renderer.calls})`
  );

  await page.evaluate(() => window.__diorama.setQuality('high'));
  await page.waitForTimeout(250);
  const high = await page.evaluate(() => window.__diorama.getMetrics());
  assert.equal(high.quality.level, 'high');
  assert.ok(high.renderer.pixelRatio >= 1 && high.renderer.pixelRatio <= 2);

  await page.evaluate(() => window.__diorama.setQuality('auto'));
  const profilerEnabled = await page.evaluate(() => window.__diorama.toggleProfiler());
  assert.equal(profilerEnabled, true);
  await page.waitForSelector('[data-diorama-profiler="true"]', { state: 'attached' });
  const profilerDisabled = await page.evaluate(() => window.__diorama.toggleProfiler());
  assert.equal(profilerDisabled, false);
  assert.deepEqual(consoleErrors, [], `browser errors:\n${consoleErrors.join('\n')}`);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mobileErrors = [];
  mobile.on('console', (message) => {
    if (message.type() === 'error') mobileErrors.push(message.text());
  });
  mobile.on('pageerror', (error) => mobileErrors.push(error.message));
  await mobile.goto(URL, { waitUntil: 'networkidle' });
  await mobile.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 20_000 });
  const mobilePixels = await sampleRenderedFrame(mobile);
  assert.ok(mobilePixels.visibleSamples > 200, 'mobile canvas is blank');
  assert.ok(mobilePixels.maxLuminance - mobilePixels.minLuminance > 25, 'mobile canvas lacks visual contrast');
  const mobileLayout = await mobile.evaluate(() => {
    const panel = document.querySelector('#dilation-panel').getBoundingClientRect();
    const clock = document.querySelector('#time-display').getBoundingClientRect();
    const info = document.querySelector('#info').getBoundingClientRect();
    return {
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      clock: { left: clock.left, right: clock.right, top: clock.top, bottom: clock.bottom },
      info: { left: info.left, right: info.right, top: info.top, bottom: info.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  for (const rect of [mobileLayout.panel, mobileLayout.clock, mobileLayout.info]) {
    assert.ok(rect.left >= -1 && rect.right <= mobileLayout.viewport.width + 1, 'mobile UI exceeds viewport width');
    assert.ok(rect.top >= -1 && rect.bottom <= mobileLayout.viewport.height + 1, 'mobile UI exceeds viewport height');
  }
  const panelOverlapsClock = !(
    mobileLayout.panel.right <= mobileLayout.clock.left ||
    mobileLayout.clock.right <= mobileLayout.panel.left ||
    mobileLayout.panel.bottom <= mobileLayout.clock.top ||
    mobileLayout.clock.bottom <= mobileLayout.panel.top
  );
  assert.equal(panelOverlapsClock, false, 'mobile panel overlaps the clock');
  await mobile.screenshot({ path: '/tmp/voxel-diorama-mobile.png' });
  await mobile.close();
  assert.deepEqual(mobileErrors, [], `mobile browser errors:\n${mobileErrors.join('\n')}`);

  console.log(JSON.stringify({
    quality: initial.metrics.quality,
    renderer: initial.metrics.renderer,
    lowQualityCalls: low.renderer.calls,
    desktopPixels,
    mobilePixels,
    exposureSamples,
    browserErrors: consoleErrors.length,
  }, null, 2));
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
