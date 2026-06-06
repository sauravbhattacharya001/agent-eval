/**
 * Tests for the Constraint Validator — Tier 1 Deterministic Check
 */

import { describe, it, expect } from 'vitest';
import {
  validateRule,
  validateConstraints,
  calculateKeywordCoverage,
  toContainKeywords,
  toNotContainKeywords,
  toMeetKeywordCoverage,
  toSatisfyConstraints,
  toMatchPatterns,
} from '../src/checks/constraints.js';
import type {
  ConstraintRule,
  ConstraintValidationOptions,
} from '../src/checks/constraints.js';

// ─── validateRule ───────────────────────────────────────────────────────────────

describe('validateRule', () => {
  describe('required keyword', () => {
    it('passes when keyword is present', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'TypeScript' };
      const result = validateRule('I love TypeScript and JavaScript.', rule);
      expect(result).toBeNull();
    });

    it('fails when keyword is missing', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'Python' };
      const result = validateRule('I love TypeScript and JavaScript.', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Missing required keyword');
      expect(result!.message).toContain('Python');
    });

    it('uses case-insensitive matching by default', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'typescript' };
      const result = validateRule('TypeScript is great.', rule);
      expect(result).toBeNull();
    });

    it('respects caseSensitive option', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'typescript', caseSensitive: true };
      const result = validateRule('TypeScript is great.', rule);
      expect(result).not.toBeNull();
    });

    it('matches whole words only', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'type' };
      const result = validateRule('TypeScript is great.', rule);
      expect(result).not.toBeNull();
    });

    it('includes reason in message when provided', () => {
      const rule: ConstraintRule = {
        kind: 'required',
        match: 'keyword',
        value: 'ESLint',
        reason: 'Must reference the linter tool',
      };
      const result = validateRule('Use prettier for formatting.', rule);
      expect(result!.message).toContain('Must reference the linter tool');
    });
  });

  describe('required phrase', () => {
    it('passes when phrase is present', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'phrase', value: 'a language model' };
      const result = validateRule('As a language model, I can help.', rule);
      expect(result).toBeNull();
    });

    it('fails when phrase is missing', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'phrase', value: 'best practices' };
      const result = validateRule('Here is the code.', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Missing required phrase');
    });

    it('matches substrings (no word boundary)', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'phrase', value: 'Script' };
      const result = validateRule('TypeScript is great.', rule);
      expect(result).toBeNull();
    });
  });

  describe('required regex', () => {
    it('passes when pattern matches', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'regex', value: 'v\\d+\\.\\d+' };
      const result = validateRule('Updated to v2.5 successfully.', rule);
      expect(result).toBeNull();
    });

    it('fails when pattern does not match', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'regex', value: '\\d{4}-\\d{2}-\\d{2}' };
      const result = validateRule('The date is tomorrow.', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Missing required regex');
    });

    it('accepts RegExp objects', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'regex', value: /function\s+\w+/ };
      const result = validateRule('function hello() { return 1; }', rule);
      expect(result).toBeNull();
    });
  });

  describe('forbidden keyword', () => {
    it('passes when keyword is absent', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'keyword', value: 'deprecated' };
      const result = validateRule('This API is current and maintained.', rule);
      expect(result).toBeNull();
    });

    it('fails when keyword is present', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'keyword', value: 'deprecated' };
      const result = validateRule('This function is deprecated.', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Found forbidden keyword');
      expect(result!.message).toContain('deprecated');
    });

    it('provides location info for forbidden matches', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'keyword', value: 'TODO' };
      const result = validateRule('Line one\nLine two\nTODO: fix this\nLine four', rule);
      expect(result).not.toBeNull();
      expect(result!.location).toBeDefined();
      expect(result!.location!.line).toBe(3);
      expect(result!.location!.matched).toBe('TODO');
    });
  });

  describe('forbidden phrase', () => {
    it('passes when phrase is absent', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'phrase', value: 'as an AI' };
      const result = validateRule('Here are the results of the analysis.', rule);
      expect(result).toBeNull();
    });

    it('fails when phrase is present', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'phrase', value: 'as an AI' };
      const result = validateRule('As an AI language model, I cannot...', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Found forbidden phrase');
    });
  });

  describe('forbidden regex', () => {
    it('passes when pattern does not match', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'regex', value: /console\.log/ };
      const result = validateRule('logger.info("Starting server");', rule);
      expect(result).toBeNull();
    });

    it('fails when pattern matches', () => {
      const rule: ConstraintRule = { kind: 'forbidden', match: 'regex', value: /console\.log/ };
      const result = validateRule('console.log("debug");', rule);
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Found forbidden regex');
    });
  });

  describe('severity', () => {
    it('defaults to error severity', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'missing' };
      const result = validateRule('nothing here', rule);
      expect(result!.severity).toBe('error');
    });

    it('respects explicit warning severity', () => {
      const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'missing', severity: 'warning' };
      const result = validateRule('nothing here', rule);
      expect(result!.severity).toBe('warning');
    });
  });
});

