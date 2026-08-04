/**
 * Direct unit tests for the pure trend-scoring engine (`trend-stats.ts`).
 *
 * The end-to-end behaviour of these helpers is already exercised through
 * `detectTrends` in `trend-detector.test.ts`. This suite pins the engine at its
 * OWN module boundary — importing from `../src/monitoring/trend-stats.js`
 * directly — so the architecture seam introduced by splitting the detector is
 * load-bearing and independently covered: `buildTrend` is asserted directly
 * (the orchestrator only reaches it indirectly), and the exported tuning
 * defaults are pinned as a stable contract.
 */

import { describe, expect, it } from 'vitest';

import {
  buildTrend,
  segmentStats,
  splitSeries,
  extractMetric,
  SEVERITY_RANK,
  DEFAULT_MIN_PER_SEGMENT,
  DEFAULT_Z_THRESHOLD,
  DEFAULT_MIN_DELTA,
  DEFAULT_CRITICAL_Z,
  type BuildOptions,
} from '../src/monitoring/trend-stats.js';
import type { TrendPoint } from '../src/monitoring/trend-detector-types.js';
import type { CheckScore, CheckName, ScoreStatus } from '../src/monitoring/scorer.js';

// --- fixtures ---------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z

function point(value: number, dayOffset: number): TrendPoint {
  const startedAtMs = BASE_MS + dayOffset * DAY_MS;
  return {
    runId: `r${dayOffset}`,
    value,
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

function row(o: { score?: number; status?: ScoreStatus; check?: CheckName } = {}): CheckScore {
  const score = o.score ?? 1;
  return {
    worker: 'builder',
    runId: '2026-06-01-1200',
    startedAt: new Date(BASE_MS).toISOString(),
    startedAtMs: BASE_MS,
    check: o.check ?? 'completeness',
    tier: 1,
    score,
    status: o.status ?? 'pass',
    summary: 'fixture',
    scoredAt: '2026-06-10T00:00:00.000Z',
  };
}

/** The defaults `detectTrends` applies, so a direct buildTrend call matches it. */
const DEFAULT_BUILD_OPTS: BuildOptions = {
  split: 'half',
  minPerSegment: DEFAULT_MIN_PER_SEGMENT,
  zThreshold: DEFAULT_Z_THRESHOLD,
  minDelta: DEFAULT_MIN_DELTA,
  criticalZ: DEFAULT_CRITICAL_Z,
  warningZ: DEFAULT_Z_THRESHOLD,
};

/** A clean down-then-flat series: baseline ~1.0, recent ~0.5 (a real slide). */
function decliningScorePoints(): TrendPoint[] {
  return [point(1, 0), point(1, 1), point(0.5, 2), point(0.5, 3)];
}

// --- exported tuning contract ----------------------------------------------

describe('trend-stats exported defaults', () => {
  it('pins the tuning constants the public detector relies on', () => {
    expect(DEFAULT_MIN_PER_SEGMENT).toBe(2);
    expect(DEFAULT_Z_THRESHOLD).toBe(1.0);
    expect(DEFAULT_MIN_DELTA).toBe(0.05);
    expect(DEFAULT_CRITICAL_Z).toBe(2.5);
  });

  it('exposes a strictly ordered severity rank', () => {
    expect(SEVERITY_RANK.none).toBeLessThan(SEVERITY_RANK.info);
    expect(SEVERITY_RANK.info).toBeLessThan(SEVERITY_RANK.warning);
    expect(SEVERITY_RANK.warning).toBeLessThan(SEVERITY_RANK.critical);
  });
});

// --- buildTrend (direct) ----------------------------------------------------

describe('buildTrend (direct seam coverage)', () => {
  it('sorts unsorted points chronologically before splitting', () => {
    // Feed them newest-first; the engine must reorder to oldest-first.
    const shuffled = [point(0.5, 3), point(1, 0), point(0.5, 2), point(1, 1)];
    const t = buildTrend('builder', 'completeness', 'score', shuffled, DEFAULT_BUILD_OPTS);
    expect(t.points.map((p) => p.startedAtMs)).toEqual([
      BASE_MS,
      BASE_MS + DAY_MS,
      BASE_MS + 2 * DAY_MS,
      BASE_MS + 3 * DAY_MS,
    ]);
    // baseline = first two (1,1), recent = last two (0.5,0.5)
    expect(t.baseline.mean).toBe(1);
    expect(t.recent.mean).toBe(0.5);
  });

  it('classifies a real score drop as degrading with a signed delta and summary', () => {
    const t = buildTrend('builder', 'completeness', 'score', decliningScorePoints(), DEFAULT_BUILD_OPTS);
    expect(t.direction).toBe('degrading');
    expect(t.delta).toBeCloseTo(-0.5, 10);
    expect(t.improved).toBe(false);
    expect(t.goodDirection).toBe('up');
    // summary is direction-aware: down arrow + percentage + z.
    expect(t.summary).toContain('builder/completeness:score');
    expect(t.summary).toContain('degrading');
    expect(t.summary).toContain('down');
  });

  it('reports insufficient-data (NaN stats) when a segment is below minPerSegment', () => {
    const t = buildTrend('builder', 'completeness', 'score', [point(1, 0), point(0.4, 1)], {
      ...DEFAULT_BUILD_OPTS,
      minPerSegment: 2, // each side has only 1 point
    });
    expect(t.direction).toBe('insufficient-data');
    expect(Number.isNaN(t.delta)).toBe(true);
    expect(Number.isNaN(t.z)).toBe(true);
    expect(t.improved).toBeUndefined();
    expect(t.summary).toContain('insufficient data');
  });

  it('caps z to a finite sentinel when the baseline has zero spread', () => {
    // Perfectly flat baseline (stdev 0) then a real move -> z must be finite.
    const flatThenDrop = [point(1, 0), point(1, 1), point(0.2, 2), point(0.2, 3)];
    const t = buildTrend('builder', 'completeness', 'score', flatThenDrop, DEFAULT_BUILD_OPTS);
    expect(Number.isFinite(t.z)).toBe(true);
    expect(Math.abs(t.z)).toBeGreaterThan(DEFAULT_CRITICAL_Z);
    expect(t.severity).toBe('critical');
  });

  it('treats a rising duration as degrading (down-is-good metric)', () => {
    const rising = [point(1000, 0), point(1000, 1), point(5000, 2), point(5000, 3)];
    const t = buildTrend('builder', 'completeness', 'durationMs', rising, DEFAULT_BUILD_OPTS);
    expect(t.goodDirection).toBe('down');
    expect(t.direction).toBe('degrading');
    expect(t.delta).toBeGreaterThan(0); // value went UP, which is bad here
    expect(t.improved).toBe(false);
  });
});

// --- a couple of pure-helper edges not already pinned elsewhere -------------

describe('segmentStats / splitSeries edges', () => {
  it('keeps min/max distinct from mean on a spread segment', () => {
    const s = segmentStats([point(0, 0), point(1, 1)]);
    expect(s.min).toBe(0);
    expect(s.max).toBe(1);
    expect(s.mean).toBe(0.5);
    expect(s.firstMs).toBe(BASE_MS);
    expect(s.lastMs).toBe(BASE_MS + DAY_MS);
  });

  it('treats a fraction of 0 as an empty recent segment', () => {
    const pts = [point(1, 0), point(1, 1), point(1, 2)];
    const { baseline, recent } = splitSeries(pts, 0);
    // n>=2 clamps recent to at least 1 so a trend is still computable.
    expect(recent.length).toBe(1);
    expect(baseline.length).toBe(2);
  });
});

describe('extractMetric (direct)', () => {
  it('synthesizes failRate per row', () => {
    expect(extractMetric(row({ status: 'fail' }), 'failRate')).toBe(1);
    expect(extractMetric(row({ status: 'pass' }), 'failRate')).toBe(0);
  });

  it('returns undefined for a missing detail metric', () => {
    expect(extractMetric(row(), 'durationMs')).toBeUndefined();
  });
});

// --- extractMetric detail/sentinel branches -------------------------------

describe('extractMetric (detail + sentinel edges)', () => {
  function rowWith(detail: Record<string, number | string | boolean>): CheckScore {
    return { ...row(), detail };
  }

  it('reads a real numeric detail metric straight through', () => {
    expect(extractMetric(rowWith({ durationMs: 4200 }), 'durationMs')).toBe(4200);
  });

  it('treats the scorer -1 durationMs sentinel as unknown (undefined)', () => {
    // -1 is the scorer's "durationMs not recorded" marker, not a real 0ms run.
    expect(extractMetric(rowWith({ durationMs: -1 }), 'durationMs')).toBeUndefined();
  });

  it('skips a non-finite score rather than charting it', () => {
    expect(extractMetric(row({ score: Number.NaN }), 'score')).toBeUndefined();
  });

  it('skips a detail metric whose value is a non-number', () => {
    expect(extractMetric(rowWith({ errors: 'lots' as unknown as number }), 'errors')).toBeUndefined();
  });
});

// --- classify / buildSummary branches reached only via buildTrend ----------

describe('classify + buildSummary (direct seam edges)', () => {
  it('stays stable when a score move clears z but is below the minDelta floor', () => {
    // Tiny but perfectly consistent dip: z is large (zero-variance sides) yet the
    // absolute score delta (0.02) is under DEFAULT_MIN_DELTA (0.05) -> stable.
    const tinyDip = [point(1.0, 0), point(1.0, 1), point(0.98, 2), point(0.98, 3)];
    const t = buildTrend('builder', 'completeness', 'score', tinyDip, DEFAULT_BUILD_OPTS);
    expect(Math.abs(t.delta)).toBeCloseTo(0.02, 10);
    expect(t.direction).toBe('stable');
    expect(t.severity).toBe('none');
    expect(t.summary).toContain('stable at ~');
  });

  it('classifies a real score rise as improving with an up arrow in the summary', () => {
    const rising = [point(0.5, 0), point(0.5, 1), point(1.0, 2), point(1.0, 3)];
    const t = buildTrend('builder', 'completeness', 'score', rising, DEFAULT_BUILD_OPTS);
    expect(t.direction).toBe('improving');
    expect(t.improved).toBe(true);
    expect(t.severity).toBe('none');
    expect(t.summary).toContain('improving');
    expect(t.summary).toContain('up');
  });

  it('does NOT apply the minDelta floor to a raw (non-score) metric', () => {
    // A 2ms consistent rise is well under any score minDelta, but for durationMs
    // the z-test alone governs, so a zero-variance move still fires.
    const raw = [point(100, 0), point(100, 1), point(102, 2), point(102, 3)];
    const t = buildTrend('builder', 'completeness', 'durationMs', raw, DEFAULT_BUILD_OPTS);
    expect(t.direction).toBe('degrading');
  });

  it('formats a sub-minute duration mean in seconds in the summary', () => {
    const sec = [point(2000, 0), point(2000, 1), point(9000, 2), point(9000, 3)];
    const t = buildTrend('builder', 'completeness', 'durationMs', sec, DEFAULT_BUILD_OPTS);
    expect(t.summary).toMatch(/\ds->/); // baseline mean 2s -> ...
    expect(t.summary).toContain('9s');
  });

  it('formats a multi-minute duration mean in minutes in the summary', () => {
    const mins = [point(120_000, 0), point(120_000, 1), point(360_000, 2), point(360_000, 3)];
    const t = buildTrend('builder', 'completeness', 'durationMs', mins, DEFAULT_BUILD_OPTS);
    expect(t.summary).toContain('2.0m');
    expect(t.summary).toContain('6.0m');
  });
});

// --- segmentStats / splitSeries: remaining pure edges ----------------------

describe('segmentStats / splitSeries (remaining pure edges)', () => {
  it('returns an all-NaN empty segment for zero points', () => {
    const s = segmentStats([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.mean)).toBe(true);
    expect(Number.isNaN(s.stdev)).toBe(true);
    expect(Number.isNaN(s.min)).toBe(true);
    expect(Number.isNaN(s.max)).toBe(true);
    expect(Number.isNaN(s.firstMs)).toBe(true);
  });

  it("splits an odd series in 'half' mode with the extra point in baseline", () => {
    // n=5, floor(5/2)=2 recent -> baseline 3 / recent 2.
    const pts = [point(1, 0), point(1, 1), point(1, 2), point(1, 3), point(1, 4)];
    const { baseline, recent } = splitSeries(pts, 'half');
    expect(baseline.length).toBe(3);
    expect(recent.length).toBe(2);
  });

  it('keeps one point on each side of a 2-point series', () => {
    const pts = [point(1, 0), point(0, 1)];
    const { baseline, recent } = splitSeries(pts, 'half');
    expect(baseline.length).toBe(1);
    expect(recent.length).toBe(1);
  });

  it('returns two empty segments for an empty series', () => {
    const { baseline, recent } = splitSeries([], 'half');
    expect(baseline.length).toBe(0);
    expect(recent.length).toBe(0);
  });
});