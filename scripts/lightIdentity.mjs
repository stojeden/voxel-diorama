/**
 * Which lights sit at the top of the ranking, and do they cast shadows?
 *
 * The cost experiment found a threshold rather than a slope: dropping two of eighteen
 * physical lights returns 9.4 ms in the hybrid and 8.4 ms in the product, while the
 * next twelve return nothing measurable. The report lists the *cause* as a hypothesis.
 * This asks the scene directly: the cap removes from the end of the ranking, so the two
 * lights it takes first are named here along with whether they render a shadow map --
 * which is the difference between "two lights" and "two lights plus two depth passes".
 *
 * Usage: node scripts/lightIdentity.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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


const PORT = Number(process.env.IDENTITY_PORT ?? 4219);
const URL = `http://127.0.0.1:${PORT}`;
const OUT = process.env.IDENTITY_OUT ?? 'docs/superpowers/spike/light-identity.json';
const SEED = 20260722;
const CHECKPOINT = process.env.IDENTITY_CHECKPOINT ?? 'spike-night-street';

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

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const report = { recordedAt: new Date().toISOString(), ...revisionOf(), checkpoint: CHECKPOINT, worlds: {} };

  for (const world of ['voxel', 'hybrid-direct']) {
    await page.goto(`${URL}/?seed=${SEED}&world=${world}&checkpoint=${CHECKPOINT}&quality=high`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
    await page.waitForTimeout(1_500);

    const lights = await page.evaluate(() => {
      const all = [];
      window.__diorama.scene.traverse((node) => {
        if (!node.isPointLight && !node.isSpotLight) return;
        all.push({
          kind: node.isSpotLight ? 'spot' : 'point',
          name: node.name || '(unnamed)',
          visible: node.visible,
          intensity: Math.round(node.intensity * 100) / 100,
          castShadow: node.castShadow,
          shadowMapSize: node.shadow ? `${node.shadow.mapSize.width}x${node.shadow.mapSize.height}` : null,
          // Both: the local transform says what a light is attached to (a vehicle's
          // headlamp sits at a small offset in its own frame), the world position says
          // where it actually shines.
          localPosition: [node.position.x, node.position.y, node.position.z].map((v) => Math.round(v * 100) / 100),
          position: (() => {
            const world = node.getWorldPosition(new node.position.constructor());
            return [world.x, world.y, world.z].map((v) => Math.round(v * 100) / 100);
          })(),
          attachedTo: node.parent?.name || node.parent?.type || null,
        });
      });
      // Same deterministic ranking the cost experiment uses, so "the last two" here are
      // the same two lights a cap of 16 removes there.
      all.sort((a, b) => {
        const key = (light) => [
          light.kind === 'spot' ? 'b-spot' : 'a-point',
          light.name === '(unnamed)' ? '' : light.name,
          ...light.localPosition.map((v) => v.toFixed(2)),
        ].join('|');
        return key(a) < key(b) ? -1 : 1;
      });
      return all;
    });

    const visible = lights.filter((light) => light.visible);
    const shadowCasters = visible.filter((light) => light.castShadow);
    const removedFirst = visible.slice(-2);
    report.worlds[world] = {
      totalLights: lights.length,
      visibleLights: visible.length,
      shadowCastingVisible: shadowCasters.length,
      shadowCasters: shadowCasters.map((light) => `${light.kind} ${light.name} at ${light.position.join(',')} ${light.shadowMapSize}`),
      removedFirstByACapOf16: removedFirst.map((light) => `${light.kind} ${light.name} on ${light.attachedTo} at world ${light.position.join(',')} castShadow=${light.castShadow}`),
      ranking: visible.map((light) => `${light.kind} ${light.name} on ${light.attachedTo} world ${light.position.join(',')} shadow=${light.castShadow}`),
    };
    console.log(`${world.padEnd(14)} ${visible.length} visible of ${lights.length}, ${shadowCasters.length} casting shadows`);
    for (const line of report.worlds[world].removedFirstByACapOf16) console.log(`  a cap of 16 drops: ${line}`);
    for (const line of report.worlds[world].shadowCasters) console.log(`  shadow caster:     ${line}`);
  }

  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\nwritten to ${OUT}`);
  assert.ok(report.worlds.voxel.visibleLights > 0, 'no visible local lights: wrong checkpoint?');
} finally {
  await browser?.close();
  try {
    if (preview?.pid && process.platform !== 'win32') process.kill(-preview.pid, 'SIGTERM');
    else preview?.kill('SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