// ─── validateConstraints ────────────────────────────────────────────────────────

describe('validateConstraints', () => {
  const sampleOutput = `
    # Setup Guide

    Install TypeScript with npm:
    \`\`\`bash
    npm install typescript --save-dev
    \`\`\`

    Configure ESLint for your project by creating .eslintrc.json.
    Make sure to add the @typescript-eslint/parser.
  `;

  it('validates multiple rules and reports all violations', () => {
    const options: ConstraintValidationOptions = {
      rules: [
        { kind: 'required', match: 'keyword', value: 'TypeScript' },
        { kind: 'required', match: 'keyword', value: 'ESLint' },
        { kind: 'required', match: 'keyword', value: 'Webpack' },
        { kind: 'forbidden', match: 'phrase', value: 'as an AI' },
      ],
    };
    const result = validateConstraints(sampleOutput, options);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(4);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.message).toContain('Webpack');
  });

  it('returns valid=true when all rules pass', () => {
    const options: ConstraintValidationOptions = {
      rules: [
        { kind: 'required', match: 'keyword', value: 'TypeScript' },
        { kind: 'required', match: 'keyword', value: 'npm' },
        { kind: 'forbidden', match: 'keyword', value: 'yarn' },
      ],
    };
    const result = validateConstraints(sampleOutput, options);
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.violations).toHaveLength(0);
  });

  it('supports failFast mode', () => {
    const options: ConstraintValidationOptions = {
      rules: [
        { kind: 'required', match: 'keyword', value: 'React' },
        { kind: 'required', match: 'keyword', value: 'Vue' },
        { kind: 'required', match: 'keyword', value: 'Angular' },
      ],
      failFast: true,
    };
    const result = validateConstraints(sampleOutput, options);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.failed).toBe(1);
  });

  it('counts warnings separately from failures', () => {
    const options: ConstraintValidationOptions = {
      rules: [
        { kind: 'required', match: 'keyword', value: 'TypeScript' },
        { kind: 'required', match: 'keyword', value: 'missing1', severity: 'warning' },
        { kind: 'required', match: 'keyword', value: 'missing2', severity: 'error' },
      ],
    };
    const result = validateConstraints(sampleOutput, options);
    expect(result.valid).toBe(false);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.warnings).toBe(1);
    expect(result.violations).toHaveLength(2);
  });

  it('treats warnings as valid (only errors cause invalid)', () => {
    const options: ConstraintValidationOptions = {
      rules: [
        { kind: 'required', match: 'keyword', value: 'TypeScript' },
        { kind: 'required', match: 'keyword', value: 'missing', severity: 'warning' },
      ],
    };
    const result = validateConstraints(sampleOutput, options);
    expect(result.valid).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it('handles empty rule set', () => {
    const result = validateConstraints(sampleOutput, { rules: [] });
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(0);
    expect(result.total).toBe(0);
  });
});

// ─── calculateKeywordCoverage ───────────────────────────────────────────────────

