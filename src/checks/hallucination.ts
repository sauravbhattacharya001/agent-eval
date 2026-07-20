/**
 * Hallucination Judge - Cross-reference claims against provided context
 *
 * A specialized evaluator that extracts factual claims from agent output and
 * verifies them against provided reference materials. This module combines
 * all three tiers:
 *
 * - Tier 1: Exact string matches, URL existence, quoted text verification
 * - Tier 2: TF-IDF similarity between claims and reference passages
 * - Tier 3: Model-as-judge for ambiguous claims requiring comprehension
 *
 * Philosophy: A hallucination is a factual claim in the output that is NOT
 * grounded in the provided context. We err on the side of flagging - it is
 * better to flag a true claim as "ungrounded" than to miss a fabrication.
 *
 * This file is the **public barrel** for the hallucination check and the home
 * of the assertion factories that compose claim extraction + verification into
 * Jest/Vitest-style assertions. The supporting seams live alongside it and are
 * re-exported here so the public surface stays a single `./hallucination.js`
 * import path:
 * - `./hallucination-types.js`        — the type vocabulary (claims, verifications, options)
 * - `./hallucination-extraction.js`   — text → factual-claim extraction
 * - `./hallucination-verification.js` — claim verification + scoring (Tier 1+2+3)
 * - `./hallucination-assert.js`       — the shared assertion shell (merge/time/analyze/catch)
 *
 * @tier mixed (1+2+3)
 * @module
 */

import type { Assertion } from '../core/types.js';
import type { HallucinationOptions } from './hallucination-types.js';
import { makeHallucinationAssertion } from './hallucination-assert.js';

// ─── TYPE RE-EXPORTS ──────────────────────────────────────────────────────────
// The hallucination type vocabulary lives in ./hallucination-types.js;
// re-export it here so consumers keep a single `./hallucination.js` import path.
export type {
  ExtractedClaim,
  ClaimKind,
  ClaimVerification,
  ClaimStatus,
  VerificationTier,
  ClaimExtractionOptions,
  VerificationOptions,
  HallucinationResult,
  HallucinationOptions,
} from './hallucination-types.js';

// ─── EXTRACTION RE-EXPORTS ─────────────────────────────────────────────────────
// The text → claims half (patterns + sentence scanning) lives alongside.
export { extractClaims } from './hallucination-extraction.js';

// ─── VERIFICATION RE-EXPORTS ───────────────────────────────────────────────────
// The reference-grounding + scoring engine (Tier 1 exact / Tier 2 similarity /
// Tier 3 judge) and its built-in rubric.
export {
  wordOverlap,
  findBestMatch,
  checkContradiction,
  verifyClaim,
  verifyClaims,
  HALLUCINATION_RUBRIC,
  analyzeHallucination,
} from './hallucination-verification.js';

// ─── ASSERTION-SHELL RE-EXPORT ─────────────────────────────────────────────────
// The shared merge/time/analyze/catch scaffold used by every factory below.
export { makeHallucinationAssertion } from './hallucination-assert.js';
export type { HallucinationDecision } from './hallucination-assert.js';

// === ASSERTION FACTORIES =====================================================

/**
 * Assert that agent output does not contain hallucinated claims.
 *
 * Extracts factual claims from output, verifies each against provided references.
 * Fails if hallucination score exceeds threshold or too many claims are ungrounded.
 *
 * @param references - Reference texts to verify against
 * @param options - Hallucination detection options
 * @tier mixed (Tier 1 exact match + Tier 2 similarity + optional Tier 3 judge)
 */
export function toNotHallucinate(
  references: string[],
  options: HallucinationOptions = {},
): Assertion {
  const maxScore = options.maxHallucinationScore ?? 0.3;
  const maxUngrounded = options.maxUngroundedClaims ?? 3;
  const failOnContradiction = options.failOnContradiction ?? true;

  return makeHallucinationAssertion(
    '[Tier 1+2] output does not hallucinate',
    'Hallucination analysis',
    references,
    options,
    (result) => {
      // Immediate fail on contradiction
      if (failOnContradiction && result.statusCounts['contradicted'] > 0) {
        const contradictions = result.flaggedClaims
          .filter((c) => c.status === 'contradicted')
          .map((c) => `"${c.claim.text.slice(0, 80)}"`)
          .join('; ');
        return {
          status: 'fail',
          message: `Output contradicts reference material: ${contradictions}`,
          expected: 'No contradictions',
          actual: `${result.statusCounts['contradicted']} contradiction(s)`,
          evidence: result.summary,
        };
      }

      // Check hallucination score
      if (result.hallucinationScore > maxScore) {
        return {
          status: 'fail',
          message: `Hallucination score ${(result.hallucinationScore * 100).toFixed(1)}% exceeds threshold ${(maxScore * 100).toFixed(1)}%`,
          expected: `<= ${(maxScore * 100).toFixed(1)}% hallucination`,
          actual: `${(result.hallucinationScore * 100).toFixed(1)}% hallucination`,
          evidence: result.summary,
        };
      }

      // Check ungrounded count
      const ungroundedCount = result.statusCounts['ungrounded'] + result.statusCounts['contradicted'];
      if (ungroundedCount > maxUngrounded) {
        return {
          status: 'fail',
          message: `${ungroundedCount} ungrounded claims exceeds maximum of ${maxUngrounded}`,
          expected: `<= ${maxUngrounded} ungrounded claims`,
          actual: `${ungroundedCount} ungrounded claims`,
          evidence: result.summary,
        };
      }

      return {
        status: 'pass',
        evidence: result.summary,
      };
    },
  );
}

