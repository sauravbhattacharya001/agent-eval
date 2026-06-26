/**
 * Tests for selection ranking (Section F, slice 4) — the capstone that turns the
 * per-run signals from slices 2 (footprint) and 3 (claim integrity) into a
 * ranked answer to the two selection questions: "given a model, which harness?"
 * and "given a harness, which model?".
 *
 * These tests pin the contract that keeps slice 4 a Tier 1+2 pillar:
 *   1. A controlled sweep holds exactly ONE axis fixed; varying both throws.
 *   2. Ranking is PROOF-/claim-integrity-derived and fully deterministic — the
 *      same cohort always ranks identically, with a stable evidence-based
 *      tie-break.
 *   3. PROOF-contradicted claims sink a candidate; `unverifiable` claims are
 *      reported as instrumentation debt but NEVER move a score or rescue a pass.
 *   4. The selection key is parsed structurally from the NEUTRAL `agent_name`
 *      (`model@harness`) — a label, never evidence.
 *   5. `rankSelection` is read-only toward the real slice-2/3 pipeline (verified
 *      by feeding the recorded fixtures through it end-to-end).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rankSelection,
  toSelectionRun,
  parseSelectionKey,
  type SelectionRun,
} from '../src/monitoring/trace-selection.js';
import type { TraceSession } from '../src/monitoring/trace-provenance.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'agent-trace-sessions',
);

function loadSession(name: string): TraceSession {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf-8')) as TraceSession;
}

/**
 * Build a fully-specified per-run signal, defaulting to a "clean" run so each
 * test perturbs only the field under examination. (Mirrors how a caller would
 * pass pre-computed slice-2/3 results into `rankSelection`.)
 */
function run(over: Partial<SelectionRun> = {}): SelectionRun {
  return {
    sessionId: over.sessionId ?? 'sess',
    model: over.model ?? 'model-a',
    harness: over.harness ?? 'harness-a',
    toolCalls: over.toolCalls ?? 3,
    toolErrorRate: over.toolErrorRate ?? 0,
    recoveryRate: over.recoveryRate ?? 1,
    longestRetryStreak: over.longestRetryStreak ?? 0,
    totalTokens: over.totalTokens ?? 1000,
    claimIntegrity: over.claimIntegrity === undefined ? 1 : over.claimIntegrity,
    contradictedClaims: over.contradictedClaims ?? 0,
    unverifiableClaims: over.unverifiableClaims ?? 0,
  };
}

describe('parseSelectionKey', () => {
  it('splits the NEUTRAL model@harness form on the first @', () => {
    expect(parseSelectionKey('claude-sonnet@winsentinel-harness')).toEqual({
      model: 'claude-sonnet',
      harness: 'winsentinel-harness',
    });
  });

  it('treats a bare name as the model with an unknown harness', () => {
    expect(parseSelectionKey('gpt-4o')).toEqual({ model: 'gpt-4o', harness: '<unknown>' });
  });

  it('only splits on the FIRST @ so a harness label may contain @', () => {
    expect(parseSelectionKey('m@team@harness')).toEqual({ model: 'm', harness: 'team@harness' });
  });

  it('falls back to <unknown> for empty / whitespace / undefined', () => {
    expect(parseSelectionKey('')).toEqual({ model: '<unknown>', harness: '<unknown>' });
    expect(parseSelectionKey('   ')).toEqual({ model: '<unknown>', harness: '<unknown>' });
    expect(parseSelectionKey(undefined)).toEqual({ model: '<unknown>', harness: '<unknown>' });
    expect(parseSelectionKey('@only-harness')).toEqual({
      model: '<unknown>',
      harness: 'only-harness',
    });
  });
});

