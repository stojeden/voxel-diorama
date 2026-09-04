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

const HOST = '127.0.0.1';
const PORT = 4176;
const URL = `http://${HOST}:${PORT}`;
const SEED = 20260722;
const WORLDS = (process.env.SPIKE_WORLDS ?? 'hybrid-direct').split(',').map((s) => s.trim()).filter(Boolean);
const QUALITIES = (process.env.SPIKE_QUALITIES ?? 'high,low').split(',').map((s) => s.trim()).filter(Boolean);
const CHECKPOINTS = ['spike-overview', 'spike-street', 'spike-golden', 'spike-night-street'];
const OUT_DIR = 'docs/superpowers/spike';
const FRAME_DIR = `${OUT_DIR}/frames`;
/** `frames` renders the Gate 1 kadry; `gate3` proves LOD, semantics and determinism; `materials` runs the LOD x quality material matrix; `postman` frames the postman mid-ride; `all` does all of them. */
const PHASE = process.env.SPIKE_PHASE ?? 'frames';
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
 * The postman, in a frame. He rides at dawn on the south road, checkpoints freeze
 * actors, and there is no free-camera hook, so the previous round verified him by
 * measurement alone. The camera can be placed through `controls.setLookAt` and the
 * scene walked through `window.__diorama.scene`, so this phase runs the live
 * simulation, waits for him to appear, and aims at where he actually is.
 */
