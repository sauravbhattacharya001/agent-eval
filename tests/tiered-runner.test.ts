import { describe, it, expect } from 'vitest';
import {
  runTiered,
  detectTier,
  classifyAssertions,
  tier1,
  tier2,
  tier3,
} from '../src/core/tiered-runner.js';
import type { Assertion, AssertionResult, EvalContext } from '../src/core/types.js';

// ─── HELPERS ────────────────────────────────────────────────────────────────────

function makeAssertion(name: string, result: 'pass' | 'fail' | 'skip' | 'error', delay = 0): Assertion {
  return {
    name,
    async evaluate(_output: string, _ctx?: EvalContext): Promise<AssertionResult> {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      if (result === 'error') throw new Error('Test error');
      return { status: result, name, durationMs: 0 };
    },
  };
}

/** Assertion that tracks whether it was called. */
function makeTracked(name: string, result: 'pass' | 'fail'): { assertion: Assertion; wasCalled: () => boolean } {
  let called = false;
  return {
    assertion: {
      name,
      async evaluate(): Promise<AssertionResult> {
        called = true;
        return { status: result, name, durationMs: 0 };
      },
    },
    wasCalled: () => called,
  };
}

// ─── TIER DETECTION ─────────────────────────────────────────────────────────────

describe('detectTier', () => {
  it('detects explicit [Tier N] markers', () => {
    expect(detectTier(makeAssertion('[Tier 1] format check', 'pass'))).toBe(1);
    expect(detectTier(makeAssertion('[Tier 2] relevance check', 'pass'))).toBe(2);
    expect(detectTier(makeAssertion('[Tier 3] judge evaluation', 'pass'))).toBe(3);
  });

  it('detects tier from keywords', () => {
    expect(detectTier(makeAssertion('judge rubric quality', 'pass'))).toBe(3);
    expect(detectTier(makeAssertion('hallucination detection', 'pass'))).toBe(2);
    expect(detectTier(makeAssertion('relevance to topic', 'pass'))).toBe(2);
    expect(detectTier(makeAssertion('repetition loop check', 'pass'))).toBe(2);
    expect(detectTier(makeAssertion('consensus evaluation', 'pass'))).toBe(3);
    expect(detectTier(makeAssertion('adversarial scoring', 'pass'))).toBe(3);
  });

  it('defaults to Tier 1', () => {
    expect(detectTier(makeAssertion('valid JSON', 'pass'))).toBe(1);
    expect(detectTier(makeAssertion('format check', 'pass'))).toBe(1);
    expect(detectTier(makeAssertion('file exists', 'pass'))).toBe(1);
  });
});

describe('classifyAssertions', () => {
  it('classifies mixed assertions into tiers', () => {
    const assertions = [
      makeAssertion('[Tier 1] parse', 'pass'),
      makeAssertion('[Tier 2] relevance', 'pass'),
      makeAssertion('[Tier 3] judge', 'pass'),
    ];

    const classified = classifyAssertions(assertions);
    expect(classified.get(1)!).toHaveLength(1);
    expect(classified.get(2)!).toHaveLength(1);
    expect(classified.get(3)!).toHaveLength(1);
  });

  it('respects explicit TieredAssertion wrappers', () => {
    const a = makeAssertion('my check', 'pass');
    const classified = classifyAssertions([tier1(a), tier2(a), tier3(a)]);

    expect(classified.get(1)!).toHaveLength(1);
    expect(classified.get(2)!).toHaveLength(1);
    expect(classified.get(3)!).toHaveLength(1);
  });
});

// ─── TIERED RUNNER ──────────────────────────────────────────────────────────────

