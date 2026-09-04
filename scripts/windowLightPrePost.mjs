/**
 * The window-pool light budget, before and after, in the picture.
 *
 * The earlier comparison was not a comparison. After the profile change the renderer
 * naturally runs fourteen physical lights, so setting a cap of 16 and a cap of 14 asked
 * for the same scene twice and produced a 0.00 % difference by construction -- it never
 * rendered the two window-pool lights the change removed.
 *
 * This harness reconstructs both configurations explicitly:
 *
 *   baseline  `DayNightCycle.windowLightBudget = 2` -- the two window pools the profile
 *             used to allow, lit by the runtime itself with the intensity and distance
 *             it computes from the clock and the residential activity curve.
 *   adopted   the same two lights withdrawn exactly as `windowLightBudget = 0` withdraws
 *             them (`visible = false`, `intensity = 0`).
 *
 * Everything else is held bit-identical, and that is proved rather than asserted: the
 * animation loop is parked, the scene is rendered on demand with delta 0, and the same
 * frame is rendered twice before anything changes. That control has to come out at 0
 * changed pixels, or the shot's numbers mean nothing.
 *
 * The two lights are not guessed at either. They are identified differentially: the set
 * of visible local lights at budget 0 subtracted from the set at budget 2.
 *
 * Every shot writes both frames, the SHA-256 of each frame's PNG bytes, the recorded
 * runtime state of the two lights, and the raw diff -- not a summary retyped by hand.
 *
 * Usage: node scripts/windowLightPrePost.mjs
 *   PREPOST_WORLD=hybrid-direct PREPOST_OUT=docs/superpowers/spike/frames
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { stopPreview } from './previewServer.mjs';
import { releaseLock, verifyBuild } from './buildProvenance.mjs';

const PORT = Number(process.env.PREPOST_PORT ?? 4221);
const URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.PREPOST_OUT ?? 'docs/superpowers/spike/frames';
const SUMMARY = process.env.PREPOST_SUMMARY
  ?? `docs/superpowers/spike/light-budget-pre-post-${process.env.PREPOST_VARIANT ?? 'windowLights'}.json`;
const WORLD = process.env.PREPOST_WORLD ?? 'hybrid-direct';
const SEED = 20260722;
/**
 * Which budget is being compared, and what the configuration before the change was.
 *
 *   windowLights  the adopted change: the High profile went from two physical window
 *                 pools to none.
 *   streetLamps   the alternative that was rejected on the frames: six street lamps
 *                 down to four. It is measured here too, because the reason for
 *                 rejecting it was resting on an older number with no revision stamp,
 *                 and an unattributed number cannot be quoted in a source comment.
 */
const VARIANTS = {
  windowLights: { field: 'windowLightBudget', baseline: 2, adopted: 0 },
  streetLamps: { field: 'streetLightBudget', baseline: 6, adopted: 4 },
};
const VARIANT = process.env.PREPOST_VARIANT ?? 'windowLights';
const { field: BUDGET_FIELD, baseline: BASELINE_BUDGET, adopted: ADOPTED_BUDGET } =
  VARIANTS[VARIANT] ?? (() => { throw new Error(`unknown variant ${VARIANT}`); })();


/**
 * Five frames. Four are cameras that could see a window pool; the fifth is the wide
 * orbit an ordinary visitor sits in, which is in the set precisely because the runtime
 * forces this budget to zero past 112 m of focus distance -- so the change *cannot*
 * show there, and the frame is the evidence for that rather than an omission.
 */
const SHOTS = [
  { name: 'night-street', checkpoint: 'spike-night-street', camera: null },
  { name: 'near-facade', checkpoint: 'spike-night-street', camera: 'facade' },
  { name: 'stop-and-bus', checkpoint: 'spike-night-street', camera: 'stop' },
  { name: 'train', checkpoint: 'night-snow-train', camera: null },
  { name: 'free-exploration', checkpoint: 'spike-night-street', camera: 'wide' },
];

const LIGHT_STATE = () => {
  const lights = [];
  window.__diorama.scene.traverse((node) => {
    if (node.isPointLight || node.isSpotLight) lights.push(node);
  });
  return lights.map((light, index) => ({
    index,
    kind: light.isSpotLight ? 'spot' : 'point',
    visible: light.visible,
    intensity: Math.round(light.intensity * 1000) / 1000,
    distance: light.distance,
    color: `#${light.color.getHexString()}`,
    position: (() => {
      const world = light.getWorldPosition(new light.position.constructor());
      return [world.x, world.y, world.z].map((v) => Math.round(v * 100) / 100);
    })(),
  }));
};