async function runPostman(page, world) {
  await page.goto(`${URL}/?seed=${SEED}&world=${world}&quality=high`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
  // 11:17, near the end of his round, because that is where the light is: at 07:12 and
  // even at 08:40 the south road is in shadow and his dark tyres disappear into it, so
  // a frame meant to judge geometry could not.
  await page.evaluate(() => window.__diorama.setTime(0.47));
  // He starts at dawn and rides a 240 m loop at 6 m/s, so he is somewhere on the south
  // road within a few seconds of the clock reaching the morning window.
  const found = await page.waitForFunction(() => {
    const bike = window.__diorama.scene.getObjectByName('postman-bike');
    if (!bike || !bike.visible) return null;
    const p = bike.getWorldPosition(new bike.position.constructor());
    return { x: p.x, y: p.y, z: p.z };
  }, null, { timeout: 60_000, polling: 100 }).then((handle) => handle.jsonValue());

  const shots = [];
  // Let him ride clear of the block he starts beside: at 6 m/s four seconds puts him
  // 24 m down the road.
  await page.waitForTimeout(4_000);
  /**
   * Three frames, and the third one on purpose does not choose its side by the sun.
   * `sunlit` is how a silhouette is *shown*; `in-world` is how it actually appears to
   * someone standing on the pavement, contrast problem included.
   */
  // Distances that show a bicycle rather than fill the frame with a shoulder: at six
  // metres and a 50 degree field of view he is cropped, not framed.
  for (const [name, side, ahead, height, sunlit] of [
    ['postman-side', 8, 0, 1.0, true],
    ['postman-three-quarter', 8, 5, 1.1, true],
    ['postman-in-world', 10, 3.5, 1.6, false],
  ]) {
    // Aim one frame before the shot: at 6 m/s he moves 10 cm per frame.
    const aimed = await page.evaluate(({ side: s, ahead: a, height: h, lit }) => {
      const bike = window.__diorama.scene.getObjectByName('postman-bike');
      const p = bike.getWorldPosition(new bike.position.constructor());
      // He rides the south road along x, so the camera stands off in z and looks back
      // along his direction of travel.
      // The two silhouette frames stand on the sunlit side; the in-world frame stands
      // on the pavement side whatever the sun is doing.
      const dz = lit ? -s : s;
      window.__diorama.controls.setLookAt(p.x + a, p.y + h + 0.55, p.z + dz, p.x, p.y + h, p.z, false);
      return { x: p.x, y: p.y, z: p.z, camera: [p.x + a, p.y + h + 0.9, p.z + dz] };
    }, { side, ahead, height, lit: sunlit });
    await settle(page, 2);
    // Line of sight, proved rather than assumed: the first framing of this shot put
    // the camera inside a tenement, and the run reported success while the file held
    // a flat red wall and nothing else. Ray against every other mesh's world box,
    // in plain arithmetic so the page needs no debug API for it. Box tests are
    // conservative -- a ray through a gap in a tree still counts as blocked -- which
    // errs toward moving the camera, the safe direction.
    const sight = await page.evaluate(() => {
      const diorama = window.__diorama;
      const bike = diorama.scene.getObjectByName('postman-bike');
      const Vector3 = bike.position.constructor;
      diorama.scene.updateMatrixWorld(true);
      const rig = new Set();
      bike.traverse((node) => { if (node.isMesh) rig.add(node); });

      const worldBox = (mesh) => {
        const geometry = mesh.geometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const b = geometry.boundingBox;
        if (!b) return null;
        const e = mesh.matrixWorld.elements;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
          const p = [
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          ];
          for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
        }
        return { min, max };
      };
      /** Slab test; returns the near hit distance along a unit direction, or null. */
      const hit = (origin, dir, box) => {
        let near = -Infinity;
        let far = Infinity;
        for (let i = 0; i < 3; i++) {
          if (Math.abs(dir[i]) < 1e-9) {
            if (origin[i] < box.min[i] || origin[i] > box.max[i]) return null;
            continue;
          }
          let t1 = (box.min[i] - origin[i]) / dir[i];
          let t2 = (box.max[i] - origin[i]) / dir[i];
          if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
          if (t1 > near) near = t1;
          if (t2 < far) far = t2;
          if (near > far) return null;
        }
        return far < 0 ? null : Math.max(near, 0);
      };

      /** Does a box enclose a point? A box holding both camera and rider is a
       *  container -- the 2000 m sky shell, the ground slab -- not an occluder. */
      const contains = (box, p) => p.every((v, i) => v >= box.min[i] - 1e-6 && v <= box.max[i] + 1e-6);
      const others = [];
      diorama.scene.traverse((node) => {
        if (!node.isMesh || rig.has(node) || !node.visible || !node.geometry) return;
        let parent = node.parent;
        let hidden = false;
        while (parent) { if (!parent.visible) hidden = true; parent = parent.parent; }
        if (hidden) return;
        const box = worldBox(node);
        if (box) others.push({ name: node.name || node.geometry.type, kind: node.isInstancedMesh ? `inst${node.count}` : 'mesh', box });
      });

      const camera = diorama.controls.camera ?? diorama.camera;
      const eye = camera.getWorldPosition(new Vector3());
      const origin = [eye.x, eye.y, eye.z];
      const blocked = [];
      // Instanced meshes are excluded: their box is the union of every instance, so
      // for the tree and window pools it spans the map and says nothing about any one
      // instance. Stated as a limit of this check rather than worked around.
      const candidates = others.filter((other) => other.kind === 'mesh');
      for (const part of ['postman-head', 'postman-uniform', 'postman-legs']) {
        const node = bike.getObjectByName(part);
        if (!node) continue;
        const target = node.getWorldPosition(new Vector3());
        const raw = [target.x - eye.x, target.y - eye.y, target.z - eye.z];
        const length = Math.hypot(...raw);
        const dir = raw.map((v) => v / length);
        for (const other of candidates) {
          if (contains(other.box, origin) && contains(other.box, [target.x, target.y, target.z])) continue;
          const distance = hit(origin, dir, other.box);
          if (distance !== null && distance < length - 0.3) {
            const size = other.box.max.map((v, i) => (v - other.box.min[i]).toFixed(1)).join('x');
            blocked.push(`${part} behind ${other.name}[${other.kind}] ${size} m at ${distance.toFixed(1)} m of ${length.toFixed(1)} m`);
            break;
          }
        }
      }
      return blocked;
    });
    assert.deepEqual(sight, [], `${world}: the ${name} camera has no clear view of the rider`);
    const frame = `${FRAME_DIR}/${world}-high-${name}.jpg`;
    await page.screenshot({ path: frame, type: 'jpeg', quality: 88 });

    // Is the bicycle actually readable, or does it only look readable to whoever
    // picked the colour? Hide a group of meshes, render again, and the pixels that
    // changed are exactly that group's own pixels -- with the background it has to
    // separate from sitting underneath. Contrast is then measured, not deduced from
    // the diffuse colours, which is where the earlier reasoning went wrong: in a
    // multiplicative lighting model a colour difference scales with the light, so a
    // tyre chosen to sit lighter than sunlit asphalt sits on top of it in shadow.
    //
    // The city has to hold still for this. The first attempt let the animation loop
    // run between the two shots and measured 596 131 changed pixels for two wheels --
    // the whole moving frame. So: stop the loop, render on demand with delta 0, and
    // prove the instrument by shooting the same scene twice before touching anything.
    // Pixels never leave the page: shipping two 2880x1800 PNGs per comparison through
    // page.evaluate as base64 was 20 MB a call and did not finish. Snapshot the WebGL
    // canvas into an ImageData in the same tick as the render -- the drawing buffer is
    // still valid then -- keep it in a page global, and return only statistics.
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
    const deltasOf = async (a, b) => page.evaluate(([first, second]) => {
      const background = window.__shots[first];
      const shown = window.__shots[second];
      const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const deltas = [];
      for (let i = 0; i < shown.length; i += 4) {
        const delta = Math.abs(luma(shown, i) - luma(background, i));
        if (delta > 0.5) deltas.push(delta);
      }
      deltas.sort((x, y) => x - y);
      if (!deltas.length) return { ownPixels: 0, medianDelta: 0, readablePercent: 0 };
      return {
        ownPixels: deltas.length,
        medianDelta: Math.round(deltas[deltas.length >> 1] * 10) / 10,
        readablePercent: Math.round((deltas.filter((delta) => delta >= 8).length / deltas.length) * 1000) / 10,
      };
    }, [a, b]);

    await page.evaluate(() => {
      window.__parked = [];
      window.__raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => { window.__parked.push(callback); return 0; };
    });
    // No settle() while the loop is parked: settle awaits requestAnimationFrame, which
    // is exactly what the freeze swallows, so the first attempt deadlocked on itself.
    await page.waitForTimeout(300);
    const size = await shoot('still');
    await shoot('again');
    const control = { ...(await deltasOf('still', 'again')), canvas: `${size.width}x${size.height}` };
    const legibility = { control };
    for (const [group, wheelsOnly] of [['wheels', true], ['frame', false]]) {
      const meshes = await page.evaluate((onlyWheels) => {
        const bike = window.__diorama.scene.getObjectByName('postman-bike');
        const off = [];
        bike.traverse((node) => {
          if (!node.isMesh || node.name.startsWith('postman-')) return;
          const isWheel = node.geometry.type === 'CylinderGeometry';
          if (onlyWheels === isWheel) { node.visible = false; off.push(node); }
        });
        window.__hiddenBikeParts = off;
        return off.length;
      }, wheelsOnly);
      await shoot('without');
      await page.evaluate(() => {
        for (const node of window.__hiddenBikeParts) node.visible = true;
        window.__hiddenBikeParts = [];
      });
      legibility[group] = { meshes, ...(await deltasOf('without', 'still')) };
    }
    await page.evaluate(() => {
      window.requestAnimationFrame = window.__raf;
      for (const callback of window.__parked) window.requestAnimationFrame(callback);
      window.__parked = [];
    });
    console.log(
      `${' '.repeat(21)}control ${legibility.control.ownPixels} px  ` +
      `wheels ${legibility.wheels.ownPixels} px median dL ${legibility.wheels.medianDelta} ${legibility.wheels.readablePercent}% >=8  ` +
      `frame ${legibility.frame.ownPixels} px median dL ${legibility.frame.medianDelta} ${legibility.frame.readablePercent}% >=8`
    );
    assert.ok(
      legibility.control.ownPixels < legibility.wheels.ownPixels / 20,
      `${world}: the frozen scene moved between shots (${legibility.control.ownPixels} px), so the ${name} legibility numbers mean nothing`
    );
    const state = await page.evaluate(() => window.__diorama.postmanState());
    shots.push({ name, frame, aimed, legibility, active: state.active, dogMode: state.dogMode });
    console.log(`${world.padEnd(14)} high  ${name.padEnd(19)} at (${aimed.x.toFixed(1)}, ${aimed.z.toFixed(1)})  active ${state.active}  dog ${state.dogMode}`);
    assert.equal(state.active, true, `${world}: the postman stopped riding before the ${name} frame`);
  }
  assert.ok(found, 'the postman never appeared');
  return { world, found, shots };
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
async function runTrain(page, world) {
  await page.goto(`${URL}/?seed=${SEED}&world=${world}&checkpoint=train&quality=high`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
  await settle(page, 4);

  const readGlazing = () => page.evaluate(() => {
    const found = new Set();
    window.__diorama.scene.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        if (node.name === 'train-window' || (material.name === 'train-window')) found.add(material);
      }
    });
    // No name to lean on: the glazing is the train material whose own colour is the
    // product's unlit window, exactly as Train.test.ts finds it.
    if (!found.size) {
      const train = window.__diorama.scene.getObjectByName('train') ?? window.__diorama.scene;
      train.traverse((node) => {
        if (!node.isMesh || !node.material) return;
        const list = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of list) {
          if (material.emissive && material.color && material.roughness !== undefined
            && material.color.getHex() === 0x24465f) found.add(material);
        }
      });
    }
    const luminance = (color) => Math.round((0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) * 1000) / 1000;
    return [...found].map((material) => ({
      colorHex: `#${material.color.getHexString()}`,
      colorLuminance: luminance(material.color),
      emissiveHex: `#${material.emissive.getHexString()}`,
      emissiveLuminance: luminance(material.emissive),
      emissiveIntensity: Math.round(material.emissiveIntensity * 1000) / 1000,
      roughness: material.roughness,
      metalness: material.metalness,
      envMapIntensity: material.envMapIntensity,
    }));
  });

  const shots = [];
  for (const [name, t01] of [['train-day', 0.42], ['train-night', 0.94]]) {
    await page.evaluate((t) => window.__diorama.setTime(t), t01);
    await settle(page, 3);
    const glazing = await readGlazing();
    const frame = `${FRAME_DIR}/${world}-high-${name}.jpg`;
    await page.screenshot({ path: frame, type: 'jpeg', quality: 88 });
    shots.push({ name, t01, frame, glazing });
    console.log(`${world.padEnd(14)} high  ${name.padEnd(12)} t=${t01}  ${glazing.map((g) => `pane ${g.colorHex} L${g.colorLuminance} emissive ${g.emissiveHex} x${g.emissiveIntensity}`).join(' | ') || 'GLAZING NOT FOUND'}`);
    assert.equal(glazing.length, 1, `${world}: expected exactly one train glazing material, found ${glazing.length}`);
  }
  const [day, night] = shots;
  // The claim, as numbers: dark glass by day, a lit interior by night, one pane.
  assert.ok(day.glazing[0].emissiveIntensity < 0.05, `train glass glows by day (${day.glazing[0].emissiveIntensity})`);
  assert.ok(night.glazing[0].emissiveIntensity > 0.9, `train interior stays dark at night (${night.glazing[0].emissiveIntensity})`);
  assert.ok(night.glazing[0].colorLuminance < 0.2, 'the night pane itself has to stay dark');
  return { world, shots };
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

  for (const world of ['gate3', 'materials', 'postman'].includes(PHASE) ? [] : WORLDS) {
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
    await writeFile(`${OUT_DIR}/spike-postman.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...postman }, null, 2));
    console.log(`postman frames written to ${FRAME_DIR}/`);
  }
  const train = PHASE === 'train' || PHASE === 'all' ? await runTrain(page, hybridWorlds[0] ?? 'voxel') : null;
  if (train) {
    await writeFile(`${OUT_DIR}/spike-train.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...train }, null, 2));
    console.log(`train frames written to ${FRAME_DIR}/`);
  }
  const materials = PHASE === 'materials' || PHASE === 'all' ? await runMaterials(page, hybridWorlds) : null;
  if (materials) {
    await writeFile(`${OUT_DIR}/spike-materials.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...materials }, null, 2));
    console.log(`material matrix written to ${OUT_DIR}/spike-materials.json`);
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
