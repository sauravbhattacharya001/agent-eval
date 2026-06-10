/**
 * Tests for the Trend Detector - Phase 3.5 Production Monitoring.
 *
 * Covers the pure detector (detectTrends + its building blocks: extractMetric,
 * segmentStats, splitSeries, classification, severity, summaries) and the
 * filesystem-facing runner (detectTrendsFromDisk + filterRowsByDate) end to end
 * against a temp transcripts tree with real scores.jsonl files.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckScore, CheckName, ScoreStatus, ScoreTier } from '../src/monitoring/scorer.js';
import {
  detectTrends,
  extractMetric,
  segmentStats,
  splitSeries,
  hasDegradation,
  formatTrendReport,
  METRIC_DIRECTIONS,
} from '../src/monitoring/trend-detector.js';
import type { TrendPoint } from '../src/monitoring/trend-detector.js';
import { detectTrendsFromDisk, filterRowsByDate } from '../src/monitoring/trend-runner.js';
import { writeScoresByWorker } from '../src/monitoring/scores-store.js';

// ─── FIXTURE BUILDERS ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z

interface RowOverrides {
  worker?: string;
  check?: CheckName;
  tier?: ScoreTier;
  score?: number;
  status?: ScoreStatus;
  dayOffset?: number;
  detail?: Record<string, number | string | boolean>;
}

/** Build one CheckScore row. `dayOffset` advances the start time by N days. */
function row(o: RowOverrides = {}): CheckScore {
  const dayOffset = o.dayOffset ?? 0;
  const startedAtMs = BASE_MS + dayOffset * DAY_MS;
  const startedAt = new Date(startedAtMs).toISOString();
  const score = o.score ?? 1;
  const runId = `${startedAt.slice(0, 10)}-${String(1200 + dayOffset).padStart(4, '0')}`;
  return {
    worker: o.worker ?? 'builder',
    runId,
    startedAt,
    startedAtMs,
    check: o.check ?? 'completeness',
    tier: o.tier ?? 1,
    score,
    status: o.status ?? (score >= 0.7 ? 'pass' : score >= 0.4 ? 'warn' : 'fail'),
    summary: `${o.check ?? 'completeness'} = ${score}`,
    ...(o.detail ? { detail: o.detail } : {}),
    scoredAt: '2026-06-10T00:00:00.000Z',
  };
}

/** Build a chronological series of one check's scores; index i -> dayOffset i. */
function series(
  values: number[],
  base: Omit<RowOverrides, 'score' | 'dayOffset'> = {},
): CheckScore[] {
  return values.map((score, i) => row({ ...base, score, dayOffset: i }));
}

function point(value: number, ms: number, runId = `r${ms}`): TrendPoint {
  return { runId, value, startedAtMs: ms, startedAt: new Date(ms).toISOString() };
}

// ─── extractMetric ──────────────────────────────────────────────────────────────

describe('extractMetric', () => {
  it('reads the normalized score for the score metric', () => {
    expect(extractMetric(row({ score: 0.42 }), 'score')).toBe(0.42);
  });

  it('returns undefined for a non-finite score', () => {
    const r = row({ score: 1 });
    (r as { score: number }).score = Number.NaN;
    expect(extractMetric(r, 'score')).toBeUndefined();
  });

  it('synthesizes failRate as 1 for failed checks and 0 otherwise', () => {
    expect(extractMetric(row({ status: 'fail' }), 'failRate')).toBe(1);
    expect(extractMetric(row({ status: 'pass' }), 'failRate')).toBe(0);
    expect(extractMetric(row({ status: 'warn' }), 'failRate')).toBe(0);
    expect(extractMetric(row({ status: 'skip' }), 'failRate')).toBe(0);
  });

  it('pulls raw signals from detail', () => {
    const r = row({ detail: { durationMs: 90_000, errors: 2, warnings: 1 } });
    expect(extractMetric(r, 'durationMs')).toBe(90_000);
    expect(extractMetric(r, 'errors')).toBe(2);
    expect(extractMetric(r, 'warnings')).toBe(1);
  });

  it('returns undefined when detail is absent or lacks the key', () => {
    expect(extractMetric(row(), 'durationMs')).toBeUndefined();
    expect(extractMetric(row({ detail: { errors: 1 } }), 'durationMs')).toBeUndefined();
  });

  it('treats the durationMs -1 sentinel as unknown, not a value', () => {
    expect(extractMetric(row({ detail: { durationMs: -1 } }), 'durationMs')).toBeUndefined();
  });

  it('ignores non-numeric detail values', () => {
    expect(extractMetric(row({ detail: { errors: 'lots' } }), 'errors')).toBeUndefined();
  });
});

