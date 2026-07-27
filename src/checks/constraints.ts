/**
 * Constraint Validator — Tier 1 Deterministic Check
 *
 * Validates agent output against explicit constraints from a task specification:
 * - Required keywords/phrases that must appear
 * - Forbidden keywords/phrases that must NOT appear
 * - Required regex patterns
 * - Forbidden regex patterns
 * - Keyword coverage scoring (what percentage of expected terms are present)
 * - Section/heading requirements
 * - Case-sensitive and case-insensitive matching
 *
 * All checks are deterministic — pure pattern/keyword matching with no AI.
 *
 * This file is the **public barrel** for constraint checking and the home of
 * the assertion factories that wrap the engine into Jest/Vitest-style
 * assertions. The supporting seams live alongside it and are re-exported here
 * so the public surface stays a single `./constraints.js` import path:
 * - ./constraints-types.js    - the type vocabulary (rule/coverage/violation model)
 * - ./constraints-analysis.js - the deterministic engine (validateRule /
 *                               validateConstraints / calculateKeywordCoverage)
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  ConstraintRule,
  ConstraintValidationOptions,
  KeywordCoverageOptions,
} from './constraints-types.js';
import {
  calculateKeywordCoverage,
  validateConstraints,
} from './constraints-analysis.js';

// --- TYPE RE-EXPORTS -----------------------------------------------------------
// The constraint type vocabulary lives in ./constraints-types.js; re-export it
// here so consumers keep a single `./constraints.js` import path.
export type {
  ConstraintRule,
  ConstraintValidationOptions,
  ConstraintValidationResult,
  ConstraintViolation,
  KeywordCoverageOptions,
  KeywordCoverageResult,
  ViolationLocation,
} from './constraints-types.js';

// --- ENGINE RE-EXPORTS ---------------------------------------------------------
// The deterministic engine (rule compilation + validation + coverage) lives
// alongside; re-export the public functions so the barrel is the single surface.
export {
  calculateKeywordCoverage,
  validateConstraints,
  validateRule,
} from './constraints-analysis.js';

// --- ASSERTION FACTORIES -------------------------------------------------------

/**
 * Assert that output contains all required keywords.
 *
 * Checks that every keyword in the list appears in the output.
 * Uses word-boundary matching by default.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toContainKeywords(['ESLint', 'TypeScript', 'config'])]
 * ```
 */
