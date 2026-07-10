/**
 * Tests for the actionability pattern tables & response-type classifier
 * (Tier 2 - Heuristic).
 *
 * These are the module-internal regex vocabulary and classifier that drive
 * heuristic actionability scoring. Only `detectResponseType` is part of the
 * public surface (re-exported from `./actionability.js`); the pattern tables
 * are internal but pinned here directly so a silent regression in the regex
 * vocabulary (which would quietly corrupt actionability scores) is caught.
 */

import { describe, it, expect } from 'vitest';
import {
  HEDGE_PATTERNS,
  PLATITUDE_PATTERNS,
  WEASEL_PATTERNS,
  IMPERATIVE_PATTERN,
  CODE_SNIPPET_PATTERN,
  FILE_REFERENCE_PATTERN,
  COMMAND_PATTERN,
  URL_PATTERN,
  STEP_PATTERN,
  SPECIFIC_VALUE_PATTERN,
  detectResponseType,
  RESPONSE_TYPE_WEIGHTS,
} from '../src/checks/actionability-patterns.js';

const anyMatch = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((r) => r.test(text));

describe('detectResponseType', () => {
  it('classifies a code review task', () => {
    expect(detectResponseType('Please review this PR diff and leave feedback')).toBe('code-review');
  });

  it('classifies a how-to task', () => {
    expect(detectResponseType('How to configure the linter')).toBe('how-to');
    expect(detectResponseType('Steps to set up the dev environment')).toBe('how-to');
  });

  it('classifies a fix task', () => {
    expect(detectResponseType('Fix the failing build')).toBe('fix');
    expect(detectResponseType('Help me troubleshoot this crash')).toBe('fix');
  });

  it('classifies a summary task', () => {
    expect(detectResponseType('Give me a TLDR of the changes')).toBe('summary');
    expect(detectResponseType('Write an overview of the module')).toBe('summary');
  });

  it('classifies a decision task', () => {
    expect(detectResponseType('Which framework should I choose?')).toBe('decision');
    expect(detectResponseType('Compare the pros and cons of these options')).toBe('decision');
  });

  it('classifies an explanation task', () => {
    expect(detectResponseType('Explain what a closure is')).toBe('explanation');
    expect(detectResponseType('Why does this deadlock?')).toBe('explanation');
  });

  it('falls back to general for unclassifiable text', () => {
    expect(detectResponseType('hello there friend')).toBe('general');
    expect(detectResponseType('')).toBe('general');
  });

  it('is case-insensitive', () => {
    expect(detectResponseType('EXPLAIN THIS')).toBe('explanation');
    expect(detectResponseType('FIX IT')).toBe('fix');
  });

  it('treats the bare word "review" as code-review (both review clauses match one word)', () => {
    // The code-review branch needs a match in each of two alternations, and the
    // single word "review" satisfies both — pin this as intentional behaviour.
    expect(detectResponseType('review')).toBe('code-review');
  });

  it('resolves ambiguous tasks by branch precedence (how-to before fix)', () => {
    // "how to fix the bug" matches both how-to and fix; how-to is checked first.
    expect(detectResponseType('how to fix the bug')).toBe('how-to');
  });
});

