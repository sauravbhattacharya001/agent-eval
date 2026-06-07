/**
 * Repetition/Loop Detection — Tier 2 Heuristic Check
 *
 * Detects agents that are repeating themselves or stuck in loops:
 * - Sentence-level repetition: same or near-identical sentences appearing multiple times
 * - Paragraph/block repetition: entire blocks duplicated verbatim or near-verbatim
 * - Structural loops: repeated patterns (e.g. "Step 1... Step 1..." or cycling tool calls)
 * - N-gram saturation: when a small set of phrases dominates the output
 * - Incremental stalling: output that keeps saying the same thing in different words
 *
 * All checks are deterministic — no AI calls, pure text analysis.
 *
 * @tier 2 — Heuristic (no AI, detects behavioral patterns)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Configuration for repetition analysis. */
export interface RepetitionOptions {
  /** Minimum number of repetitions to flag. Default: 2 */
  minRepetitions?: number;
  /** Minimum similarity (0–1) for two segments to be considered "same". Default: 0.85 */
  similarityThreshold?: number;
  /** Minimum segment length (chars) to consider for repetition. Default: 20 */
  minSegmentLength?: number;
  /** Whether to normalize whitespace before comparison. Default: true */
  normalizeWhitespace?: boolean;
  /** Whether to ignore case when comparing. Default: true */
  ignoreCase?: boolean;
}

/** A detected repetition instance. */
export interface RepetitionInstance {
  /** The repeated text (or representative sample). */
  text: string;
  /** Number of times this segment repeats. */
  count: number;
  /** Positions (character offsets) where each occurrence starts. */
  positions: number[];
  /** Type of repetition. */
  kind: RepetitionKind;
  /** Similarity score if near-duplicate (1.0 for exact). */
  similarity: number;
}

/** Categories of repetition. */
export type RepetitionKind =
  | 'exact'            // verbatim duplicate
  | 'near-duplicate'   // same content with minor word changes
  | 'structural'       // same structure/pattern repeating (e.g. numbered steps cycling)
  | 'ngram-saturation'; // a few phrases dominate the output

/** Result of repetition analysis. */
export interface RepetitionResult {
  /** Whether repetition was detected above threshold. */
  hasRepetition: boolean;
  /** Overall repetition score (0 = no repetition, 1 = entirely repetitive). */
  score: number;
  /** Individual repetition instances found. */
  instances: RepetitionInstance[];
  /** Fraction of output that is repeated content (0–1). */
  repetitionRatio: number;
  /** Number of unique vs total segments. */
  uniqueSegments: number;
  totalSegments: number;
}

/** Configuration for loop detection specifically. */
export interface LoopDetectionOptions {
  /** Minimum cycle length (in segments) to detect. Default: 1 */
  minCycleLength?: number;
  /** Maximum cycle length to search for. Default: 10 */
  maxCycleLength?: number;
  /** Minimum repetitions of a cycle to flag. Default: 2 */
  minCycleRepetitions?: number;
  /** Similarity threshold for cycle elements. Default: 0.85 */
  similarityThreshold?: number;
}

/** A detected loop/cycle pattern. */
export interface LoopInstance {
  /** The repeating cycle of segments. */
  cycle: string[];
  /** Number of times the cycle repeats. */
  repetitions: number;
  /** Starting position (segment index) of the loop. */
  startIndex: number;
  /** Cycle length in segments. */
  cycleLength: number;
}

/** Result of loop detection. */
export interface LoopResult {
  /** Whether a loop was detected. */
  hasLoop: boolean;
  /** Detected loop patterns. */
  loops: LoopInstance[];
  /** Longest detected loop (in cycle repetitions). */
  longestLoop?: LoopInstance;
  /** Fraction of output consumed by loops. */
  loopRatio: number;
}

/** Configuration for n-gram saturation analysis. */
export interface NgramSaturationOptions {
  /** N-gram size. Default: 3 (trigrams) */
  ngramSize?: number;
  /** Top-k n-grams to measure. Default: 5 */
  topK?: number;
  /** Fraction threshold: if top-k n-grams account for more than this fraction, flag. Default: 0.3 */
  saturationThreshold?: number;
}

