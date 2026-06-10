/**
 * Trend Detector — Phase 3.5 Production Monitoring
 *
 * Reads back the {@link CheckScore} rows the historical scorer wrote to
 * `transcripts/<worker>/scores.jsonl` and turns a pile of point-in-time scores
 * into a *direction*: is this worker getting better, holding steady, or rotting?
 *
 * Why this exists (the framework's thesis, applied): research-time safety !=
 * runtime safety. A worker can pass every check the day it ships and degrade
 * three weeks later — completeness creeping down, durations spiking, error rate
 * climbing — without any single run ever "failing" hard enough to notice. One
 * red run is an incident; a slow slide across twenty runs is rot, and rot is
 * exactly what point-in-time pass/fail misses. The trend detector is the smoke
 * alarm for the slow slide.
 *
 * Independence note (the core axis is independent -> corruptible): every input
 * here is a Tier 1 / Tier 2 score the worker never produced. We compare a
 * worker's *recent* runs against its *own baseline* — the agent didn't create
 * the baseline it's being measured against, which keeps the comparison honest.
 * No model-as-judge, no shared substrate: trend lines must be reproducible and
 * offline, or they are worse than no trend lines at all.
 *
 * Method (deliberately simple — explainable beats clever for a smoke alarm):
 *
 *   1. Bucket every score row by (worker, check).
 *   2. Within each bucket, sort by run start time and split the series into a
 *      *baseline* (older runs) and a *recent* (newer runs) segment.
 *   3. Compare the two segment means. The delta, scaled by the noise in the
 *      baseline, decides improving / stable / degrading and a severity.
 *
 * Direction-of-good: for the scores we emit, 1.0 is always best, so a falling
 * mean is degradation. But the detector is *direction-aware* by metric so it can
 * also reason about raw signals where higher is worse (duration, error count)
 * pulled from each row's `detail`. See {@link METRIC_DIRECTIONS}.
 *
 * Pipeline shape:
 *
 *     scores.jsonl
 *        |  readScores / readAllScores
 *        v
 *     CheckScore[]
 *        |  detectTrends
 *        v
 *     TrendReport  (per worker+check: direction, delta, severity, evidence)
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CheckScore } from './scorer.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

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

/** Top-level result of {@link detectTrends}. */
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

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

const DEFAULT_MIN_PER_SEGMENT = 2;
const DEFAULT_Z_THRESHOLD = 1.0;
const DEFAULT_MIN_DELTA = 0.05;
const DEFAULT_CRITICAL_Z = 2.5;

/** Cap z to keep zero-variance segments from producing +/-Infinity. */
const Z_CAP = 99;

const SEVERITY_RANK: Readonly<Record<TrendSeverity, number>> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

// ─── VALUE EXTRACTION ────────────────────────────────────────────────────────────

/**
 * Pull the metric value out of a score row. `score` reads the normalized score
 * field directly; everything else reads from `detail` (where the scorer stashed
 * `durationMs`, `errors`, `warnings`). `failRate` is synthesized per-row as 1
 * for a failed check and 0 otherwise, so its segment mean *is* the fail rate.
 *
 * Returns `undefined` when the metric isn't present on the row, so a metric the
 * scorer didn't record is skipped rather than charted as 0.
 */
export function extractMetric(row: CheckScore, metric: TrendMetric): number | undefined {
  if (metric === 'score') {
    return Number.isFinite(row.score) ? row.score : undefined;
  }
  if (metric === 'failRate') {
    return row.status === 'fail' ? 1 : 0;
  }
  const detail = row.detail;
  if (!detail) return undefined;
  const raw = detail[metric];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  // A sentinel -1 (the scorer's "unknown durationMs") is not a real value.
  if (metric === 'durationMs' && raw < 0) return undefined;
  return raw;
}

// ─── SEGMENT STATS ───────────────────────────────────────────────────────────────