describe('rankSelection — axis resolution', () => {
  it('infers a fixed model and ranks harnesses when every run shares one model', () => {
    const card = rankSelection([
      run({ model: 'm', harness: 'h1' }),
      run({ model: 'm', harness: 'h2' }),
    ]);
    expect(card.fixed).toBe('model');
    expect(card.varied).toBe('harness');
    expect(card.fixedValue).toBe('m');
    expect(card.ranking.map((c) => c.name).sort()).toEqual(['h1', 'h2']);
  });

  it('infers a fixed harness and ranks models when every run shares one harness', () => {
    const card = rankSelection([
      run({ model: 'm1', harness: 'h' }),
      run({ model: 'm2', harness: 'h' }),
    ]);
    expect(card.fixed).toBe('harness');
    expect(card.varied).toBe('model');
    expect(card.fixedValue).toBe('h');
  });

  it('throws when BOTH axes vary (not a controlled sweep)', () => {
    expect(() =>
      rankSelection([
        run({ model: 'm1', harness: 'h1' }),
        run({ model: 'm2', harness: 'h2' }),
      ]),
    ).toThrow(/exactly one variable fixed/i);
  });

  it('honours an explicit fixed axis and validates it is uniform', () => {
    // Two harnesses, one model: forcing fixed=harness is invalid.
    expect(() =>
      rankSelection(
        [run({ model: 'm', harness: 'h1' }), run({ model: 'm', harness: 'h2' })],
        { fixed: 'harness' },
      ),
    ).toThrow(/hold the harness fixed/i);
  });

  it('ranks an empty cohort as an empty scorecard with a null winner', () => {
    const card = rankSelection([]);
    expect(card.totalRuns).toBe(0);
    expect(card.ranking).toEqual([]);
    expect(card.winner).toBeNull();
    expect(card.fixedValue).toBe('<none>');
  });
});

describe('rankSelection — ranking behaviour', () => {
  it('ranks the cleaner harness first and names a decisive winner', () => {
    const card = rankSelection([
      run({ harness: 'good', toolErrorRate: 0, recoveryRate: 1, longestRetryStreak: 0 }),
      run({ harness: 'bad', toolErrorRate: 0.8, recoveryRate: 0, longestRetryStreak: 4 }),
    ]);
    expect(card.ranking[0]?.name).toBe('good');
    expect(card.ranking[0]?.rank).toBe(1);
    expect(card.ranking[1]?.name).toBe('bad');
    expect(card.ranking[1]?.rank).toBe(2);
    expect(card.winner?.name).toBe('good');
    expect(card.summary).toBe('for model model-a: good > bad');
  });

  it('sinks a candidate with a PROOF-contradicted claim below a clean one', () => {
    const card = rankSelection([
      run({ harness: 'honest', contradictedClaims: 0, claimIntegrity: 1 }),
      run({ harness: 'liar', contradictedClaims: 1, claimIntegrity: 0 }),
    ]);
    expect(card.ranking[0]?.name).toBe('honest');
    expect(card.ranking[1]?.name).toBe('liar');
    expect(card.ranking[1]?.contradictedClaims).toBe(1);
  });

  it('reports unverifiable claims but never lets them move the score', () => {
    // Two candidates identical except one has a pile of unverifiable claims.
    const withGap = rankSelection([
      run({ harness: 'instrumented', unverifiableClaims: 0 }),
      run({ harness: 'opaque', unverifiableClaims: 9 }),
    ]);
    const a = withGap.ranking.find((c) => c.name === 'instrumented');
    const b = withGap.ranking.find((c) => c.name === 'opaque');
    expect(a?.score).toBe(b?.score); // unverifiable claims did NOT change the score
    expect(b?.unverifiableClaims).toBe(9); // ...but they ARE surfaced
    // A pure top-score tie yields no decisive winner.
    expect(withGap.winner).toBeNull();
  });

  it('treats a run with no decidable claim as integrity=null (never a free pass)', () => {
    const card = rankSelection([
      run({ harness: 'h1', claimIntegrity: null }),
      run({ harness: 'h2', claimIntegrity: null }),
    ]);
    expect(card.ranking.every((c) => c.meanClaimIntegrity === null)).toBe(true);
  });

  it('scores steps and cost RELATIVE to the cohort (leaner is better)', () => {
    const card = rankSelection([
      run({ harness: 'lean', toolCalls: 2, totalTokens: 500 }),
      run({ harness: 'heavy', toolCalls: 10, totalTokens: 5000 }),
    ]);
    expect(card.ranking[0]?.name).toBe('lean');
    expect(card.ranking[0]!.score).toBeGreaterThan(card.ranking[1]!.score);
  });

  it('is deterministic and order-independent for the same cohort', () => {
    const cohort = [
      run({ harness: 'a', toolErrorRate: 0.1 }),
      run({ harness: 'b', toolErrorRate: 0.2 }),
      run({ harness: 'c', toolErrorRate: 0.05 }),
    ];
    const forward = rankSelection(cohort);
    const reversed = rankSelection([...cohort].reverse());
    expect(forward.ranking.map((c) => c.name)).toEqual(reversed.ranking.map((c) => c.name));
    expect(forward.summary).toEqual(reversed.summary);
  });

  it('gives tied candidates a shared rank, no decisive winner, and = in the summary', () => {
    const card = rankSelection([
      run({ harness: 'twinA' }),
      run({ harness: 'twinB' }),
    ]);
    expect(card.ranking[0]?.rank).toBe(1);
    expect(card.ranking[1]?.rank).toBe(1); // shared lowest rank
    expect(card.winner).toBeNull();
    expect(card.summary).toContain(' = ');
  });

  it('aggregates multiple runs per candidate by mean', () => {
    const card = rankSelection([
      run({ harness: 'h', toolCalls: 2 }),
      run({ harness: 'h', toolCalls: 4 }),
    ]);
    expect(card.ranking).toHaveLength(1);
    expect(card.ranking[0]?.runs).toBe(2);
    expect(card.ranking[0]?.meanToolCalls).toBe(3);
    expect(card.winner?.name).toBe('h'); // single candidate wins by default
  });

  it('drops a signal weighted to 0 without changing determinism', () => {
    // With cost weighted out, the token-heavy candidate is no longer penalised on cost.
    const weighted = rankSelection(
      [run({ harness: 'cheap', totalTokens: 100 }), run({ harness: 'pricey', totalTokens: 9000 })],
      { weights: { cost: 0 } },
    );
    const cheap = weighted.ranking.find((c) => c.name === 'cheap');
    const pricey = weighted.ranking.find((c) => c.name === 'pricey');
    expect(cheap?.score).toBe(pricey?.score); // cost ignored → otherwise-identical → tie
  });
});

