/**
 * Hybrid spike smoke: renders the Gate 1 frames for both geometry strategies in
 * the real pipeline, checks ground contact, LOD levels and renderer budgets, and
 * writes JPEG frames plus a JSON summary under docs/superpowers/spike/.
 *
 * Usage: npm run build && node scripts/spikeSmoke.mjs
 *   SPIKE_WORLDS=hybrid-direct   SPIKE_QUALITIES=high,low
 *   SPIKE_WORLDS=voxel renders the same frames without the fragment as the visual baseline
 *   (summary goes to spike-smoke-<worlds>.json unless SPIKE_SUMMARY overrides it).
 */
import assert from 'node:assert/strict';
import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { stopPreview } from './previewServer.mjs';
import { releaseLock, verifyBuild } from './buildProvenance.mjs';

const HOST = '127.0.0.1';
const PORT = 4176;
const URL = `http://${HOST}:${PORT}`;
const SEED = 20260722;
const WORLDS = (process.env.SPIKE_WORLDS ?? 'hybrid-direct').split(',').map((s) => s.trim()).filter(Boolean);
const QUALITIES = (process.env.SPIKE_QUALITIES ?? 'high,low').split(',').map((s) => s.trim()).filter(Boolean);
const CHECKPOINTS = ['spike-overview', 'spike-street', 'spike-golden', 'spike-night-street'];
/**
 * Where the evidence goes. Overridable, because a run that certifies a clean tree cannot
 * write into the repository it is certifying: the first file it saves dirties the tree
 * for every run after it. The batch points these at a scratch directory and copies the
 * finished set in afterwards.
 */
const OUT_DIR = process.env.SPIKE_OUT_DIR ?? 'docs/superpowers/spike';
const FRAME_DIR = process.env.SPIKE_FRAME_DIR ?? `${OUT_DIR}/frames`;
/** `frames` renders the Gate 1 kadry; `gate3` proves LOD, semantics and determinism; `materials` runs the LOD x quality material matrix; `postman` frames the postman mid-ride; `all` does all of them. */
const PHASE = process.env.SPIKE_PHASE ?? 'frames';
/** The signed bundle this run measures, verified before the preview server starts. */
const BUILD = verifyBuild();
/** `voxel` renders the same four frames without attaching the fragment, so the spike has a visual baseline. */
const SUMMARY = process.env.SPIKE_SUMMARY
  ?? (WORLDS.join(',') === 'hybrid-direct' ? 'spike-smoke.json' : `spike-smoke-${WORLDS.join('-')}.json`);

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
/**
 * Camera distances for the material matrix, chosen for the level they produce on the
 * facade rather than for round numbers: 300 m is past the LOD 0 exit threshold, 110 m
 * sits inside the 7..9 px/m band where hysteresis holds level 1, and 40 m and 7 m are
 * the working distances of the street camera.
 */
const DISTANCES = [['far', 300], ['band', 110], ['mid', 40], ['near', 7]];
/**
 * LOD 0 measured through the viewport rather than through distance: at 280 px of
 * height every facade of the fragment falls below the 7 px/m exit threshold while
 * still filling the frame. The camera distance is the one to the look point, and the
 * near facades sit closer than that, which is why it takes 110 m and not 55.
 */
const LOD0_LOOK = { viewport: { width: 1440, height: 280 }, distance: 110 };
const LOD0_BOX = { x: 120, y: 0, width: 1100, height: 280 };
/**
 * How much of the product's dusk light the fragment has to add inside its own
 * footprint at LOD 0. Set from measurement, not from taste: as it stands the fragment
 * adds 0.17 of the product's figure -- it draws fewer, larger, glassier windows than
 * a wall of lit voxels -- and with the main glazing moved out of the massing layer,
 * the revision-2 defect, it adds 0.07, the remainder being loggia and door glass that
 * stayed behind. The floor is the geometric mean of the two.
 */
const LOD0_DUSK_FLOOR = 0.11;
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

/** Raw PNG of a region, base64, for comparing two states pixel by pixel. */
async function captureRegion(page, box) {
  return (await page.screenshot({ clip: box, type: 'png' })).toString('base64');
}

/**
 * Pixels that actually changed between two captures of the same region, split by
 * direction. With the camera, the weather and the local lights held still and only
 * the clock moved, the pixels that brighten and warm ARE the lit windows -- which an
 * absolute "warm and bright" count cannot say, because sunlit plaster is warm and
 * bright too.
 */
async function regionDiff(page, before, after) {
  return page.evaluate(async ([a, b]) => {
    const decode = async (base64) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [x, y] = await Promise.all([decode(a), decode(b)]);
    let brighter = 0, warmer = 0, darker = 0, changed = 0, total = 0;
    for (let i = 0; i < x.length; i += 4) {
      total++;
      const l0 = 0.2126 * x[i] + 0.7152 * x[i + 1] + 0.0722 * x[i + 2];
      const l1 = 0.2126 * y[i] + 0.7152 * y[i + 1] + 0.0722 * y[i + 2];
      const warm0 = x[i] - x[i + 2];
      const warm1 = y[i] - y[i + 2];
      if (Math.abs(l1 - l0) > 12) changed++;
      if (l1 - l0 > 25) brighter++;
      if (l0 - l1 > 25) darker++;
      if (l1 - l0 > 20 && warm1 - warm0 > 10) warmer++;
    }
    return { brighter, warmer, darker, changed, total };
  }, [before, after]);
}

/**
 * Per-pixel classification of a region, which a region mean cannot do: lit windows are
 * a few percent of a facade box, so their contribution to a 520x520 average is smaller
 * than the noise from a passing cloud. Counting the pixels that satisfy a predicate
 * measures the thing itself.
 */
async function pixelCounts(page, box) {
  const shot = await page.screenshot({ clip: box, type: 'png' });
  return page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let lit = 0, bright = 0, white = 0, dark = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total++;
      // A lit window: warm (red over blue) and clearly brighter than its wall.
      if (luma > 120 && r > b + 18 && g > b + 6) lit++;
      // A specular highlight or a lamp: bright whatever its hue.
      if (luma > 200) bright++;
      // Snow: bright and neutral.
      if (luma > 175 && Math.max(r, g, b) - Math.min(r, g, b) < 22) white++;
      if (luma < 45) dark++;
    }
    return { lit, bright, white, dark, total };
  }, shot.toString('base64'));
}

