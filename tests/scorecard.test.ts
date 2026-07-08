/**
 * Tests for the Weekly Scorecard - Phase 3.5 Production Monitoring.
 *
 * Two layers, matching the module split:
 *   1. The pure aggregator (aggregateScorecard + formatScorecard /
 *      formatScorecardMarkdown) against hand-built TranscriptScore and
 *      TrendReport fixtures - exercises grading, pass-rate math, failure
 *      categories, trend arrows, sorting, totals, and both renderers.
 *   2. The filesystem runner (buildScorecard) end to end against a temp
 *      transcripts tree of real markdown files, confirming the score pass and
 *      the trend pass are wired together over one shared window.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckName, CheckScore, ScoreStatus, TranscriptScore } from '../src/monitoring/scorer.js';
import {
  aggregateScorecard,
  formatScorecard,
  formatScorecardMarkdown,
} from '../src/monitoring/scorecard.js';
import { buildScorecard } from '../src/monitoring/scorecard-runner.js';
import type { Trend, TrendReport, TrendSeverity, WorkerTrend } from '../src/monitoring/trend-detector.js';

// ─── FIXTURE BUILDERS (pure aggregator) ─────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00Z
const FIXED_NOW = new Date('2026-06-10T00:00:00.000Z');

interface CheckSpec {
  check: CheckName;
  score: number;
  status: ScoreStatus;
}

/** Build one CheckScore from a spec, at a given run offset. */
function check(spec: CheckSpec, worker: string, runId: string, ms: number): CheckScore {
  return {
    worker,
    runId,
    startedAt: new Date(ms).toISOString(),
    startedAtMs: ms,
    check: spec.check,
    tier: spec.check === 'verification' || spec.check === 'verification' ? 2 : 1,
    score: spec.score,
    status: spec.status,
    summary: `${spec.check}=${spec.score}`,
    scoredAt: FIXED_NOW.toISOString(),
  };
}

/**
 * Build a TranscriptScore for `worker` at day `dayOffset` with the given check
 * specs. The roll-up fields (overall/worst/failCount/warnCount) are derived the
 * same way the real scorer derives them, so fixtures stay faithful.
 */
function transcriptScore(
  worker: string,
  dayOffset: number,
  specs: CheckSpec[],
  reportedOutcome = 'pass',
): TranscriptScore {
  const ms = BASE_MS + dayOffset * DAY_MS;
  const runId = `${new Date(ms).toISOString().slice(0, 10)}-${String(1200 + dayOffset).padStart(4, '0')}`;
  const checks = specs.map((s) => check(s, worker, runId, ms));
  const scored = checks.filter((c) => c.status !== 'skip');
  const overall = scored.length > 0 ? scored.reduce((a, c) => a + c.score, 0) / scored.length : Number.NaN;
  const worst = scored.length > 0 ? Math.min(...scored.map((c) => c.score)) : Number.NaN;
  return {
    worker,
    runId,
    startedAt: new Date(ms).toISOString(),
    startedAtMs: ms,
    reportedOutcome,
    checks,
    overall,
    worst,
    failCount: checks.filter((c) => c.status === 'fail').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
  };
}

/** A clean run: every check passes. */
function passingRun(worker: string, dayOffset: number): TranscriptScore {
  return transcriptScore(worker, dayOffset, [
    { check: 'staleness', score: 1, status: 'pass' },
    { check: 'completeness', score: 1, status: 'pass' },
    { check: 'verification', score: 0.5, status: 'pass' },
  ]);
}

/** A run with a failing check (completeness by default). */
function failingRun(worker: string, dayOffset: number, failed: CheckName = 'completeness'): TranscriptScore {
  return transcriptScore(
    worker,
    dayOffset,
    [
      { check: 'staleness', score: 1, status: 'pass' },
      { check: failed, score: 0, status: 'fail' },
      { check: 'verification', score: 0.5, status: 'pass' },
    ],
    'partial',
  );
}