describe('rankSelection — end-to-end over recorded fixtures (read-only)', () => {
  it('reduces a recorded session to a per-run signal via the real slice-2/3 pipeline', () => {
    const session = loadSession('sentinel-push');
    const signal = toSelectionRun(session);
    expect(signal.model).toBe('claude-sonnet');
    expect(signal.harness).toBe('winsentinel-harness');
    expect(signal.sessionId).toBe('sess-sentinel-001');
    // PROOF: two tool calls, both clean → no errors, full recovery, no thrash.
    expect(signal.toolCalls).toBe(2);
    expect(signal.toolErrorRate).toBe(0);
    expect(signal.totalTokens).toBe(3400 + 880);
  });

  it('captures the retry→recover footprint of the second recorded session', () => {
    const signal = toSelectionRun(loadSession('build-retry-recover'));
    expect(signal.model).toBe('gpt-4o');
    expect(signal.harness).toBe('generic-harness');
    // PROOF: a failing build then a successful edit → some error rate, but recovered.
    expect(signal.toolErrorRate).toBeGreaterThan(0);
    expect(signal.recoveryRate).toBeGreaterThan(0);
  });

  it('does not mutate the source session (read-only toward trace data)', () => {
    const session = loadSession('sentinel-push');
    const before = JSON.stringify(session);
    toSelectionRun(session);
    // A single-session cohort is a valid (degenerate) sweep — exercises the full
    // rank path without tripping the both-axes-vary guardrail.
    rankSelection([session]);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('accepts decoded sessions directly, parsing the selection key per run', () => {
    // The two fixtures differ on BOTH axes, so a sweep must pin one explicitly.
    // Pinning fixed=model is invalid here (two models) — prove the guardrail fires
    // on real data, not just synthetic runs.
    expect(() =>
      rankSelection([loadSession('sentinel-push'), loadSession('build-retry-recover')]),
    ).toThrow(/exactly one variable fixed/i);
  });
});

describe('rankSelection — controlled sweep over recorded fixtures (real Tier 1+2 pipeline)', () => {
  // The `review-*` fixture pair holds the HARNESS fixed (`ci-review-harness`) and
  // varies the MODEL on the SAME task — a genuine "given a harness, which model?"
  // sweep. Both are fed through the real slice-2 (footprint) + slice-3
  // (claim↔proof) pipeline, so this exercises the headline capability end-to-end
  // on recorded trace data, not synthetic `SelectionRun`s. The clean run
  // (`gpt-strong`) verifies every build/tests/push claim against PROOF; the flaky
  // run (`llama-weak`) CLAIMS "build passed and pushed" while PROOF shows three
  // errored builds and no push tool — so PROOF, never the narration, decides it.

  it('infers the fixed harness and ranks the cleaner model first with a decisive winner', () => {
    const card = rankSelection([
      loadSession('review-clean-push'),
      loadSession('review-flaky-push'),
    ]);

    // Axis inference on real data: same harness, two models → hold harness, rank models.
    expect(card.fixed).toBe('harness');
    expect(card.varied).toBe('model');
    expect(card.fixedValue).toBe('ci-review-harness');
    expect(card.totalRuns).toBe(2);

    // The honest, low-error model wins decisively; the contradicted-claim model sinks.
    expect(card.ranking.map((c) => c.name)).toEqual(['gpt-strong', 'llama-weak']);
    expect(card.ranking[0]?.rank).toBe(1);
    expect(card.ranking[1]?.rank).toBe(2);
    expect(card.winner?.name).toBe('gpt-strong');
    expect(card.summary).toBe('for harness ci-review-harness: gpt-strong > llama-weak');

    // The score gap is real and large (clean PROOF + full integrity vs all-errored + contradicted).
    expect(card.ranking[0]!.score).toBeGreaterThan(card.ranking[1]!.score);
  });

  it('surfaces PROOF-derived per-candidate signals from the real footprint + claim-check', () => {
    const card = rankSelection([
      loadSession('review-clean-push'),
      loadSession('review-flaky-push'),
    ]);
    const clean = card.ranking.find((c) => c.name === 'gpt-strong')!;
    const flaky = card.ranking.find((c) => c.name === 'llama-weak')!;

    // Clean model: every decided claim verified, no PROOF contradictions, no errors, full recovery.
    expect(clean.meanClaimIntegrity).toBe(1);
    expect(clean.contradictedClaims).toBe(0);
    expect(clean.meanToolErrorRate).toBe(0);
    expect(clean.meanRecoveryRate).toBe(1);
    expect(clean.cleanRun).toBe(true);

    // Flaky model: integrity 0 because PROOF refutes the claims; every build errored, none recovered.
    expect(flaky.meanClaimIntegrity).toBe(0);
    expect(flaky.contradictedClaims).toBeGreaterThan(0);
    expect(flaky.meanToolErrorRate).toBe(1);
    expect(flaky.meanRecoveryRate).toBe(0);
    expect(flaky.cleanRun).toBe(false);
  });

  it('reaches the same ranking whether reduced first or passed as raw sessions', () => {
    const sessions = [loadSession('review-clean-push'), loadSession('review-flaky-push')];
    const fromSessions = rankSelection(sessions);
    // Pre-reduce to per-run signals (the other accepted input shape) and re-rank.
    const fromSignals = rankSelection(sessions.map((s) => toSelectionRun(s)));
    expect(fromSignals.summary).toBe(fromSessions.summary);
    expect(fromSignals.ranking.map((c) => c.name)).toEqual(
      fromSessions.ranking.map((c) => c.name),
    );
    expect(fromSignals.winner?.name).toBe(fromSessions.winner?.name);
  });

  it('honours an explicit fixed=harness on the real pair and is order-independent', () => {
    const sessions = [loadSession('review-clean-push'), loadSession('review-flaky-push')];
    const explicit = rankSelection(sessions, { fixed: 'harness' });
    const reversed = rankSelection([...sessions].reverse(), { fixed: 'harness' });
    expect(explicit.fixed).toBe('harness');
    expect(explicit.summary).toBe('for harness ci-review-harness: gpt-strong > llama-weak');
    // Determinism: reversing the cohort yields the identical ranking and summary.
    expect(reversed.ranking.map((c) => c.name)).toEqual(explicit.ranking.map((c) => c.name));
    expect(reversed.summary).toBe(explicit.summary);
  });

  it('does not mutate either source session (read-only over the real pipeline)', () => {
    const sessions = [loadSession('review-clean-push'), loadSession('review-flaky-push')];
    const before = sessions.map((s) => JSON.stringify(s));
    rankSelection(sessions);
    sessions.forEach((s, i) => expect(JSON.stringify(s)).toBe(before[i]));
  });
});

describe('rankSelection — multi-run-per-candidate cohort over recorded fixtures (real mean-aggregation)', () => {
  // The single-run `review-*` sweep above proves the *ranking* on recorded data,
  // but with one run per model it never exercises `aggregateCandidate`'s
  // mean/sum over MULTIPLE real runs of the same candidate. This cohort adds a
  // SECOND recorded run per model — each with a genuinely DIFFERENT behavioural
  // footprint — so every aggregate is a non-trivial average of two distinct
  // traces, not N copies of one. It keeps the harness fixed (`ci-review-harness`)
  // and the same task, so it stays a controlled "given a harness, which model?"
  // sweep, fed end-to-end through the real slice-2 (footprint) + slice-3
  // (claim↔proof) pipeline.
  //
  //   gpt-strong: run-1 clean (5300 tok) + run-2 clean but leaner (3600 tok)
  //               → both verified, errorRate 0, integrity 1.
  //   llama-weak: run-1 thrashes (3 errored builds, errorRate 1, no recovery,
  //               integrity 0) + run-2 a DIFFERENT failure shape (build+tests
  //               pass, push errors → errorRate 1/3, recovers nothing,
  //               integrity 0.667, push CLAIM contradicted by PROOF).
  //
  // So the means are real: gpt-strong tokens (5300+3600)/2 = 4450; llama-weak
  // errorRate (1+0.333…)/2 ≈ 0.667, recovery (0+1)/2 = 0.5, integrity
  // (0+0.667…)/2 ≈ 0.333, contradictions summed (4+2) = 6.

  const COHORT = [
    'review-clean-push',
    'review-clean-push-2',
    'review-flaky-push',
    'review-flaky-push-2',
  ] as const;

  const rankCohort = () => rankSelection(COHORT.map((n) => loadSession(n)));

  it('still ranks the honest model first with a decisive winner over four runs', () => {
    const card = rankCohort();
    expect(card.fixed).toBe('harness');
    expect(card.varied).toBe('model');
    expect(card.fixedValue).toBe('ci-review-harness');
    // Four sessions collapse to two candidates (two runs each).
    expect(card.totalRuns).toBe(4);
    expect(card.ranking.map((c) => c.name)).toEqual(['gpt-strong', 'llama-weak']);
    expect(card.ranking.every((c) => c.runs === 2)).toBe(true);
    expect(card.winner?.name).toBe('gpt-strong');
    expect(card.summary).toBe('for harness ci-review-harness: gpt-strong > llama-weak');
  });

  it('averages the clean model over two DIFFERENT recorded runs (real mean, not duplicates)', () => {
    const clean = rankCohort().ranking.find((c) => c.name === 'gpt-strong')!;
    expect(clean.runs).toBe(2);
    // The two clean runs spend different token budgets, so the mean is a true
    // average of distinct values, not the figure of a single run.
    expect(clean.meanTotalTokens).toBe((5300 + 3600) / 2); // 4450
    // Both runs are clean and honest → the integrity/error/recovery aggregates
    // are unanimous (and stay unanimous under averaging).
    expect(clean.meanClaimIntegrity).toBe(1);
    expect(clean.meanToolErrorRate).toBe(0);
    expect(clean.meanRecoveryRate).toBe(1);
    expect(clean.contradictedClaims).toBe(0);
    expect(clean.cleanRun).toBe(true);
  });

  it('averages the weak model across two DIFFERENT failure shapes (mean spans both)', () => {
    const flaky = rankCohort().ranking.find((c) => c.name === 'llama-weak')!;
    expect(flaky.runs).toBe(2);
    // run-1 errorRate 1 (all builds failed) + run-2 errorRate 1/3 (only push
    // failed) → mean lands strictly BETWEEN the two runs, proving the average
    // is computed over both rather than echoing either one. (The scorecard
    // rounds aggregates to 3 dp, so compare at 3-dp tolerance.)
    expect(flaky.meanToolErrorRate).toBeCloseTo((1 + 1 / 3) / 2, 3); // ≈ 0.667
    expect(flaky.meanToolErrorRate).toBeGreaterThan(1 / 3);
    expect(flaky.meanToolErrorRate).toBeLessThan(1);
    // run-1 recovered nothing (0) + run-2 had no recoverable error (1) → mean 0.5.
    expect(flaky.meanRecoveryRate).toBeCloseTo(0.5, 3);
    // run-1 integrity 0 + run-2 integrity 0.667 → mean ≈ 0.333 (still failing).
    expect(flaky.meanClaimIntegrity).toBeCloseTo((0 + 2 / 3) / 2, 3);
    // Contradictions are a SUM across the candidate's runs (4 + 2), not a mean.
    expect(flaky.contradictedClaims).toBe(6);
    // One bad run is enough to disqualify the candidate as clean.
    expect(flaky.cleanRun).toBe(false);
  });

  it('keeps the per-candidate mean independent of run order within the cohort', () => {
    const forward = rankCohort();
    const shuffled = rankSelection(
      [
        loadSession('review-flaky-push-2'),
        loadSession('review-clean-push-2'),
        loadSession('review-flaky-push'),
        loadSession('review-clean-push'),
      ],
    );
    const meanOf = (card: ReturnType<typeof rankSelection>, name: string) => {
      const c = card.ranking.find((r) => r.name === name)!;
      return [c.meanTotalTokens, c.meanToolErrorRate, c.meanClaimIntegrity, c.contradictedClaims];
    };
    // Aggregation groups by candidate, so the means/sums are identical regardless
    // of the order the four runs arrive in.
    expect(meanOf(shuffled, 'gpt-strong')).toEqual(meanOf(forward, 'gpt-strong'));
    expect(meanOf(shuffled, 'llama-weak')).toEqual(meanOf(forward, 'llama-weak'));
    expect(shuffled.summary).toBe(forward.summary);
  });

  it('reaches the same aggregates whether reduced to signals first or passed as raw sessions', () => {
    const sessions = COHORT.map((n) => loadSession(n));
    const fromSessions = rankCohort();
    // Pre-reducing each session to a SelectionRun (the other accepted input)
    // must aggregate to exactly the same per-candidate figures.
    const fromSignals = rankSelection(sessions.map((s) => toSelectionRun(s)));
    expect(fromSignals.ranking).toEqual(fromSessions.ranking);
    expect(fromSignals.summary).toBe(fromSessions.summary);
    expect(fromSignals.winner?.name).toBe(fromSessions.winner?.name);
  });

  it('does not mutate any of the four source sessions (read-only over the real pipeline)', () => {
    const sessions = COHORT.map((n) => loadSession(n));
    const before = sessions.map((s) => JSON.stringify(s));
    rankSelection(sessions);
    sessions.forEach((s, i) => expect(JSON.stringify(s)).toBe(before[i]));
  });
});