/**
 * Dusk warmth inside the fragment's own footprint. Counting warmed pixels over a box
 * cannot answer whether the FRAGMENT lit its windows, because the same box contains
 * the product's blocks in both worlds -- at LOD 0 that was 6415 warmed pixels for the
 * fragment against 7200 for the baseline, and deleting the fragment's glazing
 * entirely moved neither figure.
 *
 * So the footprint is found by differencing the two worlds at the same camera and the
 * same hour: the pixels where they disagree are the fragment and its shadow. Inside
 * that mask, the two dusk transitions are counted separately, and the fragment has to
 * light windows where the product lights its own.
 */
async function fragmentDuskMask(page, shots) {
  return page.evaluate(async ([vDay, vNight, hDay, hNight]) => {
    const decode = async (base64) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [vd, vn, hd, hn] = await Promise.all([decode(vDay), decode(vNight), decode(hDay), decode(hNight)]);
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const warm = (d, i) => d[i] - d[i + 2];
    const lit = (day, night, i) => luma(night, i) - luma(day, i) > 20 && warm(night, i) - warm(day, i) > 10;
    let footprint = 0, fragmentLit = 0, productLit = 0, both = 0;
    let fragmentEnergy = 0, productEnergy = 0;
    for (let i = 0; i < vd.length; i += 4) {
      // The fragment's own pixels: where the two worlds disagree, by day or by night.
      const differs = Math.abs(luma(hn, i) - luma(vn, i)) > 12 || Math.abs(luma(hd, i) - luma(vd, i)) > 12;
      if (!differs) continue;
      footprint++;
      const f = lit(hd, hn, i);
      const p = lit(vd, vn, i);
      if (f) fragmentLit++;
      if (p) productLit++;
      if (f && p) both++;
      // Total brightening, which a per-pixel threshold cannot see: at LOD 0 a window
      // is about one pixel wide, so antialiasing spreads it below any threshold while
      // the light it adds is still there.
      fragmentEnergy += Math.max(0, luma(hn, i) - luma(hd, i));
      productEnergy += Math.max(0, luma(vn, i) - luma(vd, i));
    }
    return {
      footprint, fragmentLit, productLit, both, pixels: vd.length / 4,
      fragmentEnergy: Math.round(fragmentEnergy), productEnergy: Math.round(productEnergy),
    };
  }, shots);
}

/** Place the camera on the fragment facade at a distance, and report what LOD resulted. */
async function lookFromDistance(page, distance) {
  await page.evaluate(({ look, d }) => {
    const [ax, ay, az] = look.at;
    window.__diorama.controls.setLookAt(ax + d * 0.15, ay + d * 0.22, az - d * 0.96, ax, ay, az, false);
  }, { look: FACADE_LOOK, d: distance });
  // The selector may need several steps to get there: each level change costs a
  // 0.25 s cooldown, so six frames after a jump from the street camera it has moved
  // one level, not three. Wait until it stops moving.
  await page.evaluate(async () => {
    const levels = () => Object.values(window.__diorama.getMetrics().hybrid?.lodLevels ?? {}).join('');
    let previous = levels();
    let stable = 0;
    for (let i = 0; i < 180 && stable < 24; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = levels();
      stable = now === previous ? stable + 1 : 0;
      previous = now;
    }
  });
  await settle(page, 3);
  return page.evaluate(() => {
    const m = window.__diorama.getMetrics();
    // The baseline world has no fragment, so there is nothing to report a level for.
    if (!m.hybrid) return { levels: {}, maxLevel: null, pxPerMetre: null, quality: m.quality.level };
    return {
      levels: m.hybrid.lodLevels,
      maxLevel: Math.max(...Object.values(m.hybrid.lodLevels)),
      pxPerMetre: m.hybrid.lodPixelsPerMetre,
      quality: m.quality.level,
    };
  });
}

/**
 * Is the bicycle legible, measured against its own silhouette?
 *
 * The metric this replaces was inflated, and inflated in a way that flattered the answer.
 * It compared a frame with the bicycle to a frame without it and counted only pixels whose
 * luminance moved by more than 0.5 -- so a wheel pixel that is *completely invisible*,
 * identical to the road behind it, never entered the denominator at all. The fraction was
 * therefore "of the pixels where the object already shows, how many show well", which is
 * close to a tautology. It also printed the percentage without ever asserting it.
 *
 * The denominator now comes from an independent mask:
 *
 *   1. the scene is frozen and the postman placed at a fixed position, heading, wheel
 *      angle and limb pose -- the old harness let him ride, which is why the same code
 *      reported anywhere between 43.7 % and 58.4 %;
 *   2. a flat mask pass renders the target group white on black, through the plain
 *      renderer rather than the composer, with an emissive override material, everything
 *      else hidden and the background cleared -- so the mask depends on the geometry
 *      alone, not on the object's colour, the lighting or what is behind it;
 *   3. every mask pixel is then compared between the normal frame with the object and the
 *      normal frame without it, *including the pixels that do not differ at all*;
 *   4. the denominator is the full mask, and the gate -- half the object's own pixels
 *      differing from their background by at least 8/255 -- is a real assertion, per
 *      group, that fails the run.
 *
 * The two-render control stays: the frozen scene must produce byte-identical frames, or
 * the numbers mean nothing.
 */