// ─── segmentStats ──────────────────────────────────────────────────────────────

describe('segmentStats', () => {
  it('returns an all-NaN, zero-count segment for empty input', () => {
    const s = segmentStats([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.stdev)).toBe(true);
  });

  it('computes mean, population stdev, min, max', () => {
    const s = segmentStats([point(1, 1), point(3, 2), point(5, 3)]);
    expect(s.count).toBe(3);
    expect(s.mean).toBeCloseTo(3, 10);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    // population variance of [1,3,5] about mean 3 = (4+0+4)/3 = 2.667
    expect(s.stdev).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(s.firstMs).toBe(1);
    expect(s.lastMs).toBe(3);
  });

  it('has zero stdev for a constant segment', () => {
    expect(segmentStats([point(0.8, 1), point(0.8, 2)]).stdev).toBe(0);
  });
});

// ─── splitSeries ──────────────────────────────────────────────────────────────

describe('splitSeries', () => {
  const pts = (n: number): TrendPoint[] => Array.from({ length: n }, (_, i) => point(i, i));

  it('splits in half (older baseline, newer recent) with even counts', () => {
    const { baseline, recent } = splitSeries(pts(4), 'half');
    expect(baseline.map((p) => p.value)).toEqual([0, 1]);
    expect(recent.map((p) => p.value)).toEqual([2, 3]);
  });

  it('puts the extra point in the baseline for odd counts', () => {
    const { baseline, recent } = splitSeries(pts(5), 'half');
    expect(baseline.map((p) => p.value)).toEqual([0, 1, 2]);
    expect(recent.map((p) => p.value)).toEqual([3, 4]);
  });

  it('keeps at least one point on each side for a 2-point series', () => {
    const { baseline, recent } = splitSeries(pts(2), 'half');
    expect(baseline).toHaveLength(1);
    expect(recent).toHaveLength(1);
  });

  it('supports a recent-fraction split', () => {
    const { baseline, recent } = splitSeries(pts(10), 0.3);
    expect(recent).toHaveLength(3);
    expect(baseline).toHaveLength(7);
    expect(recent.map((p) => p.value)).toEqual([7, 8, 9]);
  });

  it('clamps an out-of-range fraction', () => {
    const { baseline, recent } = splitSeries(pts(4), 5);
    // recent can't take all 4 — must leave at least one in baseline.
    expect(baseline).toHaveLength(1);
    expect(recent).toHaveLength(3);
  });

  it('returns empty segments for empty input', () => {
    const { baseline, recent } = splitSeries([], 'half');
    expect(baseline).toEqual([]);
    expect(recent).toEqual([]);
  });
});

// ─── detectTrends: classification ───────────────────────────────────────────────

