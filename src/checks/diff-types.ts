/**
 * Diff Checker - Type Vocabulary
 *
 * The pure value types for change/no-op detection: the change-kind union
 * (`ChangeKind`), a single change hunk (`DiffChange`), the summary metrics
 * (`DiffMetrics`), the analysis configuration (`DiffOptions`), the per-assertion
 * option shapes (`MeaningfulChangeOptions`, `NotNoOpOptions`, `ParrotingOptions`),
 * and the analysis result (`DiffResult`). No analysis logic lives here - the
 * engine in ./diff-analysis.js consumes these, and the public barrel ./diff.js
 * re-exports them so the import path stays a single `./diff.js` for every consumer.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

/** Classification of a single change hunk. */
export type ChangeKind = 'content' | 'structural' | 'cosmetic' | 'reorder';

/** A single change detected between before and after. */
export interface DiffChange {
  /** What kind of change this is. */
  kind: ChangeKind;
  /** Lines added. */
  additions: string[];
  /** Lines removed. */
  deletions: string[];
  /** Starting line in the original (1-indexed). */
  startLine: number;
  /** Ending line in the original (1-indexed). */
  endLine: number;
}

/** Metrics summarizing the diff between two texts. */
export interface DiffMetrics {
  /** Total lines added. */
  linesAdded: number;
  /** Total lines removed. */
  linesRemoved: number;
  /** Net change (added - removed). */
  netChange: number;
  /** Total lines modified (max of added/removed for matched hunks). */
  linesModified: number;
  /** Ratio of changed lines to total original lines (0–1). */
  changeRatio: number;
  /** Number of change hunks. */
  hunkCount: number;
  /** Whether the output is identical to input. */
  isIdentical: boolean;
  /** Whether changes are purely cosmetic (whitespace/formatting). */
  isCosmeticOnly: boolean;
  /** Whether the output is mostly a copy of the input. */
  isParroting: boolean;
  /** Breakdown of change kinds. */
  changeKinds: Record<ChangeKind, number>;
}

/** Options for diff analysis. */
export interface DiffOptions {
  /** Ignore leading/trailing whitespace on each line. Default: false. */
  ignoreWhitespace?: boolean;
  /** Ignore blank lines entirely. Default: false. */
  ignoreBlankLines?: boolean;
  /** Minimum lines of context around changes for hunk detection. Default: 3. */
  contextLines?: number;
  /** Threshold (0–1) above which output is considered "parroting" (similarity to input). Default: 0.9. */
  parrotThreshold?: number;
}

/** Options for the meaningful change assertion. */
export interface MeaningfulChangeOptions {
  /** Minimum number of non-cosmetic changes required. Default: 1. */
  minChanges?: number;
  /** Minimum change ratio required. Default: 0.0 (any change). */
  minChangeRatio?: number;
  /** Whether purely cosmetic changes count as meaningful. Default: false. */
  cosmeticIsMeaningful?: boolean;
}

/** Options for the not-a-no-op assertion. */
export interface NotNoOpOptions {
  /** The original input/before text to compare against. */
  before: string;
  /** Diff analysis options. */
  diffOptions?: DiffOptions;
}

/** Options for parroting detection. */
export interface ParrotingOptions {
  /** The original input/prompt the agent was given. */
  source: string;
  /** Similarity threshold (0–1) above which output is considered parroting. Default: 0.8. */
  threshold?: number;
  /** Ignore whitespace differences. Default: true. */
  ignoreWhitespace?: boolean;
}

/** Result of a diff analysis. */
export interface DiffResult {
  /** Summary metrics. */
  metrics: DiffMetrics;
  /** Individual change hunks. */
  changes: DiffChange[];
  /** Human-readable summary of what changed. */
  summary: string;
}