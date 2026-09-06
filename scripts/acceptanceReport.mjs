/**
 * Reading a phase's deviation report, where "I could not read it" is never "there were
 * none".
 *
 * The first version of this swallowed every error and returned an empty list, so a step
 * whose report was missing, truncated or left over from an earlier run reported PASS --
 * absence of evidence rendered as evidence of absence, in the one place where the whole
 * point is to surface an accepted shortfall. Every failure below is loud.
 *
 * Staleness is caught by two independent things: the caller hands each run its own
 * directory, so yesterday's file is not in the path at all, and the report has to carry the
 * provenance of *this* run -- the same `revisionFull` as HEAD and the same `builtAt` as the
 * manifest this run's build step signed. Two acceptances at one revision have different
 * `builtAt` stamps, so a file from the earlier one is rejected rather than believed.
 */
import { readFileSync } from 'node:fs';

/** Fields every deviation entry must carry for the summary to be able to say what it is. */
const REQUIRED_FIELDS = ['shot', 'group', 'separatedPercent', 'gate', 'floor'];

export function validateDeviationReport(report, expected) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('report is not a JSON object');
  }
  if (report.revisionFull !== expected.revisionFull) {
    throw new Error(
      `report is from revision ${report.revisionFull ?? '(brak)'} but HEAD is ${expected.revisionFull}`
    );
  }
  if (report.builtAt !== expected.builtAt) {
    throw new Error(
      `report was written against a build from ${report.builtAt ?? '(brak)'}, this run built at ${expected.builtAt}`
      + ' -- it is left over from another run'
    );
  }
  if (!Array.isArray(report.deviations)) {
    throw new Error(`report has no deviations array (found ${typeof report.deviations})`);
  }
  for (const [index, deviation] of report.deviations.entries()) {
    if (deviation === null || typeof deviation !== 'object') {
      throw new Error(`deviation ${index} is not an object`);
    }
    const missing = REQUIRED_FIELDS.filter((field) => deviation[field] === undefined);
    if (missing.length) throw new Error(`deviation ${index} is missing ${missing.join(', ')}`);
    if (!Number.isFinite(deviation.separatedPercent)) {
      throw new Error(`deviation ${index} has a non-numeric separatedPercent: ${deviation.separatedPercent}`);
    }
  }
  return report.deviations;
}

/** Read and validate one report. Throws -- the caller turns that into a failed step. */
export function readDeviationReport(file, expected) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the required report ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`the required report ${file} is not valid JSON: ${error.message}`);
  }
  return validateDeviationReport(parsed, expected);
}
