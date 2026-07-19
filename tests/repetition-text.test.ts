/**
 * Direct tests for the shared repetition text primitives leaf
 * (`src/checks/repetition-text.ts`). These cover the low-level helpers that
 * back the detectors, independent of the public `./repetition.js` barrel.
 */
import { describe, it, expect } from 'vitest';
import {
  normalize,
  jaccardSimilarity,
  areSimilar,
  extractWordNgrams,
} from '../src/checks/repetition-text.js';

describe('repetition-text: normalize', () => {
  it('lowercases and collapses whitespace by default', () => {
    expect(normalize('  Hello   WORLD\n\t ')).toBe('hello world');
  });

  it('preserves case when ignoreCase is false', () => {
    expect(normalize('Hello   World', { ignoreCase: false })).toBe('Hello World');
  });

  it('preserves whitespace when normalizeWhitespace is false', () => {
    expect(normalize('a  b', { normalizeWhitespace: false })).toBe('a  b');
  });
});

describe('repetition-text: jaccardSimilarity', () => {
  it('returns 1 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1);
  });

  it('returns 0 when only one side is empty', () => {
    expect(jaccardSimilarity('hello', '')).toBe(0);
  });

  it('returns 1 for identical word sets', () => {
    expect(jaccardSimilarity('a b c', 'c b a')).toBe(1);
  });

  it('computes partial overlap', () => {
    // {a,b} vs {b,c}: intersection 1, union 3
    expect(jaccardSimilarity('a b', 'b c')).toBeCloseTo(1 / 3, 10);
  });
});

describe('repetition-text: areSimilar', () => {
  it('is true for exact matches regardless of threshold', () => {
    expect(areSimilar('same text', 'same text', 0.99)).toBe(true);
  });

  it('short-circuits to false on large length mismatch', () => {
    expect(areSimilar('a', 'a much much longer string here', 0.85)).toBe(false);
  });

  it('respects the similarity threshold', () => {
    expect(areSimilar('the quick brown fox', 'the quick brown cat', 0.5)).toBe(true);
    expect(areSimilar('the quick brown fox', 'the quick brown cat', 0.95)).toBe(false);
  });
});

describe('repetition-text: extractWordNgrams', () => {
  it('extracts contiguous word n-grams, stripping punctuation', () => {
    expect(extractWordNgrams('Hello, world! Foo', 2)).toEqual(['hello world', 'world foo']);
  });

  it('returns empty when text has fewer words than n', () => {
    expect(extractWordNgrams('one', 3)).toEqual([]);
  });

  it('handles empty text', () => {
    expect(extractWordNgrams('', 2)).toEqual([]);
  });
});