describe('detectTrends - classification', () => {
  it('flags a clear downward slide in score as degrading (bad direction)', () => {
    const rows = series([0.95, 0.93, 0.96, 0.94, 0.6, 0.55, 0.5, 0.45]);
    const report = detectTrends(rows);
    const t = report.trends.find((x) => x.check === 'completeness' && x.metric === 'score');
    expect(t).toBeDefined();
    expect(t?.direction).toBe('degrading');
    expect(t?.improved).toBe(false);
    expect(t?.delta).toBeLessThan(0);
    expect(t?.severity === 'warning' || t?.severity === 'critical').toBe(true);
  });

  it('flags a clear upward climb in score as improving', () => {
    const rows = series([0.4, 0.45, 0.42, 0.44, 0.9, 0.92, 0.95, 0.93]);
    const t = detectTrends(rows).trends[0];
    expect(t.direction).toBe('improving');
    expect(t.improved).toBe(true);
    expect(t.delta).toBeGreaterThan(0);
    expect(t.severity).toBe('none');
  });

  it('reports a flat series as stable', () => {
    const report = detectTrends(series([0.9, 0.91, 0.9, 0.89, 0.9, 0.91, 0.9, 0.9]));
    expect(report.trends[0].direction).toBe('stable');
    expect(report.degradations).toHaveLength(0);
  });

  it('treats a sub-minDelta wobble as stable even if z is large', () => {
    const report = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.88, 0.88, 0.88, 0.88]), {
      minDelta: 0.05,
    });
    expect(report.trends[0].direction).toBe('stable');
  });

  it('escalates a large drop to critical via criticalZ', () => {
    const t = detectTrends(series([0.95, 0.95, 0.95, 0.95, 0.3, 0.3, 0.3, 0.3]), {
      criticalZ: 2.5,
    }).trends[0];
    expect(t.direction).toBe('degrading');
    expect(t.severity).toBe('critical');
  });

  it('writes a human-readable summary with an arrow and percentage', () => {
    const t = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.6, 0.6, 0.6, 0.6])).trends[0];
    expect(t.summary).toContain('degrading');
    expect(t.summary).toContain('0.90->0.60');
    expect(t.relativeDelta).toBeCloseTo(-1 / 3, 4);
  });
});

// ─── detectTrends: direction-aware raw metrics ──────────────────────────────────

describe('detectTrends - direction-aware raw metrics', () => {
  it('treats rising durationMs as degrading (down-is-good)', () => {
    const rows = [
      ...[0, 1, 2, 3].map((d) => row({ dayOffset: d, detail: { durationMs: 5 * 60_000 } })),
      ...[4, 5, 6, 7].map((d) => row({ dayOffset: d, detail: { durationMs: 40 * 60_000 } })),
    ];
    const t = detectTrends(rows, { metrics: ['durationMs'] }).trends.find(
      (x) => x.metric === 'durationMs',
    );
    expect(t?.goodDirection).toBe('down');
    expect(t?.direction).toBe('degrading');
    expect(t?.delta).toBeGreaterThan(0);
    expect(t?.improved).toBe(false);
  });

  it('treats falling durationMs as improving', () => {
    const rows = [
      ...[0, 1, 2, 3].map((d) => row({ dayOffset: d, detail: { durationMs: 40 * 60_000 } })),
      ...[4, 5, 6, 7].map((d) => row({ dayOffset: d, detail: { durationMs: 5 * 60_000 } })),
    ];
    const t = detectTrends(rows, { metrics: ['durationMs'] }).trends.find(
      (x) => x.metric === 'durationMs',
    );
    expect(t?.direction).toBe('improving');
    expect(t?.improved).toBe(true);
  });

  it('treats a rising fail rate as degrading', () => {
    const rows = [
      ...[0, 1, 2, 3].map((d) => row({ dayOffset: d, status: 'pass', score: 1 })),
      ...[4, 5, 6, 7].map((d) => row({ dayOffset: d, status: 'fail', score: 0 })),
    ];
    const t = detectTrends(rows, { metrics: ['failRate'] }).trends.find(
      (x) => x.metric === 'failRate',
    );
    expect(t?.direction).toBe('degrading');
    expect(t?.recent.mean).toBe(1);
    expect(t?.baseline.mean).toBe(0);
  });

  it('exposes a stable direction-of-good table', () => {
    expect(METRIC_DIRECTIONS.score).toBe('up');
    expect(METRIC_DIRECTIONS.durationMs).toBe('down');
    expect(METRIC_DIRECTIONS.errors).toBe('down');
    expect(METRIC_DIRECTIONS.failRate).toBe('down');
  });
});

