/**
 * Tests for the drift relevance scorer — the internal TF-IDF cosine helper
 * extracted from `checks/drift.ts` into `checks/drift-relevance.ts`.
 *
 * This module is an internal implementation detail of the drift check (not part
 * of the public API), but it underpins requirement-coverage scoring, so its
 * mathematical contract is pinned directly here:
 * - range is [0, 1]
 * - empty / whitespace inputs score 0
 * - identical text scores high; disjoint vocabulary scores ~0
 * - the score is symmetric in its two arguments
 * - tokenization is case-insensitive, stopword- and punctuation-insensitive,
 *   and stems morphological variants together
 */

import { describe, it, expect } from 'vitest';
import { relevanceScore } from '../src/checks/drift-relevance.js';

describe('relevanceScore — range and degenerate inputs', () => {
  it('returns 0 when the task is empty', () => {
    expect(relevanceScore('', 'fix the login bug in the auth module')).toBe(0);
  });

  it('returns 0 when the output is empty', () => {
    expect(relevanceScore('fix the login bug', '')).toBe(0);
  });

  it('returns 0 when both inputs are empty', () => {
    expect(relevanceScore('', '')).toBe(0);
  });

  it('returns 0 for whitespace-only inputs', () => {
    expect(relevanceScore('   \n\t ', 'real content here about widgets')).toBe(0);
    expect(relevanceScore('real content here about widgets', '   \n\t ')).toBe(0);
  });

  it('returns 0 when inputs share only stopwords (no content overlap)', () => {
    // "the and of to" are all stopwords → tokenized to empty → denominator 0.
    const score = relevanceScore('the and of to', 'a an is are was');
    expect(score).toBe(0);
  });

  it('always returns a finite value within [0, 1]', () => {
    const samples: Array<[string, string]> = [
      ['fix the login bug', 'fixed the login bug in auth.ts'],
      ['add unit tests for the parser', 'refactored the renderer instead'],
      ['explain the caching strategy', 'caching strategy uses an LRU eviction policy'],
      ['', 'nonempty'],
      ['single', 'single'],
    ];
    for (const [task, output] of samples) {
      const score = relevanceScore(task, output);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('relevanceScore — semantic ordering', () => {
  it('scores identical content above unrelated content', () => {
    const task = 'fix the authentication timeout bug in the session handler';
    const onTopic = relevanceScore(task, task);
    const offTopic = relevanceScore(task, 'a recipe for chocolate chip cookies with walnuts');
    expect(onTopic).toBeGreaterThan(offTopic);
  });

  it('scores disjoint vocabulary at or near zero', () => {
    const score = relevanceScore(
      'configure the kubernetes ingress controller',
      'photosynthesis converts sunlight into chemical energy',
    );
    expect(score).toBeLessThan(0.05);
  });

  it('ranks a topically-overlapping output above a topically-distant one', () => {
    const task = 'add retry logic to the network request client';
    const related = relevanceScore(task, 'added exponential-backoff retry logic to the request client');
    const unrelated = relevanceScore(task, 'updated the README spelling and fixed a broken link');
    expect(related).toBeGreaterThan(unrelated);
  });

  it('gives a strong (but not necessarily 1) score to near-identical phrasing', () => {
    // The two-document IDF drops terms shared by both docs, so even identical
    // text need not score exactly 1; it must still be clearly high.
    const score = relevanceScore(
      'optimize the database query performance',
      'optimize the database query performance',
    );
    expect(score).toBeGreaterThan(0.3);
  });
});

describe('relevanceScore — symmetry', () => {
  it('is symmetric: score(a, b) === score(b, a)', () => {
    const a = 'review the pull request for security issues';
    const b = 'the pull request introduces a SQL injection security issue';
    expect(relevanceScore(a, b)).toBeCloseTo(relevanceScore(b, a), 10);
  });

  it('is symmetric for unrelated inputs too', () => {
    const a = 'deploy the service to staging';
    const b = 'write a haiku about the ocean';
    expect(relevanceScore(a, b)).toBeCloseTo(relevanceScore(b, a), 10);
  });
});

describe('relevanceScore — tokenization behavior', () => {
  it('is case-insensitive', () => {
    const lower = relevanceScore('fix the login bug', 'fixed the login bug');
    const mixed = relevanceScore('FIX the LOGIN Bug', 'Fixed The LOGIN bug');
    expect(mixed).toBeCloseTo(lower, 10);
  });

  it('ignores punctuation differences', () => {
    const plain = relevanceScore('fix login bug', 'login bug fixed');
    const punct = relevanceScore('fix, login... bug!', '"login" (bug) — fixed?');
    expect(punct).toBeCloseTo(plain, 10);
  });

  it('stems morphological variants so they match', () => {
    // "testing" and "tested" should both reduce toward the "test" stem and so
    // register as overlap with a task mentioning "test".
    const score = relevanceScore('add tests for the parser', 'testing the parser was added and tested');
    expect(score).toBeGreaterThan(0);
  });

  it('treats short numeric tokens as noise (no spurious overlap)', () => {
    // Pure 1–3 digit numbers are filtered, so sharing only a short number must
    // not create relevance between otherwise-disjoint texts.
    const score = relevanceScore('item 42', 'page 42');
    expect(score).toBeLessThan(0.05);
  });
});
