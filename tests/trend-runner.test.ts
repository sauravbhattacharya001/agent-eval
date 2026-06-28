/**
 * Trend Runner — disk-wiring tests for {@link detectTrendsFromDisk} and the
 * {@link filterRowsByDate} window helper.
 *
 * The pure detector (`detectTrends`) is exercised exhaustively in
 * `trend-detector.test.ts`; the pure store round-trip + happy-path filesystem
 * I/O lives in `scorer.test.ts`. This file fills the remaining monitoring
 * disk-layer gap that neither covers: the *runner* that reads every worker's
 * `scores.jsonl` back off disk, clips to a rolling window, and hands the rows
 * to the detector — including the error/resilience branches a real cron hits
 * (corrupt + truncated JSONL on disk, an unreadable path, a missing root, and
 * rows whose date can't be determined).
 *
 * These are all Tier-1 (deterministic fs + JSON) paths — no AI, reproducible,
 * offline.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CheckScore } from '../src/monitoring/scorer.js';
import { scoresPathFor, serializeScoresJsonl } from '../src/monitoring/scores-store.js';
import { detectTrendsFromDisk, filterRowsByDate } from '../src/monitoring/trend-runner.js';

// ─── FIXTURES ────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** 2026-06-01T00:00:00.000Z — a fixed anchor so date windowing is deterministic. */
const BASE_MS = Date.UTC(2026, 5, 1);

interface RowOverrides {
  worker?: string;
  dayOffset?: number;
  score?: number;
  check?: CheckScore['check'];
}

/** Build a score row `dayOffset` days after BASE_MS with sane defaults. */
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
    tier: 1,
    score,
    status: score >= 0.7 ? 'pass' : score >= 0.4 ? 'warn' : 'fail',
    summary: 'fixture',
    scoredAt: '2026-06-10T00:00:00.000Z',
  };
}

/** Write a worker's rows to `<root>/<worker>/scores.jsonl`. */
function writeWorkerScores(root: string, worker: string, rows: readonly CheckScore[]): void {
  const path = scoresPathFor(root, worker);
  mkdirSync(join(root, worker), { recursive: true });
  writeFileSync(path, serializeScoresJsonl(rows), 'utf8');
}

// ─── filterRowsByDate (pure window helper) ─────────────────────────────────────

describe('filterRowsByDate', () => {
  const rows = [
    row({ dayOffset: 0 }), // 2026-06-01
    row({ dayOffset: 5 }), // 2026-06-06
    row({ dayOffset: 10 }), // 2026-06-11
  ];

  it('returns a copy of all rows when no bounds are given', () => {
    const out = filterRowsByDate(rows, undefined, undefined);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows); // defensive copy, not the same array
  });

  it('clips on an inclusive lower bound', () => {
    const out = filterRowsByDate(rows, '2026-06-06', undefined);
    expect(out.map((r) => r.startedAtMs)).toEqual([BASE_MS + 5 * DAY_MS, BASE_MS + 10 * DAY_MS]);
  });

  it('clips on an inclusive upper bound', () => {
    const out = filterRowsByDate(rows, undefined, '2026-06-06');
    expect(out.map((r) => r.startedAtMs)).toEqual([BASE_MS, BASE_MS + 5 * DAY_MS]);
  });

  it('clips on both bounds (inclusive on each edge)', () => {
    const out = filterRowsByDate(rows, '2026-06-06', '2026-06-06');
    expect(out.map((r) => r.runId)).toEqual([row({ dayOffset: 5 }).runId]);
  });

  it('keeps a row whose date cannot be determined rather than dropping it', () => {
    // No startedAtMs (NaN) and no usable startedAt — rowDate() returns '' and
    // the runner deliberately over-includes such a row.
    const undated: CheckScore = {
      ...row({ dayOffset: 0 }),
      startedAtMs: Number.NaN,
      startedAt: '',
    };
    const out = filterRowsByDate([undated], '2026-06-06', '2026-06-06');
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(undated);
  });

  it('falls back to the startedAt ISO prefix when startedAtMs is non-finite', () => {
    const isoOnly: CheckScore = {
      ...row({ dayOffset: 0 }),
      startedAtMs: Number.NaN,
      startedAt: '2026-06-20T12:00:00.000Z',
    };
    // In window → kept.
    expect(filterRowsByDate([isoOnly], '2026-06-15', '2026-06-25')).toHaveLength(1);
    // Out of window (before lower bound) → dropped via the ISO-prefix path.
    expect(filterRowsByDate([isoOnly], '2026-06-21', undefined)).toHaveLength(0);
  });
});

// ─── detectTrendsFromDisk (read → window → detect) ─────────────────────────────

