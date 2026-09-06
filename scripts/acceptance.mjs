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
import { mkdirSync, readFileSync } from 'node:fs';
import { readDeviationReport } from './acceptanceReport.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every environment knob that can change what a harness measures.
 *
 * These are wiped from each child's environment and then set explicitly by the step that
 * needs them. Without that, `SPIKE_PHASE=gate3` left in a shell -- or `SMOKE_DIAGNOSTIC=1`
 * from a diagnostic run an hour earlier -- would quietly turn a full acceptance into one
 * phase, or turn the geometry budget soft, and the summary would still say the acceptance
 * passed. An acceptance that depends on what the shell happens to hold is not one.
 */
const SCOPE_VARS = [
  'SPIKE_PHASE',
  'SPIKE_WORLDS',
  'SPIKE_QUALITIES',
  'SPIKE_SUMMARY',
  'SPIKE_OUT_DIR',
  'SPIKE_FRAME_DIR',
  'SMOKE_DIAGNOSTIC',
  /**
   * The one that would not narrow the run but hollow it out: with it set, the provenance
   * gate stops refusing a dirty tree, and every measurement below could be of a bundle
   * nobody signed. A standard acceptance does not offer that option.
   */
  'BUILD_PROVENANCE_ALLOW_DIRTY',
  /** Pointed at this run's own directory below, so no earlier manifest can be verified against. */
  'BUILD_MANIFEST',
];

/** What every spike step measures unless it says otherwise: the whole city, both profiles. */
const HYBRID = { SPIKE_WORLDS: 'hybrid-direct', SPIKE_QUALITIES: 'high,low' };

/**
 * Steps, in the order they should run. `env` is applied over an environment with every
 * scope variable removed, so each step states its own world, phase and profiles.
 */
const STEPS = [
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'testy jednostkowe', command: 'npm', args: ['test'] },
  { name: 'skladnia harnessow', command: process.execPath, args: ['--check', 'scripts/browserSmoke.mjs'] },
  { name: 'skladnia spikeSmoke', command: process.execPath, args: ['--check', 'scripts/spikeSmoke.mjs'] },
  { name: 'build + podpis', command: process.execPath, args: ['scripts/prepareBuild.mjs'], signsBuild: true },
  { name: 'browserSmoke', command: process.execPath, args: ['scripts/browserSmoke.mjs'] },
  /**
   * Each spike phase as its own step, rather than one `SPIKE_PHASE=all`.
   *
   * `all` runs them in one process, and the first assertion to fail takes the process
   * down with it: a run that stopped in `postman` never reached `train` or `materials`,
   * so their state was unknown and the summary could not say so. Naming them separately
   * costs one browser session each and buys a result for every phase, every time.
   */
  {
    name: 'spikeSmoke: faza frames (hybryda, budzet 600)',
    command: process.execPath,
    args: ['scripts/spikeSmoke.mjs'],
    env: { ...HYBRID, SPIKE_PHASE: 'frames', SPIKE_SUMMARY: 'spike-smoke-frames.json' },
    evidence: 'frames',
  },
  ...['gate3', 'postman', 'train', 'materials'].map((phase) => ({
    name: `spikeSmoke: faza ${phase}`,
    command: process.execPath,
    args: ['scripts/spikeSmoke.mjs'],
    env: { ...HYBRID, SPIKE_PHASE: phase, SPIKE_SUMMARY: `spike-smoke-${phase}.json` },
    evidence: phase,
    // The postman phase records the owner's accepted deviation here; the summary reads it
    // back so a deviation is reported as a deviation and never folded into a pass.
    ...(phase === 'postman' ? { deviationsFrom: 'spike-postman.json' } : {}),
  })),
  {
    name: 'spikeSmoke: swiat voxel (budzet 500)',
    command: process.execPath,
    args: ['scripts/spikeSmoke.mjs'],
    env: { SPIKE_WORLDS: 'voxel', SPIKE_QUALITIES: 'high,low', SPIKE_PHASE: 'frames', SPIKE_SUMMARY: 'spike-smoke-voxel.json' },
    evidence: 'voxel',
  },
];

const run = (step) => new Promise((resolve) => {
  const env = { ...process.env };
  for (const key of SCOPE_VARS) delete env[key];
  Object.assign(env, step.env ?? {});
  env.BUILD_MANIFEST = manifestPath;
  if (step.evidence) env.SPIKE_OUT_DIR = join(evidence, step.evidence);
  const child = spawn(step.command, step.args, { stdio: 'inherit', env });
  child.on('close', (code, signal) => resolve(signal ? `sygnal ${signal}` : code ?? 1));
});

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
/**
 * Evidence goes outside the repository, and it has to.
 *
 * `spikeSmoke` writes its frames and JSON under `docs/superpowers/spike/` by default, which
 * is right when a phase is run on its own to produce evidence for the spike. In a sequence
 * it is fatal: the first phase to write leaves an untracked file, and the provenance check
 * at the start of the NEXT harness sees a dirty tree and refuses to measure. That is the
 * gate doing its job -- so the run keeps the tree clean instead of loosening it.
 */
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const evidence = join(tmpdir(), 'voxel-diorama-acceptance', `${revision.slice(0, 12)}-${runId}`);
mkdirSync(evidence, { recursive: true });
/** This run signs its own manifest here, so nothing verifies against an older build. */
const manifestPath = join(evidence, 'build-manifest.json');
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean);
console.log(`rewizja ${revision}`);
console.log(`dowody: ${evidence}`);

