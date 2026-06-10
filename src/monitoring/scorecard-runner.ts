/**
 * Scorecard Runner — orchestrates score + trend -> scorecard from disk.
 *
 * The one-call entry point a cron worker (or the CLI) uses to produce a weekly
 * health scorecard for the whole fleet of agents:
 *
 *     buildScorecard('.../transcripts', { window: 7 })
 *
 * It sits *above* the pure aggregator ({@link aggregateScorecard}) and reuses
 * the two existing runners so there is exactly one scoring path and one trend
 * path in the codebase:
 *
 *   - {@link scoreHistory} re-scores the transcripts in the window (and, by
 *     default, refreshes each worker's `scores.jsonl`), giving the *current*
 *     pass rates and failure categories.
 *   - {@link detectTrends} runs over those same freshly-scored rows to compute
 *     the *direction* (the trend arrows), so the snapshot and the arrows cover
 *     the same window with no disk round-trip. (`trendsFromDisk: true` switches
 *     the arrows to the full persisted history via {@link detectTrendsFromDisk}.)
 *
 * Aggregating the two yields the scorecard: snapshot health + movement, per
 * worker, fleet-wide. Pure read-of-record monitoring (Tier 1+2, no
 * model-as-judge): the workers never produced the scores or the baselines they
 * are measured against.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import { rollingWindow } from './discovery.js';
import { scoreHistory } from './score-runner.js';
import type { ScoreHistoryOptions } from './score-runner.js';
import { aggregateScorecard } from './scorecard.js';
import type { AggregateScorecardOptions, Scorecard } from './scorecard.js';
import { detectTrends } from './trend-detector.js';
import { detectTrendsFromDisk } from './trend-runner.js';
import type { DetectTrendsFromDiskOptions } from './trend-runner.js';
import type { DetectTrendsOptions, TrendMetric, TrendReport } from './trend-detector.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Options for {@link buildScorecard}. */
export interface BuildScorecardOptions
  extends Pick<
      AggregateScorecardOptions,
      'now' | 'healthyPassRate' | 'watchPassRate'
    >,
    Pick<
      ScoreHistoryOptions,
      | 'workers'
      | 'excludeWorkers'
      | 'timeoutMs'
      | 'minOutputWords'
      | 'relevanceThreshold'
      | 'coverageThreshold'
    > {
  /**
   * Trailing calendar-day window the scorecard covers. Applied to both the
   * scoring pass and the trend pass so they describe the same period. Omit for
   * all-time. Overridden by explicit {@link BuildScorecardOptions.fromDate} /
   * {@link BuildScorecardOptions.toDate}.
   */
  window?: number;
  /** Inclusive `YYYY-MM-DD` lower bound (overrides the window's lower bound). */
  fromDate?: string;
  /** Inclusive `YYYY-MM-DD` upper bound (overrides the window's upper bound). */
  toDate?: string;
  /**
   * Whether the scoring pass should persist refreshed scores to
   * `scores.jsonl`. Default: false — building a scorecard is a *read* of the
   * record; a reporting call shouldn't mutate history as a side effect. Set
   * true to re-score and persist in the same call.
   */
  persist?: boolean;
  /**
   * Metrics the trend pass should consider when drawing arrows. Defaults to
   * `['score']` (headline health). Add `'durationMs'`, `'failRate'`, etc. to
   * factor raw-signal slides into the arrow.
   */
  trendMetrics?: readonly TrendMetric[];
  /**
   * Skip trend detection entirely (snapshot-only scorecard, all arrows `·`).
   * Default: false.
   */
  noTrends?: boolean;
  /**
   * Source the trend arrows from each worker's full on-disk `scores.jsonl`
   * history (via {@link detectTrendsFromDisk}) instead of the rows just scored
   * in this call. Default: false — the trend is computed over the *same*
   * window the snapshot covers, using the in-memory scores, so the scorecard is
   * self-contained and correct even when `persist` is false. Set true to draw
   * arrows from the entire persisted history regardless of the snapshot window.
   */
  trendsFromDisk?: boolean;
  /**
   * Forwarded trend-detection tunables (z-thresholds, split strategy, etc.).
   * The window/date fields are filled in from this call's window so callers
   * don't repeat themselves.
   */
  trendOptions?: Omit<
    DetectTrendsFromDiskOptions,
    'window' | 'fromDate' | 'toDate' | 'today' | 'workers' | 'metrics'
  >;
}

