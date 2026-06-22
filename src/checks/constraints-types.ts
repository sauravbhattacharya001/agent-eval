/**
 * Constraint Validator — Type Vocabulary
 *
 * The types shared by the constraint-validation engine
 * (`./constraints-analysis.js`) and the public barrel (`./constraints.js`):
 * the constraint-rule model, keyword-coverage options/results, and the
 * violation shapes. Kept dependency-free so both the engine and the assertion
 * factories can import them without pulling in any runtime code.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

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