describe('detectTrendsFromDisk', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-eval-trend-runner-'));
    // builder: a clean downward slope over 8 days (older half high, newer low) so
    // the detector sees a real degradation; gardener: a flat healthy series.
    writeWorkerScores(dir, 'builder', [
      row({ worker: 'builder', dayOffset: 0, score: 1 }),
      row({ worker: 'builder', dayOffset: 1, score: 1 }),
      row({ worker: 'builder', dayOffset: 2, score: 0.95 }),
      row({ worker: 'builder', dayOffset: 3, score: 0.9 }),
      row({ worker: 'builder', dayOffset: 4, score: 0.5 }),
      row({ worker: 'builder', dayOffset: 5, score: 0.4 }),
      row({ worker: 'builder', dayOffset: 6, score: 0.35 }),
      row({ worker: 'builder', dayOffset: 7, score: 0.3 }),
    ]);
    writeWorkerScores(dir, 'gardener', [
      row({ worker: 'gardener', dayOffset: 0, score: 1 }),
      row({ worker: 'gardener', dayOffset: 3, score: 1 }),
      row({ worker: 'gardener', dayOffset: 6, score: 1 }),
    ]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every worker file back off disk and reports rowsRead', () => {
    const out = detectTrendsFromDisk(dir);
    expect(out.rowsRead).toBe(11); // 8 builder + 3 gardener
    expect(out.rowsWindowed).toBe(11); // no window applied
    expect(out.window).toBeUndefined();
    // Two workers surface in the report (order is severity-then-name).
    expect(out.report.workers.map((w) => w.worker).sort()).toEqual(['builder', 'gardener']);
    expect(out.report.rowsConsidered).toBe(11);
  });

  it('surfaces a real degradation from the on-disk builder slope', () => {
    const out = detectTrendsFromDisk(dir);
    // The builder slope must register as a degradation somewhere in the report.
    expect(out.report.degradations.length).toBeGreaterThan(0);
    expect(out.report.degradations.some((d) => d.worker === 'builder')).toBe(true);
    expect(out.report.worstSeverity).not.toBe('none');
  });

  it('derives an inclusive date window from `window` + `today` and clips rows', () => {
    // today = day 7 (2026-06-08); window of 4 days keeps days 4..7 (inclusive).
    const today = new Date(BASE_MS + 7 * DAY_MS);
    const out = detectTrendsFromDisk(dir, { window: 4, today });
    expect(out.window).toBeDefined();
    expect(out.window?.toDate).toBe('2026-06-08');
    // builder days 4,5,6,7 (4 rows) + gardener day 6 (1 row) = 5 windowed rows.
    expect(out.rowsRead).toBe(11);
    expect(out.rowsWindowed).toBe(5);
    expect(out.report.rowsConsidered).toBe(5);
  });

  it('lets explicit fromDate/toDate override the rolling window', () => {
    const today = new Date(BASE_MS + 7 * DAY_MS);
    const out = detectTrendsFromDisk(dir, {
      window: 4, // should be ignored in favor of explicit bounds
      today,
      fromDate: '2026-06-01',
      toDate: '2026-06-02',
    });
    expect(out.window).toEqual({ fromDate: '2026-06-01', toDate: '2026-06-02' });
    // builder days 0,1 only (gardener's first row is day 0 too).
    expect(out.rowsWindowed).toBe(3);
  });

  it('forwards the workers filter so only that worker is read', () => {
    const out = detectTrendsFromDisk(dir, { workers: ['gardener'] });
    expect(out.rowsRead).toBe(3);
    expect(out.report.workers.map((w) => w.worker)).toEqual(['gardener']);
  });

  it('returns an empty result for a missing root without throwing', () => {
    const out = detectTrendsFromDisk(join(dir, 'does-not-exist'));
    expect(out.rowsRead).toBe(0);
    expect(out.rowsWindowed).toBe(0);
    expect(out.report.workers).toEqual([]);
    expect(out.report.degradations).toEqual([]);
    expect(out.report.worstSeverity).toBe('none');
  });
});

// ─── disk resilience: corrupt / truncated JSONL + unreadable paths ─────────────

describe('detectTrendsFromDisk — disk resilience', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-eval-trend-resilience-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('recovers valid rows past a corrupt + truncated final line (crash-safety)', () => {
    // Simulate a file a crashing writer left behind: good rows, a garbage line,
    // a row missing required fields, then a half-written (truncated, no newline)
    // final line. Only the two structurally-valid rows must survive.
    const good1 = JSON.stringify(row({ worker: 'crash', dayOffset: 0, score: 1 }));
    const good2 = JSON.stringify(row({ worker: 'crash', dayOffset: 1, score: 1 }));
    const text = [
      good1,
      '{ this is not json',
      JSON.stringify({ worker: 'crash', runId: 'x' }), // missing required fields
      good2,
      '{"worker":"crash","runId":"2026-06-03-1203","check":"complet', // truncated tail
    ].join('\n');
    mkdirSync(join(dir, 'crash'), { recursive: true });
    writeFileSync(scoresPathFor(dir, 'crash'), text, 'utf8');

    const out = detectTrendsFromDisk(dir, { workers: ['crash'] });
    expect(out.rowsRead).toBe(2);
    expect(out.report.rowsConsidered).toBe(2);
  });

  it('treats an unreadable scores path (a directory) as empty, not fatal', () => {
    // Make `<root>/dirworker/scores.jsonl` a DIRECTORY. readFileSync then throws
    // (EISDIR/EPERM), and readScores must swallow it and yield [] — so a single
    // poisoned worker can never crash a fleet-wide trend sweep.
    mkdirSync(join(dir, 'dirworker', 'scores.jsonl'), { recursive: true });
    const out = detectTrendsFromDisk(dir, { workers: ['dirworker'] });
    expect(out.rowsRead).toBe(0);
    expect(out.report.workers).toEqual([]);
  });

  it('scans the root and tolerates a poisoned worker among healthy ones', () => {
    // No explicit workers → readAllScores scans the root. One worker is fine,
    // one has a directory-as-file. The healthy worker's rows still come back and
    // the directory entry contributes nothing instead of throwing.
    writeWorkerScores(dir, 'healthy', [
      row({ worker: 'healthy', dayOffset: 0, score: 1 }),
      row({ worker: 'healthy', dayOffset: 1, score: 1 }),
    ]);
    const out = detectTrendsFromDisk(dir);
    const workers = out.report.workers.map((w) => w.worker);
    expect(workers).toContain('healthy');
    expect(out.rowsRead).toBeGreaterThanOrEqual(2);
  });
});