export function toContainKeywords(
  keywords: string[],
  options?: { caseSensitive?: boolean; wholeWord?: boolean },
): Assertion {
  const name = `contains keywords [${keywords.slice(0, 5).map(k => `"${k}"`).join(', ')}${keywords.length > 5 ? `, +${keywords.length - 5} more` : ''}]`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = calculateKeywordCoverage(output, {
        keywords,
        caseSensitive: options?.caseSensitive,
        wholeWord: options?.wholeWord ?? true,
      });

      if (result.missing.length === 0) {
        return {
          status: 'pass',
          name,
          message: `All ${result.total} keywords found`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name,
        message: `Missing ${result.missing.length}/${result.total} keywords: ${result.missing.slice(0, 5).map(k => `"${k}"`).join(', ')}${result.missing.length > 5 ? ` (+${result.missing.length - 5} more)` : ''}`,
        expected: `All of: ${keywords.map(k => `"${k}"`).join(', ')}`,
        actual: `Found: ${result.present.slice(0, 5).map(k => `"${k}"`).join(', ')}${result.present.length > 5 ? ` (+${result.present.length - 5} more)` : ''}`,
        evidence: `Coverage: ${(result.coverage * 100).toFixed(0)}% (${result.found}/${result.total})`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output does NOT contain any of the forbidden keywords.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toNotContainKeywords(['deprecated', 'legacy', 'workaround'])]
 * ```
 */
export function toNotContainKeywords(
  keywords: string[],
  options?: { caseSensitive?: boolean; wholeWord?: boolean },
): Assertion {
  const name = `excludes keywords [${keywords.slice(0, 5).map(k => `"${k}"`).join(', ')}${keywords.length > 5 ? `, +${keywords.length - 5} more` : ''}]`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      // Reuse the deterministic engine's presence matching rather than a
      // second inline copy: the keywords "present" in the coverage result are
      // exactly the forbidden keywords that were found. `wholeWord` defaults to
      // true here (constraint-exclusion semantics), so it is always passed
      // explicitly and never relies on the engine's own default.
      const coverage = calculateKeywordCoverage(output, {
        keywords,
        caseSensitive: options?.caseSensitive ?? false,
        wholeWord: options?.wholeWord ?? true,
      });
      const found = coverage.present;

      if (found.length === 0) {
        return {
          status: 'pass',
          name,
          message: `None of ${keywords.length} forbidden keywords found`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name,
        message: `Found ${found.length} forbidden keyword(s): ${found.map(k => `"${k}"`).join(', ')}`,
        expected: `None of: ${keywords.map(k => `"${k}"`).join(', ')}`,
        actual: `Found: ${found.map(k => `"${k}"`).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output meets a minimum keyword coverage threshold.
 *
 * Unlike `toContainKeywords` which requires ALL keywords, this allows partial
 * coverage with a configurable threshold (e.g., "at least 80% of expected terms").
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toMeetKeywordCoverage({
 *   keywords: ['setup', 'install', 'config', 'build', 'test', 'deploy'],
 *   minCoverage: 0.7
 * })]
 * ```
 */
export function toMeetKeywordCoverage(options: KeywordCoverageOptions): Assertion {
  const minCoverage = options.minCoverage ?? 0.8;
  const name = `keyword coverage ≥${(minCoverage * 100).toFixed(0)}% of [${options.keywords.slice(0, 3).map(k => `"${k}"`).join(', ')}${options.keywords.length > 3 ? `, +${options.keywords.length - 3} more` : ''}]`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = calculateKeywordCoverage(output, options);

      if (result.coverage >= minCoverage) {
        return {
          status: 'pass',
          name,
          message: `Coverage: ${(result.coverage * 100).toFixed(0)}% (${result.found}/${result.total})`,
          evidence: result.missing.length > 0
            ? `Missing (acceptable): ${result.missing.map(k => `"${k}"`).join(', ')}`
            : undefined,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name,
        message: `Coverage ${(result.coverage * 100).toFixed(0)}% below threshold ${(minCoverage * 100).toFixed(0)}%`,
        expected: `≥${(minCoverage * 100).toFixed(0)}% of keywords`,
        actual: `${(result.coverage * 100).toFixed(0)}% (${result.found}/${result.total})`,
        evidence: `Missing: ${result.missing.map(k => `"${k}"`).join(', ')}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that output satisfies all given constraint rules.
 *
 * This is the most flexible constraint assertion — takes a full set of rules
 * with required/forbidden keywords, phrases, and regex patterns.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toSatisfyConstraints({
 *   rules: [
 *     { kind: 'required', match: 'keyword', value: 'TypeScript' },
 *     { kind: 'forbidden', match: 'phrase', value: 'as an AI language model' },
 *     { kind: 'required', match: 'regex', value: 'v\\d+\\.\\d+' },
 *   ]
 * })]
 * ```
 */
export function toSatisfyConstraints(options: ConstraintValidationOptions): Assertion {
  const ruleCount = options.rules.length;
  const name = `satisfies ${ruleCount} constraint rule${ruleCount !== 1 ? 's' : ''}`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = validateConstraints(output, options);

      if (result.valid) {
        const summary = result.warnings > 0
          ? `${result.passed} passed, ${result.warnings} warning(s)`
          : `All ${result.passed} rules passed`;
        return {
          status: 'pass',
          name,
          message: summary,
          evidence: result.warnings > 0
            ? result.violations
                .filter(v => v.severity === 'warning')
                .map(v => `[warning] ${v.message}`)
                .join('; ')
            : undefined,
          durationMs: performance.now() - start,
        };
      }

      const errors = result.violations.filter(v => v.severity === 'error');
      const warnings = result.violations.filter(v => v.severity === 'warning');

      return {
        status: 'fail',
        name,
        message: `${result.failed} constraint(s) violated: ${errors.slice(0, 3).map(v => v.message).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`,
        expected: `All ${ruleCount} rules satisfied`,
        actual: `${result.passed} passed, ${result.failed} failed, ${result.warnings} warning(s)`,
        evidence: [
          ...errors.map(v => {
            const loc = v.location ? ` (line ${v.location.line})` : '';
            return `[ERROR] ${v.message}${loc}`;
          }),
          ...warnings.map(v => `[WARN] ${v.message}`),
        ].join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output matches required patterns and does not match forbidden patterns.
 *
 * Convenience wrapper around `toSatisfyConstraints` for simple regex rule sets.
 *
 * @tier 1 — Deterministic
 * @example
 * ```ts
 * assertions: [toMatchPatterns({
 *   required: [/function\s+\w+/, /return\s/],
 *   forbidden: [/console\.log/, /any/]
 * })]
 * ```
 */
export function toMatchPatterns(options: {
  required?: RegExp[];
  forbidden?: RegExp[];
}): Assertion {
  const rules: ConstraintRule[] = [];

  if (options.required) {
    for (const pattern of options.required) {
      rules.push({ kind: 'required', match: 'regex', value: pattern });
    }
  }

  if (options.forbidden) {
    for (const pattern of options.forbidden) {
      rules.push({ kind: 'forbidden', match: 'regex', value: pattern });
    }
  }

  const name = `pattern constraints (${options.required?.length ?? 0} required, ${options.forbidden?.length ?? 0} forbidden)`;

  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = validateConstraints(output, { rules });

      if (result.valid) {
        return {
          status: 'pass',
          name,
          message: `All ${result.total} pattern rules satisfied`,
          durationMs: performance.now() - start,
        };
      }

      const errors = result.violations.filter(v => v.severity === 'error');
      return {
        status: 'fail',
        name,
        message: errors.map(v => v.message).join('; '),
        expected: `All patterns ${options.required ? 'present' : ''}${options.required && options.forbidden ? ' and forbidden ' : ''}${options.forbidden ? 'absent' : ''}`,
        actual: `${result.failed} violation(s)`,
        evidence: errors.map(v => v.message).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}