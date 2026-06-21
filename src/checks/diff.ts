/**
 * Diff Checker - Tier 1 Deterministic Check
 *
 * Detects whether an agent actually produced meaningful changes or was a no-op:
 * - Compares "before" and "after" text to detect genuine changes
 * - Identifies cosmetic-only diffs (whitespace, formatting, comment shuffling)
 * - Detects verbatim parroting (output copies the input with no transformation)
 * - Measures change magnitude (additions, deletions, net change)
 * - Identifies change types (structural, content, cosmetic)
 * - Supports unified diff parsing for pre-computed diffs
 *
 * All checks are deterministic - pure text comparison with no AI.
 *
 * This file is the **public barrel** for diff checking and the home of the
 * assertion factories that wrap the analysis engine into Jest/Vitest-style
 * assertions. The supporting seams live alongside it and are re-exported here so
 * the public surface stays a single `./diff.js` import path:
 * - ./diff-types.js    - the type vocabulary (changes, metrics, options, result)
 * - ./diff-analysis.js - the LCS diff engine (analyzeDiff / textSimilarity /
 *                        detectParroting / parseUnifiedDiff)
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  DiffOptions,
  MeaningfulChangeOptions,
  NotNoOpOptions,
} from './diff-types.js';
import {
  analyzeDiff,
  detectParroting,
  parseUnifiedDiff,
} from './diff-analysis.js';

// --- TYPE RE-EXPORTS -----------------------------------------------------------
// The diff type vocabulary lives in ./diff-types.js; re-export it here so consumers
// keep a single `./diff.js` import path.
export type {
  ChangeKind,
  DiffChange,
  DiffMetrics,
  DiffOptions,
  DiffResult,
  MeaningfulChangeOptions,
  NotNoOpOptions,
  ParrotingOptions,
} from './diff-types.js';

// --- ANALYSIS RE-EXPORTS -------------------------------------------------------
// The deterministic engine (LCS diff + metrics + unified-diff parsing) lives
// alongside; re-export the public functions so the barrel is the single surface.
export {
  analyzeDiff,
  detectParroting,
  parseUnifiedDiff,
  textSimilarity,
} from './diff-analysis.js';

// --- ASSERTION FACTORIES -------------------------------------------------------

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