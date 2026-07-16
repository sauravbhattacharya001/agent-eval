import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  aggregateCandidate,
  buildSummary,
  clamp01,
  compareCandidates,
  pickWinner,
  rankAt,
  relativeLowerBetter,
  round3,
  sanitizeWeights,
  scoreCandidate,
  tieKey,
  type CandidateAgg,
  type Scored,
} from '../src/monitoring/trace-selection-scoring.js';
import type { SelectionCandidate, SelectionRun } from '../src/monitoring/trace-selection-types.js';

/**
 * Direct tests for the pure scoring/ordering leaf extracted from
 * trace-selection.ts. These cover the internal seam in isolation; the
 * end-to-end behaviour is additionally exercised through rankSelection in
 * trace-selection.test.ts.
 */

const makeRun = (over: Partial<SelectionRun> = {}): SelectionRun => ({
  sessionId: 's',
  model: 'm',
  harness: 'h',
  toolCalls: 4,
  toolErrorRate: 0,
  recoveryRate: 1,
  longestRetryStreak: 0,
  totalTokens: 100,
  claimIntegrity: 1,
  contradictedClaims: 0,
  unverifiableClaims: 0,
  ...over,
});

const scored = (over: Partial<CandidateAgg>, score: number): Scored => ({
  agg: {
    name: 'x',
    runs: [],
    meanToolCalls: 4,
    meanToolErrorRate: 0,
    meanRecoveryRate: 1,
    meanTotalTokens: 100,
    meanClaimIntegrity: 1,
    meanThrash: 0,
    contradictedClaims: 0,
    unverifiableClaims: 0,
    cleanRun: true,
    ...over,
  },
  score,
});