async function runPostman(page, world) {
  /** Half the object's own pixels must separate from their background. Fixed before measuring. */
  const GATE = 50;
  /** A luminance step of 8/255 is where an edge stops being invisible on a dark ground. */
  const SEPARATION = 8;
  /**
   * Where he stands for every shot, chosen once and hard-coded so the frames are
   * comparable between runs. On the south road, mid-block, clear of the level crossing.
   */
  // y is the walkable surface (GROUND_SURFACE_Y in WorldLayout); the bicycle's group
  // sits on it with its tyres touching.
  const POSE = { x: -29, y: -0.5, z: -45.8, yaw: Math.PI / 2, legs: -0.5, arms: -1.05 };

  await page.goto(`${URL}/?seed=${SEED}&world=${world}&quality=high`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
  await settle(page, 4);
  // Morning: the only window in which he exists at all.
  await page.evaluate(() => window.__diorama.setTime(0.47));
  const found = await page.waitForFunction(() => {
    const bike = window.__diorama.scene.getObjectByName('postman-bike');
    return bike && bike.visible ? true : null;
  }, null, { timeout: 60_000, polling: 100 }).then(() => true);
  await settle(page, 6);

  // Freeze, then place him. Nothing may move between the mask and the two frames.
  await page.evaluate(() => {
    window.__parked = [];
    window.__raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { window.__parked.push(callback); return 0; };
  });
  await page.waitForTimeout(300);

  const placed = await page.evaluate((pose) => {
    const bike = window.__diorama.scene.getObjectByName('postman-bike');
    bike.position.set(pose.x, pose.y, pose.z);
    bike.rotation.set(0, pose.yaw, 0);
    bike.getObjectByName('postman-rider').rotation.z = 0;
    bike.getObjectByName('postman-head').rotation.z = 0;
    bike.getObjectByName('postman-legs').rotation.x = pose.legs;
    bike.getObjectByName('postman-left-arm').rotation.x = pose.arms;
    bike.getObjectByName('postman-right-arm').rotation.x = pose.arms;
    let wheels = 0;
    bike.traverse((node) => {
      if (node.isMesh && node.geometry.type === 'TorusGeometry') { node.rotation.x = 0; wheels += 1; }
    });
    bike.updateMatrixWorld(true);
    return {
      position: [bike.position.x, bike.position.y, bike.position.z],
      yaw: bike.rotation.y,
      wheelsReset: wheels,
    };
  }, POSE);
  assert.equal(placed.wheelsReset, 2, `${world}: expected two wheels to reset, found ${placed.wheelsReset}`);

  /** One composer frame into a named slot, pixels kept in the page. */
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

  /**
   * The mask: the target group rendered flat white on black, geometry only.
   *
   * Through `renderer.render` rather than the composer, because bloom would spread the
   * white past the silhouette and inflate the very denominator this exists to fix.
   */
  const maskOf = async (group) => page.evaluate((which) => {
    const diorama = window.__diorama;
    const scene = diorama.scene;
    const renderer = diorama.renderer;
    const bike = scene.getObjectByName('postman-bike');

    const targets = [];
    bike.traverse((node) => {
      if (!node.isMesh || node.name.startsWith('postman-')) return;
      const isWheel = node.geometry.type === 'TorusGeometry';
      if (which === 'wheels' ? isWheel : !isWheel) targets.push(node);
    });
    const wanted = new Set(targets);

    const hidden = [];
    scene.traverse((node) => {
      if (node.isMesh && !wanted.has(node) && node.visible) { node.visible = false; hidden.push(node); }
    });
    const background = scene.background;
    const environment = scene.environment;
    scene.background = null;
    scene.environment = null;

    const Colour = targets[0].material.color.constructor;
    const previousClear = renderer.getClearColor(new Colour());
    const previousAlpha = renderer.getClearAlpha();
    // Emissive white on a standard material: light-independent, so a tyre in deep shade
    // masks exactly as brightly as one in the sun.
    const flat = new targets[0].material.constructor({
      color: 0x000000, emissive: 0xffffff, emissiveIntensity: 1, fog: false,
    });
    scene.overrideMaterial = flat;
    renderer.setClearColor(0x000000, 1);
    renderer.render(scene, diorama.controls.camera ?? diorama.camera);

    const gl = renderer.domElement;
    const canvas = new OffscreenCanvas(gl.width, gl.height);
    const context = canvas.getContext('2d');
    context.drawImage(gl, 0, 0);
    const data = context.getImageData(0, 0, gl.width, gl.height).data;

    scene.overrideMaterial = null;
    flat.dispose();
    renderer.setClearColor(previousClear, previousAlpha);
    scene.background = background;
    scene.environment = environment;
    for (const node of hidden) node.visible = true;

    window.__masks = window.__masks ?? {};
    window.__masks[which] = data;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 20) pixels += 1;
    }
    return { meshes: targets.length, maskPixels: pixels };
  }, group);

  /** Hide one group, shoot the frame without it, put it back. */
  const shootWithout = async (group, slot) => {
    const hiddenCount = await page.evaluate((which) => {
      const bike = window.__diorama.scene.getObjectByName('postman-bike');
      const off = [];
      bike.traverse((node) => {
        if (!node.isMesh || node.name.startsWith('postman-')) return;
        const isWheel = node.geometry.type === 'TorusGeometry';
        if ((which === 'wheels') === isWheel) { node.visible = false; off.push(node); }
      });
      window.__hiddenGroup = off;
      return off.length;
    }, group);
    await shoot(slot);
    await page.evaluate(() => {
      for (const node of window.__hiddenGroup ?? []) node.visible = true;
      window.__hiddenGroup = [];
    });
    return hiddenCount;
  };

  /** Every mask pixel, including the ones that do not differ at all. */
  const separationOf = async (group, withSlot, withoutSlot) => page.evaluate(([which, a, b, minimum]) => {
    const mask = window.__masks[which];
    const shown = window.__shots[a];
    const gone = window.__shots[b];
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const deltas = [];
    for (let i = 0; i < mask.length; i += 4) {
      if (0.2126 * mask[i] + 0.7152 * mask[i + 1] + 0.0722 * mask[i + 2] <= 20) continue;
      deltas.push(Math.abs(luma(shown, i) - luma(gone, i)));
    }
    if (!deltas.length) return { maskPixels: 0, separatedPercent: 0, medianDelta: 0, invisiblePixels: 0 };
    const sorted = [...deltas].sort((x, y) => x - y);
    const separated = deltas.filter((delta) => delta >= minimum).length;
    return {
      maskPixels: deltas.length,
      separatedPixels: separated,
      separatedPercent: Math.round((separated / deltas.length) * 1000) / 10,
      medianDelta: Math.round(sorted[sorted.length >> 1] * 10) / 10,
      // How much of the object is literally indistinguishable from its background.
      invisiblePixels: deltas.filter((delta) => delta < 1).length,
    };
  }, [group, withSlot, withoutSlot, SEPARATION]);

  const shots = [];
  for (const [name, side, ahead, height, sunlit] of [
    ['postman-side', 8, 0, 1.0, true],
    ['postman-three-quarter', 8, 5, 1.1, true],
    ['postman-in-world', 10, 3.5, 1.6, false],
  ]) {
    const camera = await page.evaluate(({ pose, s, a, h, lit }) => {
      const dz = lit ? -s : s;
      window.__diorama.controls.setLookAt(pose.x + a, pose.y + h + 0.55, pose.z + dz, pose.x, pose.y + h, pose.z, false);
      // The parked loop never calls controls.update(), and that is where camera-controls
      // writes the pose into the camera object.
      window.__diorama.controls.update(0);
      return window.__diorama.cameraPose();
    }, { pose: POSE, s: side, a: ahead, h: height, lit: sunlit });

    const size = await shoot('with');
    await shoot('control');
    const control = await page.evaluate(() => {
      const a = window.__shots.with;
      const b = window.__shots.control;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        const luma = (d) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (Math.abs(luma(b) - luma(a)) > 0.5) changed += 1;
      }
      return changed;
    });

    const legibility = {};
    for (const group of ['wheels', 'frame']) {
      const mask = await maskOf(group);
      const hiddenCount = await shootWithout(group, 'without');
      // The mask pass rendered over the canvas, so the frame with the object is retaken.
      await shoot('with');
      const separation = await separationOf(group, 'with', 'without');
      legibility[group] = { ...mask, hiddenMeshes: hiddenCount, ...separation, gate: GATE, separationThreshold: SEPARATION };
    }

    const frame = `${FRAME_DIR}/${world}-high-${name}.jpg`;
    await page.screenshot({ path: frame, type: 'jpeg', quality: 88 });
    shots.push({ name, frame, camera: camera.position, target: camera.target, canvas: `${size.width}x${size.height}`, controlChangedPixels: control, legibility });

    console.log(
      `${world.padEnd(14)} high  ${name.padEnd(21)} control ${control} px  ` +
      `koło ${legibility.wheels.separatedPercent}% z ${legibility.wheels.maskPixels} px maski (niewidocznych ${legibility.wheels.invisiblePixels})  ` +
      `rama ${legibility.frame.separatedPercent}% z ${legibility.frame.maskPixels} px (niewidocznych ${legibility.frame.invisiblePixels})`
    );

    assert.equal(control, 0, `${world}: the frozen scene moved between two renders (${control} px) in ${name}`);
    for (const group of ['wheels', 'frame']) {
      const value = legibility[group];
      assert.ok(value.maskPixels > 500, `${world}: ${name} ${group} mask is only ${value.maskPixels} px -- the mask pass is wrong`);
      assert.ok(
        value.separatedPercent >= GATE,
        `${world}: ${name} ${group} separates on ${value.separatedPercent}% of its ${value.maskPixels} mask pixels, gate ${GATE}%`
      );
    }
  }

  await page.evaluate(() => {
    window.requestAnimationFrame = window.__raf;
    for (const callback of window.__parked) window.requestAnimationFrame(callback);
    window.__parked = [];
  });
  assert.ok(found, 'the postman never appeared');
  return { world, found, gate: GATE, separationThreshold: SEPARATION, pose: POSE, shots };
}