/**
 * A dirty tree stops the acceptance here, not somewhere in the middle of it.
 *
 * Every harness verifies the signed bundle and refuses a dirty tree on its own, so the run
 * would fail anyway -- but it would fail on the third or fourth step, after minutes of
 * measuring, with a message about a manifest. Saying it once, up front, in the words of
 * the actual problem, costs nothing and reads as what it is.
 */
if (dirty.length) {
  console.error(
    `drzewo BRUDNE — standardowy odbior nie mierzy niezatwierdzonych zmian:\n  ${dirty.join('\n  ')}\n`
    + 'Zatwierdz je albo cofnij. BUILD_PROVENANCE_ALLOW_DIRTY nie ma tu zastosowania:'
    + ' odbior usuwa te zmienna ze srodowiska krokow.'
  );
  process.exit(1);
}
console.log('drzewo czyste');

const inherited = SCOPE_VARS.filter((key) => process.env[key] !== undefined);
if (inherited.length) {
  console.log(
    `ignoruje odziedziczone zmienne zakresu: ${inherited.map((key) => `${key}=${process.env[key]}`).join(', ')}`
    + ' — kazdy krok ustawia swoj swiat, faze i profile sam'
  );
}

/**
 * Deviations a step recorded -- and a hard failure when the report is not there.
 *
 * A step that declares `deviationsFrom` must produce it. Missing, truncated, from another
 * revision or from another run of this revision: all of those are failures of the step, not
 * an empty list. The earlier version caught everything and returned `[]`, which turned "no
 * evidence" into "no problem" in the one place built to surface a shortfall.
 */
const deviationsOf = (step, expected) => {
  if (!step.deviationsFrom || !step.evidence) return { deviations: [] };
  const file = join(evidence, step.evidence, step.deviationsFrom);
  try {
    return { deviations: readDeviationReport(file, expected) };
  } catch (error) {
    return { deviations: [], reportError: error.message };
  }
};

/** The stamp every report has to carry: this revision, this run's build. */
const provenance = () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { revisionFull: manifest.revisionFull, builtAt: manifest.builtAt };
};

const results = [];
let expected = null;
for (const step of STEPS) {
  console.log(`\n${'#'.repeat(20)} ${step.name} ${'#'.repeat(20)}`);
  const code = await run(step);
  if (step.signsBuild && code === 0) expected = provenance();
  const result = { name: step.name, code, deviations: [], reportError: null };
  if (code === 0 && step.deviationsFrom) {
    if (!expected) {
      result.reportError = 'brak podpisanego builda tego przebiegu, nie ma czym zweryfikowac raportu';
    } else {
      Object.assign(result, deviationsOf(step, expected));
    }
    if (result.reportError) console.error(`>>> ${step.name}: RAPORT NIEWAZNY — ${result.reportError}`);
  }
  results.push(result);
  console.log(`>>> ${step.name}: kod wyjscia ${code}`);
}

/**
 * Three states, not two. A step that passed every assertion it was asked reads PASS; a
 * step that failed one reads FAIL; a step whose only shortfall is a deviation the owner
 * has accepted reads ODSTEPSTWO and is never counted as a pass. Folding the third into
 * the first is how an accepted limitation turns into a claim of a clean run.
 */
console.log(`\n${'='.repeat(58)}\nODBIOR — rewizja ${revision.slice(0, 7)}`);
for (const result of results) {
  const failedStep = result.code !== 0 || Boolean(result.reportError);
  const state = failedStep ? 'FAIL      ' : result.deviations.length ? 'ODSTEPSTWO' : 'PASS      ';
  console.log(`  ${state}  ${String(result.code).padStart(3)}  ${result.name}`);
  if (result.reportError) console.log(`             └─ raport niewazny: ${result.reportError}`);
  for (const deviation of result.deviations) {
    console.log(
      `             └─ ${deviation.world ?? '?'}/${deviation.quality ?? '?'} ${deviation.shot} ${deviation.group}: `
      + `${deviation.separatedPercent}% przy bramce ${deviation.gate}%, dolna granica ${deviation.floor}% `
      + `— ${deviation.accepted}`
    );
  }
}
const failed = results.filter((result) => result.code !== 0 || result.reportError);
const deviated = results.filter((result) => result.code === 0 && !result.reportError && result.deviations.length);
console.log(
  `${results.length - failed.length - deviated.length} PASS, ${deviated.length} ODSTEPSTWO, ${failed.length} FAIL `
  + `z ${results.length} krokow`
);
if (deviated.length) console.log('ODSTEPSTWO nie jest wynikiem zaliczonym — jest jawnym ograniczeniem tej wersji.');
console.log(`dowody w ${evidence}`);
process.exit(failed.length ? 1 : 0);
