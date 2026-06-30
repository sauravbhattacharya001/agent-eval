/**
 * Direct unit tests for the Weekly Scorecard's pure aggregation engine
 * (`src/monitoring/scorecard-stats.ts`).
 *
 * The end-to-end behaviour is covered by `scorecard.test.ts` through the public
 * `aggregateScorecard` + formatters. This file pins the *individual* engine
 * seams now that they are independently importable — so a future refactor of
 * one helper (grading thresholds, the run-pass predicate, the per-check tally,
 * the fleet roll-up) fails a tight, named test instead of only showing up as a
 * mismatched scorecard several layers up.
 *
 * Fixtures here are deliberately minimal and local (no disk, no clock).
 */

import { describe, expect, it } from 'vitest';

import type { CheckName, CheckScore, ScoreStatus, TranscriptScore } from '../src/monitoring/scorer.js';
import type { ScorecardThresholds } from '../src/monitoring/scorecard-types.js';
import type { ScorecardTrend, WorkerScorecard } from '../src/monitoring/scorecard.js';
import type { TrendSeverity, WorkerTrend } from '../src/monitoring/trend-detector.js';
import {
  breakdownChecks,
  buildWorkerScorecard,
  computeTotals,
  failureCategories,
  gradeWorker,
  mean,
  round4,
  runHasSignal,
  runPassed,
  trendFromWorker,
} from '../src/monitoring/scorecard-stats.js';

// --- local fixture helpers --------------------------------------------------

const BASE_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const THRESHOLDS: ScorecardThresholds = { healthy: 0.9, watch: 0.6 };

interface CheckSpec {
  check: CheckName;
  score: number;
  status: ScoreStatus;
}

function check(spec: CheckSpec, worker: string, runId: string): CheckScore {
  return {
    worker,
    runId,
    startedAt: new Date(BASE_MS).toISOString(),
    startedAtMs: BASE_MS,
    check: spec.check,
    tier: spec.check === 'verification' ? 2 : 1,
    score: spec.score,
    status: spec.status,
    summary: `${spec.check}=${spec.score}`,
    scoredAt: new Date(BASE_MS).toISOString(),
  };
}

/** Build a TranscriptScore from specs, deriving roll-ups the way the scorer does. */
function ts(worker: string, runId: string, specs: CheckSpec[]): TranscriptScore {
  const checks = specs.map((s) => check(s, worker, runId));
  const scored = checks.filter((c) => c.status !== 'skip');
  const overall = scored.length > 0 ? scored.reduce((a, c) => a + c.score, 0) / scored.length : Number.NaN;
  const worst = scored.length > 0 ? Math.min(...scored.map((c) => c.score)) : Number.NaN;
  return {
    worker,
    runId,
    startedAt: new Date(BASE_MS).toISOString(),
    startedAtMs: BASE_MS,
    reportedOutcome: 'pass',
    checks,
    overall,
    worst,
    failCount: checks.filter((c) => c.status === 'fail').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
  };
}

const passSpecs: CheckSpec[] = [
  { check: 'staleness', score: 1, status: 'pass' },
  { check: 'completeness', score: 1, status: 'pass' },
];
const failSpecs: CheckSpec[] = [
  { check: 'staleness', score: 1, status: 'pass' },
  { check: 'completeness', score: 0, status: 'fail' },
];
const allSkipSpecs: CheckSpec[] = [
  { check: 'staleness', score: 0, status: 'skip' },
  { check: 'completeness', score: 0, status: 'skip' },
];

const NO_TREND: ScorecardTrend = trendFromWorker(undefined);

