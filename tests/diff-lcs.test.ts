/**
 * Direct unit tests for the internal LCS/line-diff core (src/checks/diff-lcs.ts).
 *
 * These building blocks were previously exercised only indirectly through
 * analyzeDiff/parseUnifiedDiff. Testing them directly pins the seam extracted
 * from diff-analysis.ts so future refactors can't silently change behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeLine,
  splitLines,
  lcsTable,
  computeDiff,
  classifyChange,
  groupIntoHunks,
} from '../src/checks/diff-lcs.js';

describe('diff-lcs: normalizeLine', () => {
  it('collapses whitespace when ignoreWhitespace is set', () => {
    expect(normalizeLine('  a   b  ', { ignoreWhitespace: true })).toBe('a b');
  });
  it('leaves the line untouched by default', () => {
    expect(normalizeLine('  a   b  ', {})).toBe('  a   b  ');
  });
});

describe('diff-lcs: splitLines', () => {
  it('splits on newline keeping blanks by default', () => {
    expect(splitLines('a\n\nb', false)).toEqual(['a', '', 'b']);
  });
  it('drops blank/whitespace-only lines when asked', () => {
    expect(splitLines('a\n  \nb', true)).toEqual(['a', 'b']);
  });
});

describe('diff-lcs: lcsTable', () => {
  it('computes the LCS length in the bottom-right cell', () => {
    const a = ['x', 'y', 'z'];
    const b = ['x', 'q', 'z'];
    const dp = lcsTable(a, b);
    expect(dp[a.length]?.[b.length]).toBe(2); // x, z
  });
  it('returns 0 for fully disjoint inputs', () => {
    const dp = lcsTable(['a'], ['b']);
    expect(dp[1]?.[1]).toBe(0);
  });
});

describe('diff-lcs: computeDiff', () => {
  it('marks identical lines as keep', () => {
    const entries = computeDiff(['a', 'b'], ['a', 'b']);
    expect(entries.every((e) => e.type === 'keep')).toBe(true);
  });
  it('emits add and remove entries for a replacement', () => {
    const entries = computeDiff(['a', 'old', 'c'], ['a', 'new', 'c']);
    expect(entries.some((e) => e.type === 'add' && e.text === 'new')).toBe(true);
    expect(entries.some((e) => e.type === 'remove' && e.text === 'old')).toBe(true);
    expect(entries.filter((e) => e.type === 'keep')).toHaveLength(2);
  });
  it('carries line numbers on keep entries', () => {
    const entries = computeDiff(['a'], ['a']);
    expect(entries[0]).toMatchObject({ type: 'keep', originalLine: 1, modifiedLine: 1 });
  });
});

describe('diff-lcs: classifyChange', () => {
  it('detects cosmetic-only (whitespace) changes', () => {
    expect(classifyChange(['a  b'], ['a b'])).toBe('cosmetic');
  });
  it('detects a pure reorder', () => {
    expect(classifyChange(['one', 'two'], ['two', 'one'])).toBe('reorder');
  });
  it('detects structural changes on keyword lines', () => {
    expect(classifyChange(['export const x = 1'], ['const y = 2'])).toBe('structural');
  });
  it('falls back to content otherwise', () => {
    expect(classifyChange(['hello world'], ['goodbye moon'])).toBe('content');
  });
});

describe('diff-lcs: groupIntoHunks', () => {
  it('produces no hunks for an all-keep diff', () => {
    const entries = computeDiff(['a', 'b'], ['a', 'b']);
    expect(groupIntoHunks(entries, 3)).toEqual([]);
  });
  it('groups an add+remove into one classified hunk', () => {
    const entries = computeDiff(['a', 'old', 'c'], ['a', 'new', 'c']);
    const hunks = groupIntoHunks(entries, 3);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.additions).toContain('new');
    expect(hunks[0]?.deletions).toContain('old');
  });
  it('splits into separate hunks when the gap exceeds contextLines', () => {
    const original = ['x', 'a', 'b', 'c', 'd', 'y'];
    const modified = ['X', 'a', 'b', 'c', 'd', 'Y'];
    const entries = computeDiff(original, modified);
    const hunks = groupIntoHunks(entries, 1);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
  });
});
