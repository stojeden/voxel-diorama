/**
 * Which bundle a measurement measured, established before the measurement starts.
 *
 * Every harness here serves `dist/` through `vite preview`, so `dist/` is whatever the
 * last build left behind and a run could stamp itself with a revision it never executed.
 * The previous attempt at this had three holes worth naming, because each of them
 * produces a plausible-looking artefact that is simply wrong:
 *
 *   - the stamp was taken while *writing the results*, so in its default mode it built a
 *     fresh bundle after the measurement and attached that bundle's hash to numbers
 *     produced by the previous one;
 *   - one harness imported the stamp and never called it;
 *   - the "already built" path compared modification times, and a timestamp is not
 *     evidence that a bundle was built from a particular commit.
 *
 * So: one build, done under a lock that also covers the build, described by a manifest
 * with the commit's full SHA and the source tree's own object hash, and verified by every
 * harness against the bundle actually sitting in `dist/` before it renders anything.
 *
 *   prepareBuild()  lock -> assert clean -> read HEAD and tree hash -> build -> write
 *                   manifest -> unlock. Run once per batch.
 *   verifyBuild()   lock -> manifest exists -> manifest HEAD == current HEAD -> tree
 *                   still clean -> entry chunk hash == manifest -> return manifest.
 *                   The caller keeps the lock until it calls releaseLock().
 *
 * Any mismatch throws, and a harness that throws here has measured nothing.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_PATH = join(tmpdir(), 'voxel-diorama-render.lock');
/**
 * Iteration escape hatch. Set it and a dirty tree is allowed -- but every artefact from
 * that run carries `provisional: true` and the list of uncommitted paths, so a frame shot
 * while trying something cannot later be mistaken for evidence. Final runs never set it.
 */
const ALLOW_DIRTY = process.env.BUILD_PROVENANCE_ALLOW_DIRTY === '1';
const MANIFEST_PATH = process.env.BUILD_MANIFEST ?? join(tmpdir(), 'voxel-diorama-build-manifest.json');

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let heldLock = false;

/**
 * One renderer or build at a time, across every harness. A stale lock -- owner gone -- is
 * taken over; a live one is refused, because two processes sharing a GPU produce a
 * measurement of neither.
 */
export function acquireLock({ waitMs = 0 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      heldLock = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(readFileSync(LOCK_PATH, 'utf8'), 10);
      let alive = false;
      if (Number.isInteger(owner)) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch (probe) {
          alive = probe.code !== 'ESRCH';
        }
      }
      if (!alive) {
        unlinkSync(LOCK_PATH);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `another Diorama build or measurement holds the lock (PID ${owner}). `
          + 'One renderer at a time: a shared GPU makes both measurements meaningless.'
        );
      }
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
    }
  }
}

export function releaseLock() {
  if (!heldLock) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  heldLock = false;
}

function headState() {
  const status = git(['status', '--porcelain']);
  return {
    revision: git(['rev-parse', '--short', 'HEAD']),
    revisionFull: git(['rev-parse', 'HEAD']),
    /** The commit's tree object: one hash over every tracked source file. */
    sourceTreeSha: git(['rev-parse', 'HEAD^{tree}']),
    dirtyPaths: status.split('\n').filter(Boolean),
  };
}

function entryChunk() {
  const assets = 'dist/assets';
  const names = readdirSync(assets).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(names.length, 1, `expected exactly one entry chunk in ${assets}, found ${names.length}`);
  const path = join(assets, names[0]);
  return {
    entryFile: names[0],
    entryBytes: statSync(path).size,
    entrySha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

/** Build once, under the lock, and describe what was built. */
export function prepareBuild() {
  acquireLock({ waitMs: 60_000 });
  try {
    const head = headState();
    if (!ALLOW_DIRTY) {
      assert.deepEqual(
        head.dirtyPaths,
        [],
        `refusing to build a signed bundle from a dirty tree:\n  ${head.dirtyPaths.join('\n  ')}`
      );
    }
    execFileSync('npm', ['run', 'build'], { stdio: 'ignore' });
    const manifest = {
      revision: head.revision,
      revisionFull: head.revisionFull,
      sourceTreeSha: head.sourceTreeSha,
      ...entryChunk(),
      builtAt: new Date().toISOString(),
      builtBy: 'scripts/buildProvenance.mjs prepareBuild',
      provisional: head.dirtyPaths.length > 0,
      provisionalBecause: head.dirtyPaths.length > 0 ? head.dirtyPaths.slice(0, 20) : undefined,
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    releaseLock();
  }
}

/**
 * Take the lock and prove that what is in `dist/` is the bundle the manifest describes,
 * built from the commit that is still checked out. The caller releases the lock.
 */
export function verifyBuild() {
  acquireLock({ waitMs: 0 });
  try {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    } catch {
      throw new Error(
        `no build manifest at ${MANIFEST_PATH}. Run \`node scripts/prepareBuild.mjs\` first: `
        + 'the bundle has to be built and signed before anything measures it.'
      );
    }
    const head = headState();
    if (!ALLOW_DIRTY) {
      assert.deepEqual(
        head.dirtyPaths,
        [],
        `the tree went dirty since the build:\n  ${head.dirtyPaths.join('\n  ')}`
      );
    }
    assert.equal(
      manifest.revisionFull,
      head.revisionFull,
      `the manifest was built from ${manifest.revisionFull} but HEAD is now ${head.revisionFull}`
    );
    assert.equal(
      manifest.sourceTreeSha,
      head.sourceTreeSha,
      `the manifest's source tree ${manifest.sourceTreeSha} is not HEAD's tree ${head.sourceTreeSha}`
    );
    const built = entryChunk();
    assert.equal(
      built.entryFile,
      manifest.entryFile,
      `dist holds ${built.entryFile}, the manifest describes ${manifest.entryFile}`
    );
    assert.equal(
      built.entrySha256,
      manifest.entrySha256,
      `the entry chunk in dist hashes to ${built.entrySha256}, the manifest says ${manifest.entrySha256}`
    );
    assert.equal(built.entryBytes, manifest.entryBytes, 'entry chunk size differs from the manifest');
    return {
      ...manifest,
      provisional: Boolean(manifest.provisional) || head.dirtyPaths.length > 0,
      provisionalBecause: head.dirtyPaths.length > 0 ? head.dirtyPaths.slice(0, 20) : manifest.provisionalBecause,
      verifiedAt: new Date().toISOString(),
      manifestPath: MANIFEST_PATH,
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
}
