/**
 * Trend Report Helpers — Phase 3.5 Production Monitoring
 *
 * The reporting/presentation seam extracted from `trend-detector.ts`. Given a
 * finished {@link TrendReport} (produced by `detectTrends`), these pure helpers
 * answer "should I alert?" ({@link hasDegradation}) and "how do I show this to a
 * human?" ({@link formatTrendReport}), plus the small comparators that order
 * trends worst-first for display.
 *
 * These functions never touch disk or a model — they only read a report that
 * was already computed from Tier 1/2 scores. They live apart from the detection
 * pipeline so the bucketing/orchestration in `trend-detector.ts` stays focused
 * on turning score rows into a report, and this file stays focused on rendering
 * one. Both are re-exported from `./trend-detector.js` so consumers keep a
 * single import path.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type {
  Trend,
  TrendDirection,
  TrendReport,
  TrendSeverity,
  WorkerTrend,
} from './trend-detector-types.js';
import { SEVERITY_RANK } from './trend-stats.js';

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
export function directionArrow(w: WorkerTrend): string {
  if (w.degradations.length > w.improvements.length) return 'v';
  if (w.improvements.length > w.degradations.length) return '^';
  return '~';
}

/** Sort degradations worst-first: severity, then magnitude of move, then name. */
export function compareBySeverityThenZ(a: Trend, b: Trend): number {
  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  // Larger-magnitude move first.
  const za = Number.isFinite(a.z) ? Math.abs(a.z) : 0;
  const zb = Number.isFinite(b.z) ? Math.abs(b.z) : 0;
  if (zb !== za) return zb - za;
  return a.check.localeCompare(b.check) || a.metric.localeCompare(b.metric);
}

/** Display order within a worker: degrading, stable, improving, no-data; then name. */
export function compareTrendsForDisplay(a: Trend, b: Trend): number {
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