const EMPTY_SEGMENT: SegmentStats = {
  count: 0,
  mean: Number.NaN,
  stdev: Number.NaN,
  min: Number.NaN,
  max: Number.NaN,
  firstMs: Number.NaN,
  lastMs: Number.NaN,
};

/** Compute summary statistics for a segment of trend points (assumed sorted). */
export function segmentStats(points: readonly TrendPoint[]): SegmentStats {
  if (points.length === 0) return { ...EMPTY_SEGMENT };
  const values = points.map((p) => p.value);
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  const stdev = Math.sqrt(variance);
  let min = values[0] as number;
  let max = values[0] as number;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    count: n,
    mean,
    stdev,
    min,
    max,
    firstMs: points[0]?.startedAtMs ?? Number.NaN,
    lastMs: points[n - 1]?.startedAtMs ?? Number.NaN,
  };
}

// ─── SPLITTING ───────────────────────────────────────────────────────────────────

/**
 * Split a chronologically-sorted point series into `[baseline, recent]`. The
 * baseline is the older portion, recent the newer. See
 * {@link DetectTrendsOptions.split} for the split modes.
 */
export function splitSeries(
  points: readonly TrendPoint[],
  split: 'half' | number,
): { baseline: TrendPoint[]; recent: TrendPoint[] } {
  const n = points.length;
  if (n === 0) return { baseline: [], recent: [] };

  let recentCount: number;
  if (split === 'half') {
    recentCount = Math.floor(n / 2);
  } else {
    const frac = Math.min(Math.max(split, 0), 1);
    recentCount = Math.round(n * frac);
  }
  // Keep at least one point on each side when we have >= 2 points overall.
  if (n >= 2) {
    recentCount = Math.min(Math.max(recentCount, 1), n - 1);
  }
  const cut = n - recentCount;
  return {
    baseline: points.slice(0, cut),
    recent: points.slice(cut),
  };
}

// ─── CLASSIFICATION ──────────────────────────────────────────────────────────────

interface ClassifyResult {
  direction: TrendDirection;
  severity: TrendSeverity;
  improved: boolean | undefined;
}

type ClassifyOptions = Required<
  Pick<DetectTrendsOptions, 'zThreshold' | 'minDelta' | 'criticalZ' | 'warningZ'>
>;

/**
 * Decide direction + severity from the segment deltas. The whole point of the
 * z-score is that "meaningful" is relative to a metric's own noise floor: a 0.1
 * drop on a metric that normally swings 0.3 is noise; the same drop on a
 * rock-steady metric is a real slide.
 */
