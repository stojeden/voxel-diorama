/**
 * Hybrid spike smoke: renders the Gate 1 frames for both geometry strategies in
 * the real pipeline, checks ground contact, LOD levels and renderer budgets, and
 * writes JPEG frames plus a JSON summary under docs/superpowers/spike/.
 *
 * Usage: npm run build && node scripts/spikeSmoke.mjs
 *   SPIKE_WORLDS=hybrid-direct,hybrid-greedy   SPIKE_QUALITIES=high,low
 */
import assert from 'node:assert/strict';
import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 4176;
const URL = `http://${HOST}:${PORT}`;
const SEED = 20260722;
const WORLDS = (process.env.SPIKE_WORLDS ?? 'hybrid-direct,hybrid-greedy').split(',').map((s) => s.trim()).filter(Boolean);
const QUALITIES = (process.env.SPIKE_QUALITIES ?? 'high,low').split(',').map((s) => s.trim()).filter(Boolean);
const CHECKPOINTS = ['spike-overview', 'spike-street', 'spike-golden', 'spike-night-street'];
const OUT_DIR = 'docs/superpowers/spike';
const FRAME_DIR = `${OUT_DIR}/frames`;

async function firstExisting(paths) {
  for (const path of paths) {
    try { await access(path); return path; } catch { /* next */ }
  }
  return undefined;
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(URL)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`preview did not start within ${timeoutMs} ms`);
}

async function assertBundles() {
  const names = await readdir('dist/assets');
  const entry = names.find((n) => /^index-.*\.js$/.test(n));
  const main = names.find((n) => /^main-.*\.js$/.test(n));
  const spike = names.find((n) => /^hybrid-spike-.*\.js$/.test(n));
  assert.ok(entry && main && spike, 'entry, main and hybrid-spike chunks must exist');
  const sizes = {
    entry: (await stat(`dist/assets/${entry}`)).size,
    main: (await stat(`dist/assets/${main}`)).size,
    spike: (await stat(`dist/assets/${spike}`)).size,
  };
  assert.ok(sizes.entry <= 240_000, `entry chunk over budget: ${sizes.entry}`);
  assert.ok(sizes.main <= 50_000, `main chunk over budget: ${sizes.main}`);
  return sizes;
}

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let browser;
const results = [];
try {
  const bundles = await assertBundles();
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
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await mkdir(FRAME_DIR, { recursive: true });

  for (const world of WORLDS) {
    for (const quality of QUALITIES) {
      const checkpoints = quality === 'high' ? CHECKPOINTS : ['spike-street', 'spike-overview'];
      for (const checkpoint of checkpoints) {
        consoleErrors.length = 0;
        await page.goto(`${URL}/?seed=${SEED}&world=${world}&checkpoint=${checkpoint}&quality=${quality}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
        // Frozen checkpoints never advance the bus state machine; a dwell makes the
        // waiting residents visible exactly as they are when the bus stops.
        await page.evaluate(() => window.__diorama.debugBusStop('Osiedle Centralne'));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForTimeout(400);
        const sample = await page.evaluate(() => ({
          metrics: window.__diorama.getMetrics(),
          state: window.__diorama.getState(),
          contact: window.__diorama.hybridGroundContact(),
        }));
        const { metrics, state, contact } = sample;
        assert.equal(state.world, world, `${world}/${checkpoint}: world flag not applied`);
        assert.equal(state.checkpoint?.id, checkpoint, `${world}/${checkpoint}: checkpoint not applied`);
        assert.equal(metrics.quality.level, quality, `${world}/${checkpoint}: quality ${metrics.quality.level}`);
        assert.ok(metrics.hybrid, `${world}/${checkpoint}: hybrid metrics missing`);
        assert.equal(metrics.hybrid.strategy, world.replace('hybrid-', ''));
        assert.ok(!/swiftshader|software|llvmpipe/i.test(metrics.renderer.gpu), `software renderer: ${metrics.renderer.gpu}`);
        assert.ok(metrics.renderer.calls <= 1_400, `${world}/${checkpoint}: draw calls ${metrics.renderer.calls}`);
        assert.ok(metrics.renderer.geometries <= 500, `${world}/${checkpoint}: geometries ${metrics.renderer.geometries}`);
        assert.ok(metrics.renderer.textures <= 80, `${world}/${checkpoint}: textures ${metrics.renderer.textures}`);
        assert.ok(contact && contact.ok, `${world}/${checkpoint}: ground contact violations ${JSON.stringify(contact?.violations)}`);
        const levels = Object.values(metrics.hybrid.lodLevels);
        if (checkpoint === 'spike-street' || checkpoint === 'spike-night-street') {
          const expectedMax = quality === 'low' ? 1 : 2;
          assert.ok(levels.some((level) => level === expectedMax), `${world}/${checkpoint}: no cluster reached LOD ${expectedMax}: ${levels.join(',')}`);
        } else {
          assert.ok(levels.every((level) => level <= 1), `${world}/${checkpoint}: overview reached LOD 2: ${levels.join(',')}`);
        }
        assert.deepEqual(consoleErrors, [], `${world}/${checkpoint}: console errors ${JSON.stringify(consoleErrors)}`);
        const frame = `${FRAME_DIR}/${world}-${quality}-${checkpoint}.jpg`;
        await page.screenshot({ path: frame, type: 'jpeg', quality: 84 });
        results.push({
          world,
          quality,
          checkpoint,
          frame,
          calls: metrics.renderer.calls,
          triangles: metrics.renderer.triangles,
          primaryTriangles: metrics.renderer.primaryTriangles,
          primaryCalls: metrics.renderer.primaryCalls,
          programs: metrics.renderer.programs,
          geometries: metrics.renderer.geometries,
          textures: metrics.renderer.textures,
          hybrid: metrics.hybrid,
          contactChecked: contact.checked,
          lodLevels: metrics.hybrid.lodLevels,
        });
        console.log(`${world.padEnd(14)} ${quality.padEnd(5)} ${checkpoint.padEnd(19)} calls ${String(metrics.renderer.calls).padStart(4)}  tris ${String(metrics.renderer.triangles).padStart(7)}  primary ${String(metrics.renderer.primaryTriangles).padStart(7)}  hybrid tris ${metrics.hybrid.triangles.join('/')}  gen ${metrics.hybrid.generationMs.toFixed(0)} ms  LOD ${levels.join('')}`);
      }
    }
  }
  await writeFile(`${OUT_DIR}/spike-smoke.json`, JSON.stringify({ generatedAt: new Date().toISOString(), bundles, results }, null, 2));
  console.log(`\nbundles: entry ${bundles.entry} B, main ${bundles.main} B, hybrid-spike ${bundles.spike} B`);
  console.log(`frames + summary written to ${OUT_DIR}/`);
} finally {
  await browser?.close();
  if (process.platform !== 'win32' && preview.pid) {
    try { process.kill(-preview.pid, 'SIGTERM'); } catch { /* already gone */ }
  } else {
    preview.kill('SIGTERM');
  }
}
