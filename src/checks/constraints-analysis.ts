/**
 * Constraint Validator — Deterministic Engine
 *
 * Pure pattern/keyword matching with zero AI dependencies: compile a
 * `ConstraintRule` into a `RegExp`, validate single rules and full rule sets,
 * and compute keyword coverage. No filesystem or network access — input
 * strings in, results out.
 *
 * Re-exported through the public barrel (`./constraints.js`); the type
 * vocabulary lives in `./constraints-types.js`.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  ConstraintRule,
  ConstraintValidationOptions,
  ConstraintValidationResult,
  ConstraintViolation,
  KeywordCoverageOptions,
  KeywordCoverageResult,
  ViolationLocation,
} from './constraints-types.js';

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