describe('runTiered', () => {
  it('runs all tiers when everything passes', async () => {
    const result = await runTiered('test', [
      tier1(makeAssertion('T1', 'pass')),
      tier2(makeAssertion('T2', 'pass')),
      tier3(makeAssertion('T3', 'pass')),
    ]);

    expect(result.passed).toBe(true);
    expect(result.failedAtTier).toBeNull();
    expect(result.tiers.tier1.ran).toBe(true);
    expect(result.tiers.tier2.ran).toBe(true);
    expect(result.tiers.tier3.ran).toBe(true);
    expect(result.totalRun).toBe(3);
    expect(result.totalSkipped).toBe(0);
  });

  it('short-circuits at Tier 1 failure', async () => {
    const t2 = makeTracked('T2 check', 'pass');
    const t3 = makeTracked('T3 check', 'pass');

    const result = await runTiered('test', [
      tier1(makeAssertion('T1 fail', 'fail')),
      tier2(t2.assertion),
      tier3(t3.assertion),
    ]);

    expect(result.passed).toBe(false);
    expect(result.failedAtTier).toBe(1);
    expect(t2.wasCalled()).toBe(false);
    expect(t3.wasCalled()).toBe(false);
    expect(result.tiers.tier2.ran).toBe(false);
    expect(result.tiers.tier3.ran).toBe(false);
  });

  it('short-circuits at Tier 2 failure', async () => {
    const t3 = makeTracked('T3 check', 'pass');

    const result = await runTiered('test', [
      tier1(makeAssertion('T1 pass', 'pass')),
      tier2(makeAssertion('T2 fail', 'fail')),
      tier3(t3.assertion),
    ]);

    expect(result.passed).toBe(false);
    expect(result.failedAtTier).toBe(2);
    expect(t3.wasCalled()).toBe(false);
    expect(result.tiers.tier1.ran).toBe(true);
    expect(result.tiers.tier2.ran).toBe(true);
    expect(result.tiers.tier3.ran).toBe(false);
  });

  it('short-circuits within a tier (first failure stops tier)', async () => {
    const t1second = makeTracked('[Tier 1] second check', 'pass');

    const result = await runTiered('test', [
      tier1(makeAssertion('T1 first fail', 'fail')),
      tier1(t1second.assertion),
    ]);

    expect(result.passed).toBe(false);
    expect(t1second.wasCalled()).toBe(false);
    expect(result.tiers.tier1.skipped).toBe(1);
  });

  it('runs all assertions when shortCircuit=false', async () => {
    const t1second = makeTracked('[Tier 1] second', 'pass');

    const result = await runTiered('test', [
      tier1(makeAssertion('T1 fail', 'fail')),
      tier1(t1second.assertion),
    ], undefined, { shortCircuit: false, runAllTiers: true });

    expect(t1second.wasCalled()).toBe(true);
    expect(result.tiers.tier1.passed).toBe(1);
    expect(result.tiers.tier1.failed).toBe(1);
  });

  it('skips Tier 3 when skipTier3=true', async () => {
    const t3 = makeTracked('T3 check', 'pass');

    const result = await runTiered('test', [
      tier1(makeAssertion('T1', 'pass')),
      tier2(makeAssertion('T2', 'pass')),
      tier3(t3.assertion),
    ], undefined, { skipTier3: true });

    expect(result.passed).toBe(true);
    expect(t3.wasCalled()).toBe(false);
    expect(result.tiers.tier3.ran).toBe(false);
    expect(result.tiers.tier3.skipped).toBe(1);
  });

  it('respects maxAssertions cost cap', async () => {
    const result = await runTiered('test', [
      tier1(makeAssertion('T1a', 'pass')),
      tier1(makeAssertion('T1b', 'pass')),
      tier1(makeAssertion('T1c', 'pass')),
    ], undefined, { maxAssertions: 2 });

    expect(result.totalRun).toBe(2);
    expect(result.totalSkipped).toBe(1);
  });

  it('handles thrown errors as failures', async () => {
    const result = await runTiered('test', [
      tier1(makeAssertion('T1 error', 'error')),
    ]);

    expect(result.passed).toBe(false);
    expect(result.failedAtTier).toBe(1);
    expect(result.allResults[0]!.status).toBe('error');
  });

  it('treats skip as neutral (not failure)', async () => {
    const result = await runTiered('test', [
      tier1(makeAssertion('T1 skip', 'skip')),
      tier2(makeAssertion('T2 pass', 'pass')),
    ]);

    expect(result.passed).toBe(true);
    expect(result.tiers.tier1.skipped).toBe(1);
    expect(result.tiers.tier2.ran).toBe(true);
  });

  it('reports accurate timing', async () => {
    const result = await runTiered('test', [
      tier1(makeAssertion('fast', 'pass', 10)),
    ]);

    expect(result.durationMs).toBeGreaterThanOrEqual(5);
  });

  it('handles empty assertion array', async () => {
    const result = await runTiered('test', []);

    expect(result.passed).toBe(true);
    expect(result.totalRun).toBe(0);
  });

  it('auto-classifies assertions without explicit tier wrappers', async () => {
    const t3 = makeTracked('[Tier 3] judge quality', 'pass');

    const result = await runTiered('test', [
      makeAssertion('[Tier 1] format valid', 'fail'),
      makeAssertion('[Tier 2] relevance ok', 'pass'),
      t3.assertion,
    ]);

    // Should auto-detect tiers and short-circuit at T1
    expect(result.failedAtTier).toBe(1);
    expect(t3.wasCalled()).toBe(false);
  });
});