// ─── detectTrends: edge cases ───────────────────────────────────────────────────

describe('detectTrends - edge cases', () => {
  it('reports insufficient-data when a segment is too small', () => {
    const t = detectTrends(series([0.9, 0.5]), { minPerSegment: 2 }).trends[0];
    expect(t.direction).toBe('insufficient-data');
    expect(Number.isNaN(t.delta)).toBe(true);
    expect(t.summary).toContain('insufficient data');
  });

  it('produces no trends at all for zero rows', () => {
    const report = detectTrends([]);
    expect(report.trends).toHaveLength(0);
    expect(report.workers).toHaveLength(0);
    expect(report.worstSeverity).toBe('none');
    expect(report.rowsConsidered).toBe(0);
  });

  it('honors a lowered minPerSegment', () => {
    const t = detectTrends(series([0.95, 0.4]), { minPerSegment: 1 }).trends[0];
    expect(t.direction).toBe('degrading');
  });

  it('still fires on a real drop when the baseline is perfectly flat', () => {
    const t = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.7, 0.7, 0.7, 0.7])).trends[0];
    expect(t.direction).toBe('degrading');
    expect(Number.isFinite(t.z)).toBe(true);
    expect(Math.abs(t.z)).toBeLessThanOrEqual(99);
  });

  it('stays stable when a flat baseline does not move', () => {
    const t = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9])).trends[0];
    expect(t.direction).toBe('stable');
    expect(t.z).toBe(0);
  });
});

// ─── detectTrends: bucketing and roll-ups ────────────────────────────────────────

describe('detectTrends - bucketing and roll-ups', () => {
  it('buckets independently per worker and per check', () => {
    const rows = [
      ...series([0.95, 0.95, 0.95, 0.95, 0.5, 0.5, 0.5, 0.5], {
        worker: 'builder',
        check: 'completeness',
      }),
      ...series([0.4, 0.4, 0.4, 0.4, 0.9, 0.9, 0.9, 0.9], {
        worker: 'builder',
        check: 'relevance',
        tier: 2,
      }),
      ...series([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], {
        worker: 'gardener',
        check: 'completeness',
      }),
    ];
    const report = detectTrends(rows);
    const builder = report.workers.find((w) => w.worker === 'builder');
    const gardener = report.workers.find((w) => w.worker === 'gardener');
    expect(builder?.trends).toHaveLength(2);
    expect(builder?.trends.find((t) => t.check === 'completeness')?.direction).toBe('degrading');
    expect(builder?.trends.find((t) => t.check === 'relevance')?.direction).toBe('improving');
    expect(gardener?.trends[0].direction).toBe('stable');
    expect(gardener?.degradations).toHaveLength(0);
  });

  it('counts distinct runs per worker', () => {
    expect(detectTrends(series([0.9, 0.9, 0.9, 0.9], { worker: 'sentinel' })).workers[0].runCount).toBe(
      4,
    );
  });

  it('orders workers by worst severity first', () => {
    const rows = [
      ...series([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], { worker: 'calm' }),
      ...series([0.95, 0.95, 0.95, 0.95, 0.25, 0.25, 0.25, 0.25], { worker: 'crashing' }),
    ];
    const report = detectTrends(rows);
    expect(report.workers[0].worker).toBe('crashing');
    expect(['critical', 'warning']).toContain(report.workers[0].worstSeverity);
  });

  it('surfaces a flat global degradations list, worst first', () => {
    // a/completeness: noisy baseline -> finite, smaller |z|.
    // b/relevance: flat baseline + bigger drop -> capped (huge) |z| => sorts worst-first.
    const rows = [
      ...series([0.95, 0.75, 0.95, 0.75, 0.7, 0.7, 0.7, 0.7], {
        worker: 'a',
        check: 'completeness',
      }),
      ...series([0.95, 0.95, 0.95, 0.95, 0.2, 0.2, 0.2, 0.2], {
        worker: 'b',
        check: 'relevance',
        tier: 2,
      }),
    ];
    const report = detectTrends(rows);
    expect(report.degradations.length).toBeGreaterThanOrEqual(2);
    expect(report.degradations[0].worker).toBe('b');
  });
});

