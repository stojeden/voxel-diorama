/**
 * Build the bundle every harness in a batch will measure, and sign it.
 *
 * Separate from the harnesses on purpose: the build has to happen once, under the same
 * lock that the measurements take, before any of them starts. Run this first; every
 * harness afterwards verifies the manifest it writes and refuses to measure anything
 * else.
 */
import { prepareBuild } from './buildProvenance.mjs';

const manifest = prepareBuild();
console.log(
  `built ${manifest.entryFile} (${manifest.entryBytes} B, sha256 ${manifest.entrySha256.slice(0, 16)}…)\n`
  + `  from ${manifest.revisionFull}\n`
  + `  tree ${manifest.sourceTreeSha}\n`
  + `  at   ${manifest.builtAt}`
);
