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
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** A single constraint rule that output must satisfy. */
export interface ConstraintRule {
  /** Type of constraint check. */
  kind: 'required' | 'forbidden';
  /** Type of matching to perform. */
  match: 'keyword' | 'regex' | 'phrase';
  /** The pattern, keyword, or phrase. For regex, provide a string that will be compiled. */
  value: string | RegExp;
  /** Case-sensitive matching (default: false for keyword/phrase, respected for regex flags). */
  caseSensitive?: boolean;
  /** Human-readable description of why this constraint exists. */
  reason?: string;
  /** Severity when violated: 'error' (fail) or 'warning'. Default: 'error'. */
  severity?: 'error' | 'warning';
}

/** Options for keyword coverage scoring. */
export interface KeywordCoverageOptions {
  /** List of expected keywords/phrases. */
  keywords: string[];
  /** Minimum coverage ratio to pass (0–1). Default: 0.8 (80%). */
  minCoverage?: number;
  /** Whether matching is case-sensitive. Default: false. */
  caseSensitive?: boolean;
  /** Whether to match whole words only. Default: false. */
  wholeWord?: boolean;
}

/** Result of a keyword coverage analysis. */
export interface KeywordCoverageResult {
  /** Coverage ratio (0–1). */
  coverage: number;
  /** Number of keywords found. */
  found: number;
  /** Total keywords expected. */
  total: number;
  /** List of keywords that were found. */
  present: string[];
  /** List of keywords that are missing. */
  missing: string[];
}

/** A constraint violation found during validation. */
export interface ConstraintViolation {
  /** The rule that was violated. */
  rule: ConstraintRule;
  /** Description of the violation. */
  message: string;
  /** Severity: error = assertion fails, warning = passes with note. */
  severity: 'error' | 'warning';
  /** Location context (line numbers, positions) if available. */
  location?: ViolationLocation;
}

/** Location details for a constraint violation. */
export interface ViolationLocation {
  /** Line number (1-indexed) where the violation was found. */
  line?: number;
  /** Column (0-indexed) where the match starts. */
  column?: number;
  /** The matched text. */
  matched?: string;
}

/** Options for constraint validation. */
export interface ConstraintValidationOptions {
  /** List of constraint rules to check. */
  rules: ConstraintRule[];
  /** Whether to fail on first violation or collect all. Default: false (collect all). */
  failFast?: boolean;
}

/** Result of constraint validation. */
export interface ConstraintValidationResult {
  /** Whether all constraints passed (no error-severity violations). */
  valid: boolean;
  /** All violations found. */
  violations: ConstraintViolation[];
  /** Number of rules that passed. */
  passed: number;
  /** Number of rules that failed (error severity). */
  failed: number;
  /** Number of rules with warnings. */
  warnings: number;
  /** Total rules checked. */
  total: number;
}

// ─── CONSTRAINT HELPERS ─────────────────────────────────────────────────────────

/**
 * Convert a ConstraintRule value into a usable RegExp for matching.
 */
function ruleToRegExp(rule: ConstraintRule): RegExp {
  const caseSensitive = rule.caseSensitive ?? false;

  if (rule.value instanceof RegExp) {
    // Use the regex as-is but respect caseSensitive override
    if (caseSensitive) {
      return rule.value;
    }
    // Rebuild without 'i' flag to honor caseSensitive=false (add 'i')
    const flags = rule.value.flags.includes('i') ? rule.value.flags : rule.value.flags + 'i';
    return new RegExp(rule.value.source, flags);
  }

  const value = rule.value;
  const flags = caseSensitive ? 'g' : 'gi';

  if (rule.match === 'regex') {
    return new RegExp(value, flags);
  }

  // For keyword/phrase matching, escape regex special characters
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (rule.match === 'keyword') {
    // Word boundary matching for keywords.
    // If the keyword starts/ends with non-word characters (e.g. "C++"),
    // we can't use \b at that boundary — use lookahead/lookbehind instead.
    const startsWithWord = /^\w/.test(escaped);
    const endsWithWord = /\w$/.test(escaped);
    const prefix = startsWithWord ? '\\b' : '(?<![\\w])';
    const suffix = endsWithWord ? '\\b' : '(?![\\w])';
    return new RegExp(`${prefix}${escaped}${suffix}`, flags);
  }

  // Phrase: exact substring matching (no word boundaries required)
  return new RegExp(escaped, flags);
}