describe('calculateKeywordCoverage', () => {
  const output = 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. It supports ESLint and Prettier for code quality.';

  it('calculates coverage correctly', () => {
    const result = calculateKeywordCoverage(output, {
      keywords: ['TypeScript', 'JavaScript', 'ESLint', 'Prettier', 'React'],
    });
    expect(result.found).toBe(4);
    expect(result.total).toBe(5);
    expect(result.coverage).toBeCloseTo(0.8);
    expect(result.present).toContain('TypeScript');
    expect(result.present).toContain('JavaScript');
    expect(result.present).toContain('ESLint');
    expect(result.present).toContain('Prettier');
    expect(result.missing).toContain('React');
  });

  it('returns 1.0 coverage when all keywords found', () => {
    const result = calculateKeywordCoverage(output, {
      keywords: ['TypeScript', 'JavaScript'],
    });
    expect(result.coverage).toBe(1);
    expect(result.missing).toHaveLength(0);
  });

  it('returns 0.0 coverage when no keywords found', () => {
    const result = calculateKeywordCoverage(output, {
      keywords: ['Python', 'Ruby', 'Go'],
    });
    expect(result.coverage).toBe(0);
    expect(result.found).toBe(0);
    expect(result.missing).toHaveLength(3);
  });

  it('returns 1.0 for empty keyword list', () => {
    const result = calculateKeywordCoverage(output, { keywords: [] });
    expect(result.coverage).toBe(1);
    expect(result.total).toBe(0);
  });

  it('is case-insensitive by default', () => {
    const result = calculateKeywordCoverage(output, {
      keywords: ['typescript', 'ESLINT'],
    });
    expect(result.found).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it('respects caseSensitive option', () => {
    const result = calculateKeywordCoverage(output, {
      keywords: ['typescript', 'ESLINT'],
      caseSensitive: true,
    });
    expect(result.found).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it('supports wholeWord matching', () => {
    const result = calculateKeywordCoverage('The typeScript compiler is fast. Scripts run well.', {
      keywords: ['Script'],
      wholeWord: true,
    });
    expect(result.found).toBe(0);
  });

  it('supports substring matching when wholeWord is false', () => {
    const result = calculateKeywordCoverage('TypeScript is great', {
      keywords: ['Script'],
      wholeWord: false,
    });
    expect(result.found).toBe(1);
  });
});

// ─── toContainKeywords assertion ────────────────────────────────────────────────

describe('toContainKeywords', () => {
  it('passes when all keywords are present', () => {
    const assertion = toContainKeywords(['function', 'return', 'const']);
    const result = assertion.evaluate('const add = function(a, b) { return a + b; }');
    expect(result.status).toBe('pass');
  });

  it('fails when some keywords are missing', () => {
    const assertion = toContainKeywords(['function', 'class', 'interface']);
    const result = assertion.evaluate('function hello() { return "hi"; }');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('class');
    expect(result.message).toContain('interface');
  });

  it('uses whole-word matching by default', () => {
    const assertion = toContainKeywords(['type']);
    const result = assertion.evaluate('TypeScript is great.');
    expect(result.status).toBe('fail');
  });

  it('shows coverage info in evidence', () => {
    const assertion = toContainKeywords(['a', 'b', 'c', 'd']);
    const result = assertion.evaluate('The word a and b are here.');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Coverage');
    expect(result.evidence).toContain('50%');
  });
});

// ─── toNotContainKeywords assertion ─────────────────────────────────────────────

describe('toNotContainKeywords', () => {
  it('passes when no forbidden keywords are present', () => {
    const assertion = toNotContainKeywords(['deprecated', 'legacy', 'hack']);
    const result = assertion.evaluate('This is a modern, well-designed API.');
    expect(result.status).toBe('pass');
  });

  it('fails when forbidden keywords are found', () => {
    const assertion = toNotContainKeywords(['deprecated', 'legacy', 'hack']);
    const result = assertion.evaluate('This is a deprecated hack from the legacy system.');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('deprecated');
    expect(result.message).toContain('hack');
    expect(result.message).toContain('legacy');
  });

  it('is case-insensitive by default', () => {
    const assertion = toNotContainKeywords(['TODO']);
    const result = assertion.evaluate('There is a todo item here.');
    expect(result.status).toBe('fail');
  });

  it('respects caseSensitive option', () => {
    const assertion = toNotContainKeywords(['TODO'], { caseSensitive: true });
    const result = assertion.evaluate('There is a todo item here.');
    expect(result.status).toBe('pass');
  });
});

// ─── toMeetKeywordCoverage assertion ────────────────────────────────────────────

describe('toMeetKeywordCoverage', () => {
  const output = 'To set up a TypeScript project, install the compiler, configure tsconfig.json, add ESLint, and run your build script.';

  it('passes when coverage meets threshold', () => {
    const assertion = toMeetKeywordCoverage({
      keywords: ['TypeScript', 'install', 'ESLint', 'configure', 'build'],
      minCoverage: 0.8,
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('100%');
  });

  it('fails when coverage is below threshold', () => {
    const assertion = toMeetKeywordCoverage({
      keywords: ['TypeScript', 'React', 'Vue', 'Angular', 'Svelte'],
      minCoverage: 0.6,
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('below threshold');
    expect(result.evidence).toContain('Missing');
  });

  it('defaults to 80% threshold', () => {
    const assertion = toMeetKeywordCoverage({
      keywords: ['TypeScript', 'install', 'ESLint', 'configure', 'missing'],
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('handles edge case of all missing', () => {
    const assertion = toMeetKeywordCoverage({
      keywords: ['Python', 'Django', 'Flask'],
      minCoverage: 0.5,
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('0%');
  });
});

// ─── toSatisfyConstraints assertion ─────────────────────────────────────────────

describe('toSatisfyConstraints', () => {
  const codeOutput = `function reverseString(input: string): string {
  return input.split('').reverse().join('');
}

export { reverseString };`;

  it('passes when all constraints are satisfied', () => {
    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'keyword', value: 'function' },
        { kind: 'required', match: 'regex', value: /:\s*string/ },
        { kind: 'required', match: 'keyword', value: 'return' },
        { kind: 'forbidden', match: 'keyword', value: 'any' },
        { kind: 'forbidden', match: 'phrase', value: 'console.log' },
      ],
    });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('pass');
  });

  it('fails when required constraints are missing', () => {
    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'keyword', value: 'class' },
        { kind: 'required', match: 'keyword', value: 'interface' },
      ],
    });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('2 constraint(s) violated');
  });

  it('fails when forbidden content is found', () => {
    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'forbidden', match: 'keyword', value: 'function' },
      ],
    });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('function');
  });

  it('reports warnings without failing', () => {
    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'keyword', value: 'function' },
        { kind: 'required', match: 'keyword', value: 'missing', severity: 'warning' },
      ],
    });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('warning');
  });

  it('provides detailed evidence on failure', () => {
    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'forbidden', match: 'keyword', value: 'function', reason: 'Use arrow functions' },
        { kind: 'required', match: 'keyword', value: 'describe', reason: 'Needs tests' },
      ],
    });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('[ERROR]');
    expect(result.evidence).toContain('Use arrow functions');
    expect(result.evidence).toContain('Needs tests');
  });

  it('handles empty rules gracefully', () => {
    const assertion = toSatisfyConstraints({ rules: [] });
    const result = assertion.evaluate(codeOutput);
    expect(result.status).toBe('pass');
  });
});

