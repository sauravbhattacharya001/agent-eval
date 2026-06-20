/**
 * Completeness Checker — type vocabulary (Tier 1 Deterministic Check)
 *
 * The content metrics, per-sub-check option bags, and the violation/result shapes
 * for the completeness check. Pure types: no constants, no logic, no IO — so both
 * the analysis engine (./completeness-analysis.js) and the public barrel
 * (./completeness.js) can depend on this without a cycle.
 *
 * Consumers should import these from ./completeness.js, which re-exports them.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

/** Metrics about the content of agent output. */
export interface ContentMetrics {
  /** Total character count. */
  charCount: number;
  /** Total word count. */
  wordCount: number;
  /** Total line count. */
  lineCount: number;
  /** Non-empty line count. */
  nonEmptyLineCount: number;
  /** Sentence count (heuristic). */
  sentenceCount: number;
  /** Paragraph count (blocks separated by blank lines). */
  paragraphCount: number;
  /** Unique word ratio (unique/total). Higher = more diverse vocabulary. */
  uniqueWordRatio: number;
  /** Average words per sentence. */
  avgWordsPerSentence: number;
  /** Whether the output appears truncated. */
  isTruncated: boolean;
  /** Whether the output appears to be a stub/placeholder. */
  isStub: boolean;
}

/** Options for length range validation. */
export interface LengthRangeOptions {
  /** Minimum character count. */
  minChars?: number;
  /** Maximum character count. */
  maxChars?: number;
  /** Minimum word count. */
  minWords?: number;
  /** Maximum word count. */
  maxWords?: number;
  /** Minimum line count. */
  minLines?: number;
  /** Maximum line count. */
  maxLines?: number;
  /** Minimum sentence count. */
  minSentences?: number;
  /** Maximum sentence count. */
  maxSentences?: number;
  /** Minimum paragraph count. */
  minParagraphs?: number;
  /** Maximum paragraph count. */
  maxParagraphs?: number;
}

/** Options for substance detection. */
export interface SubstanceOptions {
  /** Minimum unique word ratio (0-1). Default: 0.3. */
  minUniqueWordRatio?: number;
  /** Maximum allowed consecutive duplicate lines. Default: 3. */
  maxConsecutiveDuplicateLines?: number;
  /** Custom stub/placeholder patterns to detect. */
  stubPatterns?: RegExp[];
  /** Custom filler phrases to flag. */
  fillerPhrases?: string[];
  /** Minimum average words per sentence. Default: 3. */
  minAvgWordsPerSentence?: number;
}

/** Options for structural completeness. */
export interface StructuralCompletenessOptions {
  /** Check for balanced brackets/braces. Default: true. */
  checkBalancedBrackets?: boolean;
  /** Check for truncation markers. Default: true. */
  checkTruncation?: boolean;
  /** Check for incomplete sentences at the end. Default: true. */
  checkIncompleteEnding?: boolean;
  /** Required content patterns (at least one must match). */
  requiredPatterns?: RegExp[];
  /** Forbidden patterns (none should match). */
  forbiddenPatterns?: RegExp[];
}

/** Full completeness check options combining all sub-checks. */
export interface CompletenessOptions {
  /** Length range requirements. */
  length?: LengthRangeOptions;
  /** Substance detection settings. */
  substance?: SubstanceOptions;
  /** Structural completeness settings. */
  structure?: StructuralCompletenessOptions;
}

/** A single completeness violation. */
export interface CompletenessViolation {
  category: 'empty' | 'length' | 'substance' | 'structure' | 'truncation';
  message: string;
  severity: 'error' | 'warning';
}

/** Result of a completeness analysis. */
export interface CompletenessResult {
  /** Whether the output passes completeness checks. */
  complete: boolean;
  /** Content metrics. */
  metrics: ContentMetrics;
  /** List of violations found. */
  violations: CompletenessViolation[];
}
