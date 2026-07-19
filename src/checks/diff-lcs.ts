/**
 * Diff Checker - LCS Line-Diff Core
 *
 * The pure line-level engine shared by the diff analysis surface: line
 * normalization/splitting, the Longest-Common-Subsequence table, LCS
 * backtracking into keep/add/remove entries, per-hunk change classification
 * (content / structural / cosmetic / reorder), and hunk grouping. These are the
 * lowest-level building blocks that `analyzeDiff`, `textSimilarity`, and
 * `parseUnifiedDiff` (in ./diff-analysis.js) compose over.
 *
 * No IO and no AI here - deterministic functions over strings/arrays. The type
 * vocabulary lives in ./diff-types.js. Nothing in this module is part of the
 * public barrel (./diff.js); it is an internal implementation leaf.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { ChangeKind, DiffChange, DiffOptions } from './diff-types.js';

/**
 * Normalize a line for comparison according to options.
 */
export function normalizeLine(line: string, options: DiffOptions): string {
  let result = line;
  if (options.ignoreWhitespace) {
    result = result.trim().replace(/\s+/g, ' ');
  }
  return result;
}

/**
 * Split text into lines, optionally filtering blank lines.
 */
export function splitLines(text: string, ignoreBlankLines: boolean): string[] {
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
export function lcsTable(a: string[], b: string[]): number[][] {
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
 * A single line-level diff entry produced by {@link computeDiff}.
 */
export interface DiffEntry {
  type: 'keep' | 'add' | 'remove';
  text: string;
  /** Line number in original (for 'keep' and 'remove'). */
  originalLine?: number;
  /** Line number in modified (for 'keep' and 'add'). */
  modifiedLine?: number;
}

/**
 * Compute a simple diff between two line arrays using LCS.
 * Returns arrays of {type, line, lineNum} entries.
 */
export function computeDiff(originalLines: string[], modifiedLines: string[]): DiffEntry[] {
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
export function classifyChange(additions: string[], deletions: string[]): ChangeKind {
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
export function groupIntoHunks(entries: DiffEntry[], contextLines: number): DiffChange[] {
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