function workerTrend(degrading: number, improving: number, sev: TrendSeverity = 'warning'): WorkerTrend {
  const stub = { count: 3, mean: 0.8, stdev: 0.1, min: 0.7, max: 0.9, firstMs: BASE_MS, lastMs: BASE_MS };
  const mk = (dir: 'degrading' | 'improving') =>
    ({
      worker: 'w',
      check: 'completeness' as CheckName,
      metric: 'score',
      goodDirection: 'up',
      direction: dir,
      severity: dir === 'degrading' ? sev : 'none',
      delta: dir === 'degrading' ? -0.3 : 0.3,
      relativeDelta: -0.3,
      z: dir === 'degrading' ? -2 : 2,
      improved: dir === 'improving',
      baseline: stub,
      recent: stub,
      points: [],
      summary: `${dir}`,
    });
  const degradations = Array.from({ length: degrading }, () => mk('degrading'));
  const improvements = Array.from({ length: improving }, () => mk('improving'));
  return {
    worker: 'w',
    trends: [...degradations, ...improvements],
    degradations,
    improvements,
    worstSeverity: degrading > 0 ? sev : 'none',
    runCount: degrading + improving + 1,
  } as unknown as WorkerTrend;
}

// --- numeric helpers --------------------------------------------------------

describe('scorecard-stats: numeric helpers', () => {
  it('mean averages and returns NaN on empty', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([0.5])).toBe(0.5);
    expect(Number.isNaN(mean([]))).toBe(true);
  });

  it('round4 keeps 4 decimals and passes non-finite through unchanged', () => {
    expect(round4(0.123456)).toBe(0.1235);
    expect(round4(1)).toBe(1);
    expect(Number.isNaN(round4(Number.NaN))).toBe(true);
    expect(round4(Infinity)).toBe(Infinity);
  });
});

// --- run-level predicates ---------------------------------------------------

describe('scorecard-stats: run predicates', () => {
  it('runPassed: true only when >=1 non-skip check and none failed', () => {
    expect(runPassed(ts('w', 'r1', passSpecs))).toBe(true);
    expect(runPassed(ts('w', 'r2', failSpecs))).toBe(false);
  });

  it('runPassed: an all-skipped run is NOT a pass (no verdict)', () => {
    expect(runPassed(ts('w', 'r3', allSkipSpecs))).toBe(false);
  });

  it('runPassed: a warn (no fail) still counts as a pass', () => {
    const warned = ts('w', 'r4', [
      { check: 'staleness', score: 1, status: 'pass' },
      { check: 'completeness', score: 0.5, status: 'warn' },
    ]);
    expect(runPassed(warned)).toBe(true);
  });

  it('runHasSignal: true with any non-skip check, false when all skipped', () => {
    expect(runHasSignal(ts('w', 'r1', passSpecs))).toBe(true);
    expect(runHasSignal(ts('w', 'r3', allSkipSpecs))).toBe(false);
  });
});

// --- trendFromWorker --------------------------------------------------------

describe('scorecard-stats: trendFromWorker', () => {
  it('no worker -> dot / none', () => {
    expect(NO_TREND).toMatchObject({ arrow: '·', direction: 'none', severity: 'none' });
    expect(NO_TREND.summary).toBe('no trend data');
  });

  it('net degrading -> down arrow carrying worst severity', () => {
    const t = trendFromWorker(workerTrend(2, 0, 'critical'));
    expect(t).toMatchObject({ arrow: '↓', direction: 'degrading', severity: 'critical', degrading: 2 });
    expect(t.summary).toBe('2 degrading, 0 improving');
  });

  it('net improving -> up arrow, severity none', () => {
    const t = trendFromWorker(workerTrend(0, 3));
    expect(t).toMatchObject({ arrow: '↑', direction: 'improving', severity: 'none', improving: 3 });
  });

  it('balanced movement -> flat arrow (stable), severity none', () => {
    const t = trendFromWorker(workerTrend(2, 2, 'critical'));
    expect(t).toMatchObject({ arrow: '→', direction: 'stable', severity: 'none' });
  });

  it('no movement at all -> flat arrow with "steady" summary', () => {
    const t = trendFromWorker(workerTrend(0, 0));
    expect(t).toMatchObject({ arrow: '→', direction: 'stable' });
    expect(t.summary).toBe('steady');
  });
});

// --- gradeWorker ------------------------------------------------------------

