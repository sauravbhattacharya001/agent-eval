/**
 * Path/URL Verifier — shared assertion scaffold (Tier 1 Deterministic Check)
 *
 * The pass/fail result builder and the "no references → pass" early-out shared
 * by the "extract → verify → count invalid" assertions
 * (`toHaveValidUrls`, `toHaveValidPaths`, `toHaveValidGitHubRefs`,
 * `toHaveValidReferences`). Split out of `./paths-assertions.js` so the shared
 * scaffold has one home and the factory file stays focused on the four
 * factories that compose it. Behaviour is identical to the previous inline
 * copies — this only removes the duplication.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { AssertionResult } from '../core/types.js';
import type { ReferenceVerifyResult } from './paths-types.js';

/**
 * Build the pass/fail assertion result shared by the "extract → verify → count
 * invalid" assertions (`toHaveValidUrls`, `toHaveValidPaths`,
 * `toHaveValidGitHubRefs`, `toHaveValidReferences`).
 *
 * Each caller supplies its own name, the noun for messages, and an optional
 * evidence/summary formatter so wording is preserved exactly.
 */
export function buildRefAssertionResult(params: {
  name: string;
  start: number;
  results: ReferenceVerifyResult[];
  maxInvalid: number;
  /** Message noun, e.g. 'URLs', 'file paths', 'GitHub references', 'references'. */
  noun: string;
  /** Optional trailing summary appended to the message, e.g. '(URLs: 1, ...)'. */
  summary?: string;
  /** Formats one invalid result into an evidence line. */
  evidenceLine: (r: ReferenceVerifyResult) => string;
  /** Message noun used in the failure count, e.g. 'URL(s)', 'path(s)'. */
  invalidNoun: string;
  /** Word used in expected/actual, e.g. 'URLs', 'paths', 'references'. */
  countNoun: string;
}): AssertionResult {
  const { name, start, results, maxInvalid, noun, summary, evidenceLine, invalidNoun, countNoun } =
    params;
  const invalid = results.filter(r => !r.exists);
  const pass = invalid.length <= maxInvalid;
  const suffix = summary ? ` (${summary})` : '';

  return {
    status: pass ? 'pass' : 'fail',
    name,
    message: pass
      ? `All ${results.length} ${noun} verified${suffix}`
      : `${invalid.length} invalid ${invalidNoun} found${suffix}`,
    evidence: invalid.length > 0 ? invalid.map(evidenceLine).join('\n') : undefined,
    expected: `≤${maxInvalid} invalid ${countNoun}`,
    actual: `${invalid.length} invalid of ${results.length} total`,
    durationMs: performance.now() - start,
  };
}

/** The "no references found → pass" early-out shared by the count-invalid assertions. */
export function emptyPass(name: string, noun: string, start: number): AssertionResult {
  return {
    status: 'pass',
    name,
    message: `No ${noun} found in output`,
    durationMs: performance.now() - start,
  };
}
