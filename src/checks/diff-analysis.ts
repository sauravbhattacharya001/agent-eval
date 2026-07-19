/**
 * Diff Checker - Deterministic Analysis Engine
 *
 * The pure text-comparison engine behind change/no-op detection. `analyzeDiff`
 * runs an LCS line diff, groups it into classified hunks (content / structural /
 * cosmetic / reorder), and rolls the result up into `DiffMetrics` (identical,
 * cosmetic-only, parroting, change ratio); `textSimilarity` and `detectParroting`
 * measure how much of the input survives in the output; `parseUnifiedDiff` turns a
 * pre-computed unified diff into the same `DiffChange[]` shape.
 *
 * No IO and no AI here - these are deterministic functions over two strings. The
 * low-level LCS/line-diff building blocks (normalizeLine, splitLines, lcsTable,
 * computeDiff, classifyChange, groupIntoHunks) live in the internal leaf
 * ./diff-lcs.js; the type vocabulary lives in ./diff-types.js; the public barrel
 * ./diff.js re-exports this engine and wraps it in assertion factories.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { ChangeKind, DiffChange, DiffMetrics, DiffOptions, DiffResult } from './diff-types.js';
import {
  classifyChange,
  computeDiff,
  groupIntoHunks,
  lcsTable,
  normalizeLine,
  splitLines,
} from './diff-lcs.js';

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
