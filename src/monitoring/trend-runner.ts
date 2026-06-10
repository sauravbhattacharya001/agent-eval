/**
 * Trend Runner — orchestrates read -> detect for transcript scores.
 *
 * The one-call entry point a cron worker (or the CLI) uses to ask "is anything
 * rotting?" against the `scores.jsonl` files the historical scorer wrote:
 *
 *     detectTrendsFromDisk('.../transcripts', { window: 7, metrics: ['score', 'durationMs'] })
 *
 * It sits *above* the pure detector ({@link detectTrends}) and the pure store
 * (`scores-store.ts`) so each of those stays independently testable. The runner
 * just wires them to the filesystem: read every worker's score rows back,
 * optionally clip to a rolling window, hand them to the detector.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import { rollingWindow } from './discovery.js';
import type { CheckScore } from './scorer.js';
import { readAllScores } from './scores-store.js';
import { detectTrends } from './trend-detector.js';
import type { DetectTrendsOptions, TrendReport } from './trend-detector.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Options for {@link detectTrendsFromDisk}. */
export interface DetectTrendsFromDiskOptions extends DetectTrendsOptions {
  /**
   * Convenience: only consider score rows whose run started within the trailing
   * `window` calendar days (relative to {@link DetectTrendsFromDiskOptions.today}).
   * Omit to use the entire score history. Overridden by explicit from/to dates.
   */
  window?: number;
  /** Reference "today" for {@link DetectTrendsFromDiskOptions.window}. Default: now. */
  today?: Date;
  /** Inclusive `YYYY-MM-DD` lower bound on run date (overrides window's lower bound). */
  fromDate?: string;
  /** Inclusive `YYYY-MM-DD` upper bound on run date (overrides window's upper bound). */
  toDate?: string;
}

/** Result of {@link detectTrendsFromDisk}. */
export interface DetectTrendsFromDiskResult {
  /** The trend report produced from the on-disk scores. */
  report: TrendReport;
  /** Number of score rows read from disk before any windowing. */
  rowsRead: number;
  /** Number of rows that survived date windowing and were fed to the detector. */
  rowsWindowed: number;
  /** The resolved inclusive date window, if any was applied. */
  window: { fromDate: string; toDate: string } | undefined;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

/** ISO date `YYYY-MM-DD` from a row's start timestamp (UTC), or '' if unknown. */
function rowDate(row: CheckScore): string {
  if (Number.isFinite(row.startedAtMs)) {
    return new Date(row.startedAtMs).toISOString().slice(0, 10);
  }
  // Fall back to the ISO string prefix if the ms field is absent.
  return typeof row.startedAt === 'string' ? row.startedAt.slice(0, 10) : '';
}

/**
 * Clip score rows to an inclusive `[fromDate, toDate]` date window. Rows whose
 * date can't be determined are kept (better to over-include than silently drop
 * data from a malformed row).
 */
export function filterRowsByDate(
  rows: readonly CheckScore[],
  fromDate: string | undefined,
  toDate: string | undefined,
): CheckScore[] {
  if (!fromDate && !toDate) return [...rows];
  return rows.filter((row) => {
    const d = rowDate(row);
    if (!d) return true;
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Read every worker's `scores.jsonl` under a transcripts root, optionally clip
 * to a rolling date window, and run {@link detectTrends} over the result.
 *
 * This is what the twice-daily cron calls right after `scoreHistory`: score the
 * fresh transcripts, then check whether the rolling trend is sliding. Pure
 * read-side — it never writes anything.
 *
 * @param root - Transcripts root containing per-worker subdirectories.
 * @param options - Windowing + detection thresholds.
 */
export function detectTrendsFromDisk(
  root: string,
  options: DetectTrendsFromDiskOptions = {},
): DetectTrendsFromDiskResult {
  const allRows = readAllScores(root, options.workers as readonly string[] | undefined);

  // Resolve the date window: explicit from/to wins, else derive from `window`.
  let fromDate = options.fromDate;
  let toDate = options.toDate;
  if (options.window !== undefined && fromDate === undefined && toDate === undefined) {
    const win = rollingWindow(options.window, options.today ?? new Date());
    fromDate = win.fromDate;
    toDate = win.toDate;
  }

  const windowed = filterRowsByDate(allRows, fromDate, toDate);

  // Forward only the detector-relevant options (strip the runner-only fields).
  const detectOpts: DetectTrendsOptions = {
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.split !== undefined ? { split: options.split } : {}),
    ...(options.minPerSegment !== undefined ? { minPerSegment: options.minPerSegment } : {}),
    ...(options.zThreshold !== undefined ? { zThreshold: options.zThreshold } : {}),
    ...(options.minDelta !== undefined ? { minDelta: options.minDelta } : {}),
    ...(options.criticalZ !== undefined ? { criticalZ: options.criticalZ } : {}),
    ...(options.warningZ !== undefined ? { warningZ: options.warningZ } : {}),
    ...(options.workers ? { workers: options.workers } : {}),
    ...(options.checks ? { checks: options.checks } : {}),
  };

  const report = detectTrends(windowed, detectOpts);

  return {
    report,
    rowsRead: allRows.length,
    rowsWindowed: windowed.length,
    window: fromDate || toDate ? { fromDate: fromDate ?? '', toDate: toDate ?? '' } : undefined,
  };
}
