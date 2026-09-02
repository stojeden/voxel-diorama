/**
 * Hybrid spike smoke: renders the Gate 1 frames for both geometry strategies in
 * the real pipeline, checks ground contact, LOD levels and renderer budgets, and
 * writes JPEG frames plus a JSON summary under docs/superpowers/spike/.
 *
 * Usage: npm run build && node scripts/spikeSmoke.mjs
 *   SPIKE_WORLDS=hybrid-direct,hybrid-greedy   SPIKE_QUALITIES=high,low
 *   SPIKE_WORLDS=voxel renders the same frames without the fragment as the visual baseline
 *   (summary goes to spike-smoke-<worlds>.json unless SPIKE_SUMMARY overrides it).
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
/** `frames` renders the Gate 1 kadry; `gate3` proves LOD, semantics and determinism; `all` does both. */
const PHASE = process.env.SPIKE_PHASE ?? 'frames';
/** `voxel` renders the same four frames without attaching the fragment, so the spike has a visual baseline. */
const SUMMARY = process.env.SPIKE_SUMMARY
  ?? (WORLDS.join(',') === 'hybrid-direct,hybrid-greedy' ? 'spike-smoke.json' : `spike-smoke-${WORLDS.join('-')}.json`);

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

/**
 * Gate 3: screen-space LOD with hysteresis, additive layers, and identical
 * semantics (cohorts, themes, snow, wet, seed) at every level.
 *
 * The fragment's own triangle counts per layer are constant — the LOD only flips
 * layer visibility — so additivity is measured on the frame: at a fixed camera,
 * a higher level must draw strictly more triangles and never fewer.
 */
const FACADE_LOOK = { from: [3.0, 1.7, 26.0], at: [1.0, 3.0, 31.5] };
/** Screen box over the fragment's facades in the street shot, for pixel statistics. */
const FRAGMENT_BOX = { x: 40, y: 90, width: 520, height: 520 };
/** Screen box over the fragment's pavement, kerb and crosswalk — the wet-reactive surfaces. */
const GROUND_BOX = { x: 60, y: 640, width: 900, height: 200 };

async function settle(page, frames = 3) {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await page.waitForTimeout(120);
}

async function regionMean(page, box) {
  const shot = await page.screenshot({ clip: box, type: 'png' });
  // Average the raw PNG bytes' luminance via the browser, which already has a decoder.
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const n = data.length / 4;
    return { r: r / n, g: g / n, b: b / n, luma: (0.2126 * r + 0.7152 * g + 0.0722 * b) / n };
  }, shot.toString('base64'));
}

