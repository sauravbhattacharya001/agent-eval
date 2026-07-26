/**
 * Hallucination check — verification & analysis engine.
 *
 * The reference-grounding half of the hallucination judge: takes extracted
 * claims and decides whether each is grounded, ungrounded, contradicted,
 * partially-grounded, unverifiable, or self-referential, then rolls the
 * per-claim verdicts up into a single hallucination score.
 *
 * Verification tiers are applied in independence order:
 * - Tier 1 (`tier1-exact`): exact/substring match — the agent can't forge a
 *   literal hit in the reference text.
 * - Tier 2 (`tier2-similarity`): sliding-window word-overlap similarity and
 *   numeric-contradiction detection against the best-matching passage.
 * - Tier 3 (`tier3-judge`, optional): model-as-judge over the claim + the
 *   best-matching passage, used only for ambiguous Tier-2 outcomes. The judge
 *   itself lives in `./hallucination-judge.js`; this module only wires it in.
 *
 * Re-exported from `./hallucination.js` so consumers keep one import path.
 *
 * @tier mixed (1+2+3)
 * @module
 */

import type {
  ClaimStatus,
  ClaimVerification,
  ExtractedClaim,
  HallucinationOptions,
  HallucinationResult,
  VerificationOptions,
} from './hallucination-types.js';
import { extractClaims } from './hallucination-extraction.js';
import { verifyWithJudge } from './hallucination-judge.js';

// The Tier-3 grounding rubric lives in `./hallucination-judge.js`; re-export it
// here so the historical `hallucination-verification.js` import path is stable.
export { HALLUCINATION_RUBRIC } from './hallucination-judge.js';

// === VERIFICATION ============================================================

/** Tokenize text into lowercase words. */
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

/** Compute Jaccard word overlap between two texts. */
export function wordOverlap(text1: string, text2: string): number {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));
  if (tokens1.size === 0 || tokens2.size === 0) return 0;
  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }
  const union = new Set([...tokens1, ...tokens2]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Find best-matching passage in references using sliding window. */
export function findBestMatch(
  claim: string,
  references: string[],
  windowSize: number,
): { similarity: number; passage: string; sourceIndex: number } {
  let bestSimilarity = 0;
  let bestPassage = '';
  let bestSource = 0;

  const claimLower = claim.toLowerCase();

  for (let refIdx = 0; refIdx < references.length; refIdx++) {
    const ref = references[refIdx];
    if (!ref) continue;
    // Tier 1: exact substring
    if (ref.toLowerCase().includes(claimLower)) {
      return { similarity: 1.0, passage: claim, sourceIndex: refIdx };
    }
    // Sliding window
    const words = ref.split(/\s+/);
    const claimWordCount = claim.split(/\s+/).length;
    const windowWords = Math.max(claimWordCount * 2, Math.ceil(windowSize / 5));
    const step = Math.max(1, Math.floor(windowWords / 3));

    for (let i = 0; i <= Math.max(0, words.length - windowWords); i += step) {
      const window = words.slice(i, i + windowWords).join(' ');
      const sim = wordOverlap(claim, window);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestPassage = window;
        bestSource = refIdx;
      }
    }
  }
  return { similarity: bestSimilarity, passage: bestPassage, sourceIndex: bestSource };
}

/** Check if a claim contradicts a reference (same context, different numbers). */
export function checkContradiction(claim: string, reference: string): boolean {
  const claimNumbers = claim.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const refNumbers = reference.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (claimNumbers.length === 0 || refNumbers.length === 0) return false;
  if (wordOverlap(claim, reference) < 0.4) return false;

  for (const cn of claimNumbers) {
    for (const rn of refNumbers) {
      if (cn !== rn && Math.abs(cn - rn) / Math.max(cn, rn, 1) > 0.3) return true;
    }
  }
  return false;
}

/** Determine if a claim is self-referential (refers to the output itself). */
function isSelfReferential(claim: string): boolean {
  return /^(?:the (?:above|following|output|response|answer|code|result)|this (?:shows|demonstrates|example|section)|as (?:shown|described|mentioned) (?:above|below))/i.test(claim);
}

/**
 * Verify a single claim against reference context.
 *
 * Applies verification tiers in order:
 * 1. Exact/substring match (Tier 1)
 * 2. Similarity scoring with sliding window (Tier 2)
 * 3. Judge evaluation for ambiguous cases (Tier 3, optional)
 */
