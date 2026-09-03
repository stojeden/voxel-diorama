/** One-off: render named frames from the built app for visual inspection. */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = Number(process.env.SHOT_PORT ?? 4199);
const URL = `http://127.0.0.1:${PORT}`;
const OUT = process.env.SHOT_OUT;
const SEED = 20260722;
/** name|world|quality|checkpoint|camera|t01 */
const SHOTS = (process.env.SHOTS ?? '').split(';').filter(Boolean).map((row) => {
  const [name, world, quality, checkpoint, camera, t01] = row.split('|');
  return { name, world, quality, checkpoint, camera, t01: t01 ? Number(t01) : null };
});

const preview = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
const waitForServer = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('preview did not start');
};
let browser;
try {
  await waitForServer();
  await mkdir(OUT, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  for (const shot of SHOTS) {
    const q = `seed=${SEED}&world=${shot.world}&quality=${shot.quality}` + (shot.checkpoint ? `&checkpoint=${shot.checkpoint}` : '');
    await page.goto(`${URL}/?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__diorama?.ready === true, null, { timeout: 90_000 });
    if (shot.t01 !== null) await page.evaluate((t) => window.__diorama.setTime(t), shot.t01);
    if (shot.camera) await page.keyboard.press(shot.camera);
    await page.evaluate(() => window.__diorama.debugBusStop?.('Osiedle Centralne'));
    await page.waitForTimeout(700);
    const burst = Number(process.env.SHOT_BURST ?? 1);
    for (let i = 0; i < burst; i++) {
      if (i) await page.waitForTimeout(Number(process.env.SHOT_GAP_MS ?? 1200));
      const png = await page.screenshot({ type: 'png' });
      await writeFile(`${OUT}/${shot.name}${burst > 1 ? `-${i}` : ''}.png`, png);
    }
    const m = await page.evaluate(() => ({ metrics: window.__diorama.getMetrics(), state: window.__diorama.getState() }));
    console.log(shot.name, m.metrics.quality.level, m.state.world, m.state.cameraMode, 'calls', m.metrics.renderer.calls);
  }
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
