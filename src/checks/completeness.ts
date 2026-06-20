/**
 * Completeness Checker — Tier 1 Deterministic Check
 *
 * Structural validation that agent output is non-empty, substantive, and complete:
 * - Non-empty / non-stub detection (catches empty or placeholder outputs)
 * - Length range validation (char, word, line, sentence counts)
 * - Section coverage (expected headings/parts present)
 * - Substance detection (not just boilerplate, filler, or repeated content)
 * - Structural completeness (balanced brackets, no truncation markers)
 *
 * All checks are deterministic — pure text analysis with no AI.
 *
 * This file is the **public barrel** for the completeness check and the home of
 * the assertion factories that wrap the analysis engine into Jest/Vitest-style
 * assertions. The supporting seams live alongside it and are re-exported here so
 * the public surface stays a single `./completeness.js` import path:
 * - `./completeness-types.js`    — the type vocabulary (metrics, options, result)
 * - `./completeness-analysis.js` — pattern tables + analyzeContent / checkCompleteness
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  LengthRangeOptions,
  SubstanceOptions,
  StructuralCompletenessOptions,
  CompletenessOptions,
} from './completeness-types.js';
import { checkCompleteness, detectStub } from './completeness-analysis.js';

// ─── TYPE RE-EXPORTS ────────────────────────────────────────────────────────────
// The completeness type vocabulary lives in ./completeness-types.js; re-export it
// here so consumers keep a single `./completeness.js` import path.
export type {
  ContentMetrics,
  LengthRangeOptions,
  SubstanceOptions,
  StructuralCompletenessOptions,
  CompletenessOptions,
  CompletenessViolation,
  CompletenessResult,
} from './completeness-types.js';

// ─── ANALYSIS RE-EXPORTS ────────────────────────────────────────────────────────
// The deterministic engine (pattern tables + metrics + full check) lives alongside.
export { analyzeContent, checkCompleteness } from './completeness-analysis.js';

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that output is not empty and contains substantive content.
 *
 * Detects:
 * - Empty output
 * - Stub/placeholder responses (TODO, lorem ipsum, "I cannot...")
 * - Very short non-answers
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toBeNonEmpty()]
 * ```
 */