// ─── detectTrends: filters and metrics ────────────────────────────────────────

describe('detectTrends - filters and metrics', () => {
  const mixed = [
    ...series([0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5], {
      worker: 'builder',
      check: 'completeness',
    }),
    ...series([0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5], {
      worker: 'gardener',
      check: 'completeness',
    }),
  ];

  it('restricts to requested workers', () => {
    const report = detectTrends(mixed, { workers: ['builder'] });
    expect(report.workers.map((w) => w.worker)).toEqual(['builder']);
    expect(report.rowsConsidered).toBe(8);
  });

  it('restricts to requested checks', () => {
    const rows = [
      ...series([0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5], { check: 'completeness' }),
      ...series([0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5], { check: 'staleness' }),
    ];
    const report = detectTrends(rows, { checks: ['staleness'] });
    expect(report.trends.every((t) => t.check === 'staleness')).toBe(true);
  });

  it('computes multiple metrics per bucket when requested', () => {
    const rows = [
      ...[0, 1, 2, 3].map((d) =>
        row({ dayOffset: d, score: 0.9, detail: { durationMs: 5 * 60_000 } }),
      ),
      ...[4, 5, 6, 7].map((d) =>
        row({ dayOffset: d, score: 0.5, detail: { durationMs: 40 * 60_000 } }),
      ),
    ];
    const report = detectTrends(rows, { metrics: ['score', 'durationMs'] });
    expect(report.trends.map((t) => t.metric).sort()).toEqual(['durationMs', 'score']);
    expect(report.trends.every((t) => t.direction === 'degrading')).toBe(true);
  });
});

// ─── hasDegradation + formatTrendReport ────────────────────────────────────────

describe('hasDegradation', () => {
  it('returns true when a degradation meets the severity floor', () => {
    const report = detectTrends(series([0.95, 0.95, 0.95, 0.95, 0.3, 0.3, 0.3, 0.3]));
    expect(hasDegradation(report, 'warning')).toBe(true);
  });

  it('returns false when nothing degrades', () => {
    const report = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.92, 0.92, 0.92, 0.92]));
    expect(hasDegradation(report)).toBe(false);
  });

  it('respects a critical-only floor', () => {
    // Noisy baseline + a modest drop -> a real but sub-critical (warning) slide.
    const report = detectTrends(
      series([0.95, 0.75, 0.95, 0.75, 0.72, 0.66, 0.72, 0.66]),
      { criticalZ: 5 },
    );
    expect(hasDegradation(report, 'warning')).toBe(true);
    expect(hasDegradation(report, 'critical')).toBe(false);
  });
});

describe('formatTrendReport', () => {
  it('reports a clean bill of health when nothing degrades', () => {
    const report = detectTrends(series([0.9, 0.9, 0.9, 0.9, 0.91, 0.91, 0.91, 0.91]));
    expect(formatTrendReport(report)).toContain('no degradations detected');
  });

  it('lists degradations worst-first with severity tags', () => {
    const rows = [
      ...series([0.95, 0.95, 0.95, 0.95, 0.2, 0.2, 0.2, 0.2], {
        worker: 'crashing',
        check: 'completeness',
      }),
      ...series([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], { worker: 'calm' }),
    ];
    const out = formatTrendReport(detectTrends(rows));
    expect(out).toContain('degradation(s)');
    expect(out).toMatch(/\[(critical|warning)\]/);
    expect(out).toContain('crashing');
    expect(out).toContain('calm');
  });
});

// ─── filterRowsByDate ────────────────────────────────────────────────────

