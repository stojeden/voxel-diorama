/**
 * The whole acceptance, in one command, with nothing implied.
 *
 * This exists because `node scripts/spikeSmoke.mjs` runs only its default `frames` phase,
 * and a run of it was once reported as "the full spike smoke". It is not: `gate3`,
 * `materials`, `postman` and `train` never execute unless `SPIKE_PHASE` says so, and the
 * voxel world never builds unless `SPIKE_WORLDS` says so, which left the 500-geometry
 * budget untouched by anything. Every phase this project gates on is named below, so what
 * ran is what the list says and no reader has to know the defaults.
 *
 * Two rules it keeps:
 *   - every step runs, even after one fails, so a single failure cannot hide the state of
 *     the rest -- the summary lists them all and the process still exits non-zero;
 *   - exit codes come from the child process, never from the tail of a pipe.
 *
 * The build happens once, up front, under the provenance lock: every harness afterwards
 * verifies that same signed bundle and refuses to measure anything else. That is also why
 * the tree has to be clean -- a dirty tree stops the run before it starts, on purpose.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

/** Steps, in the order they should run. `env` is merged over the inherited environment. */
const STEPS = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'testy jednostkowe', command: 'npm', args: ['test'] },
  { name: 'skladnia harnessow', command: process.execPath, args: ['--check', 'scripts/browserSmoke.mjs'] },
  { name: 'skladnia spikeSmoke', command: process.execPath, args: ['--check', 'scripts/spikeSmoke.mjs'] },
  { name: 'build + podpis', command: process.execPath, args: ['scripts/prepareBuild.mjs'] },
  { name: 'browserSmoke', command: process.execPath, args: ['scripts/browserSmoke.mjs'] },
  {
    name: 'spikeSmoke: wszystkie fazy (hybryda)',
    command: process.execPath,
    args: ['scripts/spikeSmoke.mjs'],
    env: { SPIKE_PHASE: 'all' },
  },
  {
    name: 'spikeSmoke: swiat voxel (budzet 500)',
    command: process.execPath,
    args: ['scripts/spikeSmoke.mjs'],
    env: { SPIKE_WORLDS: 'voxel', SPIKE_SUMMARY: 'spike-smoke-voxel.json' },
  },
];

const run = (step) => new Promise((resolve) => {
  const child = spawn(step.command, step.args, {
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
  });
  child.on('close', (code, signal) => resolve(signal ? `sygnal ${signal}` : code ?? 1));
});

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean);
console.log(`rewizja ${revision}`);
console.log(dirty.length ? `drzewo BRUDNE: ${dirty.join(', ')}` : 'drzewo czyste');

const results = [];
for (const step of STEPS) {
  console.log(`\n${'#'.repeat(20)} ${step.name} ${'#'.repeat(20)}`);
  const code = await run(step);
  results.push({ name: step.name, code });
  console.log(`>>> ${step.name}: kod wyjscia ${code}`);
}

console.log(`\n${'='.repeat(58)}\nODBIOR — rewizja ${revision.slice(0, 7)}`);
for (const result of results) {
  console.log(`  ${result.code === 0 ? 'OK  ' : 'BLAD'}  ${String(result.code).padStart(3)}  ${result.name}`);
}
const failed = results.filter((result) => result.code !== 0);
console.log(`${results.length - failed.length}/${results.length} krokow zaliczonych`);
process.exit(failed.length ? 1 : 0);