export function toBeNonEmpty(options?: { stubPatterns?: RegExp[] }): Assertion {
  return {
    name: 'non-empty output',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const trimmed = output.trim();

      if (trimmed.length === 0) {
        return {
          status: 'fail',
          name: 'non-empty output',
          message: 'Output is empty',
          actual: '(empty string)',
          durationMs: performance.now() - start,
        };
      }

      if (detectStub(output, options?.stubPatterns)) {
        return {
          status: 'fail',
          name: 'non-empty output',
          message: 'Output appears to be a stub or placeholder',
          actual: trimmed.slice(0, 200),
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'non-empty output',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output meets length range requirements.
 *
 * Checks character count, word count, line count, sentence count, and paragraph count
 * against configurable min/max thresholds.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toMeetLengthRange({ minWords: 50, maxWords: 500, minSentences: 3 })]
 * ```
 */
export function toMeetLengthRange(range: LengthRangeOptions): Assertion {
  const constraints: string[] = [];
  if (range.minWords !== undefined) constraints.push(`≥${range.minWords}w`);
  if (range.maxWords !== undefined) constraints.push(`≤${range.maxWords}w`);
  if (range.minChars !== undefined) constraints.push(`≥${range.minChars}c`);
  if (range.maxChars !== undefined) constraints.push(`≤${range.maxChars}c`);
  if (range.minLines !== undefined) constraints.push(`≥${range.minLines}L`);
  if (range.maxLines !== undefined) constraints.push(`≤${range.maxLines}L`);
  if (range.minSentences !== undefined) constraints.push(`≥${range.minSentences}s`);
  if (range.maxSentences !== undefined) constraints.push(`≤${range.maxSentences}s`);
  if (range.minParagraphs !== undefined) constraints.push(`≥${range.minParagraphs}¶`);
  if (range.maxParagraphs !== undefined) constraints.push(`≤${range.maxParagraphs}¶`);

  const name = `length range [${constraints.join(', ')}]`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = checkCompleteness(output, { length: range });
      const lengthViolations = result.violations.filter(v => v.category === 'length');

      if (lengthViolations.length === 0) {
        return {
          status: 'pass',
          name,
          message: `Output: ${result.metrics.wordCount}w, ${result.metrics.charCount}c, ${result.metrics.lineCount}L, ${result.metrics.sentenceCount}s, ${result.metrics.paragraphCount}¶`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name,
        message: lengthViolations.map(v => v.message).join('; '),
        evidence: `Actual: ${result.metrics.wordCount} words, ${result.metrics.charCount} chars, ${result.metrics.lineCount} lines, ${result.metrics.sentenceCount} sentences, ${result.metrics.paragraphCount} paragraphs`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output has substantive content (not repetitive, not filler-heavy).
 *
 * Checks:
 * - Unique word ratio (vocabulary diversity)
 * - Consecutive duplicate lines (looping detection)
 * - Average sentence length
 * - Filler phrase density
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toBeSubstantive({ minUniqueWordRatio: 0.4 })]
 * ```
 */
export function toBeSubstantive(options?: SubstanceOptions): Assertion {
  return {
    name: 'substantive content',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = checkCompleteness(output, { substance: options });
      const substanceViolations = result.violations.filter(v => v.category === 'substance');

      if (substanceViolations.length === 0) {
        return {
          status: 'pass',
          name: 'substantive content',
          message: `Unique ratio: ${result.metrics.uniqueWordRatio.toFixed(2)}, avg words/sentence: ${result.metrics.avgWordsPerSentence.toFixed(1)}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: 'substantive content',
        message: substanceViolations.map(v => v.message).join('; '),
        evidence: `Metrics: unique ratio=${result.metrics.uniqueWordRatio.toFixed(2)}, avg words/sent=${result.metrics.avgWordsPerSentence.toFixed(1)}, words=${result.metrics.wordCount}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output is not truncated.
 *
 * Detects:
 * - Explicit truncation markers ([...], [truncated], etc.)
 * - Cut-off mid-word
 * - Incomplete endings
 * - Unbalanced brackets
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toBeComplete()]
 * ```
 */
export function toBeComplete(options?: StructuralCompletenessOptions): Assertion {
  return {
    name: 'structurally complete',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = checkCompleteness(output, { structure: options });
      const structureViolations = result.violations.filter(
        v => v.category === 'structure' || v.category === 'truncation'
      );

      if (structureViolations.length === 0) {
        return {
          status: 'pass',
          name: 'structurally complete',
          durationMs: performance.now() - start,
        };
      }

      // Errors = fail, warnings only = still pass (but with message)
      const hasErrors = structureViolations.some(v => v.severity === 'error');

      return {
        status: hasErrors ? 'fail' : 'pass',
        name: 'structurally complete',
        message: structureViolations.map(v => `[${v.severity}] ${v.message}`).join('; '),
        evidence: `Truncated: ${result.metrics.isTruncated}, chars: ${result.metrics.charCount}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Combined completeness assertion — checks non-empty + length + substance + structure.
 *
 * This is the "batteries-included" completeness check that covers all structural
 * aspects of output quality in a single assertion.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toPassCompletenessCheck({ length: { minWords: 50 }, substance: { minUniqueWordRatio: 0.4 } })]
 * ```
 */
export function toPassCompletenessCheck(options?: CompletenessOptions): Assertion {
  return {
    name: 'passes completeness check',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = checkCompleteness(output, options);

      if (result.complete) {
        const summary = [
          `${result.metrics.wordCount}w`,
          `${result.metrics.sentenceCount}s`,
          `unique=${result.metrics.uniqueWordRatio.toFixed(2)}`,
        ].join(', ');
        return {
          status: 'pass',
          name: 'passes completeness check',
          message: `Complete (${summary})`,
          durationMs: performance.now() - start,
        };
      }

      const errors = result.violations.filter(v => v.severity === 'error');
      const warnings = result.violations.filter(v => v.severity === 'warning');

      return {
        status: 'fail',
        name: 'passes completeness check',
        message: errors.map(v => v.message).join('; '),
        evidence: [
          `Errors (${errors.length}): ${errors.map(v => v.message).join('; ')}`,
          warnings.length > 0 ? `Warnings (${warnings.length}): ${warnings.map(v => v.message).join('; ')}` : null,
          `Metrics: ${result.metrics.wordCount}w, ${result.metrics.charCount}c, ${result.metrics.lineCount}L, unique=${result.metrics.uniqueWordRatio.toFixed(2)}`,
        ].filter(Boolean).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}