/** Build a minimal WorkerTrend roll-up with chosen degradation/improvement counts. */
function workerTrend(
  worker: string,
  degrading: number,
  improving: number,
  worstSeverity: TrendSeverity = 'warning',
): WorkerTrend {
  const mk = (direction: Trend['direction'], severity: TrendSeverity): Trend =>
    ({
      worker,
      check: 'completeness',
      metric: 'score',
      goodDirection: 'up',
      direction,
      severity,
      delta: direction === 'degrading' ? -0.3 : 0.3,
      relativeDelta: -0.3,
      z: direction === 'degrading' ? -2 : 2,
      improved: direction === 'improving',
      baseline: { count: 3, mean: 0.9, stdev: 0.1, min: 0.8, max: 1, firstMs: BASE_MS, lastMs: BASE_MS },
      recent: { count: 3, mean: 0.6, stdev: 0.1, min: 0.5, max: 0.7, firstMs: BASE_MS, lastMs: BASE_MS },
      points: [],
      summary: `${worker}/completeness:score ${direction}`,
    }) as Trend;

  const degradations = Array.from({ length: degrading }, () => mk('degrading', worstSeverity));
  const improvements = Array.from({ length: improving }, () => mk('improving', 'none'));
  return {
    worker,
    trends: [...degradations, ...improvements],
    degradations,
    improvements,
    worstSeverity: degrading > 0 ? worstSeverity : 'none',
    runCount: 6,
  };
}

/** Assemble a TrendReport from a set of WorkerTrends. */
function trendReport(workers: WorkerTrend[]): TrendReport {
  const degradations = workers.flatMap((w) => w.degradations);
  const rank: Record<TrendSeverity, number> = { none: 0, info: 1, warning: 2, critical: 3 };
  const worstSeverity = degradations.reduce<TrendSeverity>(
    (worst, t) => (rank[t.severity] > rank[worst] ? t.severity : worst),
    'none',
  );
  return {
    workers,
    trends: workers.flatMap((w) => w.trends),
    degradations,
    worstSeverity,
    rowsConsidered: workers.reduce((a, w) => a + w.runCount, 0),
  };
}

// ─── aggregateScorecard: pass-rate + grading ────────────────────────────────────

describe('aggregateScorecard - grading & pass rate', () => {
  it('grades an all-passing worker as healthy with 100% pass rate', () => {
    const scores = [passingRun('builder', 0), passingRun('builder', 1), passingRun('builder', 2)];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });

    expect(card.workers).toHaveLength(1);
    const w = card.workers[0]!;
    expect(w.worker).toBe('builder');
    expect(w.grade).toBe('healthy');
    expect(w.runs).toBe(3);
    expect(w.passRate).toBe(1);
    expect(w.runsWithFailures).toBe(0);
    expect(w.totalFailures).toBe(0);
    expect(w.failureCategories).toEqual([]);
  });

  it('computes a run-level pass rate (a run with any failing check is not a pass)', () => {
    const scores = [
      passingRun('gardener', 0),
      passingRun('gardener', 1),
      failingRun('gardener', 2),
      failingRun('gardener', 3),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    const w = card.workers[0]!;
    expect(w.passRate).toBe(0.5);
    expect(w.runsWithFailures).toBe(2);
    expect(w.totalFailures).toBe(2);
    // 50% pass < 0.6 watch floor => at-risk.
    expect(w.grade).toBe('at-risk');
  });

  it('grades a mostly-passing worker (between watch and healthy floors) as watch', () => {
    // 7/10 pass = 0.7: >= 0.6 (watch) but < 0.9 (healthy).
    const scores = [
      ...Array.from({ length: 7 }, (_, i) => passingRun('sentinel', i)),
      ...Array.from({ length: 3 }, (_, i) => failingRun('sentinel', 7 + i)),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    expect(card.workers[0]!.grade).toBe('watch');
    expect(card.workers[0]!.passRate).toBe(0.7);
  });

  it('honours custom healthy/watch thresholds', () => {
    const scores = [
      ...Array.from({ length: 7 }, (_, i) => passingRun('eval', i)),
      ...Array.from({ length: 3 }, (_, i) => failingRun('eval', 7 + i)),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW, healthyPassRate: 0.7 });
    expect(card.workers[0]!.grade).toBe('healthy');
  });

  it('marks a worker with no finite scores as no-data', () => {
    const ts = transcriptScore('blog', 0, [{ check: 'verification', score: 0, status: 'skip' }]);
    const card = aggregateScorecard([ts], { now: FIXED_NOW });
    const w = card.workers[0]!;
    expect(w.grade).toBe('no-data');
    expect(Number.isNaN(w.passRate)).toBe(true);
  });
});