describe('filterRowsByDate', () => {
  const rows = series([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]); // 2026-06-01 .. 06-08

  it('returns all rows when no bounds are given', () => {
    expect(filterRowsByDate(rows, undefined, undefined)).toHaveLength(8);
  });

  it('clips to an inclusive lower bound', () => {
    expect(filterRowsByDate(rows, '2026-06-05', undefined)).toHaveLength(4); // 05..08
  });

  it('clips to an inclusive upper bound', () => {
    expect(filterRowsByDate(rows, undefined, '2026-06-03')).toHaveLength(3); // 01..03
  });

  it('clips to a closed window', () => {
    expect(filterRowsByDate(rows, '2026-06-03', '2026-06-05')).toHaveLength(3); // 03..05
  });

  it('keeps rows whose date is indeterminate rather than dropping them', () => {
    const bad = row({ score: 0.9 });
    (bad as { startedAtMs: number }).startedAtMs = Number.NaN;
    (bad as { startedAt: string }).startedAt = '';
    expect(filterRowsByDate([bad], '2026-06-05', '2026-06-06')).toHaveLength(1);
  });
});

// ─── detectTrendsFromDisk (end-to-end) ────────────────────────────────────────

describe('detectTrendsFromDisk', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-eval-trends-'));
    const builder = series([0.95, 0.95, 0.95, 0.95, 0.4, 0.4, 0.4, 0.4], {
      worker: 'builder',
      check: 'completeness',
    });
    const gardener = series([0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.85], {
      worker: 'gardener',
      check: 'completeness',
    });
    writeScoresByWorker(root, [...builder, ...gardener], { mode: 'replace' });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads scores.jsonl back and detects the slide', () => {
    const { report, rowsRead, rowsWindowed } = detectTrendsFromDisk(root);
    expect(rowsRead).toBe(16);
    expect(rowsWindowed).toBe(16);
    expect(report.workers.find((w) => w.worker === 'builder')?.degradations.length).toBeGreaterThanOrEqual(
      1,
    );
    expect(report.workers.find((w) => w.worker === 'gardener')?.degradations).toHaveLength(0);
  });

  it('returns an empty report for a missing root', () => {
    const { report, rowsRead } = detectTrendsFromDisk(join(root, 'does-not-exist'));
    expect(rowsRead).toBe(0);
    expect(report.trends).toHaveLength(0);
  });

  it('applies a rolling date window relative to today', () => {
    // today = 2026-06-08; a 4-day window keeps 06-05..06-08 (the post-slide half).
    const today = new Date(Date.UTC(2026, 5, 8, 23, 0, 0));
    const res = detectTrendsFromDisk(root, { window: 4, today });
    expect(res.window).toEqual({ fromDate: '2026-06-05', toDate: '2026-06-08' });
    // Only the low-score recent rows survive -> fewer rows than the full history.
    expect(res.rowsWindowed).toBeLessThan(res.rowsRead);
    // The surviving builder rows are all 0.4 -> flat, so the trend is stable,
    // not a slide (the slide happened at the window's left edge, now excluded).
    const builder = res.report.workers.find((w) => w.worker === 'builder');
    expect(builder?.trends[0]?.direction).toBe('stable');
    expect(builder?.degradations).toHaveLength(0);
  });

  it('honors explicit from/to dates over a window', () => {
    const res = detectTrendsFromDisk(root, {
      window: 99,
      fromDate: '2026-06-01',
      toDate: '2026-06-02',
    });
    expect(res.window).toEqual({ fromDate: '2026-06-01', toDate: '2026-06-02' });
    expect(res.rowsWindowed).toBe(4); // 2 days x 2 workers
  });

  it('restricts reading to requested workers', () => {
    const res = detectTrendsFromDisk(root, { workers: ['builder'] });
    expect(res.report.workers.map((w) => w.worker)).toEqual(['builder']);
    expect(res.rowsRead).toBe(8);
  });
});