// ─── toMatchPatterns assertion ──────────────────────────────────────────────────

describe('toMatchPatterns', () => {
  const output = `export function add(a: number, b: number): number {
  return a + b;
}`;

  it('passes when all required patterns match and no forbidden patterns match', () => {
    const assertion = toMatchPatterns({
      required: [/function\s+\w+/, /:\s*number/, /return/],
      forbidden: [/console\.log/, /any/],
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('fails when a required pattern is missing', () => {
    const assertion = toMatchPatterns({
      required: [/class\s+\w+/],
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Missing required regex');
  });

  it('fails when a forbidden pattern matches', () => {
    const assertion = toMatchPatterns({
      forbidden: [/export/],
    });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Found forbidden regex');
  });

  it('handles required-only', () => {
    const assertion = toMatchPatterns({ required: [/export/] });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('handles forbidden-only', () => {
    const assertion = toMatchPatterns({ forbidden: [/import/] });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('handles both empty lists', () => {
    const assertion = toMatchPatterns({ required: [], forbidden: [] });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles special regex characters in keyword values', () => {
    const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'C++' };
    const result = validateRule('I program in C++ and Rust.', rule);
    expect(result).toBeNull();
  });

  it('handles special regex characters in phrase values', () => {
    const rule: ConstraintRule = { kind: 'required', match: 'phrase', value: 'price: $9.99' };
    const result = validateRule('The price: $9.99 is reasonable.', rule);
    expect(result).toBeNull();
  });

  it('handles multiline output', () => {
    const output = 'Line 1\nLine 2\nLine 3: contains keyword\nLine 4';
    const rule: ConstraintRule = { kind: 'forbidden', match: 'keyword', value: 'keyword' };
    const result = validateRule(output, rule);
    expect(result).not.toBeNull();
    expect(result!.location!.line).toBe(3);
  });

  it('handles empty output', () => {
    const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'something' };
    const result = validateRule('', rule);
    expect(result).not.toBeNull();
  });

  it('handles unicode keywords', () => {
    const rule: ConstraintRule = { kind: 'required', match: 'phrase', value: '日本語' };
    const result = validateRule('This text contains 日本語 characters.', rule);
    expect(result).toBeNull();
  });

  it('handles very long output efficiently', () => {
    const longOutput = 'word '.repeat(10000) + 'target word';
    const rule: ConstraintRule = { kind: 'required', match: 'keyword', value: 'target' };
    const start = performance.now();
    const result = validateRule(longOutput, rule);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(100);
  });

  it('handles multiple regex flags in RegExp value', () => {
    const rule: ConstraintRule = { kind: 'required', match: 'regex', value: /hello/im };
    const result = validateRule('HELLO\nworld', rule);
    expect(result).toBeNull();
  });
});

// ─── Real-world scenarios ───────────────────────────────────────────────────────

describe('real-world scenarios', () => {
  it('validates code review output mentions required elements', () => {
    const reviewOutput = `## Code Review

### Issues Found
1. Missing error handling in the \`fetchData\` function
2. The TypeScript types are too broad (uses \`any\`)

### Suggestions
- Add try/catch around the API call
- Define proper interfaces for the response type
- Consider adding unit tests

### Summary
Overall the code works but needs better type safety and error handling.`;

    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'keyword', value: 'error', reason: 'Must address error handling' },
        { kind: 'required', match: 'keyword', value: 'TypeScript', reason: 'Must mention TypeScript' },
        { kind: 'required', match: 'regex', value: /##\s+.+/, reason: 'Must use headings' },
        { kind: 'forbidden', match: 'phrase', value: 'as an AI', reason: 'No AI disclaimers' },
        { kind: 'forbidden', match: 'phrase', value: 'I hope this helps', reason: 'No filler' },
      ],
    });
    const result = assertion.evaluate(reviewOutput);
    expect(result.status).toBe('pass');
  });

  it('validates ESLint setup guide has necessary sections', () => {
    const guide = `# ESLint Setup for TypeScript

## Installation
npm install eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin --save-dev

## Configuration
Create .eslintrc.json with the parser setting configured.

## Running
npx eslint src/`;

    const coverage = toMeetKeywordCoverage({
      keywords: ['install', 'eslint', 'typescript', 'parser', 'npx', 'npm'],
      minCoverage: 0.7,
    });
    const result = coverage.evaluate(guide);
    expect(result.status).toBe('pass');
  });

  it('catches agent drift — setup guide that goes off-topic', () => {
    const driftedOutput = `# Getting Started with React

React is a JavaScript library for building user interfaces.
To install React, run npm install react react-dom.

## What is Virtual DOM?
The virtual DOM is an in-memory representation of the real DOM.

## Redux
Redux is a state management library.`;

    const constraints = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'keyword', value: 'ESLint', reason: 'Task was about ESLint' },
        { kind: 'required', match: 'keyword', value: 'TypeScript', reason: 'Task was about TypeScript' },
        { kind: 'forbidden', match: 'keyword', value: 'Redux', reason: 'Off-topic', severity: 'warning' },
      ],
    });
    const result = constraints.evaluate(driftedOutput);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('ESLint');
  });

  it('validates API documentation has expected structure', () => {
    const apiDoc = `# API Reference

## authenticate(credentials)
Authenticates a user with the provided credentials.

**Parameters:**
- credentials: object containing username and password

**Returns:** Promise<AuthToken>

**Throws:** AuthError if credentials are invalid.`;

    const assertion = toSatisfyConstraints({
      rules: [
        { kind: 'required', match: 'regex', value: /##\s+\w+\(/, reason: 'Must have function signature headings' },
        { kind: 'required', match: 'phrase', value: 'Parameters', reason: 'Must document parameters' },
        { kind: 'required', match: 'phrase', value: 'Returns', reason: 'Must document return value' },
        { kind: 'forbidden', match: 'phrase', value: 'TODO', reason: 'No incomplete docs' },
      ],
    });
    const result = assertion.evaluate(apiDoc);
    expect(result.status).toBe('pass');
  });
});