describe('scorecard-stats: gradeWorker', () => {
  it('grades on pass rate when trend is flat', () => {
    expect(gradeWorker(1, NO_TREND, THRESHOLDS)).toBe('healthy');
    expect(gradeWorker(0.9, NO_TREND, THRESHOLDS)).toBe('healthy');
    expect(gradeWorker(0.75, NO_TREND, THRESHOLDS)).toBe('watch');
    expect(gradeWorker(0.6, NO_TREND, THRESHOLDS)).toBe('watch');
    expect(gradeWorker(0.3, NO_TREND, THRESHOLDS)).toBe('at-risk');
  });

  it('non-finite pass rate -> no-data', () => {
    expect(gradeWorker(Number.NaN, NO_TREND, THRESHOLDS)).toBe('no-data');
  });

  it('a non-critical degrading trend demotes healthy -> watch only', () => {
    const t = trendFromWorker(workerTrend(1, 0, 'warning'));
    expect(gradeWorker(1, t, THRESHOLDS)).toBe('watch');
    // ...but does not touch an already-watch worker.
    expect(gradeWorker(0.7, t, THRESHOLDS)).toBe('watch');
  });

  it('a critical degrading trend forces at-risk, and critical on at-risk -> critical', () => {
    const t = trendFromWorker(workerTrend(1, 0, 'critical'));
    expect(gradeWorker(1, t, THRESHOLDS)).toBe('at-risk'); // healthy demoted two steps
    expect(gradeWorker(0.3, t, THRESHOLDS)).toBe('critical'); // at-risk -> critical
  });

  it('a trend can only demote, never promote', () => {
    const up = trendFromWorker(workerTrend(0, 3));
    expect(gradeWorker(0.3, up, THRESHOLDS)).toBe('at-risk'); // improving trend does not rescue a bad rate
  });
});

// --- breakdownChecks --------------------------------------------------------

describe('scorecard-stats: breakdownChecks', () => {
  it('tallies pass/warn/fail per check and ignores skips', () => {
    const scores = [
      ts('w', 'r1', [
        { check: 'completeness', score: 1, status: 'pass' },
        { check: 'staleness', score: 0, status: 'skip' },
      ]),
      ts('w', 'r2', [{ check: 'completeness', score: 0, status: 'fail' }]),
      ts('w', 'r3', [{ check: 'completeness', score: 0.5, status: 'warn' }]),
    ];
    const out = breakdownChecks(scores);
    expect(out).toHaveLength(1); // staleness was skip-only -> excluded
    const comp = out[0];
    expect(comp.check).toBe('completeness');
    expect(comp.runs).toBe(3);
    expect(comp.passes).toBe(1);
    expect(comp.warns).toBe(1);
    expect(comp.fails).toBe(1);
    expect(comp.meanScore).toBe(0.5); // (1 + 0 + 0.5) / 3
  });

  it('sorts worst mean score first', () => {
    const scores = [
      ts('w', 'r1', [
        { check: 'completeness', score: 1, status: 'pass' },
        { check: 'staleness', score: 0.2, status: 'warn' },
      ]),
    ];
    const out = breakdownChecks(scores);
    expect(out.map((c) => c.check)).toEqual(['staleness', 'completeness']);
  });

  it('empty input -> empty breakdown', () => {
    expect(breakdownChecks([])).toEqual([]);
  });
});

// --- failureCategories ------------------------------------------------------

describe('scorecard-stats: failureCategories', () => {
  it('counts only failing checks, worst-first', () => {
    const scores = [
      ts('w', 'r1', [
        { check: 'completeness', score: 0, status: 'fail' },
        { check: 'staleness', score: 0, status: 'fail' },
      ]),
      ts('w', 'r2', [{ check: 'completeness', score: 0, status: 'fail' }]),
      ts('w', 'r3', passSpecs), // no fails contributes nothing
    ];
    const cats = failureCategories(scores);
    expect(cats).toEqual([
      { check: 'completeness', count: 2 },
      { check: 'staleness', count: 1 },
    ]);
  });

  it('no failures -> empty', () => {
    expect(failureCategories([ts('w', 'r1', passSpecs)])).toEqual([]);
  });
});