describe('trace-selection-scoring: normalizers', () => {
  it('clamp01 clamps below 0 and above 1', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it('relativeLowerBetter is 1 when cohort max is 0 or non-positive', () => {
    expect(relativeLowerBetter(0, 0)).toBe(1);
    expect(relativeLowerBetter(10, 0)).toBe(1);
  });

  it('relativeLowerBetter scales linearly against the cohort max', () => {
    expect(relativeLowerBetter(0, 10)).toBe(1);
    expect(relativeLowerBetter(10, 10)).toBe(0);
    expect(relativeLowerBetter(5, 10)).toBe(0.5);
  });

  it('round3 rounds to three decimals', () => {
    expect(round3(0.12345)).toBe(0.123);
    expect(round3(1)).toBe(1);
  });
});

describe('trace-selection-scoring: sanitizeWeights', () => {
  it('drops non-finite/negative/non-number values, keeps valid ones', () => {
    const out = sanitizeWeights({
      integrity: 3,
      contradictions: -1,
      errorRate: Number.NaN,
      recovery: Infinity,
      // @ts-expect-error intentionally invalid type at runtime
      steps: 'x',
      cost: 0,
    });
    expect(out).toEqual({ integrity: 3, cost: 0 });
  });

  it('returns {} for undefined', () => {
    expect(sanitizeWeights(undefined)).toEqual({});
  });
});

describe('trace-selection-scoring: aggregateCandidate', () => {
  it('averages signals and flags a clean run', () => {
    const agg = aggregateCandidate('cand', [makeRun(), makeRun({ toolCalls: 6 })], 0.5);
    expect(agg.name).toBe('cand');
    expect(agg.meanToolCalls).toBe(5);
    expect(agg.meanClaimIntegrity).toBe(1);
    expect(agg.cleanRun).toBe(true);
  });

  it('meanClaimIntegrity is null when no run had a decidable claim', () => {
    const agg = aggregateCandidate('cand', [makeRun({ claimIntegrity: null })], 0.5);
    expect(agg.meanClaimIntegrity).toBeNull();
  });

  it('marks non-clean when error rate exceeds threshold', () => {
    const agg = aggregateCandidate('cand', [makeRun({ toolErrorRate: 0.9 })], 0.5);
    expect(agg.cleanRun).toBe(false);
  });
});

describe('trace-selection-scoring: scoreCandidate', () => {
  it('returns 0 when total weight is 0', () => {
    const agg = aggregateCandidate('c', [makeRun()], 0.5);
    const zeroWeights = {
      integrity: 0,
      contradictions: 0,
      errorRate: 0,
      recovery: 0,
      thrash: 0,
      steps: 0,
      cost: 0,
    };
    expect(scoreCandidate(agg, zeroWeights, 4, 100)).toBe(0);
  });

  it('a candidate that is best on every signal scores 1 with default weights', () => {
    // Give the candidate the cohort-minimum footprint (0 steps / 0 tokens) so the
    // relative steps/cost sub-scores are also 1; all other signals are perfect.
    const agg = aggregateCandidate('c', [makeRun({ toolCalls: 0, totalTokens: 0 })], 0.5);
    expect(scoreCandidate(agg, DEFAULT_WEIGHTS, 4, 100)).toBe(1);
  });

  it('any contradiction zeroes the contradictions sub-score', () => {
    const clean = aggregateCandidate('c', [makeRun()], 0.5);
    const bad = aggregateCandidate('c', [makeRun({ contradictedClaims: 1 })], 0.5);
    expect(scoreCandidate(bad, DEFAULT_WEIGHTS, 4, 100)).toBeLessThan(
      scoreCandidate(clean, DEFAULT_WEIGHTS, 4, 100),
    );
  });
});

describe('trace-selection-scoring: ordering', () => {
  it('compareCandidates orders by score desc then evidence cascade', () => {
    const hi = scored({}, 0.9);
    const lo = scored({}, 0.5);
    expect(compareCandidates(hi, lo)).toBeLessThan(0);
    expect(compareCandidates(lo, hi)).toBeGreaterThan(0);
  });

  it('compareCandidates tie-breaks on fewer contradictions', () => {
    const a = scored({ name: 'a', contradictedClaims: 0 }, 0.5);
    const b = scored({ name: 'b', contradictedClaims: 2 }, 0.5);
    expect(compareCandidates(a, b)).toBeLessThan(0);
  });

  it('tieKey is equal for identical evidence and differs otherwise', () => {
    const a = scored({ meanToolCalls: 4 }, 0.5);
    const b = scored({ meanToolCalls: 4 }, 0.5);
    const c = scored({ meanToolCalls: 9 }, 0.5);
    expect(tieKey(a)).toBe(tieKey(b));
    expect(tieKey(a)).not.toBe(tieKey(c));
  });

  it('rankAt shares the lowest rank across a genuine tie (competition ranking)', () => {
    const list = [scored({ name: 'a' }, 0.5), scored({ name: 'b' }, 0.5), scored({ name: 'c' }, 0.2)];
    expect(rankAt(list, 0)).toBe(1);
    expect(rankAt(list, 1)).toBe(1); // tied with index 0
    expect(rankAt(list, 2)).toBe(3);
  });
});

describe('trace-selection-scoring: winner & summary', () => {
  const cand = (name: string, rank: number): SelectionCandidate => ({
    name,
    runs: 1,
    score: 0.5,
    rank,
    meanToolCalls: 1,
    meanToolErrorRate: 0,
    meanRecoveryRate: 1,
    meanTotalTokens: 1,
    meanClaimIntegrity: 1,
    contradictedClaims: 0,
    unverifiableClaims: 0,
    cleanRun: true,
  });

  it('pickWinner returns null on an empty ranking', () => {
    expect(pickWinner([])).toBeNull();
  });

  it('pickWinner returns the sole candidate', () => {
    const only = cand('a', 1);
    expect(pickWinner([only])).toBe(only);
  });

  it('pickWinner returns null when the top is tied', () => {
    expect(pickWinner([cand('a', 1), cand('b', 1)])).toBeNull();
  });

  it('pickWinner returns the strict rank-1 candidate', () => {
    const top = cand('a', 1);
    expect(pickWinner([top, cand('b', 2)])).toBe(top);
  });

  it('buildSummary joins with > for order and = for ties', () => {
    const s = buildSummary('model', 'harness', 'm1', [cand('a', 1), cand('b', 1), cand('c', 3)]);
    expect(s).toBe('for model m1: a = b > c');
  });

  it('buildSummary reports no candidates for an empty ranking', () => {
    expect(buildSummary('model', 'harness', 'm1', [])).toBe('for model m1: no harness candidates');
  });
});
