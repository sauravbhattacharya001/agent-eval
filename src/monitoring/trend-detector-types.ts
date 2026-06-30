/**
 * Trend Detector — type vocabulary (Phase 3.5 Production Monitoring).
 *
 * The shared types for the trend detector live here so the pure scoring engine
 * (`./trend-stats.js`), the orchestration/reporting surface
 * (`./trend-detector.js`), and downstream consumers (`./scorecard.js`,
 * `./trend-runner.js`) can all depend on them without a cycle — mirroring the
 * established `*-types.ts` / `*.ts` seam used across `src/checks` and
 * `src/monitoring`. Re-exported from `./trend-detector.js`, so consumers keep a
 * single import path.
 *
 * Independence note (the core axis is independent → corruptible): every metric
 * named here is a Tier 1 / Tier 2 score the worker never produced — a check
 * score, a duration, an error count. A trend compares a worker's *recent* runs
 * against its *own baseline*, which the agent didn't create, keeping the
 * comparison honest. No model-as-judge, no shared substrate.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

/**
 * Which way is "good" for a metric. `up` means a rising value is an improvement
 * (e.g. a normalized check score); `down` means a rising value is a regression
 * (e.g. run duration, error count).
 */
export type Direction = 'up' | 'down';

/** Classification of how a metric is moving over the window. */
export type TrendDirection = 'improving' | 'stable' | 'degrading' | 'insufficient-data';

/** How alarming a degradation is. `none` for non-degrading trends. */
export type TrendSeverity = 'none' | 'info' | 'warning' | 'critical';

/**
 * Raw, direction-agnostic metrics a trend can be computed over. `score` is the
 * normalized check score (always up-is-good). The rest are pulled from a row's
 * `detail` map and reasoned about with their own direction-of-good.
 */
export type TrendMetric = 'score' | 'durationMs' | 'errors' | 'warnings' | 'failRate';

/** Direction-of-good for every supported metric. */
export const METRIC_DIRECTIONS: Readonly<Record<TrendMetric, Direction>> = {
  score: 'up',
  durationMs: 'down',
  errors: 'down',
  warnings: 'down',
  failRate: 'down',
};

/** A single observation feeding a trend: one value at one point in time. */
export interface TrendPoint {
  /** Run identifier (filename stem). */
  runId: string;
  /** Run start Unix-ms (the x-axis). */
  startedAtMs: number;
  /** Run start ISO-8601 (human-readable x-axis). */
  startedAt: string;
  /** The metric value at this point. */
  value: number;
}

/** Summary statistics for one segment (baseline or recent) of a series. */
export interface SegmentStats {
  /** Number of points in the segment. */
  count: number;
  /** Arithmetic mean of the segment values. NaN if empty. */
  mean: number;
  /** Population standard deviation of the segment values. NaN if empty. */
  stdev: number;
  /** Minimum value. NaN if empty. */
  min: number;
  /** Maximum value. NaN if empty. */
  max: number;
  /** First run's start (ms) in the segment. NaN if empty. */
  firstMs: number;
  /** Last run's start (ms) in the segment. NaN if empty. */
  lastMs: number;
}