// ─── aggregateScorecard: failure categories & check breakdown ────────────────────

describe('aggregateScorecard - failure categories & breakdown', () => {
  it('tallies failure categories worst-first', () => {
    const scores = [
      failingRun('builder', 0, 'completeness'),
      failingRun('builder', 1, 'completeness'),
      failingRun('builder', 2, 'verification'),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    const cats = card.workers[0]!.failureCategories;
    expect(cats[0]).toEqual({ check: 'completeness', count: 2 });
    expect(cats[1]).toEqual({ check: 'verification', count: 1 });
  });

  it('builds a per-check breakdown sorted by worst mean score', () => {
    const scores = [
      transcriptScore('gardener', 0, [
        { check: 'staleness', score: 1, status: 'pass' },
        { check: 'completeness', score: 0.2, status: 'fail' },
        { check: 'verification', score: 0.8, status: 'pass' },
      ]),
      transcriptScore('gardener', 1, [
        { check: 'staleness', score: 1, status: 'pass' },
        { check: 'completeness', score: 0.4, status: 'warn' },
        { check: 'verification', score: 0.6, status: 'pass' },
      ]),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    const checks = card.workers[0]!.checks;
    // completeness has the lowest mean (0.3) so it sorts first.
    expect(checks[0]!.check).toBe('completeness');
    expect(checks[0]!.meanScore).toBeCloseTo(0.3, 5);
    expect(checks[0]!.fails).toBe(1);
    expect(checks[0]!.warns).toBe(1);
    // staleness is perfect, sorts last.
    expect(checks[checks.length - 1]!.check).toBe('staleness');
    expect(checks[checks.length - 1]!.meanScore).toBe(1);
  });

  it('excludes skipped checks from the breakdown', () => {
    const scores = [
      transcriptScore('eval', 0, [
        { check: 'completeness', score: 1, status: 'pass' },
        { check: 'verification', score: 0, status: 'skip' },
      ]),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    expect(card.workers[0]!.checks.map((c) => c.check)).toEqual(['completeness']);
  });

  it('tracks mean and worst overall score per worker', () => {
    const scores = [passingRun('builder', 0), failingRun('builder', 1)];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    const w = card.workers[0]!;
    // passing overall = (1+1+0.5)/3 = 0.8333; failing overall = (1+0+0.5)/3 = 0.5.
    expect(w.meanScore).toBeCloseTo((0.8333 + 0.5) / 2, 2);
    expect(w.worstScore).toBeCloseTo(0.5, 4);
  });
});

// ─── aggregateScorecard: trend arrows ────────────────────────────────────────

describe('aggregateScorecard - trend arrows', () => {
  it('assigns a down arrow when degradations outnumber improvements', () => {
    const scores = [passingRun('builder', 0), passingRun('builder', 1)];
    const trends = trendReport([workerTrend('builder', 2, 0, 'warning')]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    const w = card.workers[0]!;
    expect(w.trend.arrow).toBe('↓');
    expect(w.trend.direction).toBe('degrading');
    expect(w.trend.degrading).toBe(2);
    expect(w.trend.severity).toBe('warning');
  });

  it('assigns an up arrow when improvements outnumber degradations', () => {
    const scores = [passingRun('gardener', 0), passingRun('gardener', 1)];
    const trends = trendReport([workerTrend('gardener', 0, 3)]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    const w = card.workers[0]!;
    expect(w.trend.arrow).toBe('↑');
    expect(w.trend.direction).toBe('improving');
    expect(w.trend.severity).toBe('none');
  });

  it('assigns a flat arrow when degradations and improvements balance', () => {
    const scores = [passingRun('eval', 0), passingRun('eval', 1)];
    const trends = trendReport([workerTrend('eval', 2, 2)]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    expect(card.workers[0]!.trend.arrow).toBe('→');
    expect(card.workers[0]!.trend.direction).toBe('stable');
  });

  it('assigns a dot arrow / none direction when no trend report is supplied', () => {
    const scores = [passingRun('builder', 0)];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    expect(card.workers[0]!.trend.arrow).toBe('·');
    expect(card.workers[0]!.trend.direction).toBe('none');
    expect(card.workers[0]!.trend.summary).toMatch(/no trend data/);
  });

  it('demotes a healthy worker to watch on a non-critical degrading trend', () => {
    const scores = Array.from({ length: 10 }, (_, i) => passingRun('builder', i)); // 100% pass
    const trends = trendReport([workerTrend('builder', 1, 0, 'warning')]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    // Snapshot is perfect, but the trend is sliding => not "healthy".
    expect(card.workers[0]!.grade).toBe('watch');
  });

  it('demotes an at-risk worker to critical on a critical degrading trend', () => {
    const scores = [failingRun('gardener', 0), failingRun('gardener', 1)]; // 0% pass => at-risk
    const trends = trendReport([workerTrend('gardener', 1, 0, 'critical')]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    expect(card.workers[0]!.grade).toBe('critical');
  });

  it('a critical trend on a healthy worker lands at at-risk, not critical', () => {
    const scores = Array.from({ length: 10 }, (_, i) => passingRun('sentinel', i)); // healthy
    const trends = trendReport([workerTrend('sentinel', 1, 0, 'critical')]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    expect(card.workers[0]!.grade).toBe('at-risk');
  });

  it('does not invent a worker that has trends but no scored runs', () => {
    const scores = [passingRun('builder', 0)];
    const trends = trendReport([workerTrend('builder', 1, 0), workerTrend('ghost', 5, 0)]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    expect(card.workers.map((w) => w.worker)).toEqual(['builder']);
  });
});

// ─── aggregateScorecard: sorting & totals ────────────────────────────────

describe('aggregateScorecard - sorting & totals', () => {
  it('orders workers worst-grade first', () => {
    const scores = [
      ...Array.from({ length: 4 }, (_, i) => passingRun('healthy-wk', i)), // healthy
      failingRun('risky-wk', 0), // at-risk (0% pass)
      failingRun('risky-wk', 1),
      passingRun('watch-wk', 0), // watch (2/3 = 0.67 pass)
      passingRun('watch-wk', 1),
      failingRun('watch-wk', 2),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    expect(card.workers.map((w) => w.worker)).toEqual(['risky-wk', 'watch-wk', 'healthy-wk']);
  });

  it('computes fleet totals across workers', () => {
    const scores = [passingRun('a', 0), passingRun('a', 1), failingRun('b', 0), passingRun('b', 1)];
    const trends = trendReport([workerTrend('a', 0, 1), workerTrend('b', 2, 0)]);
    const card = aggregateScorecard(scores, { now: FIXED_NOW, trends });
    const t = card.totals;
    expect(t.workers).toBe(2);
    expect(t.runs).toBe(4);
    expect(t.passRate).toBe(0.75); // 3 of 4 runs pass
    expect(t.degradingTrends).toBe(2);
    expect(t.improvingTrends).toBe(1);
    const gradeSum = Object.values(t.grades).reduce((x, y) => x + y, 0);
    expect(gradeSum).toBe(2);
  });

  it('records the supplied window verbatim and a generatedAt timestamp', () => {
    const card = aggregateScorecard([passingRun('a', 0)], {
      now: FIXED_NOW,
      window: { fromDate: '2026-06-03', toDate: '2026-06-10' },
    });
    expect(card.window).toEqual({ fromDate: '2026-06-03', toDate: '2026-06-10' });
    expect(card.generatedAt).toBe(FIXED_NOW.toISOString());
  });

  it('handles an empty score set', () => {
    const card = aggregateScorecard([], { now: FIXED_NOW });
    expect(card.workers).toEqual([]);
    expect(card.totals.runs).toBe(0);
    expect(Number.isNaN(card.totals.passRate)).toBe(true);
  });
});

// ─── formatScorecard (terminal) ────────────────────────────────────────

describe('formatScorecard', () => {
  it('renders a header, per-worker lines, and a footer', () => {
    const scores = [passingRun('builder', 0), passingRun('builder', 1), failingRun('gardener', 0)];
    const trends = trendReport([workerTrend('builder', 0, 1), workerTrend('gardener', 2, 0)]);
    const card = aggregateScorecard(scores, {
      now: FIXED_NOW,
      trends,
      window: { fromDate: '2026-06-03', toDate: '2026-06-10' },
    });
    const out = formatScorecard(card);

    expect(out).toMatch(/Scorecard \(2026-06-03 \.\. 2026-06-10\)/);
    expect(out).toContain('builder');
    expect(out).toContain('gardener');
    // gardener is at-risk and sorts first.
    expect(out.indexOf('gardener')).toBeLessThan(out.indexOf('builder'));
    expect(out).toContain('↑');
    expect(out).toContain('↓');
    expect(out).toMatch(/trends ↓\d+ ↑\d+/);
  });

  it('reports "no scored runs" for an empty scorecard', () => {
    const card = aggregateScorecard([], { now: FIXED_NOW });
    expect(formatScorecard(card)).toMatch(/no scored runs/);
  });

  it('shows "clean" for a worker with no failures, and lists failures otherwise', () => {
    const clean = aggregateScorecard([passingRun('a', 0)], { now: FIXED_NOW });
    expect(formatScorecard(clean)).toContain('clean');

    const dirty = aggregateScorecard([failingRun('b', 0, 'completeness')], { now: FIXED_NOW });
    expect(formatScorecard(dirty)).toContain('completeness:1');
  });

  it('caps the failure list at maxFailures', () => {
    const scores = [
      failingRun('b', 0, 'completeness'),
      failingRun('b', 1, 'verification'),
      failingRun('b', 2, 'staleness'),
      failingRun('b', 3, 'verification'),
    ];
    const card = aggregateScorecard(scores, { now: FIXED_NOW });
    const out = formatScorecard(card, { maxFailures: 2 });
    expect(out).toMatch(/\+\d+/); // "+N" overflow marker
  });
});

// ─── formatScorecardMarkdown ───────────────────────────────────────────

describe('formatScorecardMarkdown', () => {
  it('renders a titled report with a worker table and per-check sections', () => {
    const scores = [
      passingRun('builder', 0),
      passingRun('builder', 1),
      failingRun('gardener', 0),
      failingRun('gardener', 1),
    ];
    const trends = trendReport([workerTrend('builder', 0, 1), workerTrend('gardener', 2, 0)]);
    const card = aggregateScorecard(scores, {
      now: FIXED_NOW,
      trends,
      window: { fromDate: '2026-06-03', toDate: '2026-06-10' },
    });
    const md = formatScorecardMarkdown(card, { title: 'Fleet Health' });

    expect(md).toMatch(/^# Fleet Health/);
    expect(md).toContain('**Window:** 2026-06-03 .. 2026-06-10');
    expect(md).toContain('| Worker | Grade | Pass |');
    // both workers appear in the table.
    expect(md).toContain('| builder |');
    expect(md).toContain('| gardener |');
    // per-check section present.
    expect(md).toContain('## Per-check breakdown');
    expect(md).toContain('| Check | Mean |');
    // ends with a trailing newline.
    expect(md.endsWith('\n')).toBe(true);
  });

  it('can omit the per-check section', () => {
    const card = aggregateScorecard([passingRun('a', 0)], { now: FIXED_NOW });
    const md = formatScorecardMarkdown(card, { includeChecks: false });
    expect(md).not.toContain('## Per-check breakdown');
  });

  it('renders an empty-window note when there are no runs', () => {
    const card = aggregateScorecard([], { now: FIXED_NOW });
    expect(formatScorecardMarkdown(card)).toContain('No scored runs');
  });

  it('labels an all-time scorecard when no window is set', () => {
    const card = aggregateScorecard([passingRun('a', 0)], { now: FIXED_NOW });
    expect(formatScorecardMarkdown(card)).toContain('**Window:** all-time');
  });
});

// ─── buildScorecard (disk runner, end to end) ─────────────────────────────

/** A healthy, on-task, substantive transcript (passes all checks). */
function goodTranscript(dateLine: string): string {
  return `# Sentinel Run - ${dateLine} PT

## Task
Execute the WinSentinel badge command handler: implement HandleBadge in the CLI,
build it, run the test suite, and push the badge handler feature to main.

## Actions Taken
1. Read sentinel-task.md and worker-common.md for the badge command rules
2. Implemented the HandleBadge method in the WinSentinel CLI Program.cs file
3. Wired the badge command into the CLI parser argument table for dispatch
4. Built the project with dotnet build - zero errors reported on the badge code
5. Ran the WinSentinel test suite - all badge handler tests pass cleanly here

## Key Outputs
- Commit fd2f36a: implement badge command handler in the WinSentinel CLI program
- The badge command now reads the score file and prints a status badge to stdout
- Files changed: Program.cs and CliParser.cs covering the badge handler feature

## Outcome
pass - the badge command handler was fully implemented, tested, and pushed to main

## Errors & Retries
- Initial dotnet build failed on a missing restore - ran restore first, then clean

## Duration
18:15 PT -> 18:32 PT - approximately 17 minutes total
`;
}

/** A stub transcript that produced nothing (completeness fails). */
function emptyTranscript(dateLine: string): string {
  return `# Gardener Run - ${dateLine} PT

## Task
Review open repositories, pick a maintenance task, implement it, and push to main.

## Actions Taken

TODO

## Key Outputs

## Outcome
partial

## Errors & Retries
None.

## Duration
2 minutes
`;
}

describe('buildScorecard (disk runner)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-eval-scorecard-'));

    // Sentinel: four good runs across four days (healthy, trend-able).
    mkdirSync(join(root, 'sentinel'), { recursive: true });
    for (const [date, time] of [
      ['2026-06-04', '1815'],
      ['2026-06-05', '1815'],
      ['2026-06-06', '1815'],
      ['2026-06-07', '1815'],
    ] as const) {
      writeFileSync(
        join(root, 'sentinel', `${date}-${time}.md`),
        goodTranscript(`${date} ${time.slice(0, 2)}:${time.slice(2)}`),
        'utf8',
      );
    }

    // Gardener: four empty runs (completeness fails => at-risk).
    mkdirSync(join(root, 'gardener'), { recursive: true });
    for (const [date, time] of [
      ['2026-06-04', '0900'],
      ['2026-06-05', '0900'],
      ['2026-06-06', '0900'],
      ['2026-06-07', '0900'],
    ] as const) {
      writeFileSync(
        join(root, 'gardener', `${date}-${time}.md`),
        emptyTranscript(`${date} ${time.slice(0, 2)}:${time.slice(2)}`),
        'utf8',
      );
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scores transcripts and grades each worker', () => {
    const res = buildScorecard(root, { now: FIXED_NOW });
    expect(res.scored).toBe(8);
    expect(res.failed).toBe(0);

    const byWorker = Object.fromEntries(res.scorecard.workers.map((w) => [w.worker, w]));
    expect(byWorker.sentinel!.grade).toBe('healthy');
    expect(byWorker.sentinel!.passRate).toBe(1);
    // Gardener's empty runs fail completeness on every run.
    expect(byWorker.gardener!.grade).toBe('at-risk');
    expect(byWorker.gardener!.failureCategories.some((f) => f.check === 'completeness')).toBe(true);
    // Worst grade sorts first.
    expect(res.scorecard.workers[0]!.worker).toBe('gardener');
  });

  it('attaches trend arrows from the same window', () => {
    const res = buildScorecard(root, { now: FIXED_NOW });
    // Trend rows were read from the in-memory score pass for every worker/check.
    expect(res.trendRowsRead).toBeGreaterThan(0);
    for (const w of res.scorecard.workers) {
      // An arrow glyph is always assigned (· only when trends are suppressed).
      expect(['↑', '↓', '→']).toContain(w.trend.arrow);
    }
  });

  it('produces a dot arrow when trends are suppressed', () => {
    const res = buildScorecard(root, { now: FIXED_NOW, noTrends: true });
    expect(res.trendRowsRead).toBe(0);
    for (const w of res.scorecard.workers) {
      expect(w.trend.arrow).toBe('·');
      expect(w.trend.direction).toBe('none');
    }
  });

  it('does not persist scores.jsonl by default (read-only report)', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'agent-eval-scorecard-ro-'));
    try {
      mkdirSync(join(fresh, 'sentinel'), { recursive: true });
      writeFileSync(join(fresh, 'sentinel', '2026-06-08-1815.md'), goodTranscript('2026-06-08 18:15'), 'utf8');
      const res = buildScorecard(fresh, { now: FIXED_NOW });
      expect(res.scored).toBe(1);
      // The scoring pass must not have written a scores.jsonl as a side effect.
      expect(existsSync(join(fresh, 'sentinel', 'scores.jsonl'))).toBe(false);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('persists scores.jsonl when persist:true is set', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'agent-eval-scorecard-persist-'));
    try {
      mkdirSync(join(fresh, 'sentinel'), { recursive: true });
      writeFileSync(join(fresh, 'sentinel', '2026-06-08-1815.md'), goodTranscript('2026-06-08 18:15'), 'utf8');
      buildScorecard(fresh, { now: FIXED_NOW, persist: true });
      expect(existsSync(join(fresh, 'sentinel', 'scores.jsonl'))).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('can draw arrows from full on-disk history with trendsFromDisk', () => {
    // Persist first so there is an on-disk history to read.
    buildScorecard(root, { now: FIXED_NOW, persist: true });
    const res = buildScorecard(root, { now: FIXED_NOW, trendsFromDisk: true });
    expect(res.trendRowsRead).toBeGreaterThan(0);
  });

  it('restricts to specific workers', () => {
    const res = buildScorecard(root, { now: FIXED_NOW, workers: ['sentinel'] });
    expect(res.scorecard.workers.map((w) => w.worker)).toEqual(['sentinel']);
  });

  it('clips both passes to a resolved trailing window', () => {
    // A 2-day window ending 2026-06-07 keeps only 2026-06-06 and 2026-06-07.
    const res = buildScorecard(root, { now: new Date('2026-06-07T23:00:00Z'), window: 2 });
    expect(res.window).toBeDefined();
    // 2 days x 2 workers x 1 run/day = 4 transcripts.
    expect(res.scored).toBe(4);
    expect(res.scorecard.window).toEqual(res.window);
  });

  it('renders the disk-built scorecard to markdown', () => {
    const res = buildScorecard(root, { now: FIXED_NOW });
    const md = formatScorecardMarkdown(res.scorecard, { title: 'Weekly Scorecard' });
    expect(md).toContain('# Weekly Scorecard');
    expect(md).toContain('| sentinel |');
    expect(md).toContain('| gardener |');
  });

  it('handles a root with no transcripts gracefully', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agent-eval-scorecard-empty-'));
    try {
      const res = buildScorecard(empty, { now: FIXED_NOW });
      expect(res.scored).toBe(0);
      expect(res.scorecard.workers).toEqual([]);
      expect(formatScorecard(res.scorecard)).toMatch(/no scored runs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ─── Public API smoke (package root re-exports) ────────────────────────────

// These two smoke tests await import() on the package barrels; on a cold run
// vitest compiles the whole module graph on first import (~3-4s), which can
// exceed the 5s default. Give this suite headroom so it never cold-flakes
// (scoped here so real hangs elsewhere still fail fast at the default).
describe('scorecard public API', { timeout: 20000 }, () => {
  it('is re-exported from the package root', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.aggregateScorecard).toBe('function');
    expect(typeof mod.buildScorecard).toBe('function');
    expect(typeof mod.formatScorecard).toBe('function');
    expect(typeof mod.formatScorecardMarkdown).toBe('function');
  });

  it('is re-exported from the monitoring index', async () => {
    const mod = await import('../src/monitoring/index.js');
    expect(typeof mod.aggregateScorecard).toBe('function');
    expect(typeof mod.buildScorecard).toBe('function');
  });
});
