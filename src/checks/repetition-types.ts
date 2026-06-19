/**
 * Repetition/Loop Detection - type vocabulary.
 *
 * The shared types for the repetition/loop/n-gram checks live here so both the
 * analysis engine (`./repetition-analysis.js`) and the public barrel
 * (`./repetition.js`) can depend on them without a cycle. Re-exported from
 * `./repetition.js`, so consumers keep a single `./repetition.js` import path.
 *
 * @tier 2 - Heuristic (no AI, detects behavioral patterns)
 * @module
 */

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