export function verifyClaim(
  claim: ExtractedClaim,
  references: string[],
  options: VerificationOptions = {},
): ClaimVerification {
  const {
    exactMatchThreshold = 0.8,
    similarityThreshold = 0.7,
    partialThreshold = 0.4,
    contextWindow = 500,
  } = options;

  if (isSelfReferential(claim.text)) {
    return {
      claim, status: 'self-referential', verifiedBy: 'heuristic',
      confidence: 0.9, reason: 'Claim refers to the output itself, not external facts',
    };
  }

  if (references.length === 0) {
    return {
      claim, status: 'unverifiable', verifiedBy: 'heuristic',
      confidence: 1.0, reason: 'No reference context provided for verification',
    };
  }

  const { similarity, passage } = findBestMatch(claim.text, references, contextWindow);

  // Tier 1: Exact/near-exact match
  if (similarity >= exactMatchThreshold) {
    return {
      claim, status: 'grounded', verifiedBy: 'tier1-exact',
      confidence: Math.min(similarity, 0.99), groundingEvidence: passage,
    };
  }

  // Tier 2: Similarity-based
  if (similarity >= similarityThreshold) {
    if (checkContradiction(claim.text, passage)) {
      return {
        claim, status: 'contradicted', verifiedBy: 'tier2-similarity',
        confidence: 0.7, groundingEvidence: passage,
        reason: 'Similar context found but key facts differ',
      };
    }
    return {
      claim, status: 'grounded', verifiedBy: 'tier2-similarity',
      confidence: similarity * 0.9, groundingEvidence: passage,
    };
  }

  if (similarity >= partialThreshold) {
    if (checkContradiction(claim.text, passage)) {
      return {
        claim, status: 'contradicted', verifiedBy: 'tier2-similarity',
        confidence: 0.6, groundingEvidence: passage,
        reason: 'Partial context match with contradicting details',
      };
    }
    return {
      claim, status: 'partially-grounded', verifiedBy: 'tier2-similarity',
      confidence: similarity * 0.8, groundingEvidence: passage,
      reason: 'Some overlap with reference but claim extends beyond what context supports',
    };
  }

  return {
    claim, status: 'ungrounded', verifiedBy: 'tier2-similarity',
    confidence: Math.max(0.5, 1 - similarity),
    reason: 'No supporting evidence found in provided references',
  };
}

/** Verify multiple claims, optionally using Tier 3 judge for ambiguous results. */
export async function verifyClaims(
  claims: ExtractedClaim[],
  references: string[],
  options: VerificationOptions = {},
): Promise<ClaimVerification[]> {
  const results: ClaimVerification[] = [];
  for (const claim of claims) {
    const result = verifyClaim(claim, references, options);
    if (
      options.useTier3 && options.judgeBackend &&
      (result.status === 'partially-grounded' || result.status === 'unverifiable')
    ) {
      const tier3Result = await verifyWithJudge(claim, references, result, options.judgeBackend);
      results.push(tier3Result);
    } else {
      results.push(result);
    }
  }
  return results;
}

// === MAIN ANALYSIS ===========================================================

/**
 * Run a full hallucination analysis on agent output.
 *
 * Extracts claims, verifies them against references, and produces a
 * comprehensive result with hallucination scoring.
 *
 * @example
 * ```ts
 * const result = await analyzeHallucination(
 *   agentOutput,
 *   [contextDoc, referenceDoc],
 *   { maxHallucinationScore: 0.2, failOnContradiction: true }
 * );
 * ```
 */
export async function analyzeHallucination(
  output: string,
  references: string[],
  options: HallucinationOptions = {},
): Promise<HallucinationResult> {
  const start = performance.now();

  const claims = extractClaims(output, options);
  const verifications = await verifyClaims(claims, references, options);

  // Count by status
  const statusCounts: Record<ClaimStatus, number> = {
    'grounded': 0, 'ungrounded': 0, 'contradicted': 0,
    'partially-grounded': 0, 'unverifiable': 0, 'self-referential': 0,
  };
  for (const v of verifications) statusCounts[v.status]++;

  // Compute hallucination score
  const verifiableClaims = verifications.filter(
    (v) => v.status !== 'unverifiable' && v.status !== 'self-referential',
  );

  let hallucinationScore = 0;
  if (verifiableClaims.length > 0) {
    let score = 0;
    for (const v of verifiableClaims) {
      switch (v.status) {
        case 'contradicted': score += 1.0; break;
        case 'ungrounded': score += 0.8; break;
        case 'partially-grounded': score += 0.3; break;
        case 'grounded': score += 0; break;
      }
    }
    hallucinationScore = score / verifiableClaims.length;
  }

  // Flagged claims: ungrounded + contradicted, sorted by confidence desc
  const flaggedClaims = verifications
    .filter((v) => v.status === 'ungrounded' || v.status === 'contradicted')
    .sort((a, b) => b.confidence - a.confidence);

  // Build summary
  const totalClaims = claims.length;
  const parts: string[] = [];
  parts.push(`Analyzed ${totalClaims} claims from output.`);
  if (flaggedClaims.length === 0) {
    parts.push('No hallucinations detected.');
  } else {
    parts.push(`Found ${flaggedClaims.length} potentially hallucinated claim(s):`);
    parts.push(`  - ${statusCounts['contradicted']} contradicted`);
    parts.push(`  - ${statusCounts['ungrounded']} ungrounded`);
  }
  parts.push(`Hallucination score: ${(hallucinationScore * 100).toFixed(1)}%`);

  return {
    claims,
    verifications,
    hallucinationScore,
    statusCounts,
    flaggedClaims,
    summary: parts.join(' '),
    durationMs: performance.now() - start,
  };
}
