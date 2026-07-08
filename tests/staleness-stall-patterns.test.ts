/**
 * Direct coverage for two under-pinned corners of the Staleness detection seam
 * (`staleness-detection.ts`):
 *
 *   1. `STALL_PATTERNS` — a stall-signal pattern table that `staleness.ts`'s
 *      `toNotBeStalled` assertion spreads into its match set, yet nothing pinned
 *      the table itself. The two regexes are subtle (a mixed-case/multiline
 *      three-token retry-loop matcher and a `(.{50,})\1{2,}` repeated-block
 *      backreference); a careless refactor could silently weaken either without
 *      failing a single existing test. The table is intentionally seam-private
 *      (NOT re-exported through the barrel), so these tests pin its shape and
 *      both regexes' true/false boundaries directly, and confirm the ONE public
 *      surface that composes it (`toNotBeStalled`) still fires on both signals.
 *
 *   2. `detectUnbalancedCode` — a private helper reached only through
 *      `detectAbandonment({ checkUnbalancedCode })`. It powers the hardest
 *      abandonment signal (output truncated mid-code) and has several distinct
 *      branches — fenced-block extraction, the "bare code" heuristic gate (needs
 *      BOTH a bracket char AND a code keyword), balanced-vs-unbalanced, and
 *      unclosed-vs-extra-closing for each delimiter — none exercised directly.
 *      The behavioural suites only ever hit the single "unclosed brace" path.
 *
 * The inputs here were validated against the compiled module before being
 * committed, so they assert real behaviour, not a reading of the regexes.
 */

import { describe, it, expect } from 'vitest';

import {
  STALL_PATTERNS as STALL_PATTERNS_SEAM,
  detectAbandonment,
} from '../src/checks/staleness-detection.js';
import { toNotBeStalled } from '../src/checks/staleness.js';
import type { StalenessIssue } from '../src/checks/staleness-types.js';

// Markdown code fence, concatenated so literal back-ticks never confuse the
// source (and stay stable across CRLF normalization).
const FENCE = '`'.repeat(3);
const hasUnbalanced = (issues: StalenessIssue[]): boolean =>
  issues.some((i) => /unbalanced code/.test(i.message));

// === STALL_PATTERNS: exported table + barrel identity ============================

describe('STALL_PATTERNS (exported stall table)', () => {
  it('is a two-entry table of {pattern: RegExp, label: string}', () => {
    expect(STALL_PATTERNS_SEAM).toHaveLength(2);
    for (const entry of STALL_PATTERNS_SEAM) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.label).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('names the two stall signals (retry loop + repeated block)', () => {
    const labels = STALL_PATTERNS_SEAM.map((p) => p.label);
    expect(labels).toContain('repeated errors (possible retry loop)');
    expect(labels).toContain('repeated content block');
  });

  it('is composed by the barrel assertion toNotBeStalled (both signals fire)', () => {
    // The table is seam-private (NOT re-exported); the only public surface that
    // depends on it is `toNotBeStalled`, which spreads it into its match set.
    // Pin the composition so a refactor of the table cannot silently stop the
    // assertion from firing on either built-in signal.
    const retryLoop = toNotBeStalled().evaluate('error: failed retry; error: failed retry; error: failed retry');
    expect(retryLoop.status).toBe('fail');
    expect(retryLoop.message).toMatch(/retry loop/);

    const repeatedBlock = 'x'.repeat(50).repeat(3);
    const repeated = toNotBeStalled().evaluate(repeatedBlock);
    expect(repeated.status).toBe('fail');
    expect(repeated.message).toMatch(/repeated content block/);
  });
});

describe('STALL_PATTERNS: retry-loop regex boundary', () => {
  const retry = STALL_PATTERNS_SEAM[0]!.pattern;

  it('matches three error/failed/retry tokens', () => {
    expect(retry.test('error then failed then retry')).toBe(true);
  });

  it('matches case-insensitively and across newlines', () => {
    expect(retry.test('Error\nsomething\nFAILED\nmore\nRetry')).toBe(true);
  });

  it('does NOT match when only two tokens are present', () => {
    expect(retry.test('error then failed then done')).toBe(false);
  });
});

describe('STALL_PATTERNS: repeated-block regex boundary', () => {
  const repeated = STALL_PATTERNS_SEAM[1]!.pattern;
  const block = 'x'.repeat(50);

  it('matches a 50+ char block repeated three times', () => {
    expect(repeated.test(block + block + block)).toBe(true);
  });

  it('does NOT match the same block repeated only twice', () => {
    // `\1{2,}` requires the captured block to recur at least twice MORE
    // (three occurrences total), so a single repeat is below threshold.
    expect(repeated.test(block + block)).toBe(false);
  });

  it('does NOT match a short (sub-50-char) block repeated three times', () => {
    expect(repeated.test('y'.repeat(10).repeat(3))).toBe(false);
  });
});

// === detectUnbalancedCode branches (via detectAbandonment) =======================

describe('detectAbandonment: unbalanced-code detection branches', () => {
  it('flags an unclosed brace inside a fenced block as an error', () => {
    const issues = detectAbandonment('Fix:\n' + FENCE + 'ts\nfunction go() {\n  return 1;\n' + FENCE);
    const unbalanced = issues.find((i) => hasUnbalanced([i]));
    expect(unbalanced).toBeDefined();
    expect(unbalanced?.kind).toBe('abandoned');
    expect(unbalanced?.severity).toBe('error');
    expect(unbalanced?.message).toMatch(/unclosed brace/);
  });

  it('does NOT flag balanced fenced code', () => {
    const issues = detectAbandonment('All done:\n' + FENCE + 'ts\nfunction go() { return 1; }\n' + FENCE);
    expect(hasUnbalanced(issues)).toBe(false);
  });

  it('reports EXTRA closing delimiters, not just unclosed ones', () => {
    const issues = detectAbandonment(FENCE + 'ts\nfunction go() { return 1; }}\n' + FENCE);
    const unbalanced = issues.find((i) => hasUnbalanced([i]));
    expect(unbalanced?.message).toMatch(/extra closing brace/);
  });

  it('treats bare (fence-less) content as code only when it has BOTH brackets and a code keyword', () => {
    // Has a code keyword (`const`) + an unclosed bracket → detected.
    const codey = detectAbandonment('here is the change: const items = [1, 2, 3');
    expect(hasUnbalanced(codey)).toBe(true);

    // Unbalanced parens but NO code keyword → prose, not code → skipped.
    const prose = detectAbandonment('the shopping list ( milk, eggs, bread is what we still need to buy');
    expect(hasUnbalanced(prose)).toBe(false);
  });

  it('respects checkUnbalancedCode: false (opt-out suppresses the check)', () => {
    const input = FENCE + 'ts\nfunction go() {\n  return 1;';
    expect(hasUnbalanced(detectAbandonment(input))).toBe(true);
    expect(hasUnbalanced(detectAbandonment(input, { checkUnbalancedCode: false }))).toBe(false);
  });
});
