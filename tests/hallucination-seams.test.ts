/**
 * Seam tests for the Hallucination check split.
 *
 * `hallucination.ts` was split into three sibling seams — `hallucination-types.ts`
 * (type vocabulary), `hallucination-extraction.ts` (text → factual claims), and
 * `hallucination-verification.ts` (claim grounding + scoring, Tier 1+2+3) — with
 * `hallucination.ts` kept as the public barrel (re-exporting everything) plus the
 * assertion factories (`toNotHallucinate`, `toBeFullyGrounded`, …).
 *
 * The behavioural suite in `hallucination.test.ts` imports everything from
 * `hallucination.js` and therefore only reaches the moved units transitively.
 * These tests pin the seam boundary itself:
 *   1. each unit is importable from its OWN new module, and
 *   2. `hallucination.js` re-exports the *same function reference* (the barrel
 *      cannot silently diverge from the seam),
 * plus a few direct unit checks that exercise a seam through its own home — so a
 * future refactor that touches one seam can't quietly break another's contract.
 */

import { describe, it, expect } from 'vitest';

// Seam modules — imported directly from their new homes.
import {
  extractClaims as extractClaimsSeam,
} from '../src/checks/hallucination-extraction.js';
import {
  wordOverlap as wordOverlapSeam,
  findBestMatch as findBestMatchSeam,
  checkContradiction as checkContradictionSeam,
  verifyClaim as verifyClaimSeam,
  verifyClaims as verifyClaimsSeam,
  analyzeHallucination as analyzeHallucinationSeam,
  HALLUCINATION_RUBRIC as HALLUCINATION_RUBRIC_SEAM,
} from '../src/checks/hallucination-verification.js';

// Public barrel — what consumers import.
import {
  extractClaims,
  wordOverlap,
  findBestMatch,
  checkContradiction,
  verifyClaim,
  verifyClaims,
  analyzeHallucination,
  HALLUCINATION_RUBRIC,
  type ExtractedClaim,
  type ClaimKind,
} from '../src/checks/hallucination.js';

// Pure type-vocabulary seam — importable on its own and structurally compatible
// with the barrel's re-export of the same names.
import type {
  ExtractedClaim as ExtractedClaimTypeSeam,
  ClaimStatus as ClaimStatusTypeSeam,
} from '../src/checks/hallucination-types.js';

function makeClaim(text: string, kind: ClaimKind = 'factual', offset = 0): ExtractedClaim {
  return { text, kind, startOffset: offset, endOffset: offset + text.length, extractionConfidence: 0.8 };
}

// ─── RE-EXPORT IDENTITY ──────────────────────────────────────────────────────────

describe('hallucination.ts re-exports the same references as its seams', () => {
  it('extraction seam (hallucination-extraction.ts)', () => {
    expect(extractClaims).toBe(extractClaimsSeam);
  });

  it('verification seam (hallucination-verification.ts)', () => {
    expect(wordOverlap).toBe(wordOverlapSeam);
    expect(findBestMatch).toBe(findBestMatchSeam);
    expect(checkContradiction).toBe(checkContradictionSeam);
    expect(verifyClaim).toBe(verifyClaimSeam);
    expect(verifyClaims).toBe(verifyClaimsSeam);
    expect(analyzeHallucination).toBe(analyzeHallucinationSeam);
  });

  it('built-in rubric is the same object via barrel and seam', () => {
    expect(HALLUCINATION_RUBRIC).toBe(HALLUCINATION_RUBRIC_SEAM);
  });

  it('types seam is structurally compatible with the barrel re-export', () => {
    // Compile-time guard: the type names resolve from the standalone types
    // module and are assignable to the barrel's re-exported shapes.
    const claim: ExtractedClaimTypeSeam = makeClaim('x');
    const status: ClaimStatusTypeSeam = 'grounded';
    expect(claim.kind).toBe('factual');
    expect(status).toBe('grounded');
  });
});

// ─── DIRECT UNIT CHECKS THROUGH EACH SEAM ────────────────────────────────────────

