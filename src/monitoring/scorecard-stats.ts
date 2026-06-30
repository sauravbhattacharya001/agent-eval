/**
 * Scorecard — pure aggregation engine (Phase 3.5 Production Monitoring)
 *
 * The `(scores [+ trends]) -> per-worker line` math behind {@link aggregateScorecard},
 * extracted so it is testable in isolation with no filesystem, no clock, and no
 * formatting concerns. Everything here is a pure function over
 * {@link TranscriptScore}s and a worker's {@link WorkerTrend} roll-up.
 *
 * The orchestration that groups scores by worker, sorts the lines, and stamps a
 * timestamp lives in `scorecard.ts`; the disk wiring (`scoreHistory` +
 * `detectTrendsFromDisk`) lives in `scorecard-runner.ts`. This file is the
 * reproducible core both of them lean on.
 *
 * Independence note (the core axis is independent -> corruptible): every input
 * is a Tier 1 / Tier 2 score the worker never produced, and the trend arrows
 * compare a worker against *its own* earlier baseline. No model-as-judge, no
 * shared substrate — pure aggregation over independent signals.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CheckName, TranscriptScore } from './scorer.js';
import type { WorkerTrend } from './trend-detector.js';
import {
  type CheckBreakdown,
  type FailureCategory,
  type HealthGrade,
  type ScorecardThresholds,
  type ScorecardTotals,
  type ScorecardTrend,
  type TrendArrow,
  type WorkerScorecard,
  EMPTY_GRADES,
} from './scorecard-types.js';

// ─── NUMERIC HELPERS ──────────────────────────────────────────────────────────────

/** Mean of an array, or NaN when empty. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

/** Round to 4 decimals to keep JSON output tidy and stable. */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}

// ─── RUN-LEVEL PREDICATES ──────────────────────────────────────────────────────────

/** Is a run a pass? At least one non-skipped check and none failed. */
export function runPassed(ts: TranscriptScore): boolean {
  const scored = ts.checks.filter((c) => c.status !== 'skip');
  if (scored.length === 0) return false;
  return scored.every((c) => c.status !== 'fail');
}

/** Did a run produce any pass/fail signal at all (>= 1 non-skipped check)? */
export function runHasSignal(ts: TranscriptScore): boolean {
  return ts.checks.some((c) => c.status !== 'skip');
}

// ─── TREND + GRADE ─────────────────────────────────────────────────────────────────

/**
 * Derive the trend arrow for one worker from its {@link WorkerTrend} roll-up.
 * The arrow follows the degradation/improvement balance, and a down arrow
 * inherits the worst degradation severity so the formatter can flag it.
 */
export function trendFromWorker(wt: WorkerTrend | undefined): ScorecardTrend {
  if (!wt) {
    return {
      arrow: '·',
      direction: 'none',
      severity: 'none',
      degrading: 0,
      improving: 0,
      summary: 'no trend data',
    };
  }

  const degrading = wt.degradations.length;
  const improving = wt.improvements.length;

  let arrow: TrendArrow;
  let direction: ScorecardTrend['direction'];
  if (degrading > improving) {
    arrow = '↓';
    direction = 'degrading';
  } else if (improving > degrading) {
    arrow = '↑';
    direction = 'improving';
  } else {
    // Either nothing moved, or movement in both directions cancels to flat.
    arrow = '→';
    direction = 'stable';
  }

  const summary =
    degrading === 0 && improving === 0
      ? 'steady'
      : `${degrading} degrading, ${improving} improving`;

  return {
    arrow,
    direction,
    // Severity only meaningful when the net direction is down.
    severity: direction === 'degrading' ? wt.worstSeverity : 'none',
    degrading,
    improving,
    summary,
  };
}

/**
 * Grade a worker from its pass rate and trend. The trend can only *demote* a
 * worker, never promote it — a high pass rate with a critical downward trend is
 * still risky because the snapshot looks fine precisely while it rots.
 */
export function gradeWorker(
  passRate: number,
  trend: ScorecardTrend,
  thresholds: ScorecardThresholds,
): HealthGrade {
  if (!Number.isFinite(passRate)) return 'no-data';

  let grade: HealthGrade;
  if (passRate >= thresholds.healthy) grade = 'healthy';
  else if (passRate >= thresholds.watch) grade = 'watch';
  else grade = 'at-risk';

  // A degrading trend demotes. Critical degradation forces at least 'at-risk';
  // a critical trend on an already-bad worker pushes to 'critical'.
  if (trend.direction === 'degrading') {
    if (trend.severity === 'critical') {
      grade = grade === 'at-risk' ? 'critical' : 'at-risk';
    } else if (grade === 'healthy') {
      // Any non-critical degradation knocks a "healthy" worker down to "watch".
      grade = 'watch';
    }
  }

  return grade;
}

// ─── PER-CHECK + FAILURE BREAKDOWNS ──────────────────────────────────────────────

