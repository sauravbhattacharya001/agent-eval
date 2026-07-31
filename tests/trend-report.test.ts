/**
 * Trend Report comparators — the display-ordering seam of `trend-report.ts`.
 *
 * `hasDegradation` and `formatTrendReport` are exercised end-to-end (over real
 * `detectTrends` output) in `trend-detector.test.ts`. This file fills the
 * remaining gap in that module: the three pure comparators that decide the
 * *order* trends appear in when rendered to a human —
 * {@link directionArrow}, {@link compareBySeverityThenZ}, and
 * {@link compareTrendsForDisplay}. They carry the tie-break and NaN-guard logic
 * a real report leans on (severity ties fall through to |z|, a jittery metric's
 * NaN z must not poison the sort, direction rank precedes severity, and check
 * then metric name is the final stable tie-break), none of which the
 * higher-level tests pin directly.
 *
 * These are Tier-1 pure functions (no disk, no model, deterministic). We build
 * minimal {@link Trend}/{@link WorkerTrend} fixtures carrying only the fields the
 * comparators read, so the tests document exactly what each ordering depends on.
 */

import { describe, expect, it } from 'vitest';

import type { Trend, TrendDirection, TrendSeverity, WorkerTrend } from '../src/monitoring/trend-detector.js';
import {
  compareBySeverityThenZ,
  compareTrendsForDisplay,
  directionArrow,
} from '../src/monitoring/trend-report.js';

// ─── FIXTURES ────────────────────────────────────────────────────────────────

/**
 * Build a {@link Trend} carrying only the fields the comparators inspect
 * (`severity`, `z`, `direction`, `check`, `metric`). The rest of the interface
 * is irrelevant to ordering, so we cast a partial rather than fabricate
 * meaningless segment stats — this keeps the fixtures honest about what the
 * sort actually depends on.
 */
function trend(over: {
  check?: string;
  metric?: Trend['metric'];
  severity?: TrendSeverity;
  z?: number;
  direction?: TrendDirection;
}): Trend {
  return {
    check: over.check ?? 'completeness',
    metric: over.metric ?? 'score',
    severity: over.severity ?? 'none',
    z: over.z ?? 0,
    direction: over.direction ?? 'stable',
  } as unknown as Trend;
}

/** Build a {@link WorkerTrend} carrying only the counts `directionArrow` reads. */
function worker(degrading: number, improving: number): WorkerTrend {
  return {
    degradations: Array.from({ length: degrading }, () => trend({ direction: 'degrading' })),
    improvements: Array.from({ length: improving }, () => trend({ direction: 'improving' })),
  } as unknown as WorkerTrend;
}

/** Sort a copy so the comparator's total ordering is asserted, not mutation. */
function ordered(trends: Trend[], cmp: (a: Trend, b: Trend) => number): string[] {
  return [...trends].sort(cmp).map((t) => `${t.check}:${t.metric}`);
}

// ─── directionArrow ──────────────────────────────────────────────────────────

describe('directionArrow', () => {
  it('points down when degradations outnumber improvements', () => {
    expect(directionArrow(worker(3, 1))).toBe('v');
  });

  it('points up when improvements outnumber degradations', () => {
    expect(directionArrow(worker(0, 2))).toBe('^');
  });

  it('is neutral on an even split (including all-quiet)', () => {
    expect(directionArrow(worker(2, 2))).toBe('~');
    expect(directionArrow(worker(0, 0))).toBe('~');
  });
});

// ─── compareBySeverityThenZ ──────────────────────────────────────────────────

