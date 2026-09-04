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

/**
 * Every file the build produced, in a deterministic order, each with its size and digest,
 * plus one hash over that whole list.
 *
 * Hashing only `index-*.js` left most of the build unsigned: the hybrid fragment, the
 * diagnostic code and the rest arrive in their own lazy chunks, so a stale or swapped
 * chunk would have passed unnoticed -- and the fragment is the thing being measured.
 */
function distManifest() {
  const files = [];
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, relative);
      else {
        files.push({
          path: relative,
          bytes: statSync(path).size,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
      }
    }
  };
  walk('dist', '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    aggregateSha256: createHash('sha256')
      .update(files.map((file) => `${file.path} ${file.bytes} ${file.sha256}`).join('\n'))
      .digest('hex'),
    files,
  };
}

/** What changed between two dist manifests, in terms a failure message can use. */
function distDifferences(expected, actual) {
  const asMap = (list) => new Map(list.map((file) => [file.path, file]));
  const before = asMap(expected.files);
  const after = asMap(actual.files);
  const problems = [];
  for (const [path, file] of before) {
    const now = after.get(path);
    if (!now) problems.push(`missing: ${path}`);
    else if (now.sha256 !== file.sha256) problems.push(`changed: ${path} (${file.sha256.slice(0, 12)} -> ${now.sha256.slice(0, 12)})`);
    else if (now.bytes !== file.bytes) problems.push(`resized: ${path} (${file.bytes} -> ${now.bytes} B)`);
  }
  for (const path of after.keys()) if (!before.has(path)) problems.push(`unexpected: ${path}`);
  return problems;
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

    /**
     * The state is read again *after* the build, not only before it.
     *
     * A build takes tens of seconds, and anything that moves HEAD or writes into the
     * tree during it would leave a manifest describing a commit that never produced this
     * bundle. If the commit, the source tree or the cleanliness changed, no manifest is
     * written at all.
     */
    const afterBuild = headState();
    assert.equal(
      afterBuild.revisionFull,
      head.revisionFull,
      `HEAD moved during the build: ${head.revisionFull} -> ${afterBuild.revisionFull}. No manifest written.`
    );
    assert.equal(
      afterBuild.sourceTreeSha,
      head.sourceTreeSha,
      `the source tree changed during the build: ${head.sourceTreeSha} -> ${afterBuild.sourceTreeSha}. No manifest written.`
    );
    if (!ALLOW_DIRTY) {
      assert.deepEqual(
        afterBuild.dirtyPaths,
        [],
        `the tree went dirty during the build:\n  ${afterBuild.dirtyPaths.join('\n  ')}\nNo manifest written.`
      );
    }

    const manifest = {
      revision: head.revision,
      revisionFull: head.revisionFull,
      sourceTreeSha: head.sourceTreeSha,
      dist: distManifest(),
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

    // The whole build, not just its entry: a missing file, an extra one or a single
    // changed byte anywhere in dist stops the measurement.
    assert.ok(manifest.dist?.files, 'the manifest predates whole-build signing; rebuild it');
    const dist = distManifest();
    const differences = distDifferences(manifest.dist, dist);
    assert.deepEqual(
      differences,
      [],
      `dist does not match the signed build (${differences.length} difference(s)):\n  `
      + differences.slice(0, 12).join('\n  ')
    );
    assert.equal(
      dist.aggregateSha256,
      manifest.dist.aggregateSha256,
      `the build hashes to ${dist.aggregateSha256}, the manifest says ${manifest.dist.aggregateSha256}`
    );
    assert.equal(dist.fileCount, manifest.dist.fileCount, 'dist file count differs from the manifest');
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