const BUILD = verifyBuild();

const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
);
const waitForServer = async () => {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(URL)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('preview did not start');
};
const settle = async (page, frames = 4) => {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await page.waitForTimeout(150);
};

let browser;
const report = {
  recordedAt: new Date().toISOString(),
  ...BUILD,
  question: 'What do the two window-pool lights the High profile gave up actually change in the picture?',
  method: {
    variant: VARIANT,
    baseline: `DayNightCycle.${BUDGET_FIELD} = ${BASELINE_BUDGET}, lit by the runtime`,
    adopted: `the lights that budget adds, withdrawn exactly as ${BUDGET_FIELD} = ${ADOPTED_BUDGET} withdraws them`,
    held: ['seed', 'checkpoint (clock, weather and actors frozen by it)', 'camera', 'viewport', 'device scale', 'quality profile High'],
    frozen: 'requestAnimationFrame parked; renderFrame() with delta 0; the same frame rendered twice as a control',
    identification: 'differential: visible local lights at budget 2 minus visible local lights at budget 0',
    note: 'past 112 m of camera focus distance the runtime forces the window-pool budget to 0 (DayNightCycle.setCameraFocusDistance), so a wide frame cannot show a difference for that variant',
  },
  world: WORLD,
  variant: VARIANT,
  budgetField: BUDGET_FIELD,
  shots: [],
};