describe('extraction seam: extractClaims pulls verifiable claims out of text', () => {
  it('extracts a statistic claim and points offsets back into the source', () => {
    const text = 'The system processes 1500 requests per second under load.';
    const claims = extractClaimsSeam(text);
    expect(claims.length).toBeGreaterThan(0);
    const stat = claims.find((c) => c.kind === 'statistic') ?? claims[0];
    expect(text.slice(stat.startOffset, stat.endOffset)).toBe(stat.text);
  });

  it('filters out questions and instructions (non-claims)', () => {
    const claims = extractClaimsSeam('Please run the tests. Should we deploy now?');
    // Neither the imperative nor the question is a verifiable factual claim.
    expect(claims.every((c) => !c.text.trim().endsWith('?'))).toBe(true);
    expect(claims.some((c) => /^please\b/i.test(c.text.trim()))).toBe(false);
  });

  it('honours maxClaims and ignores code blocks by default', () => {
    const text = 'There are 42 widgets.\n```\nconst secret = 99999;\n```\nThe registry contains 7 entries.';
    const claims = extractClaimsSeam(text, { maxClaims: 1 });
    expect(claims.length).toBe(1);
    // The number inside the fenced code block must not surface as a claim.
    expect(claims.every((c) => !c.text.includes('99999'))).toBe(true);
  });
});

describe('verification seam: similarity, contradiction & grounding', () => {
  it('wordOverlap is 0 for disjoint text and high for identical text', () => {
    expect(wordOverlapSeam('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
    expect(wordOverlapSeam('the quick brown fox', 'the quick brown fox')).toBeGreaterThan(0.9);
  });

  it('findBestMatch returns an exact-substring hit at similarity 1.0', () => {
    const refs = ['unrelated text here', 'the cache holds 256 entries total'];
    const match = findBestMatchSeam('the cache holds 256 entries', refs, 500);
    expect(match.similarity).toBe(1.0);
    expect(match.sourceIndex).toBe(1);
  });

  it('checkContradiction flags differing numbers in similar context', () => {
    expect(checkContradictionSeam('the timeout is 30 seconds', 'the timeout is 120 seconds')).toBe(true);
    expect(checkContradictionSeam('the timeout is 30 seconds', 'bananas are yellow')).toBe(false);
  });

  it('verifyClaim marks a claim unverifiable when there are no references', () => {
    const v = verifyClaimSeam(makeClaim('the moon is made of cheese'), []);
    expect(v.status).toBe('unverifiable');
    expect(v.verifiedBy).toBe('heuristic');
  });

  it('verifyClaim grounds a claim that appears verbatim in the references', () => {
    const v = verifyClaimSeam(
      makeClaim('the build runs in 12 minutes'),
      ['Our CI pipeline: the build runs in 12 minutes on the standard runner.'],
    );
    expect(v.status).toBe('grounded');
    expect(v.verifiedBy).toBe('tier1-exact');
  });

  it('verifyClaims (Tier 1+2 only) returns one verdict per claim', async () => {
    const claims = [makeClaim('alpha is 5'), makeClaim('beta is 9')];
    const out = await verifyClaimsSeam(claims, ['alpha is 5 and that is all']);
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('grounded');
  });
});

describe('analysis seam: analyzeHallucination rolls verdicts into a score', () => {
  it('a fully-grounded output scores ~0 hallucination', async () => {
    const refs = ['The release shipped on March 3rd 2025 with 14 bug fixes.'];
    const result = await analyzeHallucinationSeam(
      'The release shipped on March 3rd 2025 with 14 bug fixes.',
      refs,
    );
    expect(result.hallucinationScore).toBeLessThan(0.2);
    expect(result.summary).toMatch(/hallucination score/i);
  });

  it('an ungrounded claim raises the score and is flagged', async () => {
    const result = await analyzeHallucinationSeam(
      'The product was launched in 1492 by Christopher Columbus.',
      ['This document is about TypeScript build tooling and has no history in it.'],
    );
    expect(result.hallucinationScore).toBeGreaterThan(0);
    expect(result.flaggedClaims.length).toBeGreaterThan(0);
  });

  it('exposes the built-in rubric with a grounding criterion', () => {
    expect(HALLUCINATION_RUBRIC_SEAM.name).toMatch(/hallucination/i);
    expect(HALLUCINATION_RUBRIC_SEAM.criteria.some((c) => c.id === 'grounding')).toBe(true);
  });
});
