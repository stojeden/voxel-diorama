/**
 * What a physical local light costs, measured rather than divided.
 *
 * The previous answer -- "0.71 ms per light" -- came from two data points, sixteen
 * lights and none, with the difference divided by sixteen. The variants labelled "8
 * lights" and "4 lights" had not reduced anything: they set `intensity = 0`, and
 * three.js compiles the *count* of visible lights into the shader, so the fragment
 * shader still looped sixteen times per pixel and the frame cost exactly the same.
 *
 * This measures real counts: 16, 12, 8, 4 and 0 lights actually visible to the
 * renderer, so the shader is recompiled for each and the light list it loops over
 * really shrinks. What is deliberately NOT touched is the lamps themselves -- the
 * emissive shades and window materials stay exactly as they are, so a variant with
 * four physical lights still shows sixteen lit lamps and the comparison is about
 * shading cost, not about deleting objects from the image.
 *
 * How the count is held down, without changing the application: `DayNightCycle`
 * reassigns `visible` on every local light every frame, so a one-shot change is undone
 * immediately. The harness therefore wraps `renderer.render` and re-applies the cap
 * immediately before each draw, which is also exactly when three.js collects its light
 * list. Lights are ranked deterministically (type, name, position) so the same lights
 * survive in every run.
 *
 * Conditions held identical across every measurement: seed, checkpoint, camera,
 * quality profile (High, pixel ratio 1.15), directional light, SSAO, postprocessing,
 * viewport and device scale factor. Vsync is off, because with it a frame time is
 * quantised to multiples of 16.7 ms and a marginal cost of a millisecond is invisible.
 * Both worlds are measured in one browser session, alternating, and the variant order
 * is run in three arrangements: given, reverse and a deterministic shuffle.
 *
 * Usage: node scripts/lightCostExperiment.mjs
 *   LIGHT_OUT=docs/superpowers/spike/light-cost-experiment.json
 *   LIGHT_CAPS=16,12,8,4,0   LIGHT_ORDERS=given,reverse,shuffle
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { chromium } from 'playwright';

const PORT = Number(process.env.LIGHT_PORT ?? 4211);
const URL = `http://127.0.0.1:${PORT}`;
const OUT = process.env.LIGHT_OUT ?? 'docs/superpowers/spike/light-cost-experiment.json';
const SEED = 20260722;
const CHECKPOINT = 'spike-night-street';
const QUALITY = 'high';
const WORLDS = ['voxel', 'hybrid-direct'];
const CAPS = (process.env.LIGHT_CAPS ?? '16,12,8,4,0').split(',').map(Number);
const ORDERS = (process.env.LIGHT_ORDERS ?? 'given,reverse,shuffle').split(',');
const VIEWPORT = { width: 1440, height: 900 };
const DEVICE_SCALE = 2;
/** Frames rendered after a cap change before anything is measured, for the recompile. */
const WARMUP_FRAMES = 45;
const MEASURE_SECONDS = 3;

const orderCaps = (order) => {
  if (order === 'given') return [...CAPS];
  if (order === 'reverse') return [...CAPS].reverse();
  if (order === 'shuffle') {
    const out = [...CAPS];
    let state = SEED >>> 0;
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
  throw new Error(`unknown order ${order}`);
};

/** Installed once per page: a cap re-applied immediately before every draw. */
const INSTALL_CAP = () => {
  const renderer = window.__diorama.renderer;
  if (window.__lightCap !== undefined) return 'already';
  window.__lightCap = null;
  window.__lightRank = () => {
    const lights = [];
    window.__diorama.scene.traverse((node) => {
      if (node.isPointLight || node.isSpotLight) lights.push(node);
    });
    // Deterministic ranking: the same lights survive a cap in every run, so a variant
    // is reproducible and does not flicker between two sets of lamps.
    lights.sort((a, b) => {
      const key = (light) => [
        light.isSpotLight ? 'spot' : 'point',
        light.name || '',
        light.position.x.toFixed(2),
        light.position.y.toFixed(2),
        light.position.z.toFixed(2),
      ].join('|');
      return key(a) < key(b) ? -1 : 1;
    });
    return lights;
  };
  const original = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    if (window.__lightCap !== null) {
      const lights = window.__lightRank();
      let kept = 0;
      for (const light of lights) {
        // Lights the day cycle has already switched off stay off; the cap only ever
        // removes, never adds, so a night scene loses exactly the lamps beyond it.
        if (!light.visible) continue;
        if (kept < window.__lightCap) kept += 1;
        else light.visible = false;
      }
    }
    original(scene, camera);
  };
  return 'installed';
};