async function openHybrid(page, world, quality, checkpoint, release = false) {
  await page.goto(`${URL}/?seed=${SEED}&world=${world}&checkpoint=${checkpoint}&quality=${quality}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
  // A frozen checkpoint pins the camera, so the LOD sweep has to let go of it first.
  if (release) await page.evaluate(() => window.__diorama.releaseCheckpoint());
  await settle(page);
}

/** What the scene believes about itself, so the recorded pixel means are self-verifying. */
async function sceneState(page) {
  return page.evaluate(() => {
    const s = window.__diorama.getState();
    const rhythm = window.__diorama.windowRhythm();
    const byCohort = new Map();
    for (const entry of rhythm) byCohort.set(entry.cohort, entry);
    return {
      t01: s.t01,
      theme: s.theme,
      weather: s.weather,
      rain: s.rain,
      voxelWindows: [...byCohort.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cohort, entry]) => ({ cohort, activity: entry.activity, emissiveIntensity: entry.material?.emissiveIntensity ?? entry.emissiveIntensity })),
    };
  });
}

async function runGate3(page, worlds) {
  const report = { worlds: {} };
  for (const world of worlds) {
    const errors = [];
    const onError = (message) => { if (message.type() === 'error') errors.push(message.text()); };
    page.on('console', onError);
    const entry = { approach: [], hysteresis: null, levels: {}, semantics: {}, determinism: null };

    // --- LOD: walk the camera in along one line and record the level per cluster.
    await openHybrid(page, world, 'high', 'spike-street', true);
    for (const distance of [300, 220, 165, 120, 90, 70, 55, 42, 32, 24, 18, 13, 9, 6, 4]) {
      // Back off along a rising ray so the eye never sinks below the ground plane.
      await page.evaluate(({ look, d }) => {
        const [ax, ay, az] = look.at;
        window.__diorama.controls.setLookAt(ax + d * 0.15, ay + d * 0.22, az - d * 0.96, ax, ay, az, false);
      }, { look: FACADE_LOOK, d: distance });
      await settle(page, 6);
      const sample = await page.evaluate(() => {
        const m = window.__diorama.getMetrics();
        return {
          levels: m.hybrid.lodLevels,
          pxPerMetre: m.hybrid.lodPixelsPerMetre,
          triangles: m.renderer.triangles,
          calls: m.renderer.calls,
        };
      });
      entry.approach.push({ distance, ...sample });
    }

    // --- Hysteresis: sit on a threshold and confirm the level settles instead of flapping.
    const flips = await page.evaluate(async () => {
      const seen = [];
      for (let i = 0; i < 90; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        seen.push(Object.values(window.__diorama.getMetrics().hybrid.lodLevels).join(''));
      }
      let changes = 0;
      for (let i = 1; i < seen.length; i++) if (seen[i] !== seen[i - 1]) changes++;
      return { changes, first: seen[0], last: seen[seen.length - 1] };
    });
    entry.hysteresis = flips;

    // --- Additive layers: same camera, quality caps maxLevel, so triangles must grow with level.
    for (const quality of ['low', 'high']) {
      await openHybrid(page, world, quality, 'spike-street', true);
      await page.evaluate((look) => window.__diorama.controls.setLookAt(...look.from, ...look.at, false), FACADE_LOOK);
      await settle(page, 6);
      const sample = await page.evaluate(() => {
        const m = window.__diorama.getMetrics();
        return { levels: m.hybrid.lodLevels, triangles: m.renderer.triangles, hybridTriangles: m.hybrid.triangles };
      });
      entry.levels[quality] = { ...sample, mean: await regionMean(page, FRAGMENT_BOX) };
    }

    // --- Semantics: time of day, themes, snow and wet must all take effect on the fragment.
    // Every sample is measured against a reference taken immediately before it, in the
    // same session, so a delta cannot be manufactured by unrelated drift.
    const sample = async () => ({
      facade: await regionMean(page, FRAGMENT_BOX),
      ground: await regionMean(page, GROUND_BOX),
      state: await sceneState(page),
    });
    const reference = async () => {
      await page.evaluate(() => {
        window.__diorama.applyTheme('classic');
        window.__diorama.debugSetSnowCover(0);
        window.__diorama.clearWeather();
        window.__diorama.setWeather('clear');
        window.__diorama.setTime(0.5);
      });
      await settle(page, 30);
      return sample();
    };

    await openHybrid(page, world, 'high', 'spike-street');
    entry.semantics.reference = await reference();
    for (const t01 of [0.05, 0.2, 0.28, 0.35, 0.5, 0.78, 0.9]) {
      await page.evaluate((t) => window.__diorama.setTime(t), t01);
      await settle(page, 4);
      entry.semantics[`t${t01}`] = await sample();
    }
    for (const theme of ['retro', 'cyberpunk']) {
      entry.semantics[`ref-theme-${theme}`] = await reference();
      await page.evaluate((id) => window.__diorama.applyTheme(id), theme);
      await settle(page, 30);
      entry.semantics[`theme-${theme}`] = await sample();
      await page.screenshot({ path: `${FRAME_DIR}/${world}-gate3-theme-${theme}.jpg`, type: 'jpeg', quality: 84 });
    }
    entry.semantics['ref-snow'] = await reference();
    await page.evaluate(() => window.__diorama.debugSetSnowCover(1));
    await settle(page, 30);
    entry.semantics.snow = await sample();
    await page.screenshot({ path: `${FRAME_DIR}/${world}-gate3-snow.jpg`, type: 'jpeg', quality: 84 });
    entry.semantics['ref-rain'] = await reference();
    await page.evaluate(() => window.__diorama.setWeather('rain'));
    // Wetness ramps over seconds, not frames; rain intensity reaching 1 is not enough.
    await page.waitForTimeout(4_000);
    await settle(page, 30);
    entry.semantics.rain = await sample();
    await page.screenshot({ path: `${FRAME_DIR}/${world}-gate3-rain.jpg`, type: 'jpeg', quality: 84 });
    await page.evaluate(() => window.__diorama.clearWeather());

    // --- Determinism: two fresh loads of the same seed build byte-identical geometry.
    const runs = [];
    for (let i = 0; i < 2; i++) {
      await openHybrid(page, world, 'high', 'spike-street');
      runs.push(await page.evaluate(() => {
        const h = window.__diorama.getMetrics().hybrid;
        return { triangles: h.triangles, bytes: h.bytes, dilated: h.dilated, lodLevels: h.lodLevels };
      }));
    }
    entry.determinism = { runs, identical: JSON.stringify(runs[0]) === JSON.stringify(runs[1]) };

    page.off('console', onError);
    entry.consoleErrors = errors;
    report.worlds[world] = entry;

    // --- Assertions.
    const levelsOf = (sample) => Object.values(sample.levels);
    // The sweep walks toward the fragment, which moves the camera *away* from the two
    // dominants, so monotonicity is asserted against each cluster's own pixels-per-metre
    // — the actual LOD input — not against the sweep parameter.
    const clusterIds = Object.keys(entry.approach[0].levels);
    for (const id of clusterIds) {
      const samples = entry.approach
        .map((sample) => ({ px: sample.pxPerMetre[id], level: sample.levels[id] }))
        .sort((a, b) => a.px - b.px);
      for (let i = 1; i < samples.length; i++) {
        assert.ok(
          samples[i].level >= samples[i - 1].level,
          `${world}: ${id} fell to LOD ${samples[i].level} at ${samples[i].px.toFixed(1)} px/m after LOD ${samples[i - 1].level} at ${samples[i - 1].px.toFixed(1)} px/m`
        );
      }
      // Levels must bracket the documented thresholds: never 0 far above enter1,
      // never 2 far below enter2.
      for (const sample of samples) {
        if (sample.px > 12) assert.ok(sample.level >= 1, `${world}: ${id} still LOD 0 at ${sample.px.toFixed(1)} px/m`);
        if (sample.px < 25) assert.ok(sample.level <= 1, `${world}: ${id} already LOD 2 at ${sample.px.toFixed(1)} px/m`);
      }
    }
    const near = levelsOf(entry.approach.at(-1));
    assert.ok(near.some((l) => l === 2), `${world}: no cluster reached LOD 2 from ${entry.approach.at(-1).distance} m`);
    const anyZero = entry.approach.some((sample) => levelsOf(sample).some((l) => l === 0));
    assert.ok(anyZero, `${world}: the sweep never observed LOD 0, so the far end is untested`);
    assert.ok(entry.hysteresis.changes <= 1, `${world}: LOD flapped ${entry.hysteresis.changes} times at a fixed camera`);
    assert.ok(
      entry.levels.high.triangles > entry.levels.low.triangles,
      `${world}: LOD 2 drew ${entry.levels.high.triangles} triangles, LOD 1 drew ${entry.levels.low.triangles}`
    );
    // Layer 2 is pure detail and quality-independent; layers 0 and 1 legitimately
    // shrink on Low because the dominants swap to their Low variants.
    assert.equal(
      entry.levels.high.hybridTriangles[2],
      entry.levels.low.hybridTriangles[2],
      `${world}: the detail layer changed size between qualities`
    );
    for (const layer of [0, 1]) {
      assert.ok(
        entry.levels.low.hybridTriangles[layer] <= entry.levels.high.hybridTriangles[layer],
        `${world}: Low grew layer ${layer}`
      );
    }
    // Each effect is compared with its own reference, on the surfaces it is supposed to
    // touch: themes and cohorts on the facades, snow and wet on the ground.
    const spread = (a, b) => Math.abs(a.luma - b.luma) + Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
    const checks = [
      ['theme-retro', 'ref-theme-retro', 'facade', 4],
      ['theme-cyberpunk', 'ref-theme-cyberpunk', 'facade', 20],
      ['snow', 'ref-snow', 'ground', 4],
      ['rain', 'ref-rain', 'ground', 4],
      ['t0.9', 'reference', 'facade', 20],
    ];
    for (const [key, refKey, surface, minimum] of checks) {
      const delta = spread(entry.semantics[key][surface], entry.semantics[refKey][surface]);
      assert.ok(
        delta > minimum,
        `${world}: ${key} moved the ${surface} by only ${delta.toFixed(2)} (needed > ${minimum})`
      );
    }
    assert.ok(entry.determinism.identical, `${world}: two runs of one seed differ: ${JSON.stringify(runs)}`);
    assert.deepEqual(errors, [], `${world}: gate 3 console errors ${JSON.stringify(errors)}`);
    console.log(
      `${world.padEnd(14)} gate3  LOD ${entry.approach.map((a) => levelsOf(a).join('')).join(' ')}\n`
      + `               flaps ${entry.hysteresis.changes}  tris L1 ${entry.levels.low.triangles} < L2 ${entry.levels.high.triangles}  deterministic ${entry.determinism.identical}`
    );
  }
  return report;
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

  for (const world of PHASE === 'gate3' ? [] : WORLDS) {
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
          contact: window.__diorama.hybridGroundContact?.() ?? null,
        }));
        const { metrics, state, contact } = sample;
        const hybrid = world !== 'voxel';
        assert.equal(state.world, world, `${world}/${checkpoint}: world flag not applied`);
        assert.equal(state.checkpoint?.id, checkpoint, `${world}/${checkpoint}: checkpoint not applied`);
        assert.equal(metrics.quality.level, quality, `${world}/${checkpoint}: quality ${metrics.quality.level}`);
        assert.ok(!/swiftshader|software|llvmpipe/i.test(metrics.renderer.gpu), `software renderer: ${metrics.renderer.gpu}`);
        assert.ok(metrics.renderer.calls <= 1_400, `${world}/${checkpoint}: draw calls ${metrics.renderer.calls}`);
        assert.ok(metrics.renderer.geometries <= 500, `${world}/${checkpoint}: geometries ${metrics.renderer.geometries}`);
        assert.ok(metrics.renderer.textures <= 80, `${world}/${checkpoint}: textures ${metrics.renderer.textures}`);
        let levels = [];
        if (hybrid) {
          assert.ok(metrics.hybrid, `${world}/${checkpoint}: hybrid metrics missing`);
          assert.equal(metrics.hybrid.strategy, world.replace('hybrid-', ''));
          assert.ok(contact && contact.ok, `${world}/${checkpoint}: ground contact violations ${JSON.stringify(contact?.violations)}`);
          levels = Object.values(metrics.hybrid.lodLevels);
          if (checkpoint === 'spike-street' || checkpoint === 'spike-night-street') {
            const expectedMax = quality === 'low' ? 1 : 2;
            assert.ok(levels.some((level) => level === expectedMax), `${world}/${checkpoint}: no cluster reached LOD ${expectedMax}: ${levels.join(',')}`);
          } else {
            assert.ok(levels.every((level) => level <= 1), `${world}/${checkpoint}: overview reached LOD 2: ${levels.join(',')}`);
          }
        } else {
          assert.ok(!metrics.hybrid, `${world}/${checkpoint}: hybrid attached in the baseline world`);
          assert.ok(!contact, `${world}/${checkpoint}: ground contact reported without a fragment`);
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
          hybrid: metrics.hybrid ?? null,
          contactChecked: contact?.checked ?? 0,
          lodLevels: metrics.hybrid?.lodLevels ?? null,
        });
        const hybridColumns = hybrid
          ? `hybrid tris ${metrics.hybrid.triangles.join('/')}  gen ${metrics.hybrid.generationMs.toFixed(0)} ms  LOD ${levels.join('')}`
          : 'baseline, no fragment attached';
        console.log(`${world.padEnd(14)} ${quality.padEnd(5)} ${checkpoint.padEnd(19)} calls ${String(metrics.renderer.calls).padStart(4)}  tris ${String(metrics.renderer.triangles).padStart(7)}  primary ${String(metrics.renderer.primaryTriangles).padStart(7)}  ${hybridColumns}`);
      }
    }
  }
  const semantics = PHASE === 'frames' ? null : await runGate3(page, WORLDS.filter((w) => w !== 'voxel'));
  if (semantics) {
    await writeFile(`${OUT_DIR}/spike-semantics.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...semantics }, null, 2));
    console.log(`gate 3 evidence written to ${OUT_DIR}/spike-semantics.json`);
  }
  if (results.length === 0) {
    console.log('frames phase skipped');
  } else await writeFile(`${OUT_DIR}/${SUMMARY}`, JSON.stringify({ generatedAt: new Date().toISOString(), bundles, results }, null, 2));
  console.log(`\nbundles: entry ${bundles.entry} B, main ${bundles.main} B, hybrid-spike ${bundles.spike} B`);
  if (results.length > 0) console.log(`frames + ${SUMMARY} written to ${OUT_DIR}/`);
} finally {
  await browser?.close();
  if (process.platform !== 'win32' && preview.pid) {
    try { process.kill(-preview.pid, 'SIGTERM'); } catch { /* already gone */ }
  } else {
    preview.kill('SIGTERM');
  }
}
