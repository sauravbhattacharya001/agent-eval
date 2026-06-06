/**
 * Diff Checker — Tier 1 Deterministic Check
 *
 * Detects whether an agent actually produced meaningful changes or was a no-op:
 * - Compares "before" and "after" text to detect genuine changes
 * - Identifies cosmetic-only diffs (whitespace, formatting, comment shuffling)
 * - Detects verbatim parroting (output copies the input with no transformation)
 * - Measures change magnitude (additions, deletions, net change)
 * - Identifies change types (structural, content, cosmetic)
 * - Supports unified diff parsing for pre-computed diffs
 *
 * All checks are deterministic — pure text comparison with no AI.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

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

// ─── CORE ANALYSIS ──────────────────────────────────────────────────────────────

/**
 * Normalize a line for comparison according to options.
 */
function normalizeLine(line: string, options: DiffOptions): string {
  let result = line;
  if (options.ignoreWhitespace) {
    result = result.trim().replace(/\s+/g, ' ');
  }
  return result;
}

/**
 * Split text into lines, optionally filtering blank lines.
 */
function splitLines(text: string, ignoreBlankLines: boolean): string[] {
  const lines = text.split('\n');
  if (ignoreBlankLines) {
    return lines.filter((l) => l.trim().length > 0);
  }
  return lines;
}

/**
 * Compute the Longest Common Subsequence length between two arrays.
 * Returns the LCS table for backtracking.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (!row || !prevRow) continue;
      if (a[i - 1] === b[j - 1]) {
        row[j] = (prevRow[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }
  return dp;
}

/**
 * Compute a simple diff between two line arrays using LCS.
 * Returns arrays of {type, line, lineNum} entries.
 */
interface DiffEntry {
  type: 'keep' | 'add' | 'remove';
  text: string;
  /** Line number in original (for 'keep' and 'remove'). */
  originalLine?: number;
  /** Line number in modified (for 'keep' and 'add'). */
  modifiedLine?: number;
}