/** Result of n-gram saturation analysis. */
export interface NgramSaturationResult {
  /** Whether saturation was detected. */
  saturated: boolean;
  /** Saturation score (fraction of text dominated by top-k n-grams). */
  score: number;
  /** The dominant n-grams and their frequencies. */
  dominantNgrams: Array<{ ngram: string; count: number; fraction: number }>;
  /** Total unique n-grams in the text. */
  uniqueNgrams: number;
  /** Total n-gram occurrences. */
  totalNgrams: number;
}

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

// ─── COMBINED ANALYSIS ──────────────────────────────────────────────────────────

/** Combined repetition analysis options. */
export interface FullRepetitionOptions {
  repetition?: RepetitionOptions;
  loops?: LoopDetectionOptions;
  ngramSaturation?: NgramSaturationOptions;
  /** Overall score threshold for flagging. Default: 0.3 */
  threshold?: number;
}

/** Combined repetition analysis result. */
export interface FullRepetitionResult {
  /** Whether any form of repetition was detected above threshold. */
  isRepetitive: boolean;
  /** Combined repetition score (0–1). */
  overallScore: number;
  /** Sentence/paragraph level repetition. */
  repetition: RepetitionResult;
  /** Cyclic loop detection. */
  loops: LoopResult;
  /** N-gram saturation analysis. */
  ngramSaturation: NgramSaturationResult;
  /** Human-readable summary of findings. */
  summary: string;
}

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

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that the output does not contain excessive repetition.
 * Detects verbatim and near-duplicate sentences/paragraphs.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for repetition detection.
 */
