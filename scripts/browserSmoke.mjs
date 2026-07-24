import assert from 'node:assert/strict';
import { access, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4173;
const URL = `http://${HOST}:${PORT}`;
const IS_CI = process.env.CI === 'true';
const WRITE_SCREENSHOTS = !IS_CI;
const READY_TIMEOUT_MS = WRITE_SCREENSHOTS ? 60_000 : 180_000;
const SIMULATION_TIMEOUT_MS = IS_CI ? 60_000 : 12_000;

async function saveScreenshot(page, path) {
  if (WRITE_SCREENSHOTS) await page.screenshot({ path });
}

async function assertBundleBudgets() {
  const assetNames = await readdir('dist/assets');
  const entry = assetNames.find((name) => /^index-.*\.js$/.test(name));
  const bootstrap = assetNames.find((name) => /^main-.*\.js$/.test(name));
  const three = assetNames.find((name) => /^three-.*\.js$/.test(name));
  const cameraControls = assetNames.find((name) => /^camera-controls-.*\.js$/.test(name));
  const postprocessing = assetNames.find((name) => /^postprocessing-.*\.js$/.test(name));
  assert.ok(entry, 'application entry chunk is missing');
  assert.ok(bootstrap, 'application bootstrap chunk is missing');
  assert.ok(three, 'Three.js vendor chunk is missing');
  assert.ok(cameraControls, 'camera-controls vendor chunk is missing');
  assert.ok(postprocessing, 'postprocessing vendor chunk is missing');
  const entryBytes = (await stat(`dist/assets/${entry}`)).size;
  const bootstrapBytes = (await stat(`dist/assets/${bootstrap}`)).size;
  const threeBytes = (await stat(`dist/assets/${three}`)).size;
  const cameraControlsBytes = (await stat(`dist/assets/${cameraControls}`)).size;
  const postprocessingBytes = (await stat(`dist/assets/${postprocessing}`)).size;
  assert.ok(entryBytes <= 240_000, `application chunk budget exceeded: ${entryBytes} bytes`);
  assert.ok(bootstrapBytes <= 50_000, `application bootstrap budget exceeded: ${bootstrapBytes} bytes`);
  assert.ok(threeBytes <= 800_000, `Three.js chunk budget exceeded: ${threeBytes} bytes`);
  assert.ok(cameraControlsBytes <= 60_000, `camera-controls chunk budget exceeded: ${cameraControlsBytes} bytes`);
  assert.ok(
    postprocessingBytes <= 300_000,
    `postprocessing chunk budget exceeded: ${postprocessingBytes} bytes`
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

async function compareCapturedFrames(page, before, after) {
  return page.evaluate(async ({ beforeUrl, afterUrl }) => {
    const decode = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return {
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      };
    };
    const firstFrame = await decode(beforeUrl);
    const secondFrame = await decode(afterUrl);
    if (
      firstFrame.width !== secondFrame.width ||
      firstFrame.height !== secondFrame.height
    ) {
      throw new Error('captured rainbow frames have different dimensions');
    }
    const first = firstFrame.pixels;
    const second = secondFrame.pixels;
    const chromaticRows = new Uint8Array(firstFrame.height);
    const chromaticColumns = new Uint8Array(firstFrame.width);
    let changedPixels = 0;
    let chromaticPixels = 0;
    let maxChannelDelta = 0;
    for (let index = 0; index < first.length; index += 4) {
      const delta = Math.max(
        Math.abs(first[index] - second[index]),
        Math.abs(first[index + 1] - second[index + 1]),
        Math.abs(first[index + 2] - second[index + 2])
      );
      if (delta >= 4) changedPixels++;
      const firstChroma = Math.max(first[index], first[index + 1], first[index + 2]) -
        Math.min(first[index], first[index + 1], first[index + 2]);
      const secondChroma = Math.max(second[index], second[index + 1], second[index + 2]) -
        Math.min(second[index], second[index + 1], second[index + 2]);
      if (delta >= 4 && secondChroma >= firstChroma + 4) {
        chromaticPixels++;
        const pixelIndex = index / 4;
        chromaticRows[Math.floor(pixelIndex / firstFrame.width)] = 1;
        chromaticColumns[pixelIndex % firstFrame.width] = 1;
      }
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    const span = (mask) => {
      const first = mask.indexOf(1);
      const last = mask.lastIndexOf(1);
      return first < 0 ? 0 : last - first + 1;
    };
    const longestRun = (mask) => {
      let longest = 0;
      let current = 0;
      for (const value of mask) {
        current = value ? current + 1 : 0;
        longest = Math.max(longest, current);
      }
      return longest;
    };
    return {
      changedPixels,
      chromaticPixels,
      maxChannelDelta,
      chromaticRowSpan: span(chromaticRows),
      chromaticColumnSpan: span(chromaticColumns),
      longestChromaticColumnRun: longestRun(chromaticColumns),
      width: firstFrame.width,
      height: firstFrame.height,
    };
  }, { beforeUrl: before, afterUrl: after });
}

async function assertMobileLayout(page) {
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('#control-panel').getBoundingClientRect();
    const eclipse = document.querySelector('#eclipse-status').getBoundingClientRect();
    const clock = document.querySelector('#time-display').getBoundingClientRect();
    const info = document.querySelector('#info').getBoundingClientRect();
    return {
      panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
      eclipse: { left: eclipse.left, right: eclipse.right, top: eclipse.top, bottom: eclipse.bottom },
      clock: { left: clock.left, right: clock.right, top: clock.top, bottom: clock.bottom },
      info: { left: info.left, right: info.right, top: info.top, bottom: info.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  for (const rect of [layout.panel, layout.eclipse, layout.clock, layout.info]) {
    assert.ok(rect.left >= -1 && rect.right <= layout.viewport.width + 1, 'mobile UI exceeds viewport width');
    assert.ok(rect.top >= -1 && rect.bottom <= layout.viewport.height + 1, 'mobile UI exceeds viewport height');
  }
  const overlaps = (first, second) => !(
    first.right <= second.left ||
    second.right <= first.left ||
    first.bottom <= second.top ||
    second.bottom <= first.top
  );
  assert.equal(overlaps(layout.panel, layout.clock), false, 'mobile panel overlaps the clock');
  assert.equal(overlaps(layout.eclipse, layout.clock), false, 'mobile eclipse status overlaps the clock');
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
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  assert.equal(browser.contexts().length, 1, 'smoke test must use exactly one browser context');
  assert.equal(page.context().pages().length, 1, 'smoke test must use exactly one browser page');
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    window.__loadingSamples = [];
    const collectLoadingProgress = () => {
      const value = Number.parseInt(document.querySelector('#loading-progress')?.textContent ?? '', 10);
      if (!Number.isFinite(value)) return;
      const samples = window.__loadingSamples;
      if (samples.at(-1) !== value) samples.push(value);
    };
    new MutationObserver(collectLoadingProgress).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.addEventListener('DOMContentLoaded', collectLoadingProgress, { once: true });
  });

  await page.goto(`${URL}/?profile=1&seed=20260722`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForTimeout(4_500);

  const initial = await page.evaluate(() => ({
    documentLanguage: document.documentElement.lang,
    state: window.__diorama.getState(),
    metrics: window.__diorama.getMetrics(),
    frameLength: window.__diorama.captureFrame(640, 0.75).length,
    loadingSamples: window.__loadingSamples,
    loadingAriaValue: document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    loadingBarTransform: document.querySelector('#loading-progress-bar')?.style.transform,
  }));
  assert.equal(initial.documentLanguage, 'pl', 'document language must match the Polish interface');
  assert.ok(initial.loadingSamples.length >= 5, `preloader exposed too few real stages: ${initial.loadingSamples}`);
  assert.equal(initial.loadingSamples.at(-1), 100, 'preloader must finish at 100%');
  assert.equal(initial.loadingAriaValue, '100', 'preloader accessibility value must finish at 100');
  assert.equal(initial.loadingBarTransform, 'scaleX(1)', 'determinate preloader bar must fill completely');
  for (let index = 1; index < initial.loadingSamples.length; index++) {
    assert.ok(
      initial.loadingSamples[index] >= initial.loadingSamples[index - 1],
      `preloader progress moved backwards: ${initial.loadingSamples}`
    );
  }
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
  await saveScreenshot(page, '/tmp/voxel-diorama-desktop.png');

  await page.goto(
    `${URL}/?profile=1&seed=20260724&checkpoint=post-rain-clear-lake&quality=high`,
    { waitUntil: 'networkidle' }
  );
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('#loading-screen')).visibility === 'hidden',
    null,
    { timeout: READY_TIMEOUT_MS }
  );
  await page.waitForTimeout(250);
  const rainbowOffFrame = await page.evaluate(
    () => window.__diorama.captureFrame(480, 1, 'png')
  );
  await page.goto(
    `${URL}/?profile=1&seed=20260724&checkpoint=post-rain-rainbow-lake&quality=high`,
    { waitUntil: 'networkidle' }
  );
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('#loading-screen')).visibility === 'hidden',
    null,
    { timeout: READY_TIMEOUT_MS }
  );
  await page.waitForTimeout(250);
  const rainbowCheckpoint = await page.evaluate(() => {
    const state = window.__diorama.getState();
    return {
      checkpoint: state.checkpoint,
      airborneMoisture: state.airborneMoisture,
      rainbow: state.rainbow,
    };
  });
  assert.equal(rainbowCheckpoint.checkpoint?.id, 'post-rain-rainbow-lake');
  assert.equal(rainbowCheckpoint.airborneMoisture, 1);
  assert.equal(rainbowCheckpoint.rainbow.source, 'lake');
  assert.equal(rainbowCheckpoint.rainbow.visible, true);
  assert.ok(rainbowCheckpoint.rainbow.strength > 0.05);
  const rainbowOnFrame = await page.evaluate(
    () => window.__diorama.captureFrame(480, 1, 'png')
  );
  const rainbowPixels = await compareCapturedFrames(page, rainbowOffFrame, rainbowOnFrame);
  assert.ok(rainbowPixels.changedPixels > 400, 'rainbow checkpoint changed too few rendered pixels');
  assert.ok(rainbowPixels.chromaticPixels > 120, 'rainbow lacks the expected chromatic arc');
  assert.ok(rainbowPixels.maxChannelDelta >= 8, 'rainbow is not visibly distinguishable from control');
  assert.ok(
    rainbowPixels.chromaticRowSpan > rainbowPixels.height * 0.15,
    'rainbow chroma does not span a plausible vertical arc'
  );
  assert.ok(
    rainbowPixels.chromaticColumnSpan > rainbowPixels.width * 0.25,
    'rainbow chroma does not span a plausible horizontal arc'
  );
  assert.ok(
    rainbowPixels.longestChromaticColumnRun > rainbowPixels.width * 0.2,
    'rainbow chroma is too fragmented to form a continuous arc'
  );
  await saveScreenshot(page, '/tmp/voxel-diorama-rainbow.png');

  if (!IS_CI) {
    await page.goto(`${URL}/?profile=1&seed=20260722`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
  }

  if (IS_CI) {
    await page.evaluate(() => window.__diorama.setQuality('low'));
    const low = await page.evaluate(() => window.__diorama.getMetrics());
    assert.equal(low.quality.level, 'low');
    assert.ok(low.renderer.pixelRatio <= 1);
    await page.evaluate(() => window.__diorama.setQuality('auto'));

    const profilerEnabled = await page.evaluate(() => window.__diorama.toggleProfiler());
    assert.equal(profilerEnabled, true);
    const profilerAttached = await page.evaluate(
      () => Boolean(document.querySelector('[data-diorama-profiler="true"]'))
    );
    assert.equal(profilerAttached, true, 'profiler must attach its diagnostics node');
    const profilerDisabled = await page.evaluate(() => window.__diorama.toggleProfiler());
    assert.equal(profilerDisabled, false);

    assert.deepEqual(consoleErrors, [], `browser errors:\n${consoleErrors.join('\n')}`);
    console.log(JSON.stringify({
      mode: 'ci-software-renderer-smoke',
      quality: initial.metrics.quality,
      renderer: initial.metrics.renderer,
      desktopPixels,
      browserErrors: consoleErrors.length,
    }, null, 2));
    await page.close();
  } else {
  await page.evaluate(() => window.__diorama.setTime(0.32));
  await page.waitForFunction(
    () => window.__diorama.postmanState().active === true,
    null,
    { timeout: SIMULATION_TIMEOUT_MS }
  );
  const postmanRenderState = await page.evaluate(() => {
    const state = window.__diorama.postmanState();
    const uniform = window.__diorama.scene.getObjectByName('postman-uniform');
    const rider = window.__diorama.scene.getObjectByName('postman-rider');
    const bike = window.__diorama.scene.getObjectByName('postman-bike');
    return {
      state,
      uniformColor: uniform?.material?.color?.getHex?.() ?? null,
      hasCap: Boolean(window.__diorama.scene.getObjectByName('postman-cap')),
      hasSatchel: Boolean(window.__diorama.scene.getObjectByName('postman-satchel')),
      riderAttachedToBike: rider?.parent === bike,
    };
  });
  assert.equal(postmanRenderState.state.active, true, 'postman must start his morning route');
  assert.equal(postmanRenderState.state.bikeVisible, true, 'active postman bicycle must be visible');
  assert.equal(postmanRenderState.state.riderGroupVisible, true, 'active postman rider must be visible');
  assert.equal(postmanRenderState.state.riderHiddenParts, 0, 'postman rider cannot lose individual meshes');
  assert.equal(postmanRenderState.state.riderOpacity, 1, 'postman rider must remain fully opaque');
  assert.ok(postmanRenderState.state.riderWorldY > 2, 'postman rider cannot flip below the road');
  assert.equal(postmanRenderState.uniformColor, 0x2368a2, 'postman uniform must use postal blue');
  assert.equal(postmanRenderState.hasCap, true, 'postman cap is missing');
  assert.equal(postmanRenderState.hasSatchel, true, 'postman satchel is missing');
  assert.equal(postmanRenderState.riderAttachedToBike, true, 'postman rider must remain attached to the bicycle');
  await page.evaluate(async () => {
    const bike = window.__diorama.scene.getObjectByName('postman-bike');
    const position = bike.position.clone();
    bike.getWorldPosition(position);
    const quaternion = bike.quaternion.clone();
    bike.getWorldQuaternion(quaternion);
    const back = position.clone().set(0, 0, 1).applyQuaternion(quaternion);
    const side = position.clone().set(1, 0, 0).applyQuaternion(quaternion);
    const camera = position.clone().addScaledVector(back, 5).addScaledVector(side, 3.8);
    camera.y += 2.8;
    const target = position.clone();
    target.y += 1.45;
    await window.__diorama.controls.setLookAt(
      camera.x, camera.y, camera.z,
      target.x, target.y, target.z,
      false
    );
  });
  await page.waitForTimeout(40);
  await saveScreenshot(page, '/tmp/voxel-diorama-postman.png');
  await page.evaluate(async () => {
    await window.__diorama.controls.setLookAt(70, 48, 80, 0, 6, 0, false);
  });

  const exposureSamples = {};
  for (const [label, time] of [['sunrise', 0.28], ['noon', 0.5], ['sunset', 0.72], ['night', 0.86]]) {
    await page.evaluate((t) => window.__diorama.setTime(t), time);
    await page.waitForTimeout(350);
    const sample = await sampleRenderedFrame(page);
    await saveScreenshot(page, `/tmp/voxel-diorama-${label}.png`);
    exposureSamples[label] = sample;
    const clippedRatio = sample.sceneClippedSamples / sample.sceneSamples;
    assert.ok(
      clippedRatio < 0.12,
      `${label} highlights are overexposed (${(clippedRatio * 100).toFixed(1)}%)`
    );
  }

  await page.evaluate(() => {
    window.__diorama.setQuality('high');
    window.__diorama.setEclipseProgress(0.31);
  });
  await page.waitForTimeout(500);
  const partialEclipse = await page.evaluate(() => {
    const state = window.__diorama.getState();
    const crescents = window.__diorama.scene.getObjectByName('eclipse-tree-crescents');
    return {
      eclipse: state.eclipse,
      reaction: state.eclipseReaction,
      crescentsVisible: crescents?.visible ?? false,
      crescentCount: crescents?.count ?? 0,
      props: window.__diorama.eclipseCrowdProps(),
      stationPassengers: window.__diorama.stationPassengers(),
      postman: window.__diorama.postmanState(),
    };
  });
  assert.ok(
    partialEclipse.eclipse.coverage > 0.65 && partialEclipse.eclipse.coverage < 0.96,
    'the partial-eclipse checkpoint must expose a readable solar crescent'
  );
  assert.ok(partialEclipse.crescentsVisible, 'tree pinhole crescents must appear in deep partial eclipse');
  assert.equal(partialEclipse.crescentCount, 46, 'High quality must use the full crescent instance budget');
  assert.ok(partialEclipse.props.glasses > 0, 'residents must use eclipse glasses');
  assert.ok(partialEclipse.props.projectionCards > 0, 'residents must use projection cards');
  assert.ok(
    partialEclipse.stationPassengers.some((passenger) => passenger.observingEclipse),
    'station passengers must react to the eclipse'
  );
  assert.ok(partialEclipse.postman.eclipseAlert > 0, 'the dog must react to the changing light');
  await saveScreenshot(page, '/tmp/voxel-diorama-eclipse-partial.png');

  await page.evaluate(() => window.__diorama.setEclipseProgress(0.35));
  await page.waitForTimeout(350);
  const highBands = await page.evaluate(
    () => window.__diorama.scene.getObjectByName('eclipse-shadow-bands')?.visible ?? false
  );
  assert.equal(highBands, true, 'shadow bands must appear near contact in High quality');
  await page.evaluate(() => window.__diorama.setQuality('medium'));
  await page.waitForTimeout(200);
  const mediumBands = await page.evaluate(
    () => window.__diorama.scene.getObjectByName('eclipse-shadow-bands')?.visible ?? false
  );
  assert.equal(mediumBands, false, 'shadow bands must remain High-only');

  await page.evaluate(() => {
    window.__diorama.setQuality('high');
    window.__diorama.setEclipseProgress(0.5);
  });
  await page.waitForTimeout(350);
  await page.waitForTimeout(500);
  const collapsedPanel = await page.locator('#control-panel').boundingBox();
  const eclipseStatus = await page.locator('#eclipse-status').boundingBox();
  await page.evaluate(() => document.querySelector('#panel-toggle')?.click());
  await page.waitForTimeout(350);
  const expandedPanel = await page.locator('#control-panel').boundingBox();
  assert.ok(collapsedPanel && expandedPanel && eclipseStatus, 'eclipse UI layout is missing');
  assert.ok(
    Math.abs(collapsedPanel.width - expandedPanel.width) < 1,
    `control panel width changes when expanded (${collapsedPanel.width} vs ${expandedPanel.width})`
  );
  assert.ok(
    expandedPanel.x + expandedPanel.width <= eclipseStatus.x,
    'control panel overlaps the eclipse status'
  );
  await page.evaluate(() => document.querySelector('#panel-toggle')?.click());
  const eclipse = await page.evaluate(() => {
    const state = window.__diorama.getState().eclipse;
    const anchor = window.__diorama.scene.getObjectByName('eclipse-celestial-anchor');
    const solarLayer = window.__diorama.scene.getObjectByName('eclipse-solar-layer');
    const moonLayer = window.__diorama.scene.getObjectByName('eclipse-moon-layer');
    return {
      state,
      anchorVisible: anchor?.visible ?? false,
      solarVisible: solarLayer?.visible ?? false,
      moonVisible: moonLayer?.visible ?? false,
    };
  });
  assert.equal(eclipse.state.phase, 'totality');
  assert.ok(eclipse.state.coverage > 0.999, 'the Moon must fully cover the Sun at maximum eclipse');
  assert.ok(eclipse.state.corona > 0.99, 'the corona must be fully visible during totality');
  assert.ok(
    eclipse.anchorVisible && eclipse.solarVisible && eclipse.moonVisible,
    'the camera-relative eclipse layers must remain visible'
  );
  const totalityReactions = await page.evaluate(() => ({
    props: window.__diorama.eclipseCrowdProps(),
    reaction: window.__diorama.getState().eclipseReaction,
  }));
  assert.deepEqual(
    totalityReactions.props,
    { glasses: 0, projectionCards: 0 },
    'eye-protection props must disappear only during safe totality'
  );
  assert.ok(totalityReactions.reaction.movementScale < 0.1, 'city life must pause at totality');
  const eclipsePixels = await sampleRenderedFrame(page);
  assert.ok(eclipsePixels.visibleSamples > 200, 'the totality scene is too dark to read');
  assert.ok(
    eclipsePixels.maxLuminance - eclipsePixels.minLuminance > 25,
    'the totality scene lacks corona and horizon contrast'
  );
  assert.ok(
    eclipsePixels.sceneClippedSamples / eclipsePixels.sceneSamples < 0.12,
    'totality overexposes the city'
  );
  await saveScreenshot(page, '/tmp/voxel-diorama-eclipse-totality.png');
  await page.evaluate(() => window.__diorama.setEclipseProgress(1));

  const cityRhythm = {};
  for (const [label, time] of [
    ['lateEvening', (23 * 60 + 50) / 1440],
    ['afterMidnight', 5 / 1440],
    ['sleeping', (1 * 60 + 42) / 1440],
    ['isolated', (2 * 60 + 30) / 1440],
    ['dark', (2 * 60 + 45) / 1440],
    ['firstWake', (4 * 60 + 5) / 1440],
    ['morning', (5 * 60 + 35) / 1440],
  ]) {
    cityRhythm[label] = await page.evaluate(async (t) => {
      window.__diorama.setTime(t);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const groups = window.__diorama.windowRhythm();
      return groups.reduce((sum, group) => sum + group.activity, 0) / groups.length;
    }, time);
  }
  assert.ok(cityRhythm.lateEvening > cityRhythm.afterMidnight, 'midnight should switch off some homes');
  assert.ok(cityRhythm.afterMidnight > cityRhythm.sleeping, '01:42 should switch off more homes');
  assert.ok(cityRhythm.sleeping > cityRhythm.isolated, '02:30 should leave isolated windows only');
  assert.equal(cityRhythm.dark, 0, 'all residential windows should be dark at 02:45');
  assert.ok(cityRhythm.firstWake > 0, 'the first homes should wake after 04:00');
  assert.ok(cityRhythm.morning > cityRhythm.firstWake, 'morning windows should wake sequentially');

  const overnightBus = await page.evaluate(async () => {
    window.__diorama.setTime((2 * 60 + 30) / 1440);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return window.__diorama.busService();
  });
  assert.deepEqual(
    { mode: overnightBus.mode, visible: overnightBus.visible, waiting: overnightBus.waitingPassengers },
    { mode: 'off', visible: false, waiting: 0 },
    'the bus and stop crowds should be off service overnight'
  );
  const morningBus = await page.evaluate(async () => {
    window.__diorama.setTime((4 * 60 + 50) / 1440);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return window.__diorama.busService();
  });
  assert.equal(morningBus.mode, 'morning-release');
  assert.equal(morningBus.visible, true);
  assert.equal(morningBus.waitingPassengers, 0, 'passengers should initially be inside the morning bus');

  await page.evaluate(async () => {
    window.__diorama.setTime(0.68);
    window.__diorama.setWeather('rain');
    await window.__diorama.controls.setLookAt(-12, 30, 96, -40, 0, 62, false);
  });
  await page.waitForTimeout(800);
  const lakePixels = await sampleRenderedFrame(page);
  assert.ok(lakePixels.maxLuminance - lakePixels.minLuminance > 25, 'lake view lacks visual contrast');
  await saveScreenshot(page, '/tmp/voxel-diorama-lake-rain.png');
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
  await saveScreenshot(page, '/tmp/voxel-diorama-bus-stop.png');

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
  await saveScreenshot(page, '/tmp/voxel-diorama-lake-bus-stop.png');

  await page.evaluate(async () => {
    await window.__diorama.controls.setLookAt(39, 13, 19, 25, 6, 3, false);
    if (!window.__diorama.debugTrainStation('Przystanek Wiadukt')) {
      throw new Error('viaduct railway station is missing');
    }
    let sawWalkingPassenger = false;
    const deadline = performance.now() + 3_600;
    while (performance.now() < deadline) {
      const passengers = window.__diorama
        .stationPassengers()
        .filter((passenger) => passenger.station === 'Przystanek Wiadukt');
      if (passengers.some((passenger) => passenger.activity !== 'idle')) sawWalkingPassenger = true;
      if (passengers.some((passenger) => passenger.colliding)) {
        throw new Error('railway passenger entered station or railing geometry');
      }
      await new Promise(requestAnimationFrame);
    }
    if (!sawWalkingPassenger) throw new Error('railway passenger navigation did not animate');
  });
  await saveScreenshot(page, '/tmp/voxel-diorama-station-navigation.png');

  const busStopDetails = await page.evaluate(() => {
    const result = { posters: 0, fixtures: 0, lights: 0, posterFaceDistances: [] };
    window.__diorama.scene.traverse((object) => {
      if (object.name.startsWith('bus-stop-poster-')) result.posters += 1;
      if (object.name.startsWith('bus-stop-ceiling-light-')) result.fixtures += 1;
      if (object.name.startsWith('bus-stop-safety-light-')) result.lights += 1;
    });
    for (let index = 0; index < 5; index++) {
      const interior = window.__diorama.scene.getObjectByName(`bus-stop-poster-${index}-interior`);
      const exterior = window.__diorama.scene.getObjectByName(`bus-stop-poster-${index}-exterior`);
      if (interior && exterior) result.posterFaceDistances.push(interior.position.distanceTo(exterior.position));
    }
    return result;
  });
  assert.equal(busStopDetails.posters, 10, 'every shelter needs a two-sided poster lightbox');
  assert.equal(busStopDetails.posterFaceDistances.length, 5, 'every shelter needs both poster faces');
  assert.ok(
    busStopDetails.posterFaceDistances.every((distance) => distance > 1.02),
    'poster faces must sit outside the one-voxel shelter wall instead of intersecting it'
  );
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
  const stationLighting = await page.evaluate(() => {
    const result = {
      fixtures: 0,
      lights: 0,
      activeLights: 0,
      weakestActiveIntensity: Number.POSITIVE_INFINITY,
      strongestBusStopIntensity: 0,
      glowVisible: false,
      glowStrength: 0,
    };
    window.__diorama.scene.traverse((object) => {
      if (object.name.startsWith('station-platform-fixture-')) result.fixtures += 1;
      if (object.name.startsWith('station-platform-light-') && object.isPointLight) {
        result.lights += 1;
        if (object.visible && object.intensity > 0) {
          result.activeLights += 1;
          result.weakestActiveIntensity = Math.min(result.weakestActiveIntensity, object.intensity);
        }
      }
      if (
        object.name.startsWith('bus-stop-safety-light-') &&
        object.visible &&
        object.intensity > 0
      ) {
        result.strongestBusStopIntensity = Math.max(result.strongestBusStopIntensity, object.intensity);
      }
      if (object.name === 'station-platform-light-pools') {
        result.glowVisible = object.visible;
        result.glowStrength = object.material.uniforms.uNight.value;
      }
    });
    return result;
  });
  assert.equal(stationLighting.fixtures, 8, 'every station needs canopy and end-of-platform fixtures');
  assert.equal(stationLighting.lights, 2, 'every station needs one dynamic platform light');
  assert.equal(stationLighting.activeLights, 2, 'both railway stations must remain lit at night');
  assert.ok(stationLighting.glowVisible && stationLighting.glowStrength > 0.5, 'platform glow is missing at night');
  assert.ok(
    stationLighting.weakestActiveIntensity > stationLighting.strongestBusStopIntensity * 2,
    'railway station lighting should be substantially stronger than bus-stop lighting'
  );
  const nightBusStopMetrics = await page.evaluate(() => window.__diorama.getMetrics());
  if (!IS_CI) {
    assert.ok(
      nightBusStopMetrics.quality.estimatedFps >= 30,
      `night bus-stop smoke test became unresponsive (${nightBusStopMetrics.quality.estimatedFps.toFixed(1)} FPS)`
    );
  }
  await saveScreenshot(page, '/tmp/voxel-diorama-night-bus-stop.png');

  await page.evaluate(async () => {
    window.__diorama.setTime(0.5);
    await window.__diorama.controls.setLookAt(-31, 6, 7, -28.5, 1.5, 16, false);
  });
  await page.waitForTimeout(350);
  await saveScreenshot(page, '/tmp/voxel-diorama-grocery.png');

  await page.evaluate(async () => {
    // This assertion isolates street-light readability from the independently
    // tested weather machine; rain/fog must not make the sample timing flaky.
    window.__diorama.setWeather('clear');
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
  await saveScreenshot(page, '/tmp/voxel-diorama-night-cow.png');
  assert.ok(
    cowNightPixels.visibleSamples > 150,
    `street lighting leaves the cow district unreadable (${cowNightPixels.visibleSamples}/${cowNightPixels.totalSamples} visible samples)`
  );
  assert.ok(cowNightPixels.maxLuminance - cowNightPixels.minLuminance > 25, 'cow district lacks night contrast');

  await page.evaluate(() => window.__diorama.setTime(0.42));
  await page.waitForTimeout(900);
  const winterFisherman = await page.evaluate(async () => {
    window.__diorama.debugWinterFisherman();
    await window.__diorama.controls.setLookAt(-45, 4.2, 69, -39, 0.4, 62, false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const state = window.__diorama.fishermanState();
    const gear = window.__diorama.scene.getObjectByName('fisherman-ice-gear');
    const stool = window.__diorama.scene.getObjectByName('fisherman-ice-stool-seat');
    const tackleBox = window.__diorama.scene.getObjectByName('fisherman-ice-tackle-box');
    return {
      ...state,
      gearVisible: gear?.visible ?? false,
      stoolVisible: stool?.visible ?? false,
      tackleBoxVisible: tackleBox?.visible ?? false,
    };
  });
  assert.equal(winterFisherman.seatKind, 'ice');
  assert.equal(winterFisherman.gearVisible, true, 'winter fisherman gear is hidden');
  assert.equal(winterFisherman.stoolVisible, true, 'winter fisherman has no visible stool');
  assert.equal(winterFisherman.tackleBoxVisible, true, 'winter tackle box is missing');
  assert.equal(winterFisherman.seatedLegsVisible, true, 'bent seated legs are hidden');
  assert.equal(winterFisherman.standingLegsVisible, false, 'standing legs intersect the stool');
  assert.ok(winterFisherman.figureY < 0, 'winter fisherman still floats above the stool');
  await saveScreenshot(page, '/tmp/voxel-diorama-winter-fisherman.png');
  await page.evaluate(() => {
    window.__diorama.debugSetSnowCover(0);
    window.__diorama.clearWeather();
  });

  const progressBefore = Number(initial.state.trainProgress);
  await page.waitForFunction(
    (before) => Math.abs(Number(window.__diorama.getState().trainProgress) - before) > 0.00001,
    progressBefore,
    { timeout: SIMULATION_TIMEOUT_MS }
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

  // A real first drag/wheel must synchronously take ownership from every tour shot.
  await page.evaluate(() => window.__diorama.startTour());
  await page.mouse.move(720, 450);
  await page.mouse.down();
  const dragInterrupted = await page.evaluate(() => window.__diorama.getState().tourChapter === null);
  assert.equal(dragInterrupted, true, 'first pointerdown must interrupt the tour synchronously');
  const cameraBeforeDrag = await page.evaluate(() => window.__diorama.cameraPose().position);
  await page.mouse.move(780, 430, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const cameraAfterDrag = await page.evaluate(() => window.__diorama.cameraPose().position);
  assert.notDeepEqual(cameraAfterDrag, cameraBeforeDrag, 'the first drag must move the released camera');

  await page.evaluate(() => window.__diorama.startTour());
  const distanceBeforeWheel = await page.evaluate(() => window.__diorama.cameraPose().distance);
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(50);
  const wheelState = await page.evaluate(() => ({
    interrupted: window.__diorama.getState().tourChapter === null,
    distance: window.__diorama.cameraPose().distance,
  }));
  assert.equal(wheelState.interrupted, true, 'first wheel must interrupt the tour synchronously');
  assert.notEqual(wheelState.distance, distanceBeforeWheel, 'the first wheel must zoom the released camera');

  const checkpointUrl = `${URL}/?seed=20260722&checkpoint=totality&quality=high`;
  const loadCheckpointState = async () => {
    await page.goto(checkpointUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
    return page.evaluate(() => {
      const state = window.__diorama.getState();
      return {
        simulationSeed: state.simulationSeed,
        layoutSeed: state.layoutSeed,
        checkpoint: state.checkpoint,
        t01: state.t01,
        theme: state.theme,
        cyberFactor: state.cyberFactor,
        weather: state.weather,
        trainProgress: state.trainProgress,
        busProgress: state.busProgress,
        camera: window.__diorama.cameraPose(),
        eclipseProgress: state.eclipse.progress,
      };
    });
  };
  const checkpointA = await loadCheckpointState();
  const checkpointB = await loadCheckpointState();
  assert.deepEqual(checkpointB, checkpointA, 'same seed+checkpoint must reproduce the same scene fingerprint');
  assert.deepEqual(consoleErrors, [], `browser errors:\n${consoleErrors.join('\n')}`);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mobileErrors = [];
  mobile.on('console', (message) => {
    if (message.type() === 'error') mobileErrors.push(message.text());
  });
  mobile.on('pageerror', (error) => mobileErrors.push(error.message));
  await mobile.goto(URL, { waitUntil: 'networkidle' });
  await mobile.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });
  await mobile.evaluate(() => window.__diorama.setEclipseProgress(0.5));
  await mobile.waitForTimeout(300);
  const mobilePixels = await sampleRenderedFrame(mobile);
  assert.ok(mobilePixels.visibleSamples > 200, 'mobile canvas is blank');
  assert.ok(mobilePixels.maxLuminance - mobilePixels.minLuminance > 25, 'mobile canvas lacks visual contrast');
  await assertMobileLayout(mobile);
  await saveScreenshot(mobile, '/tmp/voxel-diorama-mobile.png');
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