const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
const waitForServer = async () => {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(URL)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('preview did not start');
};

const machine = () => ({ loadAverage: loadavg().map((value) => Math.round(value * 100) / 100) });

let browser;
const rows = [];
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--use-angle=metal',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // Cost, not compliance: with vsync a marginal millisecond is invisible.
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
    ],
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  for (const order of ORDERS) {
    const caps = orderCaps(order);
    for (const [index, cap] of caps.entries()) {
      // Alternate which world goes first, so neither always pays for being second.
      const worlds = index % 2 === 0 ? WORLDS : [...WORLDS].reverse();
      for (const world of worlds) {
        consoleErrors.length = 0;
        await page.goto(`${URL}/?seed=${SEED}&world=${world}&checkpoint=${CHECKPOINT}&quality=${QUALITY}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
        assert.equal(await page.evaluate(INSTALL_CAP), 'installed');
        await page.waitForTimeout(1_200);

        const before = await page.evaluate(() => {
          const lights = window.__lightRank();
          return { total: lights.length, visible: lights.filter((light) => light.visible).length };
        });

        // Apply the cap, then let the shader recompile and settle before timing.
        await page.evaluate((value) => { window.__lightCap = value; }, cap);
        await page.evaluate(async (frames) => {
          for (let i = 0; i < frames; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
        }, WARMUP_FRAMES);
        await page.waitForTimeout(600);

        const sample = await page.evaluate(async (seconds) => {
          const lights = window.__lightRank();
          const visibleBefore = lights.filter((light) => light.visible).length;
          const deltas = [];
          let previous = 0;
          const deadline = performance.now() + seconds * 1000;
          await new Promise((resolve) => {
            const step = (now) => {
              if (previous > 0) deltas.push(now - previous);
              previous = now;
              if (now >= deadline) resolve();
              else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          deltas.sort((a, b) => a - b);
          const at = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))];
          const metrics = window.__diorama.getMetrics();
          const after = window.__lightRank();
          return {
            frames: deltas.length,
            frameMs: deltas.reduce((total, value) => total + value, 0) / deltas.length,
            medianMs: at(0.5),
            p95Ms: at(0.95),
            minMs: deltas[0],
            maxMs: deltas[deltas.length - 1],
            visibleLightsBefore: visibleBefore,
            visibleLightsAfter: after.filter((light) => light.visible).length,
            programs: metrics.renderer.programs,
            calls: metrics.renderer.calls,
            triangles: metrics.renderer.triangles,
            pixelRatio: metrics.renderer.pixelRatio,
            canvas: `${metrics.renderer.canvasWidth}x${metrics.renderer.canvasHeight}`,
            megapixels: (metrics.renderer.canvasWidth * metrics.renderer.canvasHeight) / 1e6,
            quality: metrics.quality.level,
            checkpoint: window.__diorama.getState().checkpoint?.id ?? null,
            world: window.__diorama.getState().world,
          };
        }, MEASURE_SECONDS);

        // The cap has to have taken effect, and it must not have been undone during the
        // window by the day cycle reassigning `visible`.
        assert.equal(sample.visibleLightsBefore, Math.min(cap, before.visible),
          `${world} cap ${cap}: ${sample.visibleLightsBefore} lights visible before the window`);
        assert.equal(sample.visibleLightsAfter, Math.min(cap, before.visible),
          `${world} cap ${cap}: ${sample.visibleLightsAfter} lights visible after the window`);
        assert.equal(sample.quality, QUALITY, `${world} cap ${cap}: quality drifted`);
        assert.equal(sample.checkpoint, CHECKPOINT, `${world} cap ${cap}: checkpoint drifted`);
        assert.ok(Math.abs(sample.pixelRatio - 1.15) < 1e-6, `${world} cap ${cap}: pixel ratio ${sample.pixelRatio}`);
        assert.deepEqual(consoleErrors, [], `${world} cap ${cap}: console errors ${JSON.stringify(consoleErrors)}`);

        rows.push({ order, cap, world, uncappedLights: before.visible, machine: machine(), ...sample });
        console.log(
          `${order.padEnd(8)} cap ${String(cap).padStart(2)} ${world.padEnd(14)}`
          + `${sample.frameMs.toFixed(2)} ms/frame (median ${sample.medianMs.toFixed(2)}, p95 ${sample.p95Ms.toFixed(2)})  `
          + `lights ${sample.visibleLightsAfter}/${before.visible}  programs ${sample.programs}  calls ${sample.calls}  `
          + `${sample.canvas}  load ${machine().loadAverage[0]}`
        );
      }
    }
  }

  /** Median of the raw samples for one world and cap, across the order variants. */
  const medianFor = (world, cap) => {
    const values = rows.filter((row) => row.world === world && row.cap === cap).map((row) => row.frameMs).sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  const summary = {};
  for (const world of WORLDS) {
    const byCap = Object.fromEntries(CAPS.map((cap) => [cap, {
      samples: rows.filter((row) => row.world === world && row.cap === cap).map((row) => Math.round(row.frameMs * 1000) / 1000),
      medianMs: Math.round(medianFor(world, cap) * 1000) / 1000,
    }]));
    const steps = [];
    for (let i = 0; i < CAPS.length - 1; i++) {
      const from = CAPS[i];
      const to = CAPS[i + 1];
      const delta = medianFor(world, from) - medianFor(world, to);
      steps.push({
        from,
        to,
        lightsRemoved: from - to,
        savedMs: Math.round(delta * 1000) / 1000,
        perLightMs: Math.round((delta / (from - to)) * 1000) / 1000,
      });
    }
    summary[world] = { byCap, marginal: steps };
  }

  await writeFile(OUT, JSON.stringify({
    recordedAt: new Date().toISOString(),
    question: 'What does one physical local light cost, and is the cost linear in the count?',
    method: {
      vsync: 'disabled: a marginal millisecond is invisible under a 16.7 ms quantum',
      lightControl: 'renderer.render wrapped to re-apply a deterministic cap immediately before each draw, because DayNightCycle reassigns visible every frame',
      lampsUntouched: 'emissive shades and window materials are not changed: a capped variant still shows every lamp lit',
      held: ['seed', 'checkpoint', 'camera', 'quality profile High', 'pixel ratio 1.15', 'directional light', 'SSAO', 'postprocessing', 'viewport', 'deviceScaleFactor'],
      worlds: 'both in one browser session, alternating which goes first',
      orders: ORDERS,
      warmupFrames: WARMUP_FRAMES,
      measureSeconds: MEASURE_SECONDS,
      samplesPerVariant: ORDERS.length,
    },
    caps: CAPS,
    rows,
    summary,
  }, null, 2));
  console.log(`\nraw samples and marginal costs written to ${OUT}`);
  for (const world of WORLDS) {
    console.log(`${world}: ${summary[world].marginal.map((step) => `${step.from}->${step.to} ${step.savedMs.toFixed(2)} ms (${step.perLightMs.toFixed(2)}/light)`).join('  ')}`);
  }
} finally {
  await browser?.close();
  try {
    if (preview?.pid && process.platform !== 'win32') process.kill(-preview.pid, 'SIGTERM');
    else preview?.kill('SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
