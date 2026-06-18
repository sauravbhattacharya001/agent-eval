/**
 * Hallucination check — type vocabulary.
 *
 * The shared types for the hallucination judge: the extracted-claim model, the
 * verification model, and the option/result bags used across extraction,
 * verification, and the assertion factories. This module is **logic-free** (no
 * runtime code, no regex tables) so the type contract has a single home and can
 * be imported without pulling in the extraction/verification engines.
 *
 * Re-exported from `./hallucination.js` so consumers keep one import path.
 *
 * @module
 */

import type { JudgeBackend } from './judge.js';

/** A single factual claim extracted from agent output. */
export interface ExtractedClaim {
  /** The claim text as found in the output. */
  text: string;
  /** Category of claim (helps determine verification strategy). */
  kind: ClaimKind;
  /** Start position in the original output. */
  startOffset: number;
  /** End position in the original output. */
  endOffset: number;
  /** Confidence that this is indeed a factual claim (0-1). */
  extractionConfidence: number;
}

/** Types of claims that can be extracted. */
export type ClaimKind =
  | 'statistic'
  | 'attribution'
  | 'factual'
  | 'reference'
  | 'quote'
  | 'temporal'
  | 'causal'
  | 'existence';

/** Result of verifying a single claim against context. */
export interface ClaimVerification {
  /** The original claim. */
  claim: ExtractedClaim;
  /** Verification status. */
  status: ClaimStatus;
  /** How was this claim verified (which tier)? */
  verifiedBy: VerificationTier;
  /** Confidence in the verification result (0-1). */
  confidence: number;
  /** The reference passage that supports this claim (if grounded). */
  groundingEvidence?: string;
  /** Explanation of why this was flagged. */
  reason?: string;
}

/** Status of a verified claim. */
export type ClaimStatus =
  | 'grounded'
  | 'ungrounded'
  | 'contradicted'
  | 'partially-grounded'
  | 'unverifiable'
  | 'self-referential';

/** Which tier verified the claim. */
export type VerificationTier = 'tier1-exact' | 'tier2-similarity' | 'tier3-judge' | 'heuristic';

/** Options for claim extraction. */
export interface ClaimExtractionOptions {
  /** Minimum confidence for a claim to be included. Default: 0.5 */
  minConfidence?: number;
  /** Whether to extract claims from code blocks. Default: false */
  includeCodeBlocks?: boolean;
  /** Maximum number of claims to extract. Default: 50 */
  maxClaims?: number;
  /** Claim kinds to extract. Default: all */
  kinds?: ClaimKind[];
}

/** Options for claim verification. */
export interface VerificationOptions {
  /** Tier 1 exact match threshold. Default: 0.8 */
  exactMatchThreshold?: number;
  /** Tier 2 similarity threshold for "grounded". Default: 0.7 */
  similarityThreshold?: number;
  /** Tier 2 similarity threshold for "partially grounded". Default: 0.4 */
  partialThreshold?: number;
  /** Whether to use Tier 3 judge for ambiguous claims. Default: false */
  useTier3?: boolean;
  /** Judge backend for Tier 3 evaluation. */
  judgeBackend?: JudgeBackend;
  /** Maximum context window per claim for similarity search (chars). Default: 500 */
  contextWindow?: number;
}

/** Full hallucination analysis result. */
export interface HallucinationResult {
  /** All extracted claims. */
  claims: ExtractedClaim[];
  /** Verification results for each claim. */
  verifications: ClaimVerification[];
  /** Overall hallucination score (0=clean, 1=all hallucinated). */
  hallucinationScore: number;
  /** Count of claims by status. */
  statusCounts: Record<ClaimStatus, number>;
  /** Flagged claims (ungrounded + contradicted, sorted by confidence). */
  flaggedClaims: ClaimVerification[];
  /** Summary explanation. */
  summary: string;
  /** Duration of analysis in milliseconds. */
  durationMs: number;
}

/** Options for the full hallucination analysis. */
export interface HallucinationOptions extends ClaimExtractionOptions, VerificationOptions {
  /** Maximum hallucination score before failing. Default: 0.3 */
  maxHallucinationScore?: number;
  /** Maximum number of ungrounded claims before failing. Default: 3 */
  maxUngroundedClaims?: number;
  /** Whether contradictions should cause immediate failure. Default: true */
  failOnContradiction?: boolean;
}
