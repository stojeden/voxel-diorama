/**
 * What a light budget looks like, not only what it costs.
 *
 * Renders the same night frames at several physical light counts and reports how much
 * of the image each count changes, per region, so a budget is chosen on the picture as
 * well as on the milliseconds. The lamps themselves are never touched: their emissive
 * heads and the street glow mesh stay exactly as they are, so what a smaller budget
 * removes is a pool of light on the road, not a lamp from the scene.
 *
 * The count is held down the same way the cost experiment holds it: `renderer.render`
 * is wrapped and a deterministic cap is re-applied immediately before each draw,
 * because `DayNightCycle` reassigns `visible` on every local light every frame.
 *
 * Usage: node scripts/lightBudgetFrames.mjs
 *   FRAMES_CAPS=16,14,12  FRAMES_OUT=docs/superpowers/spike/frames
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
/**
 * Which code produced these numbers, and whether anything was uncommitted while it did.
 * A measurement without a revision cannot be quoted in a comment or a report: that is
 * how "eleven milliseconds at sixteen lights" ended up in a source comment describing a
 * configuration nobody had measured.
 */
const revisionOf = () => {
  const run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  try {
    return {
      revision: run(['rev-parse', '--short', 'HEAD']),
      workingTreeDirty: run(['status', '--porcelain']).length > 0,
      dirtyPaths: run(['status', '--porcelain']).split('\n').filter(Boolean).slice(0, 20),
    };
  } catch {
    return { revision: 'unknown', workingTreeDirty: null, dirtyPaths: [] };
  }
};


const PORT = Number(process.env.FRAMES_PORT ?? 4213);
const URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.FRAMES_OUT ?? 'docs/superpowers/spike/frames';
const SUMMARY = process.env.FRAMES_SUMMARY ?? 'docs/superpowers/spike/light-budget-frames.json';
const CAPS = (process.env.FRAMES_CAPS ?? '16,14,12').split(',').map(Number);
const SEED = 20260722;
const WORLD = process.env.FRAMES_WORLD ?? 'hybrid-direct';
const SHOTS = [
  { name: 'night-street', checkpoint: 'spike-night-street' },
  { name: 'night-train', checkpoint: 'night-snow-train' },
];
/** Regions the acceptance criteria name, in the 1440x900 frame. */
const REGIONS = {
  street: { x: 300, y: 430, width: 840, height: 340 },
  stopAndBus: { x: 760, y: 380, width: 480, height: 260 },
  nearBuildings: { x: 0, y: 80, width: 420, height: 520 },
};

const INSTALL_CAP = () => {
  const renderer = window.__diorama.renderer;
  if (window.__lightCap !== undefined) return 'already';
  window.__lightCap = null;
  window.__lightRank = () => {
    const lights = [];
    window.__diorama.scene.traverse((node) => {
      if (node.isPointLight || node.isSpotLight) lights.push(node);
    });
    lights.sort((a, b) => {
      const key = (light) => [
        light.isSpotLight ? 'b-spot' : 'a-point',
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
      let kept = 0;
      for (const light of window.__lightRank()) {
        if (!light.visible) continue;
        if (kept < window.__lightCap) kept += 1;
        else light.visible = false;
      }
    }
    original(scene, camera);
  };
  return 'installed';
};

/** Per-region difference between two PNGs, decoded in the page. */
const REGION_DIFF = async ([a, b, regions]) => {
  const decode = async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
  };
  const [first, second] = await Promise.all([decode(a), decode(b)]);
  const scale = first.width / 1440;
  const out = {};
  for (const [name, box] of Object.entries(regions)) {
    let changed = 0;
    let total = 0;
    let sum = 0;
    let peak = 0;
    for (let y = Math.round(box.y * scale); y < Math.round((box.y + box.height) * scale); y++) {
      for (let x = Math.round(box.x * scale); x < Math.round((box.x + box.width) * scale); x++) {
        const i = (y * first.width + x) * 4;
        const luma = (data) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        const delta = Math.abs(luma(second.data) - luma(first.data));
        total += 1;
        sum += delta;
        if (delta > peak) peak = delta;
        if (delta > 6) changed += 1;
      }
    }
    out[name] = {
      pixels: total,
      changedPixels: changed,
      changedPercent: Math.round((changed / total) * 1000) / 10,
      meanDelta: Math.round((sum / total) * 100) / 100,
      peakDelta: Math.round(peak),
    };
  }
  return out;
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

let browser;
const report = { recordedAt: new Date().toISOString(), ...revisionOf(), world: WORLD, caps: CAPS, regions: REGIONS, shots: [] };
try {
  await waitForServer();
  await mkdir(OUT_DIR, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  for (const shot of SHOTS) {
    await page.goto(`${URL}/?seed=${SEED}&world=${WORLD}&checkpoint=${shot.checkpoint}&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
    assert.equal(await page.evaluate(INSTALL_CAP), 'installed');
    await page.waitForTimeout(1_200);
    const natural = await page.evaluate(() => window.__lightRank().filter((light) => light.visible).length);

    const captures = {};
    for (const cap of CAPS) {
      await page.evaluate((value) => { window.__lightCap = value; }, cap);
      await page.evaluate(async () => {
        for (let i = 0; i < 30; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await page.waitForTimeout(500);
      const lights = await page.evaluate(() => window.__lightRank().filter((light) => light.visible).length);
      const png = await page.screenshot({ type: 'png' });
      captures[cap] = { base64: png.toString('base64'), lights };
      await writeFile(`${OUT_DIR}/${WORLD}-high-${shot.name}-lights${cap}.jpg`, await page.screenshot({ type: 'jpeg', quality: 88 }));
      console.log(`${shot.name.padEnd(13)} cap ${String(cap).padStart(2)}  ${lights} lights visible  frame written`);
    }

    const reference = CAPS[0];
    const diffs = {};
    for (const cap of CAPS.slice(1)) {
      diffs[`${reference}-vs-${cap}`] = await page.evaluate(REGION_DIFF, [captures[reference].base64, captures[cap].base64, REGIONS]);
    }
    report.shots.push({
      ...shot,
      naturalLights: natural,
      lightsByCap: Object.fromEntries(Object.entries(captures).map(([cap, value]) => [cap, value.lights])),
      diffs,
    });
    for (const [pair, regions] of Object.entries(diffs)) {
      console.log(`  ${pair}: ${Object.entries(regions).map(([name, value]) => `${name} ${value.changedPercent}% changed, mean ${value.meanDelta}, peak ${value.peakDelta}`).join('; ')}`);
    }
  }
  await writeFile(SUMMARY, JSON.stringify(report, null, 2));
  console.log(`\nframes in ${OUT_DIR}, per-region differences in ${SUMMARY}`);
} finally {
  await browser?.close();
  try {
    if (preview?.pid && process.platform !== 'win32') process.kill(-preview.pid, 'SIGTERM');
    else preview?.kill('SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