/** Result of {@link buildScorecard}. */
export interface BuildScorecardResult {
  /** The assembled scorecard. */
  scorecard: Scorecard;
  /** Number of transcripts scored in the window. */
  scored: number;
  /** Number of transcripts that failed to parse/score. */
  failed: number;
  /** Parse/score failures: path -> error message. */
  errors: Array<{ path: string; error: string }>;
  /** Number of score rows the trend pass read from disk (0 when `noTrends`). */
  trendRowsRead: number;
  /** Resolved inclusive window applied to both passes, if any. */
  window: { fromDate: string; toDate: string } | undefined;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Build a fleet health scorecard from a transcripts root: score the window,
 * detect trends over the same window, and aggregate the two.
 *
 * The scoring pass and the trend pass are both clipped to one resolved date
 * window so the snapshot and the arrows describe the same period — a pass rate
 * "this week" next to a trend "this week", not a snapshot of this week beside a
 * trend computed over all of history.
 *
 * By default this does NOT persist refreshed scores (`persist: false`): a
 * report should not mutate the record it reports on. Opt in with
 * `persist: true` to also bring `scores.jsonl` up to date in the same call.
 *
 * @param root - Transcripts root containing per-worker subdirectories.
 * @param options - Window, grading thresholds, trend tunables, persistence.
 */
export function buildScorecard(
  root: string,
  options: BuildScorecardOptions = {},
): BuildScorecardResult {
  // Resolve one window for both passes.
  let fromDate = options.fromDate;
  let toDate = options.toDate;
  if (options.window !== undefined && fromDate === undefined && toDate === undefined) {
    const win = rollingWindow(options.window, options.now ?? new Date());
    fromDate = win.fromDate;
    toDate = win.toDate;
  }
  const window = fromDate || toDate ? { fromDate: fromDate ?? '', toDate: toDate ?? '' } : undefined;

  // 1) Score the transcripts in the window (current pass rates / failures).
  const scoreOpts: ScoreHistoryOptions = {
    persist: options.persist ?? false,
    ...(options.workers ? { workers: options.workers } : {}),
    ...(options.excludeWorkers ? { excludeWorkers: options.excludeWorkers } : {}),
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
    ...(options.now ? { today: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.minOutputWords !== undefined ? { minOutputWords: options.minOutputWords } : {}),
    ...(options.relevanceThreshold !== undefined
      ? { relevanceThreshold: options.relevanceThreshold }
      : {}),
    ...(options.coverageThreshold !== undefined
      ? { coverageThreshold: options.coverageThreshold }
      : {}),
  };
  const scoreResult = scoreHistory(root, scoreOpts);

  // 2) Detect trends (arrows), unless suppressed. By default trends come from
  //    the in-memory rows we just scored over this window, so the snapshot and
  //    the arrows describe the same period and no persistence is required.
  //    `trendsFromDisk` opts into the full persisted history instead.
  let trendRowsRead = 0;
  let trends: TrendReport | undefined;
  if (!options.noTrends) {
    const detectOpts: DetectTrendsOptions = {
      ...(options.trendOptions ?? {}),
      ...(options.workers ? { workers: options.workers } : {}),
      ...(options.trendMetrics ? { metrics: options.trendMetrics } : {}),
    };
    if (options.trendsFromDisk) {
      const trendOpts: DetectTrendsFromDiskOptions = {
        ...detectOpts,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
        ...(options.now ? { today: options.now } : {}),
      };
      const trendResult = detectTrendsFromDisk(root, trendOpts);
      trends = trendResult.report;
      trendRowsRead = trendResult.rowsRead;
    } else {
      // Use the freshly-scored rows directly (no disk round-trip).
      trends = detectTrends(scoreResult.rows, detectOpts);
      trendRowsRead = scoreResult.rows.length;
    }
  }

  // 3) Aggregate snapshot + movement into the scorecard.
  const aggOpts: AggregateScorecardOptions = {
    ...(trends ? { trends } : {}),
    ...(window ? { window } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.healthyPassRate !== undefined ? { healthyPassRate: options.healthyPassRate } : {}),
    ...(options.watchPassRate !== undefined ? { watchPassRate: options.watchPassRate } : {}),
  };
  const scorecard = aggregateScorecard(scoreResult.scores, aggOpts);

  return {
    scorecard,
    scored: scoreResult.scored,
    failed: scoreResult.failed,
    errors: scoreResult.errors,
    trendRowsRead,
    window,
  };
}
