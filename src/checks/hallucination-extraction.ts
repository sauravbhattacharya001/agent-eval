/**
 * Hallucination check — claim extraction.
 *
 * Identifies verifiable factual claims in agent output (statistics,
 * attributions, quotes, temporal/causal/existence assertions, references) and
 * filters out opinions, questions, instructions, and meta-text. This is the
 * pure text→claims half of the hallucination judge; it performs no
 * verification against references.
 *
 * Re-exported from `./hallucination.js` so consumers keep one import path.
 *
 * @tier mixed (feeds Tier 1+2 verification)
 * @module
 */

import type { ClaimKind, ClaimExtractionOptions, ExtractedClaim } from './hallucination-types.js';

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
