/**
 * Repetition/Loop Detection - analysis engine.
 *
 * Pure text analysis: normalization + segmentation helpers, similarity, and the
 * four detectors (`analyzeRepetition`, `detectLoops`, `analyzeNgramSaturation`,
 * `analyzeFullRepetition`). No AI calls, no IO. The assertion factories that wrap
 * these live in `./repetition.js`, which re-exports this module so the public
 * surface stays a single `./repetition.js` import path.
 *
 * @tier 2 - Heuristic (no AI, detects behavioral patterns)
 * @module
 */

import type {
  RepetitionOptions,
  RepetitionInstance,
  RepetitionKind,
  RepetitionResult,
  LoopDetectionOptions,
  LoopInstance,
  LoopResult,
  NgramSaturationOptions,
  NgramSaturationResult,
  FullRepetitionOptions,
  FullRepetitionResult,
} from './repetition-types.js';

// ─── NORMALIZATION UTILITIES ────────────────────────────────────────────────────

/**
 * Normalize text for comparison.
 */
function normalize(
  text: string,
  options: { normalizeWhitespace?: boolean; ignoreCase?: boolean } = {},
): string {
  const { normalizeWhitespace = true, ignoreCase = true } = options;
  let result = text;
  if (ignoreCase) result = result.toLowerCase();
  if (normalizeWhitespace) result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Split text into sentences (simple heuristic).
 * Splits on sentence-ending punctuation followed by whitespace.
 */
export function splitSentences(text: string): string[] {
  // Split on .!? followed by whitespace or end of string
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split text into paragraphs (double newline separated).
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Split text into lines (single newline separated, ignoring empty).
 */
export function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ─── SIMILARITY ─────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two sets of words.
 * Returns value between 0 (no overlap) and 1 (identical).
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if two strings are similar above a threshold.
 */
function areSimilar(a: string, b: string, threshold: number): boolean {
  // Fast path: exact match
  if (a === b) return true;
  // Fast path: length difference too large
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (lenRatio < threshold * 0.7) return false;
  return jaccardSimilarity(a, b) >= threshold;
}

/**
 * Compute similarity score between two strings (0–1).
 */
export function segmentSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return jaccardSimilarity(a, b);
}

// ─── REPETITION ANALYSIS ────────────────────────────────────────────────────────

/**
 * Analyze text for repetition at the sentence/paragraph level.
 * Finds exact and near-duplicate segments.
 */
export function analyzeRepetition(
  text: string,
  options: RepetitionOptions = {},
): RepetitionResult {
  const {
    minRepetitions = 2,
    similarityThreshold = 0.85,
    minSegmentLength = 20,
    normalizeWhitespace = true,
    ignoreCase = true,
  } = options;

  if (!text || text.trim().length === 0) {
    return {
      hasRepetition: false,
      score: 0,
      instances: [],
      repetitionRatio: 0,
      uniqueSegments: 0,
      totalSegments: 0,
    };
  }

  const normOpts = { normalizeWhitespace, ignoreCase };

  // Split into segments (sentences for shorter text, paragraphs for longer)
  const segments = text.length > 2000
    ? splitParagraphs(text).length > 3
      ? splitParagraphs(text)
      : splitSentences(text)
    : splitSentences(text);

  // Filter by minimum length
  const validSegments = segments.filter((s) => s.length >= minSegmentLength);

  if (validSegments.length < 2) {
    return {
      hasRepetition: false,
      score: 0,
      instances: [],
      repetitionRatio: 0,
      uniqueSegments: validSegments.length,
      totalSegments: validSegments.length,
    };
  }

  // Normalize segments for comparison
  const normalizedSegments = validSegments.map((s) => normalize(s, normOpts));

  // Group similar segments
  const groups: Array<{ representative: string; original: string; indices: number[]; similarity: number }> = [];

  for (let i = 0; i < normalizedSegments.length; i++) {
    const norm = normalizedSegments[i] as string;
    let foundGroup = false;

    for (const group of groups) {
      if (areSimilar(norm, group.representative, similarityThreshold)) {
        group.indices.push(i);
        // Update similarity (use min to be conservative)
        const sim = segmentSimilarity(norm, group.representative);
        group.similarity = Math.min(group.similarity, sim);
        foundGroup = true;
        break;
      }
    }

    if (!foundGroup) {
      groups.push({
        representative: norm,
        original: validSegments[i] as string,
        indices: [i],
        similarity: 1.0,
      });
    }
  }

  // Find repetitions
  const instances: RepetitionInstance[] = [];
  let repeatedCharCount = 0;
  const totalCharCount = validSegments.reduce((sum, s) => sum + s.length, 0);

  for (const group of groups) {
    if (group.indices.length >= minRepetitions) {
      // Calculate approximate positions in original text
      const positions = group.indices.map((idx) => {
        let pos = 0;
        for (let i = 0; i < idx; i++) {
          pos += (validSegments[i]?.length ?? 0) + 1;
        }
        return pos;
      });

      const kind: RepetitionKind = group.similarity >= 1.0 ? 'exact' : 'near-duplicate';

      instances.push({
        text: group.original.slice(0, 100) + (group.original.length > 100 ? '...' : ''),
        count: group.indices.length,
        positions,
        kind,
        similarity: group.similarity,
      });

      // Count repeated chars (all occurrences beyond the first)
      repeatedCharCount += (group.indices.length - 1) * group.original.length;
    }
  }

  const repetitionRatio = totalCharCount > 0 ? Math.min(1, repeatedCharCount / totalCharCount) : 0;
  const uniqueSegments = groups.length;
  const totalSegments = validSegments.length;

  // Compute overall score (0–1)
  // Combines repetition ratio with frequency of repetitions
  const freqScore = instances.length > 0
    ? instances.reduce((sum, inst) => sum + (inst.count - 1), 0) / totalSegments
    : 0;
  const score = Math.min(1, (repetitionRatio * 0.6 + freqScore * 0.4));

  return {
    hasRepetition: instances.length > 0,
    score,
    instances: instances.sort((a, b) => b.count - a.count),
    repetitionRatio,
    uniqueSegments,
    totalSegments,
  };
}

// ─── LOOP DETECTION ─────────────────────────────────────────────────────────────

/**
 * Detect cyclic loops in text — agent repeating a sequence of steps.
 * Looks for repeating patterns of segments (e.g. A-B-C-A-B-C).
 */
export function detectLoops(
  text: string,
  options: LoopDetectionOptions = {},
): LoopResult {
  const {
    minCycleLength = 1,
    maxCycleLength = 10,
    minCycleRepetitions = 2,
    similarityThreshold = 0.85,
  } = options;

  if (!text || text.trim().length === 0) {
    return { hasLoop: false, loops: [], loopRatio: 0 };
  }

  // Use lines as segments (better for detecting tool-call loops, step repetitions)
  const segments = splitLines(text).filter((l) => l.length >= 5);

  if (segments.length < minCycleLength * minCycleRepetitions) {
    return { hasLoop: false, loops: [], loopRatio: 0 };
  }

  // Normalize for comparison
  const normalized = segments.map((s) => normalize(s));

  const loops: LoopInstance[] = [];
  const covered = new Set<number>(); // Track indices already part of a detected loop

  // Search for cycles from longest to shortest (prefer longer patterns)
  for (let cycleLen = Math.min(maxCycleLength, Math.floor(normalized.length / minCycleRepetitions)); cycleLen >= minCycleLength; cycleLen--) {
    for (let start = 0; start <= normalized.length - cycleLen * minCycleRepetitions; start++) {
      // Skip if this start position is already covered
      if (covered.has(start)) continue;

      const cycle = normalized.slice(start, start + cycleLen);
      let reps = 1;

      // Count consecutive repetitions of this cycle
      let pos = start + cycleLen;
      while (pos + cycleLen <= normalized.length) {
        const candidate = normalized.slice(pos, pos + cycleLen);
        let matches = true;

        for (let i = 0; i < cycleLen; i++) {
          const cycleElement = cycle[i] as string;
          const candidateElement = candidate[i] as string;
          if (!areSimilar(cycleElement, candidateElement, similarityThreshold)) {
            matches = false;
            break;
          }
        }

        if (matches) {
          reps++;
          pos += cycleLen;
        } else {
          break;
        }
      }

      if (reps >= minCycleRepetitions) {
        // Mark indices as covered
        for (let i = start; i < start + cycleLen * reps; i++) {
          covered.add(i);
        }

        loops.push({
          cycle: segments.slice(start, start + cycleLen),
          repetitions: reps,
          startIndex: start,
          cycleLength: cycleLen,
        });
      }
    }
  }

  // Calculate loop ratio
  const loopSegments = loops.reduce((sum, l) => sum + l.cycleLength * l.repetitions, 0);
  const loopRatio = segments.length > 0 ? Math.min(1, loopSegments / segments.length) : 0;

  // Find longest loop
  const longestLoop = loops.length > 0
    ? loops.reduce((best, l) => l.repetitions > best.repetitions ? l : best)
    : undefined;

  return {
    hasLoop: loops.length > 0,
    loops: loops.sort((a, b) => b.repetitions - a.repetitions),
    longestLoop,
    loopRatio,
  };
}

// ─── N-GRAM SATURATION ──────────────────────────────────────────────────────────

/**
 * Extract word n-grams from text.
 */
function extractWordNgrams(text: string, n: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const ngrams: string[] = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/**
 * Analyze n-gram saturation — whether a small set of phrases dominates the output.
 * High saturation suggests the agent is repeating the same ideas/phrases.
 */
export function analyzeNgramSaturation(
  text: string,
  options: NgramSaturationOptions = {},
): NgramSaturationResult {
  const {
    ngramSize = 3,
    topK = 5,
    saturationThreshold = 0.3,
  } = options;

  if (!text || text.trim().length === 0) {
    return {
      saturated: false,
      score: 0,
      dominantNgrams: [],
      uniqueNgrams: 0,
      totalNgrams: 0,
    };
  }

  const ngrams = extractWordNgrams(text, ngramSize);
  if (ngrams.length === 0) {
    return {
      saturated: false,
      score: 0,
      dominantNgrams: [],
      uniqueNgrams: 0,
      totalNgrams: 0,
    };
  }

  // Count frequencies
  const freq = new Map<string, number>();
  for (const ngram of ngrams) {
    freq.set(ngram, (freq.get(ngram) ?? 0) + 1);
  }

  // Sort by frequency descending
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);

  // Calculate saturation from top-k
  const topEntries = sorted.slice(0, topK);
  const topCount = topEntries.reduce((sum, [, count]) => sum + count, 0);
  const totalNgrams = ngrams.length;
  const score = totalNgrams > 0 ? topCount / totalNgrams : 0;

  const dominantNgrams = topEntries
    .filter(([, count]) => count > 1) // Only report n-grams that appear more than once
    .map(([ngram, count]) => ({
      ngram,
      count,
      fraction: count / totalNgrams,
    }));

  return {
    saturated: score >= saturationThreshold,
    score,
    dominantNgrams,
    uniqueNgrams: freq.size,
    totalNgrams,
  };
}

// ---- COMBINED ANALYSIS ----

/**
 * Run full repetition analysis combining all detection methods.
 * Returns a comprehensive report suitable for eval assertions.
 */
export function analyzeFullRepetition(
  text: string,
  options: FullRepetitionOptions = {},
): FullRepetitionResult {
  const { threshold = 0.3 } = options;

  const repetition = analyzeRepetition(text, options.repetition);
  const loops = detectLoops(text, options.loops);
  const ngramSaturation = analyzeNgramSaturation(text, options.ngramSaturation);

  // Combined score: weighted average of all signals
  // Loops are strongest signal, then repetition, then saturation
  const overallScore = Math.min(1,
    repetition.score * 0.35 +
    loops.loopRatio * 0.4 +
    ngramSaturation.score * 0.25,
  );

  const isRepetitive = overallScore >= threshold;

  // Build summary
  const summaryParts: string[] = [];
  if (repetition.hasRepetition) {
    const topRep = repetition.instances[0];
    summaryParts.push(
      `Found ${repetition.instances.length} repeated segment(s) ` +
      `(worst: ${topRep?.count ?? 0}x "${topRep?.text.slice(0, 50) ?? ''}...")`,
    );
  }
  if (loops.hasLoop) {
    summaryParts.push(
      `Detected ${loops.loops.length} loop pattern(s) ` +
      `(longest: ${loops.longestLoop?.repetitions ?? 0} repetitions of ${loops.longestLoop?.cycleLength ?? 0}-segment cycle)`,
    );
  }
  if (ngramSaturation.saturated) {
    const topNgram = ngramSaturation.dominantNgrams[0];
    summaryParts.push(
      `N-gram saturation detected (top phrase "${topNgram?.ngram ?? ''}" appears ${topNgram?.count ?? 0} times)`,
    );
  }

  const summary = summaryParts.length > 0
    ? summaryParts.join('. ')
    : 'No significant repetition detected';

  return {
    isRepetitive,
    overallScore,
    repetition,
    loops,
    ngramSaturation,
    summary,
  };
}
