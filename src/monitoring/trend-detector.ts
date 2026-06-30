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
 * Module layout (this file is the orchestration + reporting surface; the pieces
 * it drives live alongside it, re-exported here so consumers keep one import
 * path at `./trend-detector.js`):
 *
 *   - `./trend-detector-types.js` — the type vocabulary + {@link METRIC_DIRECTIONS}.
 *   - `./trend-stats.js`          — the pure `(points) -> Trend` scoring engine
 *                                   (extraction, segment stats, splitting,
 *                                   classification, summary).
 *   - this file                   — bucketing, the public {@link detectTrends}
 *                                   pipeline, and the report helpers
 *                                   ({@link hasDegradation}, {@link formatTrendReport}).
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
import {
  type Trend,
  type TrendMetric,
  type TrendSeverity,
  type TrendPoint,
  type TrendDirection,
  type WorkerTrend,
  type TrendReport,
  type DetectTrendsOptions,
} from './trend-detector-types.js';
import {
  buildTrend,
  extractMetric,
  SEVERITY_RANK,
  DEFAULT_MIN_PER_SEGMENT,
  DEFAULT_Z_THRESHOLD,
  DEFAULT_MIN_DELTA,
  DEFAULT_CRITICAL_Z,
  type BuildOptions,
} from './trend-stats.js';

// Re-export the type vocabulary + pure engine so consumers keep one import path.
export {
  METRIC_DIRECTIONS,
  type Direction,
  type TrendDirection,
  type TrendSeverity,
  type TrendMetric,
  type TrendPoint,
  type SegmentStats,
  type Trend,
  type WorkerTrend,
  type TrendReport,
  type DetectTrendsOptions,
} from './trend-detector-types.js';
export { extractMetric, segmentStats, splitSeries } from './trend-stats.js';

// ─── CORE ────────────────────────────────────────────────────────────────────────

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

// ─── REPORTING ───────────────────────────────────────────────────────────────────

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