/**
 * Assert that all claims in output are grounded in references.
 *
 * Stricter than toNotHallucinate - requires all verifiable claims to be grounded.
 * Partially-grounded claims are allowed but flagged.
 *
 * @param references - Reference texts to verify against
 * @param options - Verification options
 * @tier mixed (Tier 1+2)
 */
export function toBeFullyGrounded(
  references: string[],
  options: HallucinationOptions = {},
): Assertion {
  return makeHallucinationAssertion(
    '[Tier 1+2] all claims are grounded in references',
    'Grounding analysis',
    references,
    options,
    (result) => {
      const ungrounded = result.verifications.filter(
        (v) => v.status === 'ungrounded' || v.status === 'contradicted',
      );

      if (ungrounded.length > 0) {
        const examples = ungrounded
          .slice(0, 3)
          .map((v) => `[${v.status}] "${v.claim.text.slice(0, 60)}..."`)
          .join('\n');
        return {
          status: 'fail',
          message: `${ungrounded.length} claim(s) not grounded in references`,
          expected: 'All claims grounded',
          actual: `${ungrounded.length} ungrounded/contradicted`,
          evidence: examples,
        };
      }

      return {
        status: 'pass',
        evidence: result.summary,
      };
    },
  );
}

/**
 * Assert that output has no contradictions with reference material.
 *
 * Only checks for direct contradictions (numbers that differ, facts that conflict).
 * Does NOT flag ungrounded claims - only actively wrong ones.
 *
 * @param references - Reference texts to check for contradictions
 * @param options - Verification options
 * @tier Tier 2 (heuristic number/fact comparison)
 */
export function toNotContradict(
  references: string[],
  options: HallucinationOptions = {},
): Assertion {
  return makeHallucinationAssertion(
    '[Tier 2] output does not contradict references',
    'Contradiction check',
    references,
    options,
    (result) => {
      const contradictions = result.verifications.filter((v) => v.status === 'contradicted');

      if (contradictions.length > 0) {
        const examples = contradictions
          .slice(0, 3)
          .map((v) => `"${v.claim.text.slice(0, 80)}" - ${v.reason ?? 'contradicts reference'}`)
          .join('\n');
        return {
          status: 'fail',
          message: `${contradictions.length} contradiction(s) found`,
          expected: 'No contradictions',
          actual: `${contradictions.length} contradiction(s)`,
          evidence: examples,
        };
      }

      return {
        status: 'pass',
        evidence: `Checked ${result.claims.length} claims, no contradictions found.`,
      };
    },
  );
}

/**
 * Assert that hallucination score is below a specific threshold.
 *
 * @param references - Reference texts to verify against
 * @param maxScore - Maximum allowed hallucination score (0-1). Default: 0.3
 * @param options - Analysis options
 * @tier mixed (Tier 1+2)
 */
export function toHaveHallucinationScoreBelow(
  references: string[],
  maxScore = 0.3,
  options: HallucinationOptions = {},
): Assertion {
  return makeHallucinationAssertion(
    `[Tier 1+2] hallucination score < ${(maxScore * 100).toFixed(0)}%`,
    'Score check',
    references,
    options,
    (result) => {
      const pass = result.hallucinationScore <= maxScore;
      return {
        status: pass ? 'pass' : 'fail',
        message: pass ? undefined : `Hallucination score ${(result.hallucinationScore * 100).toFixed(1)}% exceeds ${(maxScore * 100).toFixed(0)}%`,
        expected: `<= ${(maxScore * 100).toFixed(0)}%`,
        actual: `${(result.hallucinationScore * 100).toFixed(1)}%`,
        evidence: result.summary,
      };
    },
  );
}

/**
 * Assert that a minimum percentage of claims are grounded.
 *
 * @param references - Reference texts to verify against
 * @param minGroundedPercent - Minimum percentage of claims that must be grounded (0-1). Default: 0.7
 * @param options - Analysis options
 * @tier mixed (Tier 1+2)
 */
export function toHaveGroundingAbove(
  references: string[],
  minGroundedPercent = 0.7,
  options: HallucinationOptions = {},
): Assertion {
  return makeHallucinationAssertion(
    `[Tier 1+2] >= ${(minGroundedPercent * 100).toFixed(0)}% claims grounded`,
    'Grounding check',
    references,
    options,
    (result) => {
      const verifiable = result.verifications.filter(
        (v) => v.status !== 'unverifiable' && v.status !== 'self-referential',
      );

      if (verifiable.length === 0) {
        return {
          status: 'pass',
          evidence: 'No verifiable claims found (vacuously true).',
        };
      }

      const grounded = verifiable.filter(
        (v) => v.status === 'grounded' || v.status === 'partially-grounded',
      );
      const groundedPercent = grounded.length / verifiable.length;
      const pass = groundedPercent >= minGroundedPercent;

      return {
        status: pass ? 'pass' : 'fail',
        message: pass ? undefined : `Only ${(groundedPercent * 100).toFixed(1)}% of claims are grounded`,
        expected: `>= ${(minGroundedPercent * 100).toFixed(0)}%`,
        actual: `${(groundedPercent * 100).toFixed(1)}% (${grounded.length}/${verifiable.length})`,
        evidence: result.summary,
      };
    },
  );
}