try {
  await waitForServer();
  await mkdir(OUT_DIR, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  for (const shot of SHOTS) {
    await page.goto(`${URL}/?seed=${SEED}&world=${WORLD}&checkpoint=${shot.checkpoint}&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
    await settle(page, 6);

    // The two lights, identified by what turning the budget on adds to the visible set.
    const identify = async () => page.evaluate(async (wanted) => {
      const dayNight = window.__diorama.dayNight;
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const visibleSet = () => {
        const on = [];
        let index = 0;
        window.__diorama.scene.traverse((node) => {
          if (!node.isPointLight && !node.isSpotLight) return;
          if (node.visible) on.push(index);
          index++;
        });
        return on;
      };
      const lightsOf = () => {
        const all = [];
        window.__diorama.scene.traverse((node) => {
          if (node.isPointLight || node.isSpotLight) all.push(node);
        });
        return all;
      };
      dayNight[wanted.field] = wanted.adopted;
      for (let i = 0; i < 4; i++) await frame();
      const off = new Set(lightsOf().filter((light) => light.visible));
      dayNight[wanted.field] = wanted.baseline;
      for (let i = 0; i < 4; i++) await frame();
      // Object identity, not an index into a traversal: the traversal order is stable
      // but nothing guarantees it, and an index that slips points the withdrawal at a
      // light that was already dark -- which looks exactly like "the change does
      // nothing".
      const added = lightsOf().filter((light) => light.visible && !off.has(light));
      window.__windowLightsUnderTest = added;
      return {
        visibleAtAdoptedBudget: off.size,
        visibleAtBaselineBudget: off.size + added.length,
        added: added.map((light) => ({
          kind: light.isSpotLight ? 'spot' : 'point',
          intensity: Math.round(light.intensity * 1000) / 1000,
          distance: light.distance,
          color: `#${light.color.getHexString()}`,
          position: (() => {
            const world = light.getWorldPosition(new light.position.constructor());
            return [world.x, world.y, world.z].map((v) => Math.round(v * 100) / 100);
          })(),
        })),
      };
    }, { field: BUDGET_FIELD, baseline: BASELINE_BUDGET, adopted: ADOPTED_BUDGET });
    // First pass at the checkpoint's own camera: the facade shot needs to know where the
    // lights are before it can aim at one of them.
    const atCheckpointCamera = await identify();

    // Camera, after the budget is live so the focus distance the runtime sees is the
    // one this frame is shot at.
    if (shot.camera) {
      await page.evaluate((which) => {
        const diorama = window.__diorama;
        const scene = diorama.scene;
        const Vector3 = scene.position.constructor;
        if (which === 'wide') {
          diorama.controls.setLookAt(150, 95, 150, 0, 0, 0, false);
          return;
        }
        if (which === 'stop') {
          const shelter = [];
          scene.traverse((node) => { if (/shelter|bus-passenger/.test(node.name)) shelter.push(node.getWorldPosition(new Vector3())); });
          const target = shelter[0] ?? new Vector3(-11, 0, 28);
          diorama.controls.setLookAt(target.x + 9, target.y + 5, target.z + 11, target.x, target.y + 1.4, target.z, false);
          return;
        }
        // The facade the lights under test actually stand against -- the first of the
        // two the budget adds, by identity. Aiming at "a light with distance 20" found
        // some other member of the dark pool and framed a facade nothing was lit on.
        const under = window.__windowLightsUnderTest ?? [];
        const near = under.length
          ? under[0].getWorldPosition(new Vector3())
          : new Vector3(0, 6, 0);
        diorama.controls.setLookAt(near.x + 13, near.y + 5, near.z + 13, near.x, near.y - 1, near.z, false);
      }, shot.camera);
      await settle(page, 6);
    }
    // Second pass, at the camera this frame is actually shot from. Past 112 m of focus
    // distance the runtime forces the budget to zero, so at a wide camera this pass
    // finds nothing to withdraw -- which is the answer for that frame, not a fault.
    const withdrawn = await identify();

    const lightsBefore = await page.evaluate(LIGHT_STATE);
    const focusDistance = await page.evaluate(() => {
      const diorama = window.__diorama;
      const target = diorama.cameraPose ? diorama.cameraPose() : null;
      return target ? Math.round(target.distance * 10) / 10 : null;
    });

    // Freeze: nothing may move between the two variants.
    await page.evaluate(() => {
      window.__parked = [];
      window.__raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => { window.__parked.push(callback); return 0; };
    });
    await page.waitForTimeout(300);

    const shoot = async (slot) => page.evaluate((into) => {
      window.__diorama.renderFrame();
      const gl = window.__diorama.renderer.domElement;
      const canvas = new OffscreenCanvas(gl.width, gl.height);
      const context = canvas.getContext('2d');
      context.drawImage(gl, 0, 0);
      window.__shots = window.__shots ?? {};
      window.__shots[into] = context.getImageData(0, 0, gl.width, gl.height).data;
      return { width: gl.width, height: gl.height };
    }, slot);
    await page.evaluate(() => {
      window.__hashOf = async (slot) => {
        const digest = await crypto.subtle.digest('SHA-256', window.__shots[slot]);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      };
    });
    const diffOf = async (a, b) => page.evaluate(([first, second]) => {
      const before = window.__shots[first];
      const after = window.__shots[second];
      const width = window.__diorama.renderer.domElement.width;
      const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      let changed = 0;
      let sum = 0;
      let peak = 0;
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (let i = 0; i < after.length; i += 4) {
        const delta = Math.abs(luma(after, i) - luma(before, i));
        sum += delta;
        if (delta > peak) peak = delta;
        if (delta > 6) {
          changed += 1;
          const pixel = i / 4;
          const x = pixel % width;
          const y = (pixel - x) / width;
          if (x < bounds.minX) bounds.minX = x;
          if (x > bounds.maxX) bounds.maxX = x;
          if (y < bounds.minY) bounds.minY = y;
          if (y > bounds.maxY) bounds.maxY = y;
        }
      }
      const pixels = after.length / 4;
      return {
        pixels,
        changedPixels: changed,
        changedPercent: Math.round((changed / pixels) * 10000) / 100,
        meanDelta: Math.round((sum / pixels) * 1000) / 1000,
        peakDelta: Math.round(peak),
        changedBounds: changed ? bounds : null,
      };
    }, [a, b]);

    const size = await shoot('baseline');
    // Hash the pixels that were compared, not the page. A page screenshot includes the
    // DOM HUD, whose clock text advances in real time even while the render loop is
    // parked -- which made two identical frames hash differently.
    const baselineHash = await page.evaluate((slot) => window.__hashOf(slot), 'baseline');
    const baselinePng = await page.screenshot({ type: 'png' });
    const control = await shoot('control');
    void control;
    const controlDiff = await diffOf('baseline', 'control');

    // The adopted configuration: exactly what windowLightBudget = 0 does to these two.
    const removed = await page.evaluate(() => {
      const state = [];
      for (const light of window.__windowLightsUnderTest ?? []) {
        state.push({
          wasVisible: light.visible,
          intensity: Math.round(light.intensity * 1000) / 1000,
          distance: light.distance,
        });
        light.visible = false;
        light.intensity = 0;
      }
      return state;
    });
    await shoot('adopted');
    const adoptedHash = await page.evaluate((slot) => window.__hashOf(slot), 'adopted');
    const adoptedPng = await page.screenshot({ type: 'png' });
    const diff = await diffOf('baseline', 'adopted');

    await page.evaluate(() => {
      window.requestAnimationFrame = window.__raf;
      for (const callback of window.__parked) window.requestAnimationFrame(callback);
      window.__parked = [];
    });

    const baseName = `${WORLD}-high-prepost-${VARIANT}-${shot.name}`;
    await writeFile(`${OUT_DIR}/${baseName}-baseline.png`, baselinePng);
    await writeFile(`${OUT_DIR}/${baseName}-adopted.png`, adoptedPng);

    const record = {
      ...shot,
      canvas: `${size.width}x${size.height}`,
      cameraFocusDistanceM: focusDistance,
      wideViewForcesBudgetToZero: focusDistance !== null && focusDistance > 112,
      windowLightsUnderTestAtCheckpointCamera: atCheckpointCamera,
      windowLightsUnderTest: withdrawn,
      withdrawnRuntimeState: removed,
      lightsVisibleInBaseline: lightsBefore.filter((light) => light.visible).length,
      frames: {
        baseline: {
          file: `${baseName}-baseline.png`,
          renderedPixelsSha256: baselineHash,
          pageScreenshotSha256: createHash('sha256').update(baselinePng).digest('hex'),
        },
        adopted: {
          file: `${baseName}-adopted.png`,
          renderedPixelsSha256: adoptedHash,
          pageScreenshotSha256: createHash('sha256').update(adoptedPng).digest('hex'),
        },
      },
      controlDiff,
      diff,
    };
    report.shots.push(record);

    console.log(
      `${shot.name.padEnd(17)} focus ${String(focusDistance).padStart(6)} m  ` +
      `lights ${withdrawn.visibleAtAdoptedBudget} -> ${withdrawn.visibleAtBaselineBudget} ` +
      `[${withdrawn.added.map((light) => `${light.kind} I=${light.intensity} d=${light.distance} @${light.position.join(',')}`).join('; ')}]  ` +
      `control ${controlDiff.changedPixels} px  ` +
      `changed ${diff.changedPixels} px (${diff.changedPercent} %) mean ${diff.meanDelta} peak ${diff.peakDelta}`
    );
    assert.equal(
      controlDiff.changedPixels,
      0,
      `${shot.name}: the frozen scene moved between two identical renders (${controlDiff.changedPixels} px), so this shot proves nothing`
    );
    // A shot with nothing to withdraw is the wide-view case, and there the two frames
    // *must* be identical: the runtime already forces this budget to zero past 112 m.
    // Anywhere else, identical frames would mean the baseline never rendered the lights.
    record.changeObservable = diff.changedPixels > 0;
    if (withdrawn.added.length === 0) {
      // The wide-view case: the runtime already forces this budget to zero past 112 m,
      // so there is nothing to withdraw and the two frames must be identical.
      assert.equal(
        record.frames.baseline.renderedPixelsSha256,
        record.frames.adopted.renderedPixelsSha256,
        `${shot.name}: no window light was withdrawn, yet the rendered pixels differ`
      );
      assert.ok(
        record.wideViewForcesBudgetToZero,
        `${shot.name}: no window light to withdraw at ${focusDistance} m focus, inside the 112 m wide-view threshold -- unexplained`
      );
    } else if (shot.camera === 'facade') {
      // This is the shot aimed at one of the two lights by identity, so here the
      // difference has to appear. If it does not, the reconstruction is broken and no
      // other shot's zero means anything.
      assert.ok(
        diff.changedPixels > 0,
        `${shot.name}: aimed at the light under test and nothing changed -- the baseline never rendered it`
      );
    }
  }

  await writeFile(SUMMARY, JSON.stringify(report, null, 2));
  console.log(`\nframes in ${OUT_DIR}/, raw diffs and hashes in ${SUMMARY}`);
  assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
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