/** A computed trend for one (worker, check, metric) triple. */
export interface Trend {
  /** Worker name. */
  worker: string;
  /** Check the metric came from, e.g. "completeness". */
  check: string;
  /** Which metric this trend tracks. */
  metric: TrendMetric;
  /** Direction-of-good for the metric. */
  goodDirection: Direction;
  /** Classification of the movement. */
  direction: TrendDirection;
  /** Severity of a degradation (`none` unless degrading). */
  severity: TrendSeverity;
  /**
   * Signed raw change: `recent.mean - baseline.mean`. Positive means the value
   * went up regardless of whether up is good. Use {@link Trend.improved} for
   * direction-aware semantics. NaN if either segment is empty.
   */
  delta: number;
  /**
   * Relative change as a fraction of the baseline mean (`delta / |baseline.mean|`).
   * NaN when the baseline mean is 0 or a segment is empty. Useful for percentage
   * framing ("durations up 40%").
   */
  relativeDelta: number;
  /**
   * Delta expressed in baseline-standard-deviations (a z-like score). This is
   * the noise-aware signal the classifier actually thresholds on, so a 0.05
   * wobble on a jittery metric isn't mistaken for a real slide. Capped to a
   * finite range; NaN when a segment is empty.
   */
  z: number;
  /**
   * True when the metric moved in the *good* direction by a meaningful amount,
   * false when it moved the bad way, undefined when it's effectively flat or
   * undecidable. Direction-aware (accounts for {@link Trend.goodDirection}).
   */
  improved: boolean | undefined;
  /** Baseline (older) segment statistics. */
  baseline: SegmentStats;
  /** Recent (newer) segment statistics. */
  recent: SegmentStats;
  /** All points used, oldest first (for charting / drill-down). */
  points: TrendPoint[];
  /** Human-readable one-liner describing the trend. */
  summary: string;
}

/** Per-worker roll-up of trends across all of its checks. */
export interface WorkerTrend {
  /** Worker name. */
  worker: string;
  /** Every trend computed for this worker (all checks x tracked metrics). */
  trends: Trend[];
  /** Trends classified as degrading, worst (highest severity) first. */
  degradations: Trend[];
  /** Trends classified as improving. */
  improvements: Trend[];
  /** Highest severity among this worker's degradations. */
  worstSeverity: TrendSeverity;
  /** Number of distinct runs that contributed any score. */
  runCount: number;
}

/** Top-level result of `detectTrends`. */
export interface TrendReport {
  /** Per-worker trend roll-ups, ordered by worst severity then name. */
  workers: WorkerTrend[];
  /** Flat list of every trend across all workers. */
  trends: Trend[];
  /** Flat list of every degrading trend, worst first. */
  degradations: Trend[];
  /** Highest severity observed anywhere in the report. */
  worstSeverity: TrendSeverity;
  /** Total score rows considered (after any pre-filtering). */
  rowsConsidered: number;
}

/** Options controlling trend detection. */
export interface DetectTrendsOptions {
  /**
   * Which metrics to compute trends for. Defaults to `['score']` — the headline
   * health signal. Add `'durationMs'`, `'errors'`, etc. to surface raw-signal
   * trends pulled from each row's `detail`.
   */
  metrics?: readonly TrendMetric[];
  /**
   * How to split each series into baseline vs. recent. `'half'` (default) puts
   * the older half in the baseline and the newer half in recent. A number in
   * (0, 1) is the fraction of points assigned to the *recent* segment (e.g. 0.3
   * -> newest 30% is "recent", oldest 70% is "baseline").
   */
  split?: 'half' | number;
  /**
   * Minimum points required in *each* segment to compute a trend. Below this the
   * trend is reported as `insufficient-data`. Default: 2.
   */
  minPerSegment?: number;
  /**
   * Absolute z-threshold (in baseline stdevs) a move must exceed to count as a
   * real trend rather than noise. Default: 1.0.
   */
  zThreshold?: number;
  /**
   * Minimum absolute raw delta required as well, so trends on near-constant
   * series with microscopic spread don't fire on rounding dust. Applied to the
   * `score` metric in score-units. Default: 0.05.
   */
  minDelta?: number;
  /**
   * z magnitude at which a degradation escalates to `critical`. Default: 2.5.
   */
  criticalZ?: number;
  /**
   * z magnitude at which a bad-way move registers as a `warning` (below it,
   * but still past {@link DetectTrendsOptions.zThreshold}, it's `info`).
   * Default: equal to {@link DetectTrendsOptions.zThreshold}.
   */
  warningZ?: number;
  /** Restrict to specific workers. */
  workers?: readonly string[];
  /** Restrict to specific checks. */
  checks?: readonly string[];
}
