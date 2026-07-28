/**
 * Repetition/Loop Detection - the three primitive detectors.
 *
 * These are the leaf detectors that inspect text for a single class of
 * repetition, with no AI calls and no IO:
 *   - `analyzeRepetition`      - duplicate/near-duplicate segments
 *   - `detectLoops`            - cyclic step patterns (A-B-C-A-B-C)
 *   - `analyzeNgramSaturation` - phrase-frequency dominance
 *
 * The combined orchestrator (`analyzeFullRepetition`) that fuses these three
 * signals lives in `./repetition-analysis.js`, which re-exports this module so
 * the public surface stays a single `./repetition.js` import path. The shared
 * text primitives (normalize/split/similarity/n-gram) live in
 * `./repetition-text.js`.
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
} from './repetition-types.js';
import {
  normalize,
  splitSentences,
  splitParagraphs,
  splitLines,
  areSimilar,
  segmentSimilarity,
  extractWordNgrams,
} from './repetition-text.js';

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
