/**
 * Does the diorama still render when there is no GPU?
 *
 * Every other harness in this repository runs on whatever graphics card the developer has, and
 * on 2026-09-12 that blindness cost a red CI run and an afternoon. A change to the warm-up
 * moved the moment at which the PMREM reflection probe is built -- it is built exactly once,
 * on the first `DayNightCycle.update` call -- and the probe came back black on the runner's
 * software rasteriser. The scene drew 621k triangles with the sun at full intensity and every
 * material rendered black. On a real GPU it was invisible: every local gate passed.
 *
 * So this one asks the only question those gates could not: with ANGLE pointed at SwiftShader,
 * does a frame still contain a picture? It is deliberately not wired into CI, because CI has
 * no GPU and already answers it; this exists so a developer can answer it in three minutes
 * instead of learning it from a deploy twenty minutes later.
 *
 *   node scripts/prepareBuild.mjs && node scripts/softwareRenderSmoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { stopPreview } from './previewServer.mjs';
import { releaseLock, verifyBuild } from './buildProvenance.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SOFTWARE_RENDER_PORT ?? 4195);
const URL = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = 300_000;
/**
 * A frame with a picture in it, in bytes of JPEG.
 *
 * The black frame measured 4.9 kB and a healthy one 89-110 kB, so the threshold sits an order
 * of magnitude above the failure and well below the floor of the passing range. It is the
 * same shape of assertion `browserSmoke.mjs` already makes about its own captured frame.
 */
const MIN_FRAME_BYTES = 30_000;

await verifyBuild();

const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }
);
let previewLog = '';
preview.stdout.on('data', (chunk) => { previewLog += chunk.toString(); });
preview.stderr.on('data', (chunk) => { previewLog += chunk.toString(); });

const waitForServer = async () => {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(URL);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`preview never came up:\n${previewLog}`);
};

let browser;
try {
  await waitForServer();
  const executablePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => existsSync(candidate));
  assert.ok(executablePath, 'no system Chrome found to drive');

  browser = await chromium.launch({
    executablePath,
    // The runner's own configuration: ANGLE over SwiftShader, no hardware path at all.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--disable-gpu', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`${URL}/?seed=20260722`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: READY_TIMEOUT_MS });

  const reading = await page.evaluate(() => {
    const diorama = window.__diorama;
    const metrics = diorama.getMetrics();
    /**
     * Captured twice, with and without the environment map.
     *
     * The difference is the diagnosis. A black scene that comes back to life when
     * `scene.environment` is cleared is a broken reflection probe and nothing else; without
     * this second reading the failure looks like a lighting bug and sends the next person
     * down the same five wrong paths.
     */
    const withEnvironment = diorama.captureFrame(640, 0.92, 'jpeg').length;
    const keep = diorama.scene.environment;
    diorama.scene.environment = null;
    diorama.renderFrame();
    const withoutEnvironment = diorama.captureFrame(640, 0.92, 'jpeg').length;
    diorama.scene.environment = keep;
    diorama.renderFrame();
    return {
      gpu: metrics.renderer.gpu,
      quality: metrics.quality.level,
      calls: metrics.renderer.calls,
      triangles: metrics.renderer.triangles,
      withEnvironment,
      withoutEnvironment,
    };
  });

  console.log(JSON.stringify({ softwareRender: reading }, null, 2));

  assert.ok(
    /swiftshader|software|llvmpipe/i.test(reading.gpu),
    `this gate must run without a GPU, but the context reports: ${reading.gpu}`
  );
  assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  assert.ok(reading.triangles > 100_000, `scene did not draw: ${reading.triangles} triangles`);
  assert.ok(
    reading.withEnvironment >= MIN_FRAME_BYTES,
    `frame is blank on a software rasteriser: ${reading.withEnvironment} bytes` +
      (reading.withoutEnvironment >= MIN_FRAME_BYTES
        ? ` -- and it renders at ${reading.withoutEnvironment} bytes with scene.environment cleared,` +
          ' so the PMREM reflection probe is the broken thing, not the lighting.'
        : ' -- clearing scene.environment does not help, so the probe is not the cause this time.')
  );
  console.log('software rasteriser: a frame still has a picture in it');
} finally {
  try {
    await browser?.close();
    console.log(`preview: ${await stopPreview(preview)}`);
  } finally {
    releaseLock();
  }
}