/** Build the per-check breakdown for one worker from its scored runs. */
export function breakdownChecks(scores: readonly TranscriptScore[]): CheckBreakdown[] {
  const acc = new Map<
    CheckName,
    { scores: number[]; fails: number; warns: number; passes: number }
  >();

  for (const ts of scores) {
    for (const c of ts.checks) {
      if (c.status === 'skip') continue; // skipped checks carry no signal
      let a = acc.get(c.check);
      if (!a) {
        a = { scores: [], fails: 0, warns: 0, passes: 0 };
        acc.set(c.check, a);
      }
      a.scores.push(c.score);
      if (c.status === 'fail') a.fails += 1;
      else if (c.status === 'warn') a.warns += 1;
      else if (c.status === 'pass') a.passes += 1;
    }
  }

  const out: CheckBreakdown[] = [];
  for (const [check, a] of acc) {
    out.push({
      check,
      meanScore: round4(mean(a.scores)),
      runs: a.scores.length,
      fails: a.fails,
      warns: a.warns,
      passes: a.passes,
    });
  }

  // Worst mean score first; ties broken by more failures, then name.
  out.sort((x, y) => {
    const mx = Number.isFinite(x.meanScore) ? x.meanScore : Infinity;
    const my = Number.isFinite(y.meanScore) ? y.meanScore : Infinity;
    if (mx !== my) return mx - my;
    if (x.fails !== y.fails) return y.fails - x.fails;
    return x.check.localeCompare(y.check);
  });
  return out;
}

/** Tally failure categories (which checks failed, how often) worst-first. */
export function failureCategories(scores: readonly TranscriptScore[]): FailureCategory[] {
  const counts = new Map<CheckName, number>();
  for (const ts of scores) {
    for (const c of ts.checks) {
      if (c.status === 'fail') counts.set(c.check, (counts.get(c.check) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([check, count]) => ({ check, count }))
    .sort((a, b) => b.count - a.count || a.check.localeCompare(b.check));
}

// ─── PER-WORKER + FLEET ROLL-UP ─────────────────────────────────────────────────

/** Build one worker's scorecard line from its scored runs and (optional) trend. */
export function buildWorkerScorecard(
  worker: string,
  scores: readonly TranscriptScore[],
  trend: ScorecardTrend,
  thresholds: ScorecardThresholds,
): WorkerScorecard {
  const runs = scores.length;

  // Pass rate is measured only over runs that produced a pass/fail signal. A
  // run where every check skipped (no task, empty body) carries no verdict and
  // would otherwise unfairly drag the rate to 0.
  const evaluable = scores.filter(runHasSignal);
  const passingRuns = evaluable.filter(runPassed).length;
  const runsWithFailures = scores.filter((ts) => ts.failCount > 0).length;
  const totalFailures = scores.reduce((a, ts) => a + ts.failCount, 0);

  const overalls = scores.map((ts) => ts.overall).filter((n) => Number.isFinite(n));
  const passRate = evaluable.length > 0 ? passingRuns / evaluable.length : Number.NaN;
  const meanScore = round4(mean(overalls));
  const worstScore = overalls.length > 0 ? round4(Math.min(...overalls)) : Number.NaN;

  const cats = failureCategories(scores);
  const checks = breakdownChecks(scores);
  const grade = gradeWorker(passRate, trend, thresholds);

  const passPctStr = Number.isFinite(passRate) ? `${Math.round(passRate * 100)}%` : 'n/a';
  const worstCat = cats[0] ? `, top failure: ${cats[0].check} (${cats[0].count})` : '';
  const summary =
    runs === 0
      ? `${worker}: no runs in window`
      : `${worker}: ${grade}, ${passPctStr} pass (${passingRuns}/${runs}) ${trend.arrow}${worstCat}`;

  return {
    worker,
    grade,
    runs,
    passRate: round4(passRate),
    meanScore,
    worstScore,
    runsWithFailures,
    totalFailures,
    failureCategories: cats,
    checks,
    trend,
    summary,
  };
}

/** Compute fleet-wide totals from the per-worker lines + raw scores. */
export function computeTotals(
  workers: readonly WorkerScorecard[],
  scores: readonly TranscriptScore[],
): ScorecardTotals {
  const grades: Record<HealthGrade, number> = { ...EMPTY_GRADES };
  let degradingTrends = 0;
  let improvingTrends = 0;
  for (const w of workers) {
    grades[w.grade] += 1;
    degradingTrends += w.trend.degrading;
    improvingTrends += w.trend.improving;
  }

  const totalRuns = scores.length;
  const evaluable = scores.filter(runHasSignal);
  const passingRuns = evaluable.filter(runPassed).length;
  const overalls = scores.map((ts) => ts.overall).filter((n) => Number.isFinite(n));

  return {
    workers: workers.length,
    runs: totalRuns,
    passRate: evaluable.length > 0 ? round4(passingRuns / evaluable.length) : Number.NaN,
    meanScore: round4(mean(overalls)),
    grades,
    degradingTrends,
    improvingTrends,
  };
}
