/**
 * Trend Detector — pure scoring engine (Phase 3.5 Production Monitoring).
 *
 * The deterministic math behind a single trend lives here, split off from the
 * orchestration/reporting surface in `./trend-detector.js` so the two can be
 * read, tested, and reasoned about independently. Nothing in this module does
 * IO, touches the network, or mutates its input — it is the pure
 * `(points) -> Trend` core that `detectTrends` drives once per
 * `(worker, check, metric)` bucket.
 *
 * The pipeline within one bucket:
 *
 *   1. {@link extractMetric}   — pull a metric value out of a score row.
 *   2. {@link splitSeries}     — split the chronological series into
 *                                `[baseline, recent]`.
 *   3. {@link segmentStats}    — summary stats (mean/stdev/min/max) per segment.
 *   4. {@link classify}        — direction + severity from the noise-aware
 *                                z-score (internal).
 *   5. {@link buildTrend}      — assemble the {@link Trend}, including its
 *                                {@link buildSummary | human one-liner}.
 *
 * Direction-of-good is per metric (see {@link METRIC_DIRECTIONS}): for the
 * scores we emit, 1.0 is best so a falling mean is degradation, but the engine
 * also reasons about raw signals where higher is worse (duration, error count).
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CheckScore } from './scorer.js';
import {
  METRIC_DIRECTIONS,
  type Direction,
  type SegmentStats,
  type Trend,
  type TrendDirection,
  type TrendMetric,
  type TrendPoint,
  type TrendSeverity,
  type DetectTrendsOptions,
} from './trend-detector-types.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/** Default minimum points required in each segment to compute a trend. */
export const DEFAULT_MIN_PER_SEGMENT = 2;
/** Default absolute z-threshold (in baseline stdevs) for a real move. */
export const DEFAULT_Z_THRESHOLD = 1.0;
/** Default minimum absolute raw delta (score-units) to fire on. */
export const DEFAULT_MIN_DELTA = 0.05;
/** Default z magnitude at which a degradation escalates to `critical`. */
export const DEFAULT_CRITICAL_Z = 2.5;

/** Cap z to keep zero-variance segments from producing +/-Infinity. */
const Z_CAP = 99;

/** Numeric rank of each severity, for ordering and worst-of reductions. */
export const SEVERITY_RANK: Readonly<Record<TrendSeverity, number>> = {
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

export type ClassifyOptions = Required<
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

/** Build the human-readable one-liner for a trend (everything but `summary`). */
export function buildSummary(t: Omit<Trend, 'summary'>): string {
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

// ─── BUILD ───────────────────────────────────────────────────────────────────────

export type BuildOptions = Required<
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
export function buildTrend(
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
