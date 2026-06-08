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
 * @tier mixed (1+2+3)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
} from './judge.js';
import {
  buildRubric,
  JudgeEvaluator,
} from './judge.js';

// === TYPES ===================================================================

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

// === CLAIM EXTRACTION ========================================================

/** Non-claim sentence patterns (opinions, questions, instructions). */
const NON_CLAIM_PATTERNS: RegExp[] = [
  /^(?:please|you\s+(?:should|can|could|might|may)|try|make\s+sure|consider|remember|note\s+that|let'?s)/i,
  /\?$/,
  /^(?:I\s+(?:think|believe|suggest|recommend|would)|in\s+my\s+(?:opinion|view)|here(?:'s|\s+is))/i,
  /^(?:it\s+(?:might|may|could|seems?)|perhaps|possibly|probably|likely)/i,
  /^.{0,15}$/,
];

/** Remove code blocks from text. */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
}

/** Split text into sentences. */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z])|(?<=\n)\s*(?=[A-Z])/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 10) sentences.push(trimmed);
  }
  return sentences;
}

/** Check if a sentence is not a verifiable claim. */
function isNonClaim(text: string): boolean {
  return NON_CLAIM_PATTERNS.some((p) => p.test(text.trim()));
}

/** Claim extraction patterns with confidence scores. */
const CLAIM_PATTERNS: { kind: ClaimKind; pattern: RegExp; confidence: number }[] = [
  {
    kind: 'statistic',
    pattern: /([^.!?\n]*?\b(?:\d+(?:\.\d+)?%|\d{2,}(?:,\d{3})*(?:\.\d+)?)\b[^.!?\n]*)/gm,
    confidence: 0.85,
  },
  {
    kind: 'attribution',
    pattern: /([^.!?\n]*?(?:according to|said|stated|reported|claimed|argued|noted|found|showed|demonstrated|published|announced|confirmed|revealed)\b[^.!?\n]*)/gmi,
    confidence: 0.9,
  },
  {
    kind: 'quote',
    pattern: /([^.!?\n]*?[""][^""]+[""][^.!?\n]*)/gm,
    confidence: 0.8,
  },
  {
    kind: 'temporal',
    pattern: /([^.!?\n]*?\b(?:in (?:19|20)\d{2}|since (?:19|20)\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?)\b[^.!?\n]*)/gmi,
    confidence: 0.8,
  },
  {
    kind: 'reference',
    pattern: /([^.!?\n]*?(?:https?:\/\/[^\s]+|`[^`]+`)[^.!?\n]*)/gm,
    confidence: 0.75,
  },
  {
    kind: 'causal',
    pattern: /([^.!?\n]*?\b(?:causes?|leads?\s+to|results?\s+in|because|due\s+to|consequently|therefore)\b[^.!?\n]*)/gmi,
    confidence: 0.7,
  },
  {
    kind: 'existence',
    pattern: /([^.!?\n]*?\b(?:there (?:is|are|exists?)|contains?|includes?|provides?|offers?|supports?)\b[^.!?\n]*)/gmi,
    confidence: 0.6,
  },
];

/**
 * Extract verifiable factual claims from agent output text.
 *
 * Identifies sentences making factual assertions checkable against references.
 * Filters out opinions, questions, instructions, and meta-text.
 */
export function extractClaims(
  output: string,
  options: ClaimExtractionOptions = {},
): ExtractedClaim[] {
  const {
    minConfidence = 0.5,
    includeCodeBlocks = false,
    maxClaims = 50,
    kinds,
  } = options;

  const processedText = includeCodeBlocks ? output : stripCodeBlocks(output);
  const claims: ExtractedClaim[] = [];
  const seenRanges: Array<[number, number]> = [];

  function overlaps(start: number, end: number): boolean {
    return seenRanges.some(
      ([s, e]) => (start >= s && start < e) || (end > s && end <= e) || (start <= s && end >= e),
    );
  }

  const patterns = kinds
    ? CLAIM_PATTERNS.filter((p) => kinds.includes(p.kind))
    : CLAIM_PATTERNS;

  for (const { kind, pattern, confidence } of patterns) {
    if (confidence < minConfidence) continue;
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(processedText)) !== null) {
      const claimText = (match[1] ?? match[0]).trim();
      if (claimText.length < 15) continue;
      if (isNonClaim(claimText)) continue;

      const startOffset = output.indexOf(claimText);
      if (startOffset === -1) continue;
      const endOffset = startOffset + claimText.length;
      if (overlaps(startOffset, endOffset)) continue;

      seenRanges.push([startOffset, endOffset]);
      claims.push({ text: claimText, kind, startOffset, endOffset, extractionConfidence: confidence });
      if (claims.length >= maxClaims) break;
    }
    if (claims.length >= maxClaims) break;
  }

  // Fallback: sentence-level scan for factual-sounding sentences
  if (claims.length < maxClaims) {
    const sentences = splitIntoSentences(processedText);
    for (const sentence of sentences) {
      if (claims.length >= maxClaims) break;
      if (isNonClaim(sentence)) continue;
      if (sentence.length < 20 || sentence.length > 500) continue;

      const startOffset = output.indexOf(sentence);
      if (startOffset === -1) continue;
      const endOffset = startOffset + sentence.length;
      if (overlaps(startOffset, endOffset)) continue;

      const hasFactualIndicators =
        /\b(?:is|are|was|were|has|have|had|does|did)\b/i.test(sentence) &&
        !/^(?:this|that|it)\s/i.test(sentence);

      if (hasFactualIndicators) {
        seenRanges.push([startOffset, endOffset]);
        claims.push({
          text: sentence, kind: 'factual', startOffset, endOffset,
          extractionConfidence: 0.5,
        });
      }
    }
  }

  claims.sort((a, b) => a.startOffset - b.startOffset);
  return claims;
}

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

// === TIER 3: JUDGE-BASED VERIFICATION ========================================

/** Built-in rubric for hallucination verification. */
export const HALLUCINATION_RUBRIC: Rubric = buildRubric('Hallucination Verification')
  .describe('Evaluate whether a specific claim is grounded in provided reference materials.')
  .criterion('grounding', 'Is the claim supported by the reference materials?')
    .weight(0.6)
    .level(1, 'Contradicted', 'The reference directly contradicts this claim')
    .level(2, 'Ungrounded', 'No relevant information in references supports this claim')
    .level(3, 'Partially grounded', 'Some aspects are supported but claim extends beyond')
    .level(4, 'Mostly grounded', 'The core assertion is supported with minor gaps')
    .level(5, 'Fully grounded', 'The claim is directly and completely supported by references')
    .done()
  .criterion('specificity', 'How specific and verifiable is this claim?')
    .weight(0.2)
    .level(1, 'Vague', 'Too vague to verify meaningfully')
    .level(3, 'Moderate', 'Makes some specific assertions')
    .level(5, 'Highly specific', 'Makes precise, verifiable assertions')
    .done()
  .criterion('severity', 'If hallucinated, how harmful would this be?')
    .weight(0.2)
    .level(1, 'Critical', 'Would cause significant harm if believed')
    .level(3, 'Moderate', 'Could mislead but unlikely to cause direct harm')
    .level(5, 'Low', 'Minor inaccuracy with minimal real-world impact')
    .done()
  .passAt(0.6)
  .confidenceAt(0.6)
  .build();

/** Use Tier 3 judge to verify an ambiguous claim. */
async function verifyWithJudge(
  claim: ExtractedClaim,
  references: string[],
  tier2Result: ClaimVerification,
  backend: JudgeBackend,
): Promise<ClaimVerification> {
  const evaluator = new JudgeEvaluator(backend, HALLUCINATION_RUBRIC);

  const judgeInput = [
    `CLAIM TO VERIFY: "${claim.text}"`,
    `CLAIM TYPE: ${claim.kind}`,
    '',
    'REFERENCE MATERIALS:',
    ...references.map((r, i) => `--- Reference ${i + 1} ---\n${r.slice(0, 2000)}`),
    '',
    tier2Result.groundingEvidence
      ? `BEST MATCHING PASSAGE: "${tier2Result.groundingEvidence}"`
      : 'NO CLOSE MATCH FOUND IN REFERENCES',
  ].join('\n');

  try {
    const result = await evaluator.evaluate(judgeInput, {
      task: 'Verify whether this claim is grounded in the provided reference materials.',
      references,
    });

    const groundingScore = result.criterionScores.find((s) => s.criterionId === 'grounding');
    const normalizedGrounding = groundingScore?.normalizedScore ?? 0;

    let status: ClaimStatus;
    if (normalizedGrounding >= 0.8) status = 'grounded';
    else if (normalizedGrounding >= 0.5) status = 'partially-grounded';
    else if (normalizedGrounding <= 0.2) status = 'contradicted';
    else status = 'ungrounded';

    if (result.confidence === 'low') status = 'unverifiable';

    return {
      claim, status, verifiedBy: 'tier3-judge',
      confidence: result.confidenceValue,
      groundingEvidence: tier2Result.groundingEvidence,
      reason: result.summary,
    };
  } catch {
    return tier2Result;
  }
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

  return {
    name: '[Tier 1+2] output does not hallucinate',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);

        // Immediate fail on contradiction
        if (failOnContradiction && result.statusCounts['contradicted'] > 0) {
          const contradictions = result.flaggedClaims
            .filter((c) => c.status === 'contradicted')
            .map((c) => `"${c.claim.text.slice(0, 80)}"`)
            .join('; ');
          return {
            status: 'fail',
            name: '[Tier 1+2] output does not hallucinate',
            message: `Output contradicts reference material: ${contradictions}`,
            expected: 'No contradictions',
            actual: `${result.statusCounts['contradicted']} contradiction(s)`,
            evidence: result.summary,
            durationMs: performance.now() - start,
          };
        }

        // Check hallucination score
        if (result.hallucinationScore > maxScore) {
          return {
            status: 'fail',
            name: '[Tier 1+2] output does not hallucinate',
            message: `Hallucination score ${(result.hallucinationScore * 100).toFixed(1)}% exceeds threshold ${(maxScore * 100).toFixed(1)}%`,
            expected: `<= ${(maxScore * 100).toFixed(1)}% hallucination`,
            actual: `${(result.hallucinationScore * 100).toFixed(1)}% hallucination`,
            evidence: result.summary,
            durationMs: performance.now() - start,
          };
        }

        // Check ungrounded count
        const ungroundedCount = result.statusCounts['ungrounded'] + result.statusCounts['contradicted'];
        if (ungroundedCount > maxUngrounded) {
          return {
            status: 'fail',
            name: '[Tier 1+2] output does not hallucinate',
            message: `${ungroundedCount} ungrounded claims exceeds maximum of ${maxUngrounded}`,
            expected: `<= ${maxUngrounded} ungrounded claims`,
            actual: `${ungroundedCount} ungrounded claims`,
            evidence: result.summary,
            durationMs: performance.now() - start,
          };
        }

        return {
          status: 'pass',
          name: '[Tier 1+2] output does not hallucinate',
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 1+2] output does not hallucinate',
          message: `Hallucination analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
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
  return {
    name: '[Tier 1+2] all claims are grounded in references',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);

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
            name: '[Tier 1+2] all claims are grounded in references',
            message: `${ungrounded.length} claim(s) not grounded in references`,
            expected: 'All claims grounded',
            actual: `${ungrounded.length} ungrounded/contradicted`,
            evidence: examples,
            durationMs: performance.now() - start,
          };
        }

        return {
          status: 'pass',
          name: '[Tier 1+2] all claims are grounded in references',
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 1+2] all claims are grounded in references',
          message: `Grounding analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
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
  return {
    name: '[Tier 2] output does not contradict references',
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);

        const contradictions = result.verifications.filter((v) => v.status === 'contradicted');

        if (contradictions.length > 0) {
          const examples = contradictions
            .slice(0, 3)
            .map((v) => `"${v.claim.text.slice(0, 80)}" - ${v.reason ?? 'contradicts reference'}`)
            .join('\n');
          return {
            status: 'fail',
            name: '[Tier 2] output does not contradict references',
            message: `${contradictions.length} contradiction(s) found`,
            expected: 'No contradictions',
            actual: `${contradictions.length} contradiction(s)`,
            evidence: examples,
            durationMs: performance.now() - start,
          };
        }

        return {
          status: 'pass',
          name: '[Tier 2] output does not contradict references',
          evidence: `Checked ${result.claims.length} claims, no contradictions found.`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 2] output does not contradict references',
          message: `Contradiction check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
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
  return {
    name: `[Tier 1+2] hallucination score < ${(maxScore * 100).toFixed(0)}%`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);

        const pass = result.hallucinationScore <= maxScore;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 1+2] hallucination score < ${(maxScore * 100).toFixed(0)}%`,
          message: pass ? undefined : `Hallucination score ${(result.hallucinationScore * 100).toFixed(1)}% exceeds ${(maxScore * 100).toFixed(0)}%`,
          expected: `<= ${(maxScore * 100).toFixed(0)}%`,
          actual: `${(result.hallucinationScore * 100).toFixed(1)}%`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 1+2] hallucination score < ${(maxScore * 100).toFixed(0)}%`,
          message: `Score check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
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
  return {
    name: `[Tier 1+2] >= ${(minGroundedPercent * 100).toFixed(0)}% claims grounded`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);

        const verifiable = result.verifications.filter(
          (v) => v.status !== 'unverifiable' && v.status !== 'self-referential',
        );

        if (verifiable.length === 0) {
          return {
            status: 'pass',
            name: `[Tier 1+2] >= ${(minGroundedPercent * 100).toFixed(0)}% claims grounded`,
            evidence: 'No verifiable claims found (vacuously true).',
            durationMs: performance.now() - start,
          };
        }

        const grounded = verifiable.filter(
          (v) => v.status === 'grounded' || v.status === 'partially-grounded',
        );
        const groundedPercent = grounded.length / verifiable.length;
        const pass = groundedPercent >= minGroundedPercent;

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 1+2] >= ${(minGroundedPercent * 100).toFixed(0)}% claims grounded`,
          message: pass ? undefined : `Only ${(groundedPercent * 100).toFixed(1)}% of claims are grounded`,
          expected: `>= ${(minGroundedPercent * 100).toFixed(0)}%`,
          actual: `${(groundedPercent * 100).toFixed(1)}% (${grounded.length}/${verifiable.length})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 1+2] >= ${(minGroundedPercent * 100).toFixed(0)}% claims grounded`,
          message: `Grounding check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
