/**
 * Scorecard — type vocabulary + grading constants (Phase 3.5 Production Monitoring)
 *
 * The shared vocabulary for {@link aggregateScorecard} and its formatters, split
 * out so the pure aggregation engine (`scorecard-stats.ts`), the orchestration +
 * formatting surface (`scorecard.ts`), and the disk runner (`scorecard-runner.ts`)
 * all speak the same types without a cycle. This file holds **only** types and
 * the static grading/display constants — no logic, no IO.
 *
 * The orchestrator re-exports every public type below so consumers keep one
 * import path at `./scorecard.js`.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CheckName } from './scorer.js';
import type { TrendReport, TrendSeverity } from './trend-detector.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/**
 * Overall health grade for a worker, derived from its pass rate and whether any
 * trend is degrading. Coarser than the raw numbers on purpose — a grade is what
 * goes in the headline; the numbers are the drill-down.
 */
export type HealthGrade = 'healthy' | 'watch' | 'at-risk' | 'critical' | 'no-data';

/**
 * A single trend arrow glyph. The literal values are the rendered characters so
 * a formatter can splice them straight into a table without a lookup.
 */
export type TrendArrow = '↑' | '↓' | '→' | '·';

/** How a worker's overall health is moving, with the glyph and a label. */
export interface ScorecardTrend {
  /** The glyph to render. */
  arrow: TrendArrow;
  /** Machine-readable direction. `none` when there is no trend signal at all. */
  direction: 'improving' | 'degrading' | 'stable' | 'none';
  /** Worst degradation severity contributing to a down arrow, else `none`. */
  severity: TrendSeverity;
  /** Count of degrading (worker, check, metric) trends. */
  degrading: number;
  /** Count of improving trends. */
  improving: number;
  /** Human one-liner, e.g. "2 degrading, 1 improving". */
  summary: string;
}

/** Per-check roll-up within one worker: how a single check is performing. */
export interface CheckBreakdown {
  /** The check name, e.g. "completeness". */
  check: CheckName;
  /** Mean score for this check across the window, in [0, 1]. NaN if no data. */
  meanScore: number;
  /** Number of runs that exercised this check (non-skipped). */
  runs: number;
  /** How many of those runs failed this check. */
  fails: number;
  /** How many warned. */
  warns: number;
  /** How many passed. */
  passes: number;
}

/** A single failure category: a check and how many times it failed. */
export interface FailureCategory {
  /** The check that failed. */
  check: CheckName;
  /** Number of runs in which it failed. */
  count: number;
}

/**
 * One worker's complete scorecard line: a grade, a pass rate, the failure
 * breakdown, and a trend arrow. This is the atomic unit a reader scans.
 */
export interface WorkerScorecard {
  /** Worker name. */
  worker: string;
  /** Overall health grade. */
  grade: HealthGrade;
  /** Number of distinct runs scored in the window. */
  runs: number;
  /**
   * Pass rate in [0, 1]: fraction of scored runs with zero failing checks. NaN
   * when there were no runs. This is run-level (a run "passes" only if every
   * non-skipped check passed), which is stricter and more honest than a
   * check-level average.
   */
  passRate: number;
  /** Mean of every run's overall score, in [0, 1]. NaN if no runs. */
  meanScore: number;
  /** Worst single run's overall score in the window. NaN if no runs. */
  worstScore: number;
  /** Number of runs with at least one failing check. */
  runsWithFailures: number;
  /** Total failing-check occurrences across all runs. */
  totalFailures: number;
  /**
   * Failure categories: which checks failed and how often, worst (most
   * failures) first. The "what's breaking" column.
   */
  failureCategories: FailureCategory[];
  /** Per-check performance breakdown, worst mean score first. */
  checks: CheckBreakdown[];
  /** Trend arrow + detail. `direction: 'none'` when no trend report was supplied. */
  trend: ScorecardTrend;
  /** One-line human summary of this worker's line. */
  summary: string;
}

/** Fleet-wide totals across every worker on the scorecard. */
export interface ScorecardTotals {
  /** Number of workers represented. */
  workers: number;
  /** Total runs scored across all workers. */
  runs: number;
  /** Fleet pass rate: passing runs / total runs, in [0, 1]. NaN if no runs. */
  passRate: number;
  /** Mean overall score across all runs (every run weighted equally). NaN if none. */
  meanScore: number;
  /** Count of workers at each grade. */
  grades: Record<HealthGrade, number>;
  /** Total degrading trends across the fleet. */
  degradingTrends: number;
  /** Total improving trends across the fleet. */
  improvingTrends: number;
}

/** Top-level scorecard: per-worker lines + fleet totals. */
export interface Scorecard {
  /** Inclusive date window this scorecard covers, if one was applied. */
  window: { fromDate: string; toDate: string } | undefined;
  /** When the scorecard was generated (ISO-8601). */
  generatedAt: string;
  /** Per-worker lines, worst grade first. */
  workers: WorkerScorecard[];
  /** Fleet-wide totals. */
  totals: ScorecardTotals;
}

/** Options for {@link aggregateScorecard}. */
export interface AggregateScorecardOptions {
  /**
   * Trend report (from `detectTrends` / `detectTrendsFromDisk`) used to compute
   * the trend arrow per worker. Omit for a snapshot-only scorecard (every arrow
   * becomes `·` / `direction: 'none'`).
   */
  trends?: TrendReport;
  /** The inclusive date window covered, recorded verbatim on the result. */
  window?: { fromDate: string; toDate: string };
  /** Override the generation timestamp (testing). Default: now. */
  now?: Date;
  /**
   * Pass-rate floor (inclusive) at or above which a worker can be `healthy`,
   * assuming no degrading trend. Default: 0.9.
   */
  healthyPassRate?: number;
  /**
   * Pass-rate floor (inclusive) at or above which a worker is at worst `watch`
   * (below it, the worker is `at-risk`). Default: 0.6.
   */
  watchPassRate?: number;
}

/** Resolved grading thresholds passed to the pure engine. */
export interface ScorecardThresholds {
  /** Pass-rate floor for `healthy`. */
  healthy: number;
  /** Pass-rate floor for `watch` (below it ⇒ `at-risk`). */
  watch: number;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/** Default pass-rate floor (inclusive) for a `healthy` grade. */
export const DEFAULT_HEALTHY_PASS_RATE = 0.9;
/** Default pass-rate floor (inclusive) for a `watch` grade. */
export const DEFAULT_WATCH_PASS_RATE = 0.6;

/** Sort rank for grades: worst (0) first, so a scorecard leads with trouble. */
export const GRADE_RANK: Readonly<Record<HealthGrade, number>> = {
  critical: 0,
  'at-risk': 1,
  watch: 2,
  healthy: 3,
  'no-data': 4,
};

/** A zeroed grade tally, copied to seed {@link ScorecardTotals.grades}. */
export const EMPTY_GRADES: Readonly<Record<HealthGrade, number>> = {
  healthy: 0,
  watch: 0,
  'at-risk': 0,
  critical: 0,
  'no-data': 0,
};

/** Short label per grade for compact terminal/Markdown rendering. */
export const GRADE_LABEL: Readonly<Record<HealthGrade, string>> = {
  healthy: 'OK',
  watch: 'WATCH',
  'at-risk': 'RISK',
  critical: 'CRIT',
  'no-data': '--',
};

// Re-exported by `scorecard.ts` so consumers can `import type { TranscriptScore }`
// alongside the scorecard types from one path if they wish.
export type { CheckName, TranscriptScore } from './scorer.js';
