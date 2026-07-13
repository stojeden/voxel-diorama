import assert from 'node:assert/strict';
import { access, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4173;
const URL = `http://${HOST}:${PORT}`;

async function assertBundleBudgets() {
  const assetNames = await readdir('dist/assets');
  const entry =
    assetNames.find((name) => /^main-.*\.js$/.test(name)) ??
    assetNames.find((name) => /^index-.*\.js$/.test(name));
  const three = assetNames.find((name) => /^three-.*\.js$/.test(name));
  const renderingEffects = assetNames.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(entry, 'application entry chunk is missing');
  assert.ok(three, 'Three.js vendor chunk is missing');
  assert.ok(renderingEffects, 'rendering effects chunk is missing');
  const entryBytes = (await stat(`dist/assets/${entry}`)).size;
  const threeBytes = (await stat(`dist/assets/${three}`)).size;
  const renderingEffectsBytes = (await stat(`dist/assets/${renderingEffects}`)).size;
  assert.ok(entryBytes <= 200_000, `application chunk budget exceeded: ${entryBytes} bytes`);
  assert.ok(threeBytes <= 800_000, `Three.js chunk budget exceeded: ${threeBytes} bytes`);
  assert.ok(
    renderingEffectsBytes <= 420_000,
    `rendering effects chunk budget exceeded: ${renderingEffectsBytes} bytes`
  );
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
  assert.ok(initial.metrics.renderer.calls <= 1_400, `high-quality draw-call budget exceeded: ${initial.metrics.renderer.calls}`);
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
  for (const [label, time] of [['sunrise', 0.28], ['noon', 0.5], ['sunset', 0.72], ['night', 0.86]]) {
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

  await page.evaluate(async () => {
    window.__diorama.setTime(0.68);
    window.__diorama.setWeather('rain');
    await window.__diorama.controls.setLookAt(-12, 30, 96, -40, 0, 62, false);
  });
  await page.waitForTimeout(800);
  const lakePixels = await sampleRenderedFrame(page);
  assert.ok(lakePixels.maxLuminance - lakePixels.minLuminance > 25, 'lake view lacks visual contrast');
  await page.screenshot({ path: '/tmp/voxel-diorama-lake-rain.png' });
  await page.evaluate(() => window.__diorama.clearWeather());

  const grocerySignCount = await page.evaluate(() => {
    let count = 0;
    window.__diorama.scene.traverse((object) => {
      if (object.name.startsWith('neighborhood-grocery-sign-')) count += 1;
    });
    return count;
  });
  assert.equal(grocerySignCount, 2, 'both neighborhood grocery kiosks need physical signs');

  await page.evaluate(async () => {
    window.__diorama.setTime(0.5);
    await window.__diorama.controls.setLookAt(-4, 6, 17, -11, 0.3, 28, false);
  });
  await page.waitForTimeout(450);
  await page.screenshot({ path: '/tmp/voxel-diorama-bus-stop.png' });

  await page.evaluate(async () => {
    await window.__diorama.controls.setLookAt(-37, 6, 51, -45, 0.6, 44, false);
    if (!window.__diorama.debugBusStop('Park Nadjeziorny')) {
      throw new Error('lake bus stop is missing');
    }
    let sawWalkingPassenger = false;
    const deadline = performance.now() + 3_600;
    while (performance.now() < deadline) {
      const passengers = window.__diorama.busPassengers();
      const lakePassengers = passengers.filter((passenger) => passenger.stop === 'Park Nadjeziorny');
      if (lakePassengers.some((passenger) => passenger.activity !== 'idle')) sawWalkingPassenger = true;
      if (lakePassengers.some((passenger) => passenger.colliding)) {
        throw new Error('lake bus-stop passenger entered shelter geometry');
      }
      await new Promise(requestAnimationFrame);
    }
    if (!sawWalkingPassenger) throw new Error('lake bus-stop navigation did not animate');
  });
  await page.screenshot({ path: '/tmp/voxel-diorama-lake-bus-stop.png' });

  const busStopDetails = await page.evaluate(() => {
    const result = { posters: 0, fixtures: 0, lights: 0 };
    window.__diorama.scene.traverse((object) => {
      if (object.name.startsWith('bus-stop-poster-')) result.posters += 1;
      if (object.name.startsWith('bus-stop-ceiling-light-')) result.fixtures += 1;
      if (object.name.startsWith('bus-stop-safety-light-')) result.lights += 1;
    });
    return result;
  });
  assert.equal(busStopDetails.posters, 10, 'every shelter needs a two-sided poster lightbox');
  assert.equal(busStopDetails.fixtures, 5, 'every shelter needs a ceiling fixture');
  assert.equal(busStopDetails.lights, 5, 'every shelter needs a safety light');

  await page.evaluate(() => window.__diorama.setTime(0.86));
  await page.waitForTimeout(900);
  const activeBusStopLights = await page.evaluate(() => {
    let active = 0;
    window.__diorama.scene.traverse((object) => {
      if (
        object.name.startsWith('bus-stop-safety-light-') &&
        object.visible &&
        object.intensity > 0
      ) active += 1;
    });
    return active;
  });
  assert.ok(
    activeBusStopLights >= 1 && activeBusStopLights <= 2,
    'nearest shelter lights should respect the GPU budget while every fixture remains emissive'
  );
  const nightBusStopMetrics = await page.evaluate(() => window.__diorama.getMetrics());
  assert.ok(
    nightBusStopMetrics.quality.estimatedFps >= 55,
    `night bus-stop lighting is too expensive (${nightBusStopMetrics.quality.estimatedFps.toFixed(1)} FPS)`
  );
  await page.screenshot({ path: '/tmp/voxel-diorama-night-bus-stop.png' });

  await page.evaluate(async () => {
    window.__diorama.setTime(0.5);
    await window.__diorama.controls.setLookAt(-31, 6, 7, -28.5, 1.5, 16, false);
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/voxel-diorama-grocery.png' });

  await page.evaluate(async () => {
    window.__diorama.setTime(0.86);
    window.__diorama.placeCowAtMeadow();
    const cow = window.__diorama.scene.getObjectByName('lakeside-cow');
    if (!cow) throw new Error('lakeside cow is missing from the scene');
    const target = cow.position;
    await window.__diorama.controls.setLookAt(
      target.x + 11,
      5.5,
      target.z - 10,
      target.x,
      target.y + 0.8,
      target.z,
      false
    );
  });
  await page.waitForTimeout(450);
  const cowNightPixels = await sampleRenderedFrame(page);
  await page.screenshot({ path: '/tmp/voxel-diorama-night-cow.png' });
  assert.ok(cowNightPixels.visibleSamples > 150, 'street lighting leaves the cow district unreadable');
  assert.ok(cowNightPixels.maxLuminance - cowNightPixels.minLuminance > 25, 'cow district lacks night contrast');

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
    nightBusStopFps: nightBusStopMetrics.quality.estimatedFps,
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
