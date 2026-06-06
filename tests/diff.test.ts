/**
 * Tests for the Diff Checker — Tier 1 Deterministic Check
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeDiff,
  detectParroting,
  parseUnifiedDiff,
  textSimilarity,
  toHaveMeaningfulDiff,
  toNotBeNoOp,
  toNotParrot,
  toHaveMinimumChanges,
  toHaveMeaningfulUnifiedDiff,
} from '../src/checks/diff.js';

// ─── textSimilarity ─────────────────────────────────────────────────────────────

describe('textSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(textSimilarity('', '')).toBe(1);
  });

  it('returns 0 when one string is empty and other is not', () => {
    expect(textSimilarity('', 'hello')).toBe(0);
    expect(textSimilarity('hello', '')).toBe(0);
  });

  it('returns high similarity for nearly identical texts', () => {
    const a = 'line1\nline2\nline3\nline4\nline5';
    const b = 'line1\nline2\nline3\nline4\nline5 modified';
    const sim = textSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.7);
  });

  it('returns low similarity for completely different texts', () => {
    const a = 'the quick brown fox';
    const b = 'completely unrelated content here';
    const sim = textSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
  });

  it('handles multiline texts', () => {
    const a = 'function add(a, b) {\n  return a + b;\n}';
    const b = 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}';
    const sim = textSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(1);
  });
});

// ─── analyzeDiff ────────────────────────────────────────────────────────────────

describe('analyzeDiff', () => {
  it('detects identical texts', () => {
    const text = 'hello\nworld';
    const result = analyzeDiff(text, text);
    expect(result.metrics.isIdentical).toBe(true);
    expect(result.metrics.linesAdded).toBe(0);
    expect(result.metrics.linesRemoved).toBe(0);
    expect(result.metrics.hunkCount).toBe(0);
    expect(result.changes).toHaveLength(0);
  });

  it('detects added lines', () => {
    const before = 'line1\nline2';
    const after = 'line1\nline2\nline3\nline4';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.linesAdded).toBeGreaterThan(0);
    expect(result.metrics.netChange).toBeGreaterThan(0);
  });

  it('detects removed lines', () => {
    const before = 'line1\nline2\nline3\nline4';
    const after = 'line1\nline4';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.linesRemoved).toBeGreaterThan(0);
    expect(result.metrics.netChange).toBeLessThan(0);
  });

  it('detects cosmetic-only changes (whitespace)', () => {
    const before = 'function foo() {\n  return 1;\n}';
    const after = 'function foo() {\n    return 1;\n}';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.isCosmeticOnly).toBe(true);
  });

  it('detects content changes', () => {
    const before = 'function foo() {\n  return 1;\n}';
    const after = 'function foo() {\n  return 42;\n}';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.isCosmeticOnly).toBe(false);
    expect(result.metrics.changeKinds.content).toBeGreaterThan(0);
  });

  it('detects structural changes', () => {
    const before = 'const x = 1;\nconst y = 2;';
    const after = 'const x = 1;\nimport { z } from "./z";\nconst y = 2;';
    const result = analyzeDiff(before, after);
    expect(result.metrics.changeKinds.structural).toBeGreaterThan(0);
  });

  it('detects reordering', () => {
    const before = 'line A\nline B\nline C';
    const after = 'line C\nline B\nline A';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
  });

  it('respects ignoreWhitespace option', () => {
    const before = '  hello  world  ';
    const after = 'hello world';
    const resultDefault = analyzeDiff(before, after);
    const resultIgnore = analyzeDiff(before, after, { ignoreWhitespace: true });
    expect(resultIgnore.metrics.isIdentical).toBe(true);
    expect(resultDefault.metrics.isIdentical).toBe(false);
  });

  it('respects ignoreBlankLines option', () => {
    const before = 'line1\n\nline2';
    const after = 'line1\nline2';
    const resultDefault = analyzeDiff(before, after);
    const resultIgnore = analyzeDiff(before, after, { ignoreBlankLines: true });
    expect(resultIgnore.metrics.isIdentical).toBe(true);
    expect(resultDefault.metrics.isIdentical).toBe(false);
  });

  it('detects parroting (output very similar to input)', () => {
    // 5 lines, only the last changes slightly — LCS gives 4/5 = 0.8
    const before = 'This is the original text.\nIt has multiple lines.\nAnd some content.\nPlus more context.\nEnd of text.';
    const after = 'This is the original text.\nIt has multiple lines.\nAnd some content.\nPlus more context.\nEnd of text!';
    const result = analyzeDiff(before, after, { parrotThreshold: 0.8 });
    expect(result.metrics.isParroting).toBe(true);
  });

  it('does not flag as parroting when text is very different', () => {
    const before = 'Original text here with some content.';
    const after = 'Completely different output.\nWith new structure.\nAnd new ideas.';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isParroting).toBe(false);
  });

  it('calculates changeRatio correctly', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nX\nY\nd\ne';
    const result = analyzeDiff(before, after);
    expect(result.metrics.changeRatio).toBeGreaterThan(0);
    expect(result.metrics.changeRatio).toBeLessThanOrEqual(1);
  });

  it('generates a human-readable summary', () => {
    const before = 'line1\nline2';
    const after = 'line1\nline2\nline3';
    const result = analyzeDiff(before, after);
    expect(result.summary).toContain('+');
    expect(result.summary).toContain('lines');
  });

  it('handles empty before text', () => {
    const result = analyzeDiff('', 'new content');
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.linesAdded).toBeGreaterThan(0);
  });

  it('handles empty after text', () => {
    const result = analyzeDiff('original content', '');
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.linesRemoved).toBeGreaterThan(0);
  });
});

// ─── detectParroting ────────────────────────────────────────────────────────────

describe('detectParroting', () => {
  it('detects exact copy as parroting', () => {
    const source = 'Write a function that adds two numbers';
    const output = 'Write a function that adds two numbers';
    const { isParroting, similarity } = detectParroting(output, source);
    expect(isParroting).toBe(true);
    expect(similarity).toBe(1);
  });

  it('detects verbatim inclusion as parroting', () => {
    const source = 'This is a fairly long prompt that contains enough context to be meaningful';
    const output = `Here is my response. ${source} And that's all.`;
    const { isParroting } = detectParroting(output, source);
    expect(isParroting).toBe(true);
  });

  it('does not flag genuinely different output', () => {
    const source = 'Write a function that reverses a string';
    const output = 'function reverseString(str: string): string {\n  return str.split("").reverse().join("");\n}';
    const { isParroting } = detectParroting(output, source);
    expect(isParroting).toBe(false);
  });

  it('respects custom threshold', () => {
    const source = 'hello world';
    const output = 'hello there world';
    const lowResult = detectParroting(output, source, { threshold: 0.3 });
    const highResult = detectParroting(output, source, { threshold: 0.99 });
    expect(highResult.isParroting).toBe(false);
    expect(lowResult.similarity).toBe(highResult.similarity);
  });

  it('handles whitespace normalization', () => {
    const source = 'hello   world';
    const output = 'hello world';
    const withNorm = detectParroting(output, source, { ignoreWhitespace: true });
    const withoutNorm = detectParroting(output, source, { ignoreWhitespace: false });
    expect(withNorm.similarity).toBeGreaterThanOrEqual(withoutNorm.similarity);
  });

  it('does not flag short source as parroting via inclusion check', () => {
    const source = 'short';
    const output = 'This is a short answer.';
    const { isParroting } = detectParroting(output, source);
    expect(isParroting).toBe(false);
  });
});

// ─── parseUnifiedDiff ───────────────────────────────────────────────────────────

describe('parseUnifiedDiff', () => {
  it('parses a simple unified diff', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      '+const z = 4;',
      ' const w = 5;',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]!.additions.length).toBeGreaterThan(0);
    expect(changes[0]!.deletions.length).toBeGreaterThan(0);
  });

  it('parses additions only', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,4 @@',
      ' line1',
      '+added1',
      '+added2',
      ' line2',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.length).toBe(1);
    expect(changes[0]!.additions).toEqual(['added1', 'added2']);
    expect(changes[0]!.deletions).toHaveLength(0);
  });

  it('parses deletions only', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,4 +1,2 @@',
      ' line1',
      '-removed1',
      '-removed2',
      ' line2',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.length).toBe(1);
    expect(changes[0]!.deletions).toEqual(['removed1', 'removed2']);
    expect(changes[0]!.additions).toHaveLength(0);
  });

  it('handles multiple hunks', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old1',
      '+new1',
      ' line3',
      '@@ -10,3 +10,3 @@',
      ' line10',
      '-old10',
      '+new10',
      ' line12',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.length).toBe(2);
  });

  it('returns empty array for non-diff text', () => {
    const changes = parseUnifiedDiff('this is not a diff');
    expect(changes).toHaveLength(0);
  });

  it('classifies structural changes in diff', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1;',
      "+import { foo } from './foo';",
      ' const y = 2;',
      ' const z = 3;',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.some((c) => c.kind === 'structural')).toBe(true);
  });

  it('classifies cosmetic changes in diff', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-  indented content',
      '+    indented content',
      ' line3',
    ].join('\n');
    const changes = parseUnifiedDiff(diff);
    expect(changes.some((c) => c.kind === 'cosmetic')).toBe(true);
  });
});

// ─── toHaveMeaningfulDiff (assertion) ───────────────────────────────────────────

describe('toHaveMeaningfulDiff', () => {
  it('passes when there are meaningful content changes', () => {
    const before = 'function foo() {\n  return 1;\n}';
    const after = 'function foo() {\n  return 42;\n}\n\nfunction bar() {\n  return "hello";\n}';
    const assertion = toHaveMeaningfulDiff(before);
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
  });

  it('fails when output is identical to before', () => {
    const text = 'some content here';
    const assertion = toHaveMeaningfulDiff(text);
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('identical');
  });

  it('fails when only cosmetic changes are present', () => {
    const before = 'function foo() {\n  return 1;\n}';
    const after = 'function foo() {\n    return 1;\n}';
    const assertion = toHaveMeaningfulDiff(before);
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('cosmetic');
  });

  it('passes cosmetic changes when cosmeticIsMeaningful is true', () => {
    const before = 'function foo() {\n  return 1;\n}';
    const after = 'function foo() {\n    return 1;\n}';
    const assertion = toHaveMeaningfulDiff(before, { cosmeticIsMeaningful: true });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
  });

  it('enforces minChanges threshold', () => {
    const before = 'line1\nline2\nline3\nline4\nline5';
    const after = 'line1\nmodified\nline3\nline4\nline5';
    const assertion = toHaveMeaningfulDiff(before, { minChanges: 3 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
  });

  it('enforces minChangeRatio', () => {
    const before = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
    const after = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nmodified';
    const assertion = toHaveMeaningfulDiff(before, { minChangeRatio: 0.5 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Change ratio');
  });

  it('provides evidence in pass result', () => {
    const before = 'old content';
    const after = 'new content entirely different';
    const assertion = toHaveMeaningfulDiff(before);
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
    expect(result.evidence).toBeDefined();
  });
});

// ─── toNotBeNoOp (assertion) ────────────────────────────────────────────────────

describe('toNotBeNoOp', () => {
  it('passes when output differs substantively from input', () => {
    const before = 'const x = 1;';
    const after = 'const x = 42;\nconst y = 100;';
    const assertion = toNotBeNoOp({ before });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
  });

  it('fails when output is identical to input', () => {
    const text = 'nothing changed';
    const assertion = toNotBeNoOp({ before: text });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('identical');
  });

  it('fails when only whitespace changes', () => {
    const before = 'hello world';
    const after = '  hello world  ';
    const assertion = toNotBeNoOp({ before });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('cosmetic');
  });

  it('passes diff options through', () => {
    const before = 'hello  world';
    const after = 'hello world';
    const assertion1 = toNotBeNoOp({ before });
    const result1 = assertion1.evaluate(after);
    expect(result1.status).toBe('fail');

    const assertion2 = toNotBeNoOp({ before, diffOptions: { ignoreWhitespace: true } });
    const result2 = assertion2.evaluate(after);
    expect(result2.status).toBe('fail');
    expect(result2.message).toContain('identical');
  });
});

// ─── toNotParrot (assertion) ────────────────────────────────────────────────────

describe('toNotParrot', () => {
  it('passes when output transforms the input', () => {
    const source = 'Write a function to calculate fibonacci numbers';
    const output = 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}';
    const assertion = toNotParrot(source);
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('fails when output copies the input', () => {
    const source = 'This is the task description that was given to the agent for processing';
    const assertion = toNotParrot(source);
    const result = assertion.evaluate(source);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('similar');
  });

  it('fails when output contains the input verbatim', () => {
    const source = 'Explain how dependency injection works in TypeScript applications';
    const output = `Sure! ${source}. Here is my explanation of it.`;
    const assertion = toNotParrot(source);
    const result = assertion.evaluate(output);
    expect(result.status).toBe('fail');
  });

  it('respects custom threshold', () => {
    const source = 'short task';
    const output = 'short task complete';
    const assertion = toNotParrot(source, { threshold: 0.99 });
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
  });

  it('provides similarity percentage in evidence', () => {
    const source = 'Some prompt text';
    const output = 'Completely different response about something else entirely';
    const assertion = toNotParrot(source);
    const result = assertion.evaluate(output);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('%');
  });
});

// ─── toHaveMinimumChanges (assertion) ───────────────────────────────────────────

describe('toHaveMinimumChanges', () => {
  it('passes when enough lines are changed', () => {
    const before = 'line1\nline2\nline3';
    const after = 'lineX\nlineY\nlineZ';
    const assertion = toHaveMinimumChanges(before, { minLinesChanged: 2 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
  });

  it('fails when too few lines are changed', () => {
    const before = 'line1\nline2\nline3\nline4\nline5';
    const after = 'line1\nline2\nmodified\nline4\nline5';
    const assertion = toHaveMinimumChanges(before, { minLinesChanged: 5 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('lines changed');
  });

  it('enforces minimum net change', () => {
    const before = 'line1\nline2';
    const after = 'line1\nline2\nnew1\nnew2\nnew3';
    const assertion = toHaveMinimumChanges(before, { minNetChange: 2 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('pass');
  });

  it('fails when net change is too small', () => {
    const before = 'line1\nline2\nline3';
    const after = 'line1\nmodified\nline3';
    const assertion = toHaveMinimumChanges(before, { minNetChange: 3 });
    const result = assertion.evaluate(after);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Net change');
  });

  it('provides evidence in results', () => {
    const before = 'old';
    const after = 'new content with more text';
    const assertion = toHaveMinimumChanges(before);
    const result = assertion.evaluate(after);
    expect(result.evidence).toBeDefined();
  });
});

// ─── toHaveMeaningfulUnifiedDiff (assertion) ─────────────────────────────────────

describe('toHaveMeaningfulUnifiedDiff', () => {
  it('passes for a valid unified diff with content changes', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 42;',
      ' const z = 3;',
    ].join('\n');
    const assertion = toHaveMeaningfulUnifiedDiff();
    const result = assertion.evaluate(diff);
    expect(result.status).toBe('pass');
  });

  it('fails for empty or non-diff text', () => {
    const assertion = toHaveMeaningfulUnifiedDiff();
    const result = assertion.evaluate('this is not a diff');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('No change hunks');
  });

  it('fails for cosmetic-only unified diff', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-  indented',
      '+    indented',
      ' line3',
    ].join('\n');
    const assertion = toHaveMeaningfulUnifiedDiff({ requireNonCosmetic: true });
    const result = assertion.evaluate(diff);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('cosmetic');
  });

  it('passes cosmetic diff when requireNonCosmetic is false', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-  indented',
      '+    indented',
      ' line3',
    ].join('\n');
    const assertion = toHaveMeaningfulUnifiedDiff({ requireNonCosmetic: false });
    const result = assertion.evaluate(diff);
    expect(result.status).toBe('pass');
  });

  it('enforces minHunks', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 42;',
      ' const z = 3;',
    ].join('\n');
    const assertion = toHaveMeaningfulUnifiedDiff({ minHunks: 3 });
    const result = assertion.evaluate(diff);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('hunk');
  });

  it('provides evidence with line counts', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,5 +1,6 @@',
      ' line1',
      '-removed1',
      '-removed2',
      '+added1',
      '+added2',
      '+added3',
      ' line4',
      ' line5',
    ].join('\n');
    const assertion = toHaveMeaningfulUnifiedDiff();
    const result = assertion.evaluate(diff);
    expect(result.status).toBe('pass');
    expect(result.evidence).toContain('+');
    expect(result.evidence).toContain('/');
  });
});

// ─── Edge cases and integration ─────────────────────────────────────────────────

describe('diff checker edge cases', () => {
  it('handles very large identical texts', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = analyzeDiff(lines, lines);
    expect(result.metrics.isIdentical).toBe(true);
  });

  it('handles multiline additions at end', () => {
    const before = 'line1\nline2';
    const after = 'line1\nline2\nnew1\nnew2\nnew3\nnew4\nnew5';
    const result = analyzeDiff(before, after);
    expect(result.metrics.linesAdded).toBe(5);
    expect(result.metrics.linesRemoved).toBe(0);
    expect(result.metrics.netChange).toBe(5);
  });

  it('handles complete replacement', () => {
    const before = 'old1\nold2\nold3';
    const after = 'new1\nnew2\nnew3\nnew4';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.isCosmeticOnly).toBe(false);
    expect(result.metrics.linesAdded).toBeGreaterThan(0);
    expect(result.metrics.linesRemoved).toBeGreaterThan(0);
  });

  it('classifies import changes as structural', () => {
    const before = 'const x = 1;';
    const after = 'import { y } from "./y";\nconst x = 1;';
    const result = analyzeDiff(before, after);
    expect(result.changes.some((c) => c.kind === 'structural')).toBe(true);
  });

  it('summary mentions parroting when detected', () => {
    // 5 lines, only 1 changes — LCS gives 4/5 = 0.8 which is above 0.7
    const text = 'This is some text.\nWith multiple lines.\nThat stays the same.\nMore context here.\nFinal line.';
    const after = 'This is some text.\nWith multiple lines.\nThat stays the same.\nMore context here.\nFinal line!';
    const result = analyzeDiff(text, after, { parrotThreshold: 0.7 });
    expect(result.summary).toContain('parroting');
  });

  it('summary describes cosmetic-only changes', () => {
    const before = 'indented';
    const after = '  indented';
    const result = analyzeDiff(before, after);
    if (result.metrics.isCosmeticOnly) {
      expect(result.summary.toLowerCase()).toContain('cosmetic');
    }
  });

  it('all assertions have correct names', () => {
    const before = 'text';
    expect(toHaveMeaningfulDiff(before).name).toBe('has meaningful diff from original');
    expect(toNotBeNoOp({ before }).name).toBe('is not a no-op');
    expect(toNotParrot(before).name).toBe('does not parrot input');
    expect(toHaveMinimumChanges(before).name).toBe('meets minimum change threshold');
    expect(toHaveMeaningfulUnifiedDiff().name).toBe('unified diff has meaningful changes');
  });

  it('all assertions return durationMs', () => {
    const before = 'original';
    const after = 'modified completely';
    const assertions = [
      toHaveMeaningfulDiff(before),
      toNotBeNoOp({ before }),
      toNotParrot(before),
      toHaveMinimumChanges(before),
      toHaveMeaningfulUnifiedDiff(),
    ];
    for (const assertion of assertions) {
      const result = assertion.evaluate(after);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe('number');
    }
  });

  it('handles single character change', () => {
    const before = 'abcdefghij';
    const after = 'abcdeXghij';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
    expect(result.metrics.linesAdded).toBeGreaterThan(0);
  });

  it('handles unicode content', () => {
    const before = 'Hello 世界\nLine 2';
    const after = 'Hello 世界\nModified 行';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
  });

  it('handles windows line endings', () => {
    const before = 'line1\r\nline2\r\nline3';
    const after = 'line1\r\nmodified\r\nline3';
    const result = analyzeDiff(before, after);
    expect(result.metrics.isIdentical).toBe(false);
  });
});