/**
 * Find the location of a match in text.
 */
function findMatchLocation(text: string, pattern: RegExp): ViolationLocation | undefined {
  const match = pattern.exec(text);
  if (!match) return undefined;

  const beforeMatch = text.slice(0, match.index);
  const line = (beforeMatch.match(/\n/g) || []).length + 1;
  const lastNewline = beforeMatch.lastIndexOf('\n');
  const column = lastNewline === -1 ? match.index : match.index - lastNewline - 1;

  return {
    line,
    column,
    matched: match[0],
  };
}

// ─── VALIDATION FUNCTIONS ───────────────────────────────────────────────────────

/**
 * Validate a single constraint rule against output text.
 */
export function validateRule(output: string, rule: ConstraintRule): ConstraintViolation | null {
  const pattern = ruleToRegExp(rule);
  const isPresent = pattern.test(output);

  // Reset lastIndex for global regexes
  pattern.lastIndex = 0;

  const severity = rule.severity ?? 'error';

  if (rule.kind === 'required' && !isPresent) {
    const valueStr = rule.value instanceof RegExp ? rule.value.toString() : `"${rule.value}"`;
    return {
      rule,
      message: rule.reason
        ? `Missing required ${rule.match}: ${valueStr} — ${rule.reason}`
        : `Missing required ${rule.match}: ${valueStr}`,
      severity,
    };
  }

  if (rule.kind === 'forbidden' && isPresent) {
    const valueStr = rule.value instanceof RegExp ? rule.value.toString() : `"${rule.value}"`;
    const location = findMatchLocation(output, pattern);
    return {
      rule,
      message: rule.reason
        ? `Found forbidden ${rule.match}: ${valueStr} — ${rule.reason}`
        : `Found forbidden ${rule.match}: ${valueStr}`,
      severity,
      location,
    };
  }

  return null;
}

/**
 * Validate output against a full set of constraint rules.
 */
export function validateConstraints(
  output: string,
  options: ConstraintValidationOptions,
): ConstraintValidationResult {
  const violations: ConstraintViolation[] = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const rule of options.rules) {
    const violation = validateRule(output, rule);

    if (violation === null) {
      passed++;
    } else {
      violations.push(violation);
      if (violation.severity === 'error') {
        failed++;
        if (options.failFast) {
          return {
            valid: false,
            violations,
            passed,
            failed,
            warnings,
            total: options.rules.length,
          };
        }
      } else {
        warnings++;
      }
    }
  }

  return {
    valid: failed === 0,
    violations,
    passed,
    failed,
    warnings,
    total: options.rules.length,
  };
}

/**
 * Calculate keyword coverage — what percentage of expected keywords appear in output.
 */
export function calculateKeywordCoverage(
  output: string,
  options: KeywordCoverageOptions,
): KeywordCoverageResult {
  const { keywords, caseSensitive = false, wholeWord = false } = options;
  const present: string[] = [];
  const missing: string[] = [];

  const normalizedOutput = caseSensitive ? output : output.toLowerCase();

  for (const keyword of keywords) {
    const normalizedKeyword = caseSensitive ? keyword : keyword.toLowerCase();
    let found: boolean;

    if (wholeWord) {
      const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = caseSensitive ? '' : 'i';
      const pattern = new RegExp(`\\b${escaped}\\b`, flags);
      found = pattern.test(output);
    } else {
      found = normalizedOutput.includes(normalizedKeyword);
    }

    if (found) {
      present.push(keyword);
    } else {
      missing.push(keyword);
    }
  }

  const total = keywords.length;
  const coverage = total === 0 ? 1 : present.length / total;

  return { coverage, found: present.length, total, present, missing };
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

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
      const caseSensitive = options?.caseSensitive ?? false;
      const wholeWord = options?.wholeWord ?? true;
      const found: string[] = [];

      for (const keyword of keywords) {
        let isPresent: boolean;
        if (wholeWord) {
          const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const flags = caseSensitive ? '' : 'i';
          const pattern = new RegExp(`\\b${escaped}\\b`, flags);
          isPresent = pattern.test(output);
        } else {
          const normalizedOutput = caseSensitive ? output : output.toLowerCase();
          const normalizedKeyword = caseSensitive ? keyword : keyword.toLowerCase();
          isPresent = normalizedOutput.includes(normalizedKeyword);
        }
        if (isPresent) {
          found.push(keyword);
        }
      }

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