/**
 * Gate 3, materials half: an LOD x quality matrix under light we control, with the
 * window glass, the cohort rhythm, the snow and the wetness each checked directly
 * rather than inferred from one average.
 *
 * Local lights are held off through the whole matrix, so what the facade shows is the
 * material's own emissive and nothing else, and the gate that holds them off is read
 * back from the scene rather than assumed.
 */
/**
 * The carriage glazing, in the picture rather than in a unit test.
 *
 * Same camera, same weather, same train position by day and by night: the only
 * variable is the clock, which is the whole claim being checked -- daylight glass is
 * dark and takes its brightness from the sky, a lit interior is a night state. The
 * material's own numbers are read off the finished mesh in the same breath as the
 * frame, so a frame that looks right for the wrong reason is still caught.
 */
/**
 * Day and night on the same train, at the same place, at controlled times.
 *
 * Three things had to be separable, and now are: the train's position, the clock, and
 * the lighting's settled state.
 *
 * - **Position** comes from `train.seekRouteProgress` followed by `train.update` with a
 *   zero delta -- which places the cars from `leadT` without advancing anything -- so
 *   the harness no longer waits for the consist to come round a 162.3 m loop while the
 *   clock runs on. That waiting is what left the two frames at t01 0.545 and 0.065 when
 *   0.42 and 0.94 were asked for.
 * - **The clock** is set, allowed to settle, corrected for the drift the settling cost,
 *   and then frozen: with `requestAnimationFrame` parked the frame loop stops, and t01
 *   only advances inside it.
 * - **The lighting** is settled *before* the freeze by waiting for the value the shot is
 *   judged on to stop moving, because DayNightCycle eases its night factor over real
 *   time. The frozen night factor is then handed to `train.update` explicitly, so the
 *   glazing this frame renders is the glazing this clock implies.
 *
 * Weather and camera are set explicitly rather than inherited. Both tolerances are fixed
 * here, before the run.
 */