describe('actionable-signal patterns', () => {
  it('IMPERATIVE_PATTERN matches leading action verbs only', () => {
    expect(IMPERATIVE_PATTERN.test('Run the tests now')).toBe(true);
    expect(IMPERATIVE_PATTERN.test('Install the package')).toBe(true);
    // must be at the start — a verb mid-sentence should not match
    expect(IMPERATIVE_PATTERN.test('The tests are running')).toBe(false);
  });

  it('CODE_SNIPPET_PATTERN matches fenced and inline code', () => {
    expect(CODE_SNIPPET_PATTERN.test('```js\nx\n```')).toBe(true);
    expect(CODE_SNIPPET_PATTERN.test('use `foo()` here')).toBe(true);
    expect(CODE_SNIPPET_PATTERN.test('no code here at all')).toBe(false);
  });

  it('FILE_REFERENCE_PATTERN matches paths and known extensions', () => {
    expect(FILE_REFERENCE_PATTERN.test('see src/index.ts')).toBe(true);
    expect(FILE_REFERENCE_PATTERN.test('open config.yaml')).toBe(true);
    expect(FILE_REFERENCE_PATTERN.test('just prose about things')).toBe(false);
  });

  it('COMMAND_PATTERN matches a known tool followed by an argument', () => {
    expect(COMMAND_PATTERN.test('npm install foo')).toBe(true);
    expect(COMMAND_PATTERN.test('git commit -m x')).toBe(true);
    // the tool name alone (no argument) should not match
    expect(COMMAND_PATTERN.test('please install foo')).toBe(false);
  });

  it('URL_PATTERN matches http(s) URLs', () => {
    expect(URL_PATTERN.test('go to https://example.com/y')).toBe(true);
    expect(URL_PATTERN.test('http://x.io')).toBe(true);
    expect(URL_PATTERN.test('no link here')).toBe(false);
  });

  it('STEP_PATTERN matches numbered and worded steps', () => {
    expect(STEP_PATTERN.test('1. first thing')).toBe(true);
    expect(STEP_PATTERN.test('2) second thing')).toBe(true);
    expect(STEP_PATTERN.test('Step 2 do this')).toBe(true);
    expect(STEP_PATTERN.test('just a paragraph')).toBe(false);
  });

  it('SPECIFIC_VALUE_PATTERN matches concrete values and units', () => {
    expect(SPECIFIC_VALUE_PATTERN.test('set timeout = 30')).toBe(true);
    expect(SPECIFIC_VALUE_PATTERN.test('wait 500ms')).toBe(true);
    expect(SPECIFIC_VALUE_PATTERN.test('a `CONST_NAME` value')).toBe(true);
    expect(SPECIFIC_VALUE_PATTERN.test('vague and unspecific')).toBe(false);
  });
});

describe('anti-signal pattern tables', () => {
  it('HEDGE_PATTERNS flag non-committal advice', () => {
    expect(anyMatch(HEDGE_PATTERNS, 'you might want to consider this')).toBe(true);
    expect(anyMatch(HEDGE_PATTERNS, 'it depends on your situation')).toBe(true);
    expect(anyMatch(HEDGE_PATTERNS, 'Run migration 004 then restart the server')).toBe(false);
  });

  it('PLATITUDE_PATTERNS flag empty best-practice advice', () => {
    expect(anyMatch(PLATITUDE_PATTERNS, 'make sure to follow best practices')).toBe(true);
    expect(anyMatch(PLATITUDE_PATTERNS, 'test your code thoroughly')).toBe(true);
    expect(anyMatch(PLATITUDE_PATTERNS, 'delete the stale lock at .cache/lock')).toBe(false);
  });

  it('WEASEL_PATTERNS flag vague quantifiers and appeals', () => {
    expect(anyMatch(WEASEL_PATTERNS, 'research shows this works')).toBe(true);
    expect(anyMatch(WEASEL_PATTERNS, 'many developers prefer this')).toBe(true);
    expect(anyMatch(WEASEL_PATTERNS, 'the function returns 42 on line 10')).toBe(false);
  });

  it('pattern tables are non-empty', () => {
    expect(HEDGE_PATTERNS.length).toBeGreaterThan(0);
    expect(PLATITUDE_PATTERNS.length).toBeGreaterThan(0);
    expect(WEASEL_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('RESPONSE_TYPE_WEIGHTS', () => {
  const types = [
    'code-review',
    'how-to',
    'explanation',
    'fix',
    'summary',
    'decision',
    'general',
  ] as const;

  it('has an entry for every response type', () => {
    expect(Object.keys(RESPONSE_TYPE_WEIGHTS).sort()).toEqual([...types].sort());
  });

  it('each weight set sums to 1.0 (a valid convex combination)', () => {
    for (const type of types) {
      const w = RESPONSE_TYPE_WEIGHTS[type];
      const sum = w.imperative + w.specificity + w.examples + w.completeness;
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('every weight is a non-negative fraction', () => {
    for (const type of types) {
      const w = RESPONSE_TYPE_WEIGHTS[type];
      for (const v of [w.imperative, w.specificity, w.examples, w.completeness]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('weights the review type toward specificity and imperative signals', () => {
    const w = RESPONSE_TYPE_WEIGHTS['code-review'];
    expect(w.specificity).toBeGreaterThanOrEqual(w.completeness);
    expect(w.imperative).toBeGreaterThan(w.completeness);
  });
});
