/**
 * Does the bundle about to be published match the one the gates measured?
 *
 * Until 2026-09-11 the deploy job ran its own `npm ci && npm run build` and published that
 * `dist/`. So every budget assertion, every pixel comparison and the whole of
 * `buildProvenance.mjs` -- 309 lines whose own header lists three previously caught holes --
 * applied to a bundle that was then thrown away, and a different one shipped. Two builds of
 * the same commit are usually identical, which is exactly what makes the gap easy to miss and
 * pointless to rely on: "usually identical" is not a gate.
 *
 * Now the tested `dist/` travels to the deploy job as an artifact, and this compares what
 * arrived against the manifest written beside it. It is deliberately dumb -- read the
 * manifest, hash every file it lists, compare, and also refuse anything in `dist/` that the
 * manifest does not mention, because an EXTRA file is how you would smuggle something in.
 *
 *   node scripts/verifyArtifact.mjs <manifest.json> <dist dir>
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [manifestPath, distDir] = process.argv.slice(2);
if (!manifestPath || !distDir) {
  console.error('usage: node scripts/verifyArtifact.mjs <manifest.json> <dist dir>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expected = new Map(manifest.dist.files.map((file) => [file.path, file]));

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const problems = [];
const seen = new Set();

for (const full of walk(distDir)) {
  const path = relative(distDir, full).split(sep).join('/');
  seen.add(path);
  const want = expected.get(path);
  if (!want) {
    problems.push(`${path}: present in the artifact, absent from the manifest`);
    continue;
  }
  const bytes = readFileSync(full);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== want.bytes) {
    problems.push(`${path}: ${bytes.length} bytes, manifest says ${want.bytes}`);
  } else if (sha !== want.sha256) {
    problems.push(`${path}: sha256 ${sha.slice(0, 12)}, manifest says ${want.sha256.slice(0, 12)}`);
  }
}

for (const path of expected.keys()) {
  if (!seen.has(path)) problems.push(`${path}: in the manifest, missing from the artifact`);
}

if (problems.length > 0) {
  console.error(
    `the bundle about to be published is not the one that was measured (${manifest.revision}):\n  ` +
      problems.join('\n  ')
  );
  process.exit(1);
}

console.log(
  `artifact matches the measured build ${manifest.revision}: ` +
    `${manifest.dist.fileCount} files, ${manifest.dist.totalBytes} bytes`
);