// --- buildWorkerScorecard ---------------------------------------------------

describe('scorecard-stats: buildWorkerScorecard', () => {
  it('computes a clean all-pass line', () => {
    const line = buildWorkerScorecard('w', [ts('w', 'r1', passSpecs), ts('w', 'r2', passSpecs)], NO_TREND, THRESHOLDS);
    expect(line.worker).toBe('w');
    expect(line.runs).toBe(2);
    expect(line.passRate).toBe(1);
    expect(line.grade).toBe('healthy');
    expect(line.runsWithFailures).toBe(0);
    expect(line.totalFailures).toBe(0);
    expect(line.failureCategories).toEqual([]);
    expect(line.summary).toContain('100% pass (2/2)');
  });

  it('pass rate ignores all-skipped runs (no verdict does not drag it to 0)', () => {
    const line = buildWorkerScorecard(
      'w',
      [ts('w', 'r1', passSpecs), ts('w', 'r2', allSkipSpecs)],
      NO_TREND,
      THRESHOLDS,
    );
    // Only r1 is evaluable, and it passed -> 100%, not 50%.
    expect(line.passRate).toBe(1);
    expect(line.runs).toBe(2);
  });

  it('mixes pass + fail into pass rate, failure tally, and top-failure summary', () => {
    const line = buildWorkerScorecard(
      'w',
      [ts('w', 'r1', passSpecs), ts('w', 'r2', failSpecs), ts('w', 'r3', failSpecs)],
      NO_TREND,
      THRESHOLDS,
    );
    expect(line.passRate).toBe(round4(1 / 3));
    expect(line.runsWithFailures).toBe(2);
    expect(line.totalFailures).toBe(2);
    expect(line.failureCategories[0]).toEqual({ check: 'completeness', count: 2 });
    expect(line.grade).toBe('at-risk'); // 33% < watch floor
    expect(line.summary).toContain('top failure: completeness (2)');
  });

  it('empty run list -> NaN pass rate, no-data grade, "no runs" summary', () => {
    const line = buildWorkerScorecard('w', [], NO_TREND, THRESHOLDS);
    expect(Number.isNaN(line.passRate)).toBe(true);
    expect(line.grade).toBe('no-data');
    expect(line.runs).toBe(0);
    expect(line.summary).toBe('w: no runs in window');
  });
});

// --- computeTotals ----------------------------------------------------------

describe('scorecard-stats: computeTotals', () => {
  it('aggregates grades, runs, fleet pass rate and trend counts', () => {
    const scores = [
      ts('a', 'r1', passSpecs),
      ts('a', 'r2', passSpecs),
      ts('b', 'r1', failSpecs),
    ];
    const lines: WorkerScorecard[] = [
      buildWorkerScorecard('a', [scores[0], scores[1]], trendFromWorker(workerTrend(0, 2)), THRESHOLDS),
      buildWorkerScorecard('b', [scores[2]], trendFromWorker(workerTrend(1, 0, 'critical')), THRESHOLDS),
    ];
    const totals = computeTotals(lines, scores);
    expect(totals.workers).toBe(2);
    expect(totals.runs).toBe(3);
    // 2 passing of 3 evaluable runs.
    expect(totals.passRate).toBe(round4(2 / 3));
    expect(totals.improvingTrends).toBe(2);
    expect(totals.degradingTrends).toBe(1);
    expect(totals.grades.healthy).toBe(1); // worker a (improving trend, 100% pass)
    expect(totals.grades.critical).toBe(1); // worker b: 0% pass (at-risk) + critical trend -> critical
  });

  it('all-skipped scores -> NaN fleet pass rate', () => {
    const scores = [ts('a', 'r1', allSkipSpecs)];
    const lines = [buildWorkerScorecard('a', scores, NO_TREND, THRESHOLDS)];
    const totals = computeTotals(lines, scores);
    expect(Number.isNaN(totals.passRate)).toBe(true);
    expect(totals.runs).toBe(1);
  });
});