describe('compareBySeverityThenZ', () => {
  it('orders by severity first, worst (critical) before milder', () => {
    const trends = [
      trend({ check: 'a', severity: 'warning', z: -1 }),
      trend({ check: 'b', severity: 'critical', z: -1 }),
      trend({ check: 'c', severity: 'info', z: -1 }),
    ];
    expect(ordered(trends, compareBySeverityThenZ)).toEqual(['b:score', 'a:score', 'c:score']);
  });

  it('breaks a severity tie by larger-magnitude move (|z|), sign-agnostic', () => {
    // Same severity: the bigger |z| move sorts first, whether z is + or -.
    const trends = [
      trend({ check: 'small', severity: 'warning', z: -1 }),
      trend({ check: 'bigneg', severity: 'warning', z: -4 }),
      trend({ check: 'bigpos', severity: 'warning', z: 3 }),
    ];
    // |−4| > |3| > |−1|
    expect(ordered(trends, compareBySeverityThenZ)).toEqual([
      'bigneg:score',
      'bigpos:score',
      'small:score',
    ]);
  });

  it('treats a non-finite z as magnitude 0 so it never jumps the queue', () => {
    const trends = [
      trend({ check: 'nan', severity: 'warning', z: Number.NaN }),
      trend({ check: 'real', severity: 'warning', z: -2 }),
    ];
    // NaN → 0 magnitude, so the real move sorts ahead of it.
    expect(ordered(trends, compareBySeverityThenZ)).toEqual(['real:score', 'nan:score']);
  });

  it('falls through to check then metric name when severity and |z| tie', () => {
    const trends = [
      trend({ check: 'zeta', metric: 'score', severity: 'warning', z: -2 }),
      trend({ check: 'alpha', metric: 'errors', severity: 'warning', z: -2 }),
      trend({ check: 'alpha', metric: 'durationMs', severity: 'warning', z: -2 }),
    ];
    // check asc, then metric asc for the two 'alpha' rows (durationMs < errors).
    expect(ordered(trends, compareBySeverityThenZ)).toEqual([
      'alpha:durationMs',
      'alpha:errors',
      'zeta:score',
    ]);
  });
});

// ─── compareTrendsForDisplay ─────────────────────────────────────────────────

describe('compareTrendsForDisplay', () => {
  it('ranks by direction: degrading, stable, improving, insufficient-data', () => {
    const trends = [
      trend({ check: 'imp', direction: 'improving' }),
      trend({ check: 'ins', direction: 'insufficient-data' }),
      trend({ check: 'deg', direction: 'degrading', severity: 'warning' }),
      trend({ check: 'sta', direction: 'stable' }),
    ];
    expect(ordered(trends, compareTrendsForDisplay)).toEqual([
      'deg:score',
      'sta:score',
      'imp:score',
      'ins:score',
    ]);
  });

  it('within degrading, orders by severity worst-first', () => {
    const trends = [
      trend({ check: 'warn', direction: 'degrading', severity: 'warning' }),
      trend({ check: 'crit', direction: 'degrading', severity: 'critical' }),
      trend({ check: 'info', direction: 'degrading', severity: 'info' }),
    ];
    expect(ordered(trends, compareTrendsForDisplay)).toEqual([
      'crit:score',
      'warn:score',
      'info:score',
    ]);
  });

  it('does not apply the severity tie-break for non-degrading directions', () => {
    // Two improving trends carry no meaningful severity; ordering falls straight
    // through to check then metric name, ignoring severity entirely.
    const trends = [
      trend({ check: 'zeta', direction: 'improving', severity: 'critical' }),
      trend({ check: 'alpha', direction: 'improving', severity: 'none' }),
    ];
    expect(ordered(trends, compareTrendsForDisplay)).toEqual(['alpha:score', 'zeta:score']);
  });

  it('breaks a same-direction, same-severity tie by check then metric', () => {
    const trends = [
      trend({ check: 'alpha', metric: 'score', direction: 'degrading', severity: 'warning' }),
      trend({ check: 'alpha', metric: 'errors', direction: 'degrading', severity: 'warning' }),
      trend({ check: 'beta', metric: 'score', direction: 'degrading', severity: 'warning' }),
    ];
    expect(ordered(trends, compareTrendsForDisplay)).toEqual([
      'alpha:errors',
      'alpha:score',
      'beta:score',
    ]);
  });
});
