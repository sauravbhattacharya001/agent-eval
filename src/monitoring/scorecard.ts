/**
 * Weekly Scorecard — Phase 3.5 Production Monitoring
 *
 * The capstone of the monitoring pipeline. The scorer turns transcripts into
 * point-in-time {@link TranscriptScore}s; the trend detector turns those scores
 * into a *direction* per (worker, check, metric). Neither alone answers the
 * question a human actually asks on Monday morning: **"which workers are
 * healthy, which are slipping, and what's breaking?"** The scorecard is that
 * answer — one roll-up per worker combining a current pass rate, a breakdown of
 * what's failing, and a trend arrow (up improving / down degrading / flat steady).
 *
 * Why it exists (the framework's thesis, applied one more time): research-time
 * safety != runtime safety. A fleet of agents can each look fine on any single
 * run while the fleet as a whole quietly rots. The scorecard is the weekly
 * physical — it reads the record the workers can't forge (their own scored
 * transcripts) and reports the trend, not the snapshot.
 *
 * Independence note (the core axis is independent -> corruptible): every input
 * is a Tier 1 / Tier 2 score the worker never produced, and the trend arrows
 * compare a worker against *its own* earlier baseline. No model-as-judge, no
 * shared substrate. The scorecard is pure aggregation + formatting over those
 * independent signals — reproducible and offline by construction.
 *
 * Pipeline shape:
 *
 *     scores.jsonl --scoreHistory--> TranscriptScore[]  -.
 *                                                          >-- aggregateScorecard --> Scorecard
 *     scores.jsonl --detectTrends--> TrendReport        -'                              |
 *                                                                                       v
 *                                                   formatScorecard / formatScorecardMarkdown
 *
 * Module layout (this file is the orchestration + formatting surface; the pieces
 * it drives live alongside it, re-exported here so consumers keep one import
 * path at `./scorecard.js`):
 *
 *   - `./scorecard-types.js` — the type vocabulary + grading/display constants.
 *   - `./scorecard-stats.js` — the pure `(scores [+ trend]) -> line` engine
 *                              (predicates, grading, per-check + failure
 *                              breakdowns, per-worker + fleet roll-up).
 *   - `./scorecard-format.js` — the pure `(Scorecard) -> string` renderers
 *                              ({@link formatScorecard}, {@link formatScorecardMarkdown}),
 *                              re-exported here.
 *   - this file              — grouping/sorting orchestration ({@link aggregateScorecard}).
 *   - `./scorecard-runner.js` — the disk wiring (`scoreHistory` +
 *                               `detectTrendsFromDisk` -> {@link aggregateScorecard}).
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { TranscriptScore } from './scorer.js';
import type { WorkerTrend } from './trend-detector.js';
import {
  type AggregateScorecardOptions,
  type Scorecard,
  type ScorecardThresholds,
  type WorkerScorecard,
  DEFAULT_HEALTHY_PASS_RATE,
  DEFAULT_WATCH_PASS_RATE,
  GRADE_RANK,
} from './scorecard-types.js';
import {
  buildWorkerScorecard,
  computeTotals,
  trendFromWorker,
} from './scorecard-stats.js';

// Re-export the type vocabulary so consumers keep one import path at
// `./scorecard.js` (mirrors the trend-detector split).
export type {
  HealthGrade,
  TrendArrow,
  ScorecardTrend,
  CheckBreakdown,
  FailureCategory,
  WorkerScorecard,
  ScorecardTotals,
  Scorecard,
  AggregateScorecardOptions,
} from './scorecard-types.js';

// Re-export the pure engine pieces a consumer might want to drive directly
// (e.g. to build a single worker line without re-grouping).
export {
  buildWorkerScorecard,
  computeTotals,
  trendFromWorker,
  gradeWorker,
  breakdownChecks,
  failureCategories,
} from './scorecard-stats.js';

// Re-export the renderers so consumers keep one import path at `./scorecard.js`.
export {
  formatScorecard,
  formatScorecardMarkdown,
} from './scorecard-format.js';

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Aggregate scored transcripts (and an optional trend report) into a
 * {@link Scorecard}. Pure: no filesystem, no clock beyond `options.now`.
 *
 * Workers are grouped from the {@link TranscriptScore.worker} field, so the set
 * of workers on the scorecard is exactly the set that produced scored runs in
 * the window. The trend report only contributes arrows; it never adds a worker
 * that has no scored runs (a trend with no current data is not actionable).
 *
 * @param scores - Per-transcript scores (typically `scoreHistory(...).scores`).
 * @param options - Trend report, window, and grading thresholds.
 */
export function aggregateScorecard(
  scores: readonly TranscriptScore[],
  options: AggregateScorecardOptions = {},
): Scorecard {
  const now = options.now ?? new Date();
  const thresholds: ScorecardThresholds = {
    healthy: options.healthyPassRate ?? DEFAULT_HEALTHY_PASS_RATE,
    watch: options.watchPassRate ?? DEFAULT_WATCH_PASS_RATE,
  };

  // Index trends by worker for arrow lookup.
  const trendByWorker = new Map<string, WorkerTrend>();
  if (options.trends) {
    for (const wt of options.trends.workers) trendByWorker.set(wt.worker, wt);
  }

  // Group scores by worker, preserving first-seen order for stable grouping.
  const byWorker = new Map<string, TranscriptScore[]>();
  for (const ts of scores) {
    const list = byWorker.get(ts.worker);
    if (list) list.push(ts);
    else byWorker.set(ts.worker, [ts]);
  }

  const workers: WorkerScorecard[] = [];
  for (const [worker, runs] of byWorker) {
    const trend = trendFromWorker(trendByWorker.get(worker));
    workers.push(buildWorkerScorecard(worker, runs, trend, thresholds));
  }

  // Worst grade first; within a grade, lowest pass rate first, then name.
  workers.sort((a, b) => {
    const g = GRADE_RANK[a.grade] - GRADE_RANK[b.grade];
    if (g !== 0) return g;
    const pa = Number.isFinite(a.passRate) ? a.passRate : Infinity;
    const pb = Number.isFinite(b.passRate) ? b.passRate : Infinity;
    if (pa !== pb) return pa - pb;
    return a.worker.localeCompare(b.worker);
  });

  const totals = computeTotals(workers, scores);

  return {
    window: options.window,
    generatedAt: now.toISOString(),
    workers,
    totals,
  };
}