function computeDiff(originalLines: string[], modifiedLines: string[]): DiffEntry[] {
  const dp = lcsTable(originalLines, modifiedLines);
  const result: DiffEntry[] = [];

  let i = originalLines.length;
  let j = modifiedLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === modifiedLines[j - 1]) {
      result.push({ type: 'keep', text: originalLines[i - 1] ?? '', originalLine: i, modifiedLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      result.push({ type: 'add', text: modifiedLines[j - 1] ?? '', modifiedLine: j });
      j--;
    } else {
      result.push({ type: 'remove', text: originalLines[i - 1] ?? '', originalLine: i });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Classify a change as content, structural, cosmetic, or reorder.
 */
function classifyChange(additions: string[], deletions: string[]): ChangeKind {
  // Check if it's purely whitespace/formatting changes
  const normalizedAdds = additions.map((l) => l.trim().replace(/\s+/g, ' '));
  const normalizedDels = deletions.map((l) => l.trim().replace(/\s+/g, ' '));

  // If normalized versions are the same, it's cosmetic
  if (
    normalizedAdds.length === normalizedDels.length &&
    normalizedAdds.every((l, idx) => l === normalizedDels[idx])
  ) {
    return 'cosmetic';
  }

  // Check if it's a reorder (same lines, different order)
  if (normalizedAdds.length === normalizedDels.length && normalizedAdds.length > 0) {
    const sortedAdds = [...normalizedAdds].sort();
    const sortedDels = [...normalizedDels].sort();
    if (sortedAdds.every((l, idx) => l === sortedDels[idx])) {
      return 'reorder';
    }
  }

  // Check for structural changes (function/class/import/export lines)
  const structuralPattern =
    /^(import|export|class|interface|type|function|const|let|var|def|fn|pub|mod|use|#include|#define|package|struct|enum)\b/;
  const isStructural =
    additions.some((l) => structuralPattern.test(l.trim())) ||
    deletions.some((l) => structuralPattern.test(l.trim()));

  if (isStructural) {
    return 'structural';
  }

  return 'content';
}

/**
 * Group consecutive diff entries into change hunks.
 */
function groupIntoHunks(entries: DiffEntry[], contextLines: number): DiffChange[] {
  const changes: DiffChange[] = [];
  let currentAdds: string[] = [];
  let currentDels: string[] = [];
  let startLine = 1;
  let endLine = 1;
  let lastChangeIdx = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.type === 'keep') {
      // If we have accumulated changes and enough context has passed, flush
      if (currentAdds.length > 0 || currentDels.length > 0) {
        const gap = i - lastChangeIdx;
        if (gap > contextLines) {
          changes.push({
            kind: classifyChange(currentAdds, currentDels),
            additions: currentAdds,
            deletions: currentDels,
            startLine,
            endLine,
          });
          currentAdds = [];
          currentDels = [];
        }
      }
    } else if (entry.type === 'add') {
      if (currentAdds.length === 0 && currentDels.length === 0) {
        startLine = entry.modifiedLine ?? i + 1;
      }
      currentAdds.push(entry.text);
      endLine = entry.modifiedLine ?? i + 1;
      lastChangeIdx = i;
    } else {
      // remove
      if (currentAdds.length === 0 && currentDels.length === 0) {
        startLine = entry.originalLine ?? i + 1;
      }
      currentDels.push(entry.text);
      endLine = entry.originalLine ?? i + 1;
      lastChangeIdx = i;
    }
  }

  // Flush remaining
  if (currentAdds.length > 0 || currentDels.length > 0) {
    changes.push({
      kind: classifyChange(currentAdds, currentDels),
      additions: currentAdds,
      deletions: currentDels,
      startLine,
      endLine,
    });
  }

  return changes;
}

/**
 * Compute the similarity ratio between two strings (0–1).
 * Uses character-level comparison for efficiency.
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Use line-level LCS for efficiency on larger texts
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const dp = lcsTable(aLines, bLines);
  const lcsLen = dp[aLines.length]?.[bLines.length] ?? 0;
  const maxLen = Math.max(aLines.length, bLines.length);

  return lcsLen / maxLen;
}

/**
 * Analyze the diff between two texts.
 *
 * @param before - The original/input text
 * @param after - The modified/output text
 * @param options - Diff analysis options
 * @returns Detailed diff result with metrics and changes
 */
export function analyzeDiff(before: string, after: string, options: DiffOptions = {}): DiffResult {
  const {
    ignoreWhitespace = false,
    ignoreBlankLines = false,
    contextLines = 3,
    parrotThreshold = 0.9,
  } = options;

  // Handle edge cases
  if (before === after) {
    return {
      metrics: {
        linesAdded: 0,
        linesRemoved: 0,
        netChange: 0,
        linesModified: 0,
        changeRatio: 0,
        hunkCount: 0,
        isIdentical: true,
        isCosmeticOnly: false,
        isParroting: true,
        changeKinds: { content: 0, structural: 0, cosmetic: 0, reorder: 0 },
      },
      changes: [],
      summary: 'No changes detected — output is identical to input.',
    };
  }

  // Prepare lines for comparison
  const beforeLines = splitLines(before, ignoreBlankLines);
  const afterLines = splitLines(after, ignoreBlankLines);

  // Normalize for comparison if needed
  const normalizedBefore = ignoreWhitespace
    ? beforeLines.map((l) => normalizeLine(l, { ignoreWhitespace }))
    : beforeLines;
  const normalizedAfter = ignoreWhitespace
    ? afterLines.map((l) => normalizeLine(l, { ignoreWhitespace }))
    : afterLines;

  // Compute diff
  const entries = computeDiff(normalizedBefore, normalizedAfter);

  // Check if normalized comparison yields no differences
  const hasChanges = entries.some((e) => e.type !== 'keep');
  if (!hasChanges) {
    return {
      metrics: {
        linesAdded: 0,
        linesRemoved: 0,
        netChange: 0,
        linesModified: 0,
        changeRatio: 0,
        hunkCount: 0,
        isIdentical: true,
        isCosmeticOnly: false,
        isParroting: true,
        changeKinds: { content: 0, structural: 0, cosmetic: 0, reorder: 0 },
      },
      changes: [],
      summary: 'No changes detected — output is identical to input (after normalization).',
    };
  }

  // Group into hunks
  const changes = groupIntoHunks(entries, contextLines);

  // Calculate metrics
  let linesAdded = 0;
  let linesRemoved = 0;
  const changeKinds: Record<ChangeKind, number> = { content: 0, structural: 0, cosmetic: 0, reorder: 0 };

  for (const change of changes) {
    linesAdded += change.additions.length;
    linesRemoved += change.deletions.length;
    changeKinds[change.kind]++;
  }

  const linesModified = Math.min(linesAdded, linesRemoved);
  const totalOriginalLines = beforeLines.length || 1;
  const changeRatio = (linesAdded + linesRemoved) / (totalOriginalLines + afterLines.length || 1);

  const isCosmeticOnly =
    changes.length > 0 && changes.every((c) => c.kind === 'cosmetic' || c.kind === 'reorder');

  // Parroting check: high similarity between before and after
  const similarity = textSimilarity(
    ignoreWhitespace ? normalizedBefore.join('\n') : before,
    ignoreWhitespace ? normalizedAfter.join('\n') : after,
  );
  const isParroting = similarity >= parrotThreshold;

  const metrics: DiffMetrics = {
    linesAdded,
    linesRemoved,
    netChange: linesAdded - linesRemoved,
    linesModified,
    changeRatio,
    hunkCount: changes.length,
    isIdentical: false,
    isCosmeticOnly,
    isParroting,
    changeKinds,
  };

  // Generate summary
  const summary = generateSummary(metrics, changes);

  return { metrics, changes, summary };
}

/**
 * Generate a human-readable summary of the diff.
 */
function generateSummary(metrics: DiffMetrics, changes: DiffChange[]): string {
  if (metrics.isIdentical) {
    return 'No changes detected — output is identical to input.';
  }

  const parts: string[] = [];

  if (metrics.isParroting) {
    parts.push('⚠️ Output appears to be parroting the input (high similarity).');
  }

  if (metrics.isCosmeticOnly) {
    parts.push('Only cosmetic changes detected (whitespace/formatting/reordering).');
  } else {
    const kindSummary: string[] = [];
    if (metrics.changeKinds.content > 0) {
      kindSummary.push(`${metrics.changeKinds.content} content`);
    }
    if (metrics.changeKinds.structural > 0) {
      kindSummary.push(`${metrics.changeKinds.structural} structural`);
    }
    if (metrics.changeKinds.cosmetic > 0) {
      kindSummary.push(`${metrics.changeKinds.cosmetic} cosmetic`);
    }
    if (metrics.changeKinds.reorder > 0) {
      kindSummary.push(`${metrics.changeKinds.reorder} reorder`);
    }
    parts.push(`${changes.length} change hunks (${kindSummary.join(', ')}).`);
  }

  parts.push(`+${metrics.linesAdded}/-${metrics.linesRemoved} lines (net ${metrics.netChange >= 0 ? '+' : ''}${metrics.netChange}).`);

  return parts.join(' ');
}

/**
 * Detect if output is parroting (copying) the source input.
 *
 * @param output - The agent's output
 * @param source - The original input/prompt
 * @param options - Parroting detection options
 * @returns Object with isParroting flag and similarity score
 */
export function detectParroting(
  output: string,
  source: string,
  options: { threshold?: number; ignoreWhitespace?: boolean } = {},
): { isParroting: boolean; similarity: number } {
  const { threshold = 0.8, ignoreWhitespace = true } = options;

  let a = output;
  let b = source;
  if (ignoreWhitespace) {
    a = a.replace(/\s+/g, ' ').trim();
    b = b.replace(/\s+/g, ' ').trim();
  }

  // Quick check: if output contains the entire source verbatim
  if (a.includes(b) && b.length > 20) {
    return { isParroting: true, similarity: 1 };
  }

  const similarity = textSimilarity(a, b);
  return { isParroting: similarity >= threshold, similarity };
}

/**
 * Parse a unified diff string into structured changes.
 * Handles standard unified diff format (git diff output).
 */
export function parseUnifiedDiff(diffText: string): DiffChange[] {
  const lines = diffText.split('\n');
  const changes: DiffChange[] = [];
  let currentAdds: string[] = [];
  let currentDels: string[] = [];
  let startLine = 0;
  let currentLine = 0;
  let inHunk = false;

  for (const line of lines) {
    // Hunk header: @@ -start,count +start,count @@
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      // Flush previous hunk
      if (currentAdds.length > 0 || currentDels.length > 0) {
        changes.push({
          kind: classifyChange(currentAdds, currentDels),
          additions: currentAdds,
          deletions: currentDels,
          startLine,
          endLine: currentLine,
        });
        currentAdds = [];
        currentDels = [];
      }
      startLine = parseInt(hunkMatch[1] ?? '0', 10);
      currentLine = startLine;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentAdds.length === 0 && currentDels.length === 0) {
        startLine = currentLine;
      }
      currentAdds.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (currentAdds.length === 0 && currentDels.length === 0) {
        startLine = currentLine;
      }
      currentDels.push(line.slice(1));
      currentLine++;
    } else if (line.startsWith(' ')) {
      // Context line — flush accumulated changes
      if (currentAdds.length > 0 || currentDels.length > 0) {
        changes.push({
          kind: classifyChange(currentAdds, currentDels),
          additions: currentAdds,
          deletions: currentDels,
          startLine,
          endLine: currentLine,
        });
        currentAdds = [];
        currentDels = [];
      }
      currentLine++;
    }
  }

  // Flush remaining
  if (currentAdds.length > 0 || currentDels.length > 0) {
    changes.push({
      kind: classifyChange(currentAdds, currentDels),
      additions: currentAdds,
      deletions: currentDels,
      startLine,
      endLine: currentLine,
    });
  }

  return changes;
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that the output represents a meaningful change from a "before" state.
 * Fails if output is identical to, or nearly identical to, the original.
 *
 * @param before - The original text to compare against
 * @param options - Options controlling what counts as meaningful
 */
export function toHaveMeaningfulDiff(
  before: string,
  options: MeaningfulChangeOptions & DiffOptions = {},
): Assertion {
  const { minChanges = 1, minChangeRatio = 0, cosmeticIsMeaningful = false, ...diffOptions } = options;

  return {
    name: 'has meaningful diff from original',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = analyzeDiff(before, output, diffOptions);
      const { metrics } = result;

      if (metrics.isIdentical) {
        return {
          status: 'fail',
          name: 'has meaningful diff from original',
          message: 'Output is identical to the original — no changes were made.',
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      // Count meaningful changes
      const meaningfulHunks = cosmeticIsMeaningful
        ? result.changes.length
        : result.changes.filter((c) => c.kind !== 'cosmetic' && c.kind !== 'reorder').length;

      if (meaningfulHunks < minChanges) {
        return {
          status: 'fail',
          name: 'has meaningful diff from original',
          message: `Only ${meaningfulHunks} meaningful change(s) found (minimum: ${minChanges}). ${metrics.isCosmeticOnly ? 'All changes are cosmetic only.' : ''}`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      if (metrics.changeRatio < minChangeRatio) {
        return {
          status: 'fail',
          name: 'has meaningful diff from original',
          message: `Change ratio ${(metrics.changeRatio * 100).toFixed(1)}% is below minimum ${(minChangeRatio * 100).toFixed(1)}%.`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'has meaningful diff from original',
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output is NOT a no-op — it represents actual work done.
 * Compares against the "before" state to ensure something changed.
 *
 * @param options - Configuration including the before text
 */
export function toNotBeNoOp(options: NotNoOpOptions): Assertion {
  return {
    name: 'is not a no-op',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = analyzeDiff(options.before, output, options.diffOptions);

      if (result.metrics.isIdentical) {
        return {
          status: 'fail',
          name: 'is not a no-op',
          message: 'Output is identical to input — agent produced no changes.',
          durationMs: performance.now() - start,
        };
      }

      if (result.metrics.isCosmeticOnly) {
        return {
          status: 'fail',
          name: 'is not a no-op',
          message: 'Only cosmetic changes detected (whitespace/formatting) — no substantive work done.',
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'is not a no-op',
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does NOT parrot (copy) the source input.
 * Detects when an agent simply echoes back what it was given.
 *
 * @param source - The original prompt/input to check against
 * @param options - Parroting detection options
 */
export function toNotParrot(source: string, options: { threshold?: number; ignoreWhitespace?: boolean } = {}): Assertion {
  const { threshold = 0.8 } = options;

  return {
    name: 'does not parrot input',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const { isParroting, similarity } = detectParroting(output, source, options);

      if (isParroting) {
        return {
          status: 'fail',
          name: 'does not parrot input',
          message: `Output is ${(similarity * 100).toFixed(1)}% similar to input (threshold: ${(threshold * 100).toFixed(1)}%). Agent appears to be copying rather than transforming.`,
          expected: `Similarity below ${(threshold * 100).toFixed(1)}%`,
          actual: `${(similarity * 100).toFixed(1)}% similarity`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'does not parrot input',
        evidence: `Similarity: ${(similarity * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert minimum change magnitude between before and after.
 * Useful for ensuring an agent made a substantive modification.
 *
 * @param before - The original text
 * @param options - Minimum thresholds for changes
 */
export function toHaveMinimumChanges(
  before: string,
  options: { minLinesChanged?: number; minNetChange?: number; diffOptions?: DiffOptions } = {},
): Assertion {
  const { minLinesChanged = 1, minNetChange, diffOptions } = options;

  return {
    name: 'meets minimum change threshold',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = analyzeDiff(before, output, diffOptions);
      const totalChanged = result.metrics.linesAdded + result.metrics.linesRemoved;

      if (totalChanged < minLinesChanged) {
        return {
          status: 'fail',
          name: 'meets minimum change threshold',
          message: `Only ${totalChanged} lines changed (minimum: ${minLinesChanged}).`,
          expected: `At least ${minLinesChanged} lines changed`,
          actual: `${totalChanged} lines changed`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      if (minNetChange !== undefined && Math.abs(result.metrics.netChange) < minNetChange) {
        return {
          status: 'fail',
          name: 'meets minimum change threshold',
          message: `Net change is ${result.metrics.netChange} lines (minimum magnitude: ${minNetChange}).`,
          expected: `Net change magnitude ≥ ${minNetChange}`,
          actual: `Net change: ${result.metrics.netChange}`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'meets minimum change threshold',
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that a unified diff string contains meaningful changes.
 * For use when you already have a git diff or similar output.
 *
 * @param options - Options for what constitutes meaningful
 */
export function toHaveMeaningfulUnifiedDiff(
  options: { minHunks?: number; requireNonCosmetic?: boolean } = {},
): Assertion {
  const { minHunks = 1, requireNonCosmetic = true } = options;

  return {
    name: 'unified diff has meaningful changes',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const changes = parseUnifiedDiff(output);

      if (changes.length === 0) {
        return {
          status: 'fail',
          name: 'unified diff has meaningful changes',
          message: 'No change hunks found in unified diff output.',
          durationMs: performance.now() - start,
        };
      }

      const nonCosmetic = changes.filter((c) => c.kind !== 'cosmetic' && c.kind !== 'reorder');

      if (requireNonCosmetic && nonCosmetic.length === 0) {
        return {
          status: 'fail',
          name: 'unified diff has meaningful changes',
          message: `All ${changes.length} hunks are cosmetic/reorder only — no substantive changes.`,
          durationMs: performance.now() - start,
        };
      }

      const relevantChanges = requireNonCosmetic ? nonCosmetic : changes;
      if (relevantChanges.length < minHunks) {
        return {
          status: 'fail',
          name: 'unified diff has meaningful changes',
          message: `Only ${relevantChanges.length} meaningful hunk(s) found (minimum: ${minHunks}).`,
          durationMs: performance.now() - start,
        };
      }

      const totalAdds = changes.reduce((sum, c) => sum + c.additions.length, 0);
      const totalDels = changes.reduce((sum, c) => sum + c.deletions.length, 0);

      return {
        status: 'pass',
        name: 'unified diff has meaningful changes',
        evidence: `${relevantChanges.length} meaningful hunk(s), +${totalAdds}/-${totalDels} lines.`,
        durationMs: performance.now() - start,
      };
    },
  };
}