function classify(
  delta: number,
  z: number,
  goodDirection: Direction,
  opts: ClassifyOptions,
  metric: TrendMetric,
): ClassifyResult {
  if (!Number.isFinite(delta)) {
    return { direction: 'insufficient-data', severity: 'none', improved: undefined };
  }

  const absZ = Math.abs(z);
  const absDelta = Math.abs(delta);

  // The raw-delta floor only meaningfully applies to score-units; for raw
  // signals (ms, counts) the z-test carries the weight.
  const meetsDelta = metric === 'score' ? absDelta >= opts.minDelta : true;
  const meetsZ = absZ >= opts.zThreshold;

  if (!meetsZ || !meetsDelta) {
    return { direction: 'stable', severity: 'none', improved: undefined };
  }

  // Did the value move in the good direction?
  const movedUp = delta > 0;
  const good = goodDirection === 'up' ? movedUp : !movedUp;

  if (good) {
    return { direction: 'improving', severity: 'none', improved: true };
  }

  // Degrading — grade the severity by z magnitude.
  let severity: TrendSeverity;
  if (absZ >= opts.criticalZ) severity = 'critical';
  else if (absZ >= opts.warningZ) severity = 'warning';
  else severity = 'info';

  return { direction: 'degrading', severity, improved: false };
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────────

function formatValue(metric: TrendMetric, v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (metric === 'durationMs') {
    const min = v / 60_000;
    return min >= 1 ? `${min.toFixed(1)}m` : `${Math.round(v / 1000)}s`;
  }
  if (metric === 'score' || metric === 'failRate') return v.toFixed(2);
  return String(Math.round(v * 100) / 100);
}

function buildSummary(t: Omit<Trend, 'summary'>): string {
  const label = `${t.worker}/${t.check}:${t.metric}`;
  if (t.direction === 'insufficient-data') {
    return `${label}: insufficient data (baseline=${t.baseline.count}, recent=${t.recent.count})`;
  }
  const from = formatValue(t.metric, t.baseline.mean);
  const to = formatValue(t.metric, t.recent.mean);
  const pct = Number.isFinite(t.relativeDelta) ? ` (${(t.relativeDelta * 100).toFixed(0)}%)` : '';
  const zStr = Number.isFinite(t.z) ? `, z=${t.z.toFixed(2)}` : '';

  if (t.direction === 'stable') {
    return `${label}: stable at ~${to}${zStr}`;
  }
  const arrow = t.delta > 0 ? 'up' : 'down';
  const verb = t.direction === 'improving' ? 'improving' : 'degrading';
  return `${label}: ${verb} (${arrow}) ${from}->${to}${pct}${zStr}`;
}

// ─── CORE ────────────────────────────────────────────────────────────────────────

type BuildOptions = Required<
  Pick<
    DetectTrendsOptions,
    'split' | 'minPerSegment' | 'zThreshold' | 'minDelta' | 'criticalZ' | 'warningZ'
  >
>;

function clampZ(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? Z_CAP : -Z_CAP;
  if (z > Z_CAP) return Z_CAP;
  if (z < -Z_CAP) return -Z_CAP;
  return z;
}

/** Build a single trend for one (worker, check, metric) point series. */
function buildTrend(
  worker: string,
  check: string,
  metric: TrendMetric,
  points: TrendPoint[],
  opts: BuildOptions,
): Trend {
  const goodDirection = METRIC_DIRECTIONS[metric];
  const sorted = [...points].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const { baseline: basePts, recent: recentPts } = splitSeries(sorted, opts.split);
  const baseline = segmentStats(basePts);
  const recent = segmentStats(recentPts);

  const enoughData = baseline.count >= opts.minPerSegment && recent.count >= opts.minPerSegment;

  let delta = Number.NaN;
  let relativeDelta = Number.NaN;
  let z = Number.NaN;
  let cls: ClassifyResult = {
    direction: 'insufficient-data',
    severity: 'none',
    improved: undefined,
  };

  if (enoughData) {
    delta = recent.mean - baseline.mean;
    relativeDelta = baseline.mean !== 0 ? delta / Math.abs(baseline.mean) : Number.NaN;
    if (baseline.stdev > 0) {
      z = clampZ(delta / baseline.stdev);
    } else {
      // Zero baseline spread: any real delta is "infinitely" significant. Use a
      // capped sentinel so it still trips thresholds without poisoning the math.
      z = delta === 0 ? 0 : clampZ(Math.sign(delta) * Z_CAP);
    }
    cls = classify(delta, z, goodDirection, opts, metric);
  }

  const partial: Omit<Trend, 'summary'> = {
    worker,
    check,
    metric,
    goodDirection,
    direction: cls.direction,
    severity: cls.severity,
    delta,
    relativeDelta,
    z,
    improved: cls.improved,
    baseline,
    recent,
    points: sorted,
  };

  return { ...partial, summary: buildSummary(partial) };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Detect degradation/improvement trends across a set of {@link CheckScore} rows
 * (typically read back from one or more `scores.jsonl` files).
 *
 * Rows are bucketed by `(worker, check)`, each bucket's chosen metric series is
 * split into baseline vs. recent, and the segment means are compared with a
 * noise-aware z-test. The result groups trends per worker, with degradations
 * surfaced worst-first so a cron caller can alert on the top of the list.
 *
 * The comparison is intentionally *within-worker, against its own history* —
 * the agent never produced the baseline it's measured against, so the signal
 * stays independent (Tier 1+2, no model-as-judge).
 *
 * @param rows - Score rows to analyze. Order does not matter; they're sorted
 *   chronologically per bucket internally.
 * @param options - Metric selection, split strategy, and thresholds.
 */
export function detectTrends(
  rows: readonly CheckScore[],
  options: DetectTrendsOptions = {},
): TrendReport {
  const metrics =
    options.metrics && options.metrics.length > 0 ? options.metrics : (['score'] as const);
  const zThreshold = options.zThreshold ?? DEFAULT_Z_THRESHOLD;
  const opts: BuildOptions = {
    split: options.split ?? 'half',
    minPerSegment: options.minPerSegment ?? DEFAULT_MIN_PER_SEGMENT,
    zThreshold,
    minDelta: options.minDelta ?? DEFAULT_MIN_DELTA,
    criticalZ: options.criticalZ ?? DEFAULT_CRITICAL_Z,
    warningZ: options.warningZ ?? zThreshold,
  };

  const workerFilter = options.workers ? new Set(options.workers.map((w) => w.toLowerCase())) : null;
  const checkFilter = options.checks ? new Set(options.checks) : null;

  // Bucket rows by worker -> check -> metric -> points, skipping rows that are
  // filtered out or that don't carry the metric in question.
  type Bucket = Map<TrendMetric, TrendPoint[]>;
  const byWorker = new Map<string, Map<string, Bucket>>();
  const runsByWorker = new Map<string, Set<string>>();
  let considered = 0;

  for (const row of rows) {
    if (workerFilter && !workerFilter.has(row.worker.toLowerCase())) continue;
    if (checkFilter && !checkFilter.has(row.check)) continue;
    considered += 1;

    let checks = byWorker.get(row.worker);
    if (!checks) {
      checks = new Map();
      byWorker.set(row.worker, checks);
    }
    let bucket = checks.get(row.check);
    if (!bucket) {
      bucket = new Map();
      checks.set(row.check, bucket);
    }

    let runs = runsByWorker.get(row.worker);
    if (!runs) {
      runs = new Set();
      runsByWorker.set(row.worker, runs);
    }
    runs.add(row.runId);

    for (const metric of metrics) {
      const value = extractMetric(row, metric);
      if (value === undefined) continue;
      const point: TrendPoint = {
        runId: row.runId,
        startedAtMs: row.startedAtMs,
        startedAt: row.startedAt,
        value,
      };
      const list = bucket.get(metric);
      if (list) list.push(point);
      else bucket.set(metric, [point]);
    }
  }

  // Build trends per bucket.
  const allTrends: Trend[] = [];
  const workerTrends: WorkerTrend[] = [];

  for (const [worker, checks] of byWorker) {
    const trends: Trend[] = [];
    for (const [check, bucket] of checks) {
      for (const metric of metrics) {
        const points = bucket.get(metric);
        if (!points || points.length === 0) continue;
        trends.push(buildTrend(worker, check, metric, points, opts));
      }
    }

    const degradations = trends
      .filter((t) => t.direction === 'degrading')
      .sort(compareBySeverityThenZ);
    const improvements = trends.filter((t) => t.direction === 'improving');
    const worstSeverity = degradations.reduce<TrendSeverity>(
      (worst, t) => (SEVERITY_RANK[t.severity] > SEVERITY_RANK[worst] ? t.severity : worst),
      'none',
    );

    trends.sort(compareTrendsForDisplay);
    workerTrends.push({
      worker,
      trends,
      degradations,
      improvements,
      worstSeverity,
      runCount: runsByWorker.get(worker)?.size ?? 0,
    });
    allTrends.push(...trends);
  }

  workerTrends.sort((a, b) => {
    const sev = SEVERITY_RANK[b.worstSeverity] - SEVERITY_RANK[a.worstSeverity];
    if (sev !== 0) return sev;
    return a.worker.localeCompare(b.worker);
  });

  const degradations = allTrends
    .filter((t) => t.direction === 'degrading')
    .sort(compareBySeverityThenZ);
  const worstSeverity = degradations.reduce<TrendSeverity>(
    (worst, t) => (SEVERITY_RANK[t.severity] > SEVERITY_RANK[worst] ? t.severity : worst),
    'none',
  );

  return {
    workers: workerTrends,
    trends: allTrends,
    degradations,
    worstSeverity,
    rowsConsidered: considered,
  };
}

/**
 * Convenience predicate: does a report contain any degradation at or above the
 * given severity? Handy for a cron caller deciding whether to raise an alert.
 *
 * @param report - A {@link TrendReport}.
 * @param minSeverity - Lowest severity that should count as alarming. Default:
 *   `'warning'` (so transient `info`-level wobble doesn't page anyone).
 */
export function hasDegradation(
  report: TrendReport,
  minSeverity: TrendSeverity = 'warning',
): boolean {
  const floor = SEVERITY_RANK[minSeverity];
  return report.degradations.some((t) => SEVERITY_RANK[t.severity] >= floor);
}

/**
 * Render a compact, human-readable digest of a trend report — the kind of
 * thing a cron worker drops into its status file or a Telegram alert. Lists the
 * worst degradations first, then a one-line per-worker health summary.
 *
 * @param report - A {@link TrendReport}.
 * @param options.maxDegradations - Cap the degradation list. Default: 10.
 */
export function formatTrendReport(
  report: TrendReport,
  options: { maxDegradations?: number } = {},
): string {
  const max = options.maxDegradations ?? 10;
  const lines: string[] = [];

  if (report.degradations.length === 0) {
    lines.push('Trends: no degradations detected.');
  } else {
    lines.push(`Trends: ${report.degradations.length} degradation(s), worst=${report.worstSeverity}`);
    for (const t of report.degradations.slice(0, max)) {
      lines.push(`  [${t.severity}] ${t.summary}`);
    }
    if (report.degradations.length > max) {
      lines.push(`  ... and ${report.degradations.length - max} more`);
    }
  }

  for (const w of report.workers) {
    const arrow = directionArrow(w);
    lines.push(
      `  ${arrow} ${w.worker}: ${w.degradations.length} degrading, ` +
        `${w.improvements.length} improving (${w.runCount} runs)`,
    );
  }

  return lines.join('\n');
}

/** Pick a single trend arrow summarizing a worker's overall direction. */
function directionArrow(w: WorkerTrend): string {
  if (w.degradations.length > w.improvements.length) return 'v';
  if (w.improvements.length > w.degradations.length) return '^';
  return '~';
}

function compareBySeverityThenZ(a: Trend, b: Trend): number {
  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  // Larger-magnitude move first.
  const za = Number.isFinite(a.z) ? Math.abs(a.z) : 0;
  const zb = Number.isFinite(b.z) ? Math.abs(b.z) : 0;
  if (zb !== za) return zb - za;
  return a.check.localeCompare(b.check) || a.metric.localeCompare(b.metric);
}

/** Display order within a worker: degrading, stable, improving, no-data; then name. */
function compareTrendsForDisplay(a: Trend, b: Trend): number {
  const rank: Record<TrendDirection, number> = {
    degrading: 0,
    stable: 1,
    improving: 2,
    'insufficient-data': 3,
  };
  const dir = rank[a.direction] - rank[b.direction];
  if (dir !== 0) return dir;
  if (a.direction === 'degrading') {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
  }
  return a.check.localeCompare(b.check) || a.metric.localeCompare(b.metric);
}