export function toNotRepeat(options?: RepetitionOptions & { maxScore?: number }): Assertion {
  const maxScore = options?.maxScore ?? 0.3;

  return {
    name: `no excessive repetition (max score: ${maxScore})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeRepetition(output, options);

      if (result.score <= maxScore) {
        return {
          status: 'pass',
          name: `no excessive repetition (max score: ${maxScore})`,
          evidence:
            `Repetition score: ${result.score.toFixed(3)}. ` +
            `${result.uniqueSegments}/${result.totalSegments} segments are unique`,
          durationMs: performance.now() - start,
        };
      }

      const topInstance = result.instances[0];
      return {
        status: 'fail',
        name: `no excessive repetition (max score: ${maxScore})`,
        message: 'Output contains excessive repetition',
        expected: `repetition score <= ${maxScore}`,
        actual: `score = ${result.score.toFixed(3)} (${result.instances.length} repeated segments)`,
        evidence: topInstance
          ? `Most repeated (${topInstance.count}x, ${topInstance.kind}): "${topInstance.text}"`
          : 'Multiple segments are repeated',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output is not stuck in a loop.
 * Detects cyclic patterns where the agent repeats sequences of steps.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for loop detection.
 */
export function toNotLoop(options?: LoopDetectionOptions & { maxLoopRatio?: number }): Assertion {
  const maxLoopRatio = options?.maxLoopRatio ?? 0.3;

  return {
    name: `no loop patterns (max ratio: ${maxLoopRatio})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = detectLoops(output, options);

      if (!result.hasLoop || result.loopRatio <= maxLoopRatio) {
        return {
          status: 'pass',
          name: `no loop patterns (max ratio: ${maxLoopRatio})`,
          evidence: result.hasLoop
            ? `Minor loops detected (ratio: ${result.loopRatio.toFixed(3)}) — within tolerance`
            : 'No loop patterns detected',
          durationMs: performance.now() - start,
        };
      }

      const longest = result.longestLoop;
      return {
        status: 'fail',
        name: `no loop patterns (max ratio: ${maxLoopRatio})`,
        message: 'Output is stuck in a loop',
        expected: `loop ratio <= ${maxLoopRatio}`,
        actual: `loop ratio = ${result.loopRatio.toFixed(3)} (${result.loops.length} loop patterns)`,
        evidence: longest
          ? `Longest loop: ${longest.repetitions} repetitions of ${longest.cycleLength}-segment cycle starting at segment ${longest.startIndex}. ` +
            `First cycle element: "${longest.cycle[0]?.slice(0, 80) ?? ''}"`
          : `${result.loops.length} loop patterns detected`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does not have n-gram saturation
 * (a few phrases dominating the entire text).
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for saturation detection.
 */
export function toNotBeSaturated(options?: NgramSaturationOptions): Assertion {
  const threshold = options?.saturationThreshold ?? 0.3;

  return {
    name: `no n-gram saturation (threshold: ${threshold})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeNgramSaturation(output, options);

      if (!result.saturated) {
        return {
          status: 'pass',
          name: `no n-gram saturation (threshold: ${threshold})`,
          evidence:
            `Saturation score: ${result.score.toFixed(3)}. ` +
            `${result.uniqueNgrams} unique n-grams across ${result.totalNgrams} total`,
          durationMs: performance.now() - start,
        };
      }

      const topNgram = result.dominantNgrams[0];
      return {
        status: 'fail',
        name: `no n-gram saturation (threshold: ${threshold})`,
        message: 'Output is dominated by a small set of repeated phrases',
        expected: `saturation score < ${threshold}`,
        actual: `score = ${result.score.toFixed(3)}`,
        evidence: topNgram
          ? `Dominant phrase "${topNgram.ngram}" appears ${topNgram.count} times ` +
            `(${(topNgram.fraction * 100).toFixed(1)}% of all n-grams). ` +
            `Top ${result.dominantNgrams.length} phrases account for ${(result.score * 100).toFixed(1)}% of content`
          : 'High phrase repetition throughout the output',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output is not repetitive (combined check).
 * Runs all repetition detection methods and provides a unified verdict.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for full repetition analysis.
 */
export function toNotBeRepetitive(options?: FullRepetitionOptions): Assertion {
  const threshold = options?.threshold ?? 0.3;

  return {
    name: `not repetitive (threshold: ${threshold})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeFullRepetition(output, options);

      if (!result.isRepetitive) {
        return {
          status: 'pass',
          name: `not repetitive (threshold: ${threshold})`,
          evidence:
            `Overall score: ${result.overallScore.toFixed(3)}. ${result.summary}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `not repetitive (threshold: ${threshold})`,
        message: 'Output shows signs of repetitive or looping behavior',
        expected: `overall repetition score < ${threshold}`,
        actual: `score = ${result.overallScore.toFixed(3)}`,
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert a maximum number of times any segment can repeat.
 * Simpler check — just counts repetitions without scoring.
 *
 * @tier 2 — Heuristic
 * @param maxRepetitions - Maximum allowed repetitions of any segment. Default: 3
 * @param options - Additional repetition options.
 */
export function toNotExceedRepetitions(
  maxRepetitions?: number,
  options?: RepetitionOptions,
): Assertion {
  const maxReps = maxRepetitions ?? 3;

  return {
    name: `no segment repeats > ${maxReps} times`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeRepetition(output, { ...options, minRepetitions: 2 });

      const violators = result.instances.filter((inst) => inst.count > maxReps);

      if (violators.length === 0) {
        return {
          status: 'pass',
          name: `no segment repeats > ${maxReps} times`,
          evidence: result.hasRepetition
            ? `Some repetition found but within limit (max: ${result.instances[0]?.count ?? 0}x)`
            : 'No repeated segments detected',
          durationMs: performance.now() - start,
        };
      }

      const worst = violators[0] as (typeof violators)[number];
      return {
        status: 'fail',
        name: `no segment repeats > ${maxReps} times`,
        message: `A segment repeats ${worst.count} times (max allowed: ${maxReps})`,
        expected: `no segment repeats more than ${maxReps} times`,
        actual: `"${worst.text}" repeats ${worst.count} times`,
        evidence: `${violators.length} segment(s) exceed the repetition limit`,
        durationMs: performance.now() - start,
      };
    },
  };
}