async function runTrain(page, world) {
  /** 0.001 of a 162.3 m route is 0.16 m; a seek lands exactly, so this is slack, not aim. */
  const PROGRESS_TOLERANCE = 0.001;
  /** 0.002 of a day is under three minutes of diorama time. */
  const T01_TOLERANCE = 0.002;
  /** The route position and camera the product's own `train` checkpoint frames. */
  const TARGET_PROGRESS = 0.68;
  const CAMERA = [52, 18, 23];
  const TARGET = [30, 4, 2];
  /** Fixed, so the carriages' wobble phase is identical in both frames. */
  const FROZEN_ELAPSED = 100;

  const readGlazing = () => page.evaluate(() => {
    // Identified by the parameters this round chose for it, and asserted to be unique.
    // Everything else was tried and does not work in the live scene: the material has
    // no name to spend bundle bytes on; seven materials in the city share the product's
    // unlit window colour (flats, the bus, the shelter); the train's only named part is
    // its bogie, and its carriages are siblings of the bogies rather than parents; and
    // mergeStaticMeshes folds the carriage meshes into `batched-*` meshes -- it reuses
    // the same material object, so what Train.update writes is still what draws, but
    // their node positions are useless for identification. What is unique is the pane
    // itself: a carriage window is a large flat sheet seen side-on, so it was given
    // 0.2 roughness, 0.4 metalness and 1.0 reflectivity, deliberately not the bus's
    // 0.12 and 1.2.
    const hosts = new Map();
    const Vector3 = window.__diorama.scene.position.constructor;
    window.__diorama.scene.updateMatrixWorld(true);
    window.__diorama.scene.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (material.color?.getHex() !== 0x24465f || !material.emissive) continue;
        if (Math.abs(material.roughness - 0.2) > 0.001) continue;
        if (Math.abs(material.metalness - 0.4) > 0.001) continue;
        if (Math.abs((material.envMapIntensity ?? 0) - 1) > 0.001) continue;
        const centre = node.getWorldPosition(new Vector3());
        const list = hosts.get(material) ?? [];
        list.push(`${node.name || node.geometry.type}@${centre.x.toFixed(0)},${centre.z.toFixed(0)}`);
        hosts.set(material, list);
      }
    });
    const luminance = (color) => Math.round((0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) * 1000) / 1000;
    return {
      materials: [...hosts.entries()].map(([material, meshes]) => ({
        meshes,
        colorHex: `#${material.color.getHexString()}`,
        colorLuminance: luminance(material.color),
        emissiveHex: `#${material.emissive.getHexString()}`,
        emissiveLuminance: luminance(material.emissive),
        emissiveIntensity: Math.round(material.emissiveIntensity * 1000) / 1000,
        roughness: material.roughness,
        metalness: material.metalness,
        envMapIntensity: material.envMapIntensity,
      })),
    };
  });

  const shots = [];
  for (const [name, t01] of [['train-day', 0.42], ['train-night', 0.94]]) {
    // No checkpoint: a locked checkpoint zeroes the presentation delta, and the night
    // factor is eased with that delta, so the lighting would never reach the clock.
    await page.goto(`${URL}/?seed=${SEED}&world=${world}&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
    await settle(page, 4);
    await page.evaluate((t) => {
      window.__diorama.setWeather('clear');
      window.__diorama.setTime(t);
    }, t01);

    /**
     * Settle the lighting on the value that actually drives it, then correct the clock
     * for the drift the settling cost.
     *
     * Not the glazing's emissive: that is `min(1, night * 1.4)`, so it saturates at a
     * night factor of 0.714 and reports "settled" while the light is still climbing. A
     * frame taken then was lit at 0.936 of night and looked it. DayNightCycle's own
     * smoothed factor is the thing to wait for.
     */
    const ramp = [];
    const nightRamp = [];
    for (let i = 0; i < 90; i++) {
      const before = await page.evaluate(() => window.__diorama.dayNight.smoothedNight);
      await settle(page, 3);
      const after = await page.evaluate(() => window.__diorama.dayNight.smoothedNight);
      nightRamp.push(Math.round(after * 10000) / 10000);
      ramp.push((await readGlazing()).materials[0]?.emissiveIntensity ?? 0);
      if (i > 0 && Math.abs(after - before) < 0.0005) break;
    }
    const driftedTo = await page.evaluate(() => window.__diorama.getState().t01);
    await page.evaluate((t) => window.__diorama.setTime(t), t01);
    await settle(page, 3);

    // Freeze: from here the clock, the actors and the weather cannot move.
    await page.evaluate(() => {
      window.__parked = [];
      window.__raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => { window.__parked.push(callback); return 0; };
    });
    await page.waitForTimeout(200);

    // Place the train and the camera in the frozen world.
    const placed = await page.evaluate(([progress, elapsed, camera, target]) => {
      const diorama = window.__diorama;
      const night = diorama.dayNight.smoothedNight;
      diorama.train.seekRouteProgress(progress);
      // Zero delta: places the cars from leadT, advances nothing.
      diorama.train.update(0, elapsed, night, 1);
      diorama.controls.setLookAt(camera[0], camera[1], camera[2], target[0], target[1], target[2], false);
      // With the frame loop parked nothing calls controls.update(), and camera-controls
      // only writes the pose into the camera object there -- so setLookAt alone left the
      // camera wherever the director had put it, three metres off.
      diorama.controls.update(0);
      return {
        progress: diorama.train.getRouteProgress(),
        night: Math.round(night * 10000) / 10000,
        t01: diorama.getState().t01,
      };
    }, [TARGET_PROGRESS, FROZEN_ELAPSED, CAMERA, TARGET]);

    const pose = await page.evaluate(() => window.__diorama.cameraPose());
    for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]]) {
      assert.ok(
        Math.abs(pose.position[index] - CAMERA[index]) < 0.01,
        `${world}: the ${name} camera drifted on ${axis}: ${pose.position[index]} vs ${CAMERA[index]}`
      );
    }

    await page.evaluate(() => window.__diorama.renderFrame());
    const frame = `${FRAME_DIR}/${world}-high-${name}.jpg`;
    await page.screenshot({ path: frame, type: 'jpeg', quality: 88 });
    const reading = await readGlazing();
    const glazing = reading.materials;
    await page.evaluate(() => {
      window.requestAnimationFrame = window.__raf;
      for (const callback of window.__parked) window.requestAnimationFrame(callback);
      window.__parked = [];
    });

    const progressError = Math.abs(((placed.progress - TARGET_PROGRESS) % 1 + 1.5) % 1 - 0.5);
    const t01Error = Math.abs(((placed.t01 - t01) % 1 + 1.5) % 1 - 0.5);
    shots.push({
      name,
      requestedT01: t01,
      shotAtT01: Math.round(placed.t01 * 100000) / 100000,
      t01Error: Math.round(t01Error * 100000) / 100000,
      t01Tolerance: T01_TOLERANCE,
      clockDriftDuringSettle: Math.round((driftedTo - t01) * 100000) / 100000,
      nightFactorAtShot: placed.night,
      requestedProgress: TARGET_PROGRESS,
      shotAtProgress: Math.round(placed.progress * 100000) / 100000,
      progressError: Math.round(progressError * 100000) / 100000,
      progressErrorMetres: Math.round(progressError * 162.3 * 1000) / 1000,
      progressTolerance: PROGRESS_TOLERANCE,
      weather: 'clear',
      camera: CAMERA,
      target: TARGET,
      frozenElapsed: FROZEN_ELAPSED,
      frame,
      settledAfterReads: ramp.length,
      glazingRamp: ramp,
      nightFactorRamp: nightRamp,
      glazing,
    });
    console.log(
      `${world.padEnd(14)} high  ${name.padEnd(12)} t01 ${placed.t01.toFixed(4)} (asked ${t01}, err ${t01Error.toFixed(5)})  ` +
      `night ${placed.night}  progress ${placed.progress.toFixed(5)} (err ${(progressError * 162.3).toFixed(3)} m)  ` +
      `${glazing.map((g) => `pane ${g.colorHex} L${g.colorLuminance} emissive ${g.emissiveHex} x${g.emissiveIntensity}`).join(' | ') || 'GLAZING NOT FOUND'}`
    );
    assert.equal(glazing.length, 1, `${world}: expected exactly one train glazing material, found ${glazing.length}`);
    assert.ok(t01Error < T01_TOLERANCE, `${world}: ${name} shot at t01 ${placed.t01}, asked ${t01}, tolerance ${T01_TOLERANCE}`);
    assert.ok(progressError < PROGRESS_TOLERANCE, `${world}: ${name} shot ${progressError * 162.3} m from the target position`);
  }

  const [day, night] = shots;
  const between = Math.abs(day.shotAtProgress - night.shotAtProgress);
  console.log(`${' '.repeat(21)}day and night: ${(between * 162.3).toFixed(3)} m apart, clocks ${day.shotAtT01} and ${night.shotAtT01}`);
  assert.ok(between < PROGRESS_TOLERANCE, `train day and night were shot ${(between * 162.3).toFixed(3)} m apart`);
  assert.ok(day.nightFactorAtShot < 0.01, `the day frame's night factor is ${day.nightFactorAtShot}`);
  assert.ok(night.nightFactorAtShot > 0.99, `the night frame's night factor is ${night.nightFactorAtShot}`);
  assert.ok(day.glazing[0].emissiveIntensity < 0.05, `train glass glows by day (${day.glazing[0].emissiveIntensity})`);
  assert.ok(night.glazing[0].emissiveIntensity > 0.9, `train interior stays dark at night (${night.glazing[0].emissiveIntensity})`);
  assert.ok(night.glazing[0].colorLuminance < 0.2, 'the night pane itself has to stay dark');
  return {
    world,
    routeLengthM: 162.3,
    progressTolerance: PROGRESS_TOLERANCE,
    t01Tolerance: T01_TOLERANCE,
    shots,
  };
}

async function runMaterials(page, worlds) {
  const report = { worlds: {} };
  for (const world of worlds) {
    const errors = [];
    const onError = (message) => { if (message.type() === 'error') errors.push(message.text()); };
    page.on('console', onError);
    const entry = { matrix: [], windows: [], lod0: null, cohorts: null, effects: [] };

    for (const quality of ['high', 'low']) {
      await openHybrid(page, world, quality, 'spike-street', true);
      // Controlled light: no street lamps, no bus or train headlamps, for the whole
      // matrix, verified in the scene and not just requested.
      await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(false));
      await settle(page, 4);
      const litLamps = await page.evaluate(() => (() => {
      let n = 0;
      window.__diorama.scene.traverse((node) => {
        if ((node.isPointLight || node.isSpotLight) && node.visible && node.intensity > 0) n += 1;
      });
      return n;
    })());
      assert.equal(litLamps, 0, `${world}/${quality}: local lights still on for the material matrix`);

      for (const [label, distance] of DISTANCES) {
        const placed = await lookFromDistance(page, distance);
        const shots = {};
        for (const [phase, t01] of [['day', 0.5], ['night', 0.94]]) {
          await page.evaluate((t) => window.__diorama.setTime(t), t01);
          await settle(page, 6);
          const after = await page.evaluate(() => (() => {
      let n = 0;
      window.__diorama.scene.traverse((node) => {
        if ((node.isPointLight || node.isSpotLight) && node.visible && node.intensity > 0) n += 1;
      });
      return n;
    })());
          assert.equal(after, 0, `${world}/${quality}/${label}/${phase}: local lights came back mid-matrix`);
          shots[phase] = await captureRegion(page, FRAGMENT_BOX);
          entry.matrix.push({
            quality,
            distance: label,
            lod: placed.levels['building-3'],
            levels: placed.levels,
            phase,
            t01,
            pixels: await pixelCounts(page, FRAGMENT_BOX),
          });
        }
        // The window rhythm itself: what dusk changed on this facade, at this level.
        const windows = await regionDiff(page, shots.day, shots.night);
        entry.windows.push({ quality, distance: label, lod: placed.levels['building-3'], windows });
      }
      await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(true));
    }

    // --- Windows: dusk has to light glass at every level and every quality. The
    // measure is the pixels that brightened AND warmed between the two clock
    // settings, with nothing else touched, so plaster in sunlight cannot count.
    // The floor is 60 warmed pixels: at 300 m the whole fragment covers about
    // 30 000 pixels of the box, so this only demands that the rhythm be visible
    // at all, not that it hit a particular figure.
    for (const row of entry.windows) {
      assert.ok(
        row.windows.warmer > 60,
        `${world}: ${row.quality}/${row.distance} (LOD ${row.lod}) lit only ${row.windows.warmer} window pixels at dusk`
      );
    }
    // ...and Low must be the same material, not a cheaper one: at the same distance
    // the two qualities have to agree on the glass to within a factor of three.
    for (const [label] of DISTANCES) {
      const high = entry.windows.find((r) => r.quality === 'high' && r.distance === label);
      const low = entry.windows.find((r) => r.quality === 'low' && r.distance === label);
      const ratio = high.windows.warmer / Math.max(1, low.windows.warmer);
      assert.ok(
        ratio > 0.33 && ratio < 3,
        `${world}: ${label} dusk glass high ${high.windows.warmer} vs low ${low.windows.warmer} (ratio ${ratio.toFixed(2)})`
      );
    }
    // ...and LOD 0 has to carry glazing at all: this is the level that shipped empty
    // in revision 2, when the massing layer had no windows in it. At the distance
    // that produces LOD 0 the facade box also contains the product's own buildings,
    // so an absolute count cannot answer this -- 826 warm pixels at 300 m were mostly
    // blocks outside the fragment. The reference is the same camera and the same two
    // clock settings in the voxel world, where those blocks are the product's own
    // lit-window voxels: the fragment has to light up like them, not merely light up.
    const farLevels = entry.windows.filter((r) => r.distance === 'far');
    for (const row of farLevels) {
      assert.equal(row.lod, 0, `${world}: ${row.quality}/far never reached LOD 0 (was ${row.lod})`);
    }
    // Pixels per metre is viewport height over distance, so a short viewport reaches
    // LOD 0 without moving the camera 300 m away, and the fragment still fills the
    // frame instead of being a smudge among the product's own blocks. That is what
    // makes this measurable at all: at 300 m the same count was 824 for the fragment
    // and 827 for the product, because neither number was about the fragment.
    const duskShotsAt = async (openWorld) => {
      await openHybrid(page, openWorld, 'high', 'spike-street', true);
      await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(false));
      await settle(page, 4);
      const placed = await lookFromDistance(page, LOD0_LOOK.distance);
      const shots = [];
      for (const t01 of [0.5, 0.94]) {
        await page.evaluate((t) => window.__diorama.setTime(t), t01);
        await settle(page, 6);
        shots.push(await captureRegion(page, LOD0_BOX));
      }
      return { placed, shots };
    };
    await page.setViewportSize(LOD0_LOOK.viewport);
    const baseline = await duskShotsAt('voxel');
    const fragment = await duskShotsAt(world);
    const mask = await fragmentDuskMask(page, [...baseline.shots, ...fragment.shots]);
    await page.setViewportSize({ width: 1440, height: 900 });
    entry.lod0 = { viewport: LOD0_LOOK.viewport, distance: LOD0_LOOK.distance, mask, levels: fragment.placed.levels };
    const facadeLevels = Object.entries(fragment.placed.levels).filter(([key]) => key.startsWith('building-'));
    assert.ok(
      facadeLevels.every(([, level]) => level === 0),
      `${world}: the short viewport did not put every facade on LOD 0 (levels ${JSON.stringify(fragment.placed.levels)}, `
      + `px/m ${JSON.stringify(fragment.placed.pxPerMetre)})`
    );
    assert.ok(mask.footprint > 5_000, `${world}: the two worlds differ on only ${mask.footprint} pixels, nothing to compare`);
    // Three tenths of the product's figure is the floor: the fragment draws fewer and
    // larger windows than the voxel city, so parity is not expected -- what is being
    // ruled out is the glazing disappearing with the detail layers, as it did in
    // revision 2, where LOD 0 was massing with no windows in it at all.
    // The measure is the light dusk adds inside that footprint, not the count of
    // pixels that clear a threshold: at LOD 0 a window is about a pixel wide, so
    // antialiasing dilutes each one below any per-pixel test while the light it adds
    // remains. The two worlds put their windows in different places -- the fragment
    // draws fewer and larger ones -- so this compares totals, not pixels.
    const ratio = mask.fragmentEnergy / Math.max(1, mask.productEnergy);
    assert.ok(
      ratio > LOD0_DUSK_FLOOR,
      `${world}: inside its own footprint the fragment adds ${mask.fragmentEnergy} of dusk light at LOD 0 `
      + `against the product's ${mask.productEnergy} (ratio ${ratio.toFixed(2)}, footprint ${mask.footprint} px, `
      + `lit pixels ${mask.fragmentLit} vs ${mask.productLit})`
    );
    // ...and the LOD cap has to be real: Low may not reach the top level.
    // Levels across every cluster, because the cap is global, not per facade.
    const allLevels = (quality) => entry.matrix
      .filter((r) => r.quality === quality)
      .flatMap((r) => Object.values(r.levels));
    const lowLevels = allLevels('low');
    const highLevels = allLevels('high');
    assert.ok(Math.max(...lowLevels) <= 1, `${world}: Low reached LOD ${Math.max(...lowLevels)}`);
    assert.equal(Math.max(...highLevels), 2, `${world}: High never reached LOD 2`);

    // --- Cohorts: the five window groups wake and sleep at different hours, so the
    // lit-pixel count has to follow the activity the scene itself reports.
    await openHybrid(page, world, 'high', 'spike-street', true);
    await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(false));
    await lookFromDistance(page, 24);
    const cohortSamples = [];
    const cohortShots = {};
    for (const t01 of [0.5, 0.86, 0.94, 0.05]) {
      await page.evaluate((t) => window.__diorama.setTime(t), t01);
      await settle(page, 6);
      const state = await sceneState(page);
      const activity = state.voxelWindows.reduce((sum, entry2) => sum + entry2.activity, 0);
      cohortShots[t01] = await captureRegion(page, FRAGMENT_BOX);
      cohortSamples.push({ t01, activity, perCohort: state.voxelWindows, pixels: await pixelCounts(page, FRAGMENT_BOX) });
    }
    // Two night hours where the rhythm reports different cohorts awake: 20:38 has all
    // five lit, 01:12 has two of them dark. Both are night, so the difference on the
    // facade is the cohorts going out and not the sky changing colour.
    const lateNight = await regionDiff(page, cohortShots[0.86], cohortShots[0.05]);
    entry.cohorts = { samples: cohortSamples, lateNight };
    const ordered = [...cohortSamples].sort((a, b) => a.activity - b.activity);
    const quietest = ordered[0];
    const busiest = ordered[ordered.length - 1];
    assert.ok(
      busiest.activity > quietest.activity + 0.3,
      `${world}: cohort activity never varies (${quietest.activity.toFixed(2)}..${busiest.activity.toFixed(2)})`
    );
    assert.ok(
      busiest.pixels.lit > quietest.pixels.lit,
      `${world}: cohort activity ${quietest.activity.toFixed(2)}->${busiest.activity.toFixed(2)} did not change the glass `
      + `(${quietest.pixels.lit} -> ${busiest.pixels.lit} lit pixels)`
    );
    const awakeAt = (t01) => cohortSamples.find((sample) => sample.t01 === t01);
    assert.ok(
      awakeAt(0.86).activity > awakeAt(0.05).activity,
      `${world}: the rhythm claims no cohort sleeps between 20:38 and 01:12`
    );
    assert.ok(
      lateNight.darker > 200,
      `${world}: ${awakeAt(0.86).activity} cohorts awake at 20:38 and ${awakeAt(0.05).activity} at 01:12, `
      + `but only ${lateNight.darker} facade pixels went dark`
    );
    // The cohorts are five distinct groups, not one switch: at some hour they disagree.
    const spread = Math.max(...cohortSamples.map((sample) => {
      const values = sample.perCohort.map((c) => c.activity);
      return Math.max(...values) - Math.min(...values);
    }));
    assert.ok(spread > 0.15, `${world}: all cohorts move together (max spread ${spread.toFixed(3)})`);

    // --- Snow and wetness, in every combination that exists: both qualities, day and
    // night. They used to be measured once, at High, at noon, which left the case the
    // diorama is actually judged on -- wet asphalt at night -- untested.
    for (const quality of ['high', 'low']) {
      await openHybrid(page, world, quality, 'spike-street', true);
      await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(false));
      await lookFromDistance(page, 24);
      for (const [phase, t01] of [['day', 0.5], ['night', 0.94]]) {
        await page.evaluate((t) => window.__diorama.setTime(t), t01);
        await settle(page, 6);
        const dry = await pixelCounts(page, GROUND_BOX);
        await page.evaluate(() => window.__diorama.setWeather('snow'));
        await page.waitForTimeout(4_000);
        await settle(page, 6);
        const snowy = await pixelCounts(page, GROUND_BOX);
        await page.evaluate(() => window.__diorama.clearWeather());
        await page.waitForTimeout(1_500);
        await page.evaluate(() => window.__diorama.setWeather('rain'));
        await page.waitForTimeout(6_000);
        await settle(page, 6);
        const wet = await pixelCounts(page, GROUND_BOX);
        const rain = (await sceneState(page)).rain;
        await page.evaluate(() => window.__diorama.clearWeather());
        await page.waitForTimeout(1_500);
        entry.effects.push({ quality, phase, t01, dry, snowy, wet, rain });

        // Snow whitens the ground; at night there is less light to whiten, so the floor
        // is a fraction of the dry figure rather than a fixed count.
        assert.ok(
          snowy.white > dry.white * 1.2 + 200,
          `${world}: ${quality}/${phase} snow added only ${snowy.white - dry.white} white ground pixels `
          + `(dry ${dry.white}, snowy ${snowy.white})`
        );
        assert.ok(rain > 0.2, `${world}: ${quality}/${phase} rain intensity only ${rain}`);
        // Wetness darkens the road and sharpens what it reflects, so either the dark or
        // the bright count has to move. Thresholds scale with the ground box's pixels.
        const moved = Math.abs(wet.dark - dry.dark) + Math.abs(wet.bright - dry.bright);
        assert.ok(
          moved > wet.total * 0.01,
          `${world}: ${quality}/${phase} rain moved only ${moved} of ${wet.total} ground pixels `
          + `(dark ${dry.dark}->${wet.dark}, bright ${dry.bright}->${wet.bright})`
        );
      }
      await page.evaluate(() => window.__diorama.debugSetLocalLightsEnabled(true));
    }

    assert.deepEqual(errors, [], `${world}: materials console errors ${JSON.stringify(errors)}`);
    page.off('console', onError);
    report.worlds[world] = entry;
    const nightRow = entry.matrix.filter((r) => r.phase === 'night').map((r) => `${r.quality[0]}${r.distance[0]}:L${r.lod}=${r.pixels.lit}`).join(' ');
    const effectRow = entry.effects.map((e) => `${e.quality[0]}${e.phase[0]} snow ${e.dry.white}->${e.snowy.white} wet ${e.dry.dark}->${e.wet.dark}`).join('  ');
    console.log(`${world.padEnd(14)} materials  ${nightRow}\n               LOD0 dusk light ${entry.lod0.mask.fragmentEnergy} vs product ${entry.lod0.mask.productEnergy} (${entry.lod0.mask.fragmentLit}/${entry.lod0.mask.productLit} px in ${entry.lod0.mask.footprint})  cohorts ${lateNight.darker} px dark at 01:12\n               ${effectRow}`);
  }
  return report;
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
        return { triangles: h.triangles, bytes: h.bytes, lodLevels: h.lodLevels };
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
  detached: true,
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

  for (const world of ['gate3', 'materials', 'postman', 'train'].includes(PHASE) ? [] : WORLDS) {
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
        // Two more frames from the same load, so the set the fragment is judged on
        // includes the cameras a visitor actually rides: the bus and the guided tour.
        // They come from the live cameras, not from a checkpoint, so they are only
        // taken once per world at High.
        if (quality === 'high' && checkpoint === 'spike-street') {
          // 'b' is the bus camera; the guided tour is started from its own HUD button,
          // not from a key -- 't' is the train camera, which is a different shot.
          for (const [name, act] of [
            ['bus-camera', async () => page.keyboard.press('b')],
            ['tour-camera', async () => page.evaluate(() => document.getElementById('tour-button').click())],
          ]) {
            await page.evaluate(() => window.__diorama.releaseCheckpoint());
            await act();
            await settle(page, 8);
            await page.waitForTimeout(2_000);
            const mode = await page.evaluate(() => ({
              camera: window.__diorama.getState().cameraMode,
              automation: window.__diorama.getState().cameraAutomation,
              chapter: window.__diorama.getState().tourChapter,
            }));
            const extra = `${FRAME_DIR}/${world}-high-${name}.jpg`;
            await page.screenshot({ path: extra, type: 'jpeg', quality: 84 });
            results.push({ world, quality, checkpoint: name, cameraMode: mode, frame: extra });
            console.log(`${world.padEnd(14)} high  ${name.padEnd(19)} camera ${mode.camera}/${mode.automation}${mode.chapter ? ` chapter ${mode.chapter}` : ''}`);
          }
        }
        const hybridColumns = hybrid
          ? `hybrid tris ${metrics.hybrid.triangles.join('/')}  gen ${metrics.hybrid.generationMs.toFixed(0)} ms  LOD ${levels.join('')}`
          : 'baseline, no fragment attached';
        console.log(`${world.padEnd(14)} ${quality.padEnd(5)} ${checkpoint.padEnd(19)} calls ${String(metrics.renderer.calls).padStart(4)}  tris ${String(metrics.renderer.triangles).padStart(7)}  primary ${String(metrics.renderer.primaryTriangles).padStart(7)}  ${hybridColumns}`);
      }
    }
  }
  const hybridWorlds = WORLDS.filter((w) => w !== 'voxel');
  const semantics = PHASE === 'gate3' || PHASE === 'all' ? await runGate3(page, hybridWorlds) : null;
  if (semantics) {
    await writeFile(`${OUT_DIR}/spike-semantics.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...semantics }, null, 2));
    console.log(`gate 3 evidence written to ${OUT_DIR}/spike-semantics.json`);
  }
  const postman = PHASE === 'postman' || PHASE === 'all'
    ? await runPostman(page, hybridWorlds[0] ?? WORLDS[0])
    : null;
  if (postman) {
    await writeFile(`${OUT_DIR}/spike-postman.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...BUILD, ...postman }, null, 2));
    console.log(`postman frames written to ${FRAME_DIR}/`);
  }
  const train = PHASE === 'train' || PHASE === 'all' ? await runTrain(page, hybridWorlds[0] ?? 'voxel') : null;
  if (train) {
    await writeFile(`${OUT_DIR}/spike-train.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...BUILD, ...train }, null, 2));
    console.log(`train frames written to ${FRAME_DIR}/`);
  }
  const materials = PHASE === 'materials' || PHASE === 'all' ? await runMaterials(page, hybridWorlds) : null;
  if (materials) {
    await writeFile(`${OUT_DIR}/spike-materials.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...BUILD, ...materials }, null, 2));
    console.log(`material matrix written to ${OUT_DIR}/spike-materials.json`);
  }
  if (results.length === 0) {
    console.log('frames phase skipped');
  } else await writeFile(`${OUT_DIR}/${SUMMARY}`, JSON.stringify({ generatedAt: new Date().toISOString(), ...BUILD, bundles, results }, null, 2));
  console.log(`\nbundles: entry ${bundles.entry} B, main ${bundles.main} B, hybrid-spike ${bundles.spike} B`);
  if (results.length > 0) console.log(`frames + ${SUMMARY} written to ${OUT_DIR}/`);
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
