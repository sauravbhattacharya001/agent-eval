/**
 * Tests for the Historical Scorer - Phase 3.5 Production Monitoring.
 *
 * Covers the pure scorer (scoreTranscript / scoreTranscripts / toScoreRows),
 * the JSONL store (read/write/upsert/group), and the orchestrating runner
 * (scoreHistory) end to end against a temp transcripts tree.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseTranscript } from '../src/monitoring/transcript-reader.js';
import { scoreTranscript, scoreTranscripts, toScoreRows } from '../src/monitoring/scorer.js';
import type { CheckScore } from '../src/monitoring/scorer.js';
import {
  groupRowsByWorker,
  parseScoresJsonl,
  readAllScores,
  readScores,
  scoreKey,
  scoresPathFor,
  serializeScoresJsonl,
  upsertScores,
  writeScores,
  writeScoresByWorker,
  writeScoresFor,
} from '../src/monitoring/scores-store.js';
import { scoreHistory } from '../src/monitoring/score-runner.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

/** A healthy, on-task sentinel run. */
const GOOD_TRANSCRIPT = `# Sentinel Run - 2026-06-08 18:15 PT

## Task
Execute the WinSentinel badge command handler: implement HandleBadge in the CLI,
build it, run the test suite, and push the badge handler feature to main.

## Actions Taken
1. Read sentinel-task.md and worker-common.md for the badge command rules
2. Implemented the HandleBadge method in the WinSentinel CLI Program.cs
3. Wired the badge command into the CLI parser argument table
4. Built the project with dotnet build - zero errors reported
5. Ran the WinSentinel test suite - all badge handler tests pass

## Key Outputs
- Commit fd2f36a: implement badge command handler in the WinSentinel CLI
- The badge command now reads the score file and prints a status badge
- Files changed: Program.cs, CliParser.cs covering the badge handler feature

## Outcome
pass - the badge command handler was fully implemented, tested, and pushed to main

## Errors & Retries
- Initial dotnet build failed on a missing restore - ran restore first, then built clean

## Duration
18:15 PT -> 18:32 PT - approximately 17 minutes total
`;

/** A run that produced almost nothing - completeness should fail. */
const EMPTY_TRANSCRIPT = `# Gardener Run - 2026-06-08 09:00 PT

## Task
Review open repositories, pick a maintenance task, implement it, and push.

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

/** A run with no Task section - relevance & coverage must be skipped. */
const NO_TASK_TRANSCRIPT = `# Eval Run - 2026-06-09 12:00 PT

## Actions Taken
1. Did several substantive things across the framework today and wrote tests
2. Implemented a meaningful module with full documentation and coverage here

## Key Outputs
- Implemented a feature with assertions, tests, and documentation all included

## Outcome
pass

## Duration
12:00 PT -> 12:20 PT
`;

function parse(text: string, filename: string, source?: string) {
  return parseTranscript(text, { filename, ...(source ? { source } : {}) });
}

function sampleRow(over: Partial<CheckScore> = {}): CheckScore {
  return {
    worker: 'sentinel',
    runId: '2026-06-08-1815',
    startedAt: '2026-06-08T18:15:00-07:00',
    startedAtMs: 1,
    check: 'staleness',
    tier: 1,
    score: 1,
    status: 'pass',
    summary: 'ok',
    scoredAt: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

// ─── scoreTranscript ─────────────────────────────────────────────────────────────

describe('scoreTranscript', () => {
  it('produces one row per check with correct identity', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const result = scoreTranscript(t);

    expect(result.worker).toBe('sentinel');
    expect(result.runId).toBe('2026-06-08-1815');
    expect(result.checks.map((c) => c.check).sort()).toEqual([
      'completeness',
      'keyword-coverage',
      'relevance',
      'staleness',
    ]);
    for (const c of result.checks) {
      expect(c.worker).toBe('sentinel');
      expect(c.runId).toBe('2026-06-08-1815');
      expect(c.startedAtMs).toBe(t.identity.startedAtMs);
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(typeof c.summary).toBe('string');
      expect(c.scoredAt).toBeTruthy();
    }
  });

  it('labels each check with its independence tier', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const byCheck = Object.fromEntries(scoreTranscript(t).checks.map((c) => [c.check, c.tier]));
    expect(byCheck.staleness).toBe(1);
    expect(byCheck.completeness).toBe(1);
    expect(byCheck.relevance).toBe(2);
    expect(byCheck['keyword-coverage']).toBe(2);
  });

  it('passes staleness for a healthy run within budget', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const stale = scoreTranscript(t).checks.find((c) => c.check === 'staleness')!;
    expect(stale.status).toBe('pass');
    expect(stale.score).toBe(1);
  });

  it('fails staleness when the run exceeds its timeout budget', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    // 17-minute run, 5-minute budget => timeout error.
    const stale = scoreTranscript(t, { timeoutMs: 5 * 60_000 }).checks.find(
      (c) => c.check === 'staleness',
    )!;
    expect(stale.status).toBe('fail');
    expect(stale.score).toBeLessThan(1);
    expect(stale.summary).toContain('stale');
  });

  it('accepts a per-worker timeout map', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const stale = scoreTranscript(t, { timeoutMs: { sentinel: 5 * 60_000 } }).checks.find(
      (c) => c.check === 'staleness',
    )!;
    expect(stale.status).toBe('fail');
  });

  it('fails completeness when deliverables are empty/stub', () => {
    const t = parse(EMPTY_TRANSCRIPT, '2026-06-08-0900.md');
    const complete = scoreTranscript(t).checks.find((c) => c.check === 'completeness')!;
    expect(complete.status).toBe('fail');
    expect(complete.score).toBeLessThan(0.7);
  });

  it('passes completeness for a substantive run', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const complete = scoreTranscript(t).checks.find((c) => c.check === 'completeness')!;
    expect(complete.status).not.toBe('fail');
    expect(complete.score).toBeGreaterThanOrEqual(0.9);
  });

  it('scores relevance for an on-task run above the default threshold', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const rel = scoreTranscript(t).checks.find((c) => c.check === 'relevance')!;
    expect(rel.status).not.toBe('skip');
    expect(rel.score).toBeGreaterThan(0);
    expect(typeof rel.detail?.similarity).toBe('number');
  });

  it('skips relevance and coverage when there is no Task section', () => {
    const t = parse(NO_TASK_TRANSCRIPT, '2026-06-09-1200.md');
    const result = scoreTranscript(t);
    const rel = result.checks.find((c) => c.check === 'relevance')!;
    const cov = result.checks.find((c) => c.check === 'keyword-coverage')!;
    expect(rel.status).toBe('skip');
    expect(cov.status).toBe('skip');
    expect(rel.detail?.skipped).toBe(true);
  });

  it('excludes skipped checks from the roll-up', () => {
    const t = parse(NO_TASK_TRANSCRIPT, '2026-06-09-1200.md');
    const result = scoreTranscript(t);
    const scored = result.checks.filter((c) => c.status !== 'skip');
    expect(scored.length).toBe(2);
    const mean = scored.reduce((a, c) => a + c.score, 0) / scored.length;
    expect(result.overall).toBeCloseTo(mean, 6);
    expect(result.worst).toBe(Math.min(...scored.map((c) => c.score)));
  });

  it('keeps overall finite when at least one check is scored', () => {
    const t = parse(NO_TASK_TRANSCRIPT, '2026-06-09-1200.md');
    expect(Number.isFinite(scoreTranscript(t).overall)).toBe(true);
  });

  it('carries the reported outcome and source through', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md', '/tmp/sentinel/2026-06-08-1815.md');
    const result = scoreTranscript(t);
    expect(result.reportedOutcome).toBe('pass');
    expect(result.source).toBe('/tmp/sentinel/2026-06-08-1815.md');
    expect(result.checks[0]?.source).toBe('/tmp/sentinel/2026-06-08-1815.md');
  });

  it('uses the provided now for scoredAt', () => {
    const t = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const now = new Date('2026-06-10T00:00:00Z');
    expect(scoreTranscript(t, { now }).checks[0]?.scoredAt).toBe(now.toISOString());
  });

  it('counts failCount and warnCount on the roll-up', () => {
    const result = scoreTranscript(parse(EMPTY_TRANSCRIPT, '2026-06-08-0900.md'));
    expect(result.failCount).toBe(result.checks.filter((c) => c.status === 'fail').length);
    expect(result.warnCount).toBe(result.checks.filter((c) => c.status === 'warn').length);
  });
});

// ─── scoreTranscripts / toScoreRows ──────────────────────────────────────────────

describe('scoreTranscripts + toScoreRows', () => {
  it('scores a batch preserving order', () => {
    const a = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const b = parse(EMPTY_TRANSCRIPT, '2026-06-08-0900.md');
    expect(scoreTranscripts([a, b]).map((s) => s.runId)).toEqual([
      '2026-06-08-1815',
      '2026-06-08-0900',
    ]);
  });

  it('flattens to rows in append order', () => {
    const a = parse(GOOD_TRANSCRIPT, '2026-06-08-1815.md');
    const b = parse(NO_TASK_TRANSCRIPT, '2026-06-09-1200.md');
    const rows = toScoreRows(scoreTranscripts([a, b]));
    expect(rows.length).toBe(8); // 4 checks x 2 transcripts
    expect(rows[0]?.check).toBe('staleness');
  });
});

// ─── scores-store: serialize / parse ─────────────────────────────────────────────

describe('scores-store serialization', () => {
  it('round-trips through JSONL', () => {
    const rows = [sampleRow(), sampleRow({ check: 'completeness', score: 0.9, status: 'warn' })];
    const text = serializeScoresJsonl(rows);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseScoresJsonl(text)).toEqual(rows);
  });

  it('serializes empty input as empty string', () => {
    expect(serializeScoresJsonl([])).toBe('');
  });

  it('skips blank and malformed lines on parse', () => {
    const text = [
      JSON.stringify(sampleRow()),
      '',
      '   ',
      '{ not valid json',
      JSON.stringify({ missing: 'fields' }),
      JSON.stringify(sampleRow({ check: 'relevance', tier: 2 })),
    ].join('\n');
    const rows = parseScoresJsonl(text);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.check)).toEqual(['staleness', 'relevance']);
  });

  it('builds a stable dedupe key', () => {
    expect(scoreKey(sampleRow())).toBe('sentinel\u00002026-06-08-1815\u0000staleness');
  });

  it('groups rows by worker preserving first-seen order', () => {
    const rows = [
      sampleRow({ worker: 'sentinel' }),
      sampleRow({ worker: 'gardener' }),
      sampleRow({ worker: 'sentinel', check: 'completeness' }),
    ];
    const groups = groupRowsByWorker(rows);
    expect([...groups.keys()]).toEqual(['sentinel', 'gardener']);
    expect(groups.get('sentinel')!.length).toBe(2);
  });

  it('upsert replaces rows with the same key, keeps order', () => {
    const a = sampleRow({ score: 1 });
    const b = sampleRow({ check: 'completeness', score: 0.5 });
    const a2 = sampleRow({ score: 0.2, summary: 'now stale' });
    const merged = upsertScores([a, b], [a2]);
    expect(merged.length).toBe(2);
    expect(merged[0]?.summary).toBe('now stale');
    expect(merged[0]?.score).toBe(0.2);
    expect(merged[1]?.check).toBe('completeness');
  });
});

// ─── scores-store: filesystem ────────────────────────────────────────────

describe('scores-store filesystem', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-eval-scores-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rowFor(
    worker: string,
    runId: string,
    check: CheckScore['check'],
    over: Partial<CheckScore> = {},
  ): CheckScore {
    return sampleRow({ worker, runId, check, ...over });
  }

  it('returns [] for a missing file', () => {
    expect(readScores(join(dir, 'nope', 'scores.jsonl'))).toEqual([]);
  });

  it('writes then reads back rows (upsert default), creating dirs', () => {
    const path = scoresPathFor(dir, 'sentinel');
    const rows = [rowFor('sentinel', '2026-06-08-1815', 'staleness')];
    const res = writeScores(path, rows);
    expect(res.added).toBe(1);
    expect(res.replaced).toBe(0);
    expect(res.total).toBe(1);
    expect(readScores(path)).toEqual(rows);
  });

  it('upsert on re-write replaces the matching row, no duplicate', () => {
    const path = scoresPathFor(dir, 'upsert-worker');
    writeScores(path, [rowFor('upsert-worker', 'r1', 'staleness', { score: 1 })]);
    const res = writeScores(path, [
      rowFor('upsert-worker', 'r1', 'staleness', { score: 0.2, summary: 'stale now' }),
    ]);
    expect(res.replaced).toBe(1);
    expect(res.added).toBe(0);
    const back = readScores(path);
    expect(back.length).toBe(1);
    expect(back[0]?.score).toBe(0.2);
  });

  it('append mode duplicates rows', () => {
    const path = scoresPathFor(dir, 'append-worker');
    writeScores(path, [rowFor('append-worker', 'r1', 'staleness')], { mode: 'append' });
    writeScores(path, [rowFor('append-worker', 'r1', 'staleness')], { mode: 'append' });
    expect(readScores(path).length).toBe(2);
  });

  it('replace mode truncates to the supplied rows', () => {
    const path = scoresPathFor(dir, 'replace-worker');
    writeScores(path, [
      rowFor('replace-worker', 'r1', 'staleness'),
      rowFor('replace-worker', 'r1', 'completeness'),
    ]);
    const res = writeScores(path, [rowFor('replace-worker', 'r2', 'staleness')], {
      mode: 'replace',
    });
    expect(res.total).toBe(1);
    expect(readScores(path).map((r) => r.runId)).toEqual(['r2']);
  });

  it('writeScoresFor routes to the worker file', () => {
    const res = writeScoresFor(dir, [rowFor('routed', 'r1', 'staleness')]);
    expect(res.path).toBe(scoresPathFor(dir, 'routed'));
    expect(readScores(scoresPathFor(dir, 'routed')).length).toBe(1);
  });

  it('writeScoresFor rejects mixed-worker input', () => {
    expect(() =>
      writeScoresFor(dir, [rowFor('a', 'r1', 'staleness'), rowFor('b', 'r1', 'staleness')]),
    ).toThrow(/share one worker/);
  });

  it('writeScoresFor with empty rows is a no-op', () => {
    const res = writeScoresFor(dir, []);
    expect(res.total).toBe(0);
    expect(res.path).toBe('');
  });

  it('writeScoresByWorker fans out to per-worker files', () => {
    const rows = [
      rowFor('fan-a', 'r1', 'staleness'),
      rowFor('fan-b', 'r1', 'staleness'),
      rowFor('fan-a', 'r1', 'completeness'),
    ];
    const results = writeScoresByWorker(dir, rows);
    expect(results.length).toBe(2);
    expect(readScores(scoresPathFor(dir, 'fan-a')).length).toBe(2);
    expect(readScores(scoresPathFor(dir, 'fan-b')).length).toBe(1);
  });

  it('readAllScores concatenates explicit workers', () => {
    writeScoresFor(dir, [rowFor('all-x', 'r1', 'staleness')]);
    writeScoresFor(dir, [rowFor('all-y', 'r1', 'staleness')]);
    const all = readAllScores(dir, ['all-x', 'all-y']);
    expect(all.some((r) => r.worker === 'all-x')).toBe(true);
    expect(all.some((r) => r.worker === 'all-y')).toBe(true);
  });

  it('readAllScores scans the root when no workers are given', () => {
    writeScoresFor(dir, [rowFor('scan-z', 'r1', 'staleness')]);
    const all = readAllScores(dir);
    expect(all.some((r) => r.worker === 'scan-z')).toBe(true);
  });
});

// ─── scoreHistory (runner) ──────────────────────────────────────────────

describe('scoreHistory', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-eval-history-'));
    mkdirSync(join(root, 'sentinel'), { recursive: true });
    writeFileSync(join(root, 'sentinel', '2026-06-08-1815.md'), GOOD_TRANSCRIPT, 'utf8');
    writeFileSync(join(root, 'sentinel', '2026-06-07-1000.md'), GOOD_TRANSCRIPT, 'utf8');
    mkdirSync(join(root, 'gardener'), { recursive: true });
    writeFileSync(join(root, 'gardener', '2026-06-08-0900.md'), EMPTY_TRANSCRIPT, 'utf8');
    // a corrupt-but-named file: still parses (parser is lenient), so to test
    // hard failure we point at a path the loader can read but cannot identify.
    writeFileSync(join(root, 'gardener', '2026-06-06-0900.md'), '\u0000\u0000', 'utf8');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers, scores, and persists scores.jsonl per worker', () => {
    const res = scoreHistory(root);
    expect(res.discovered).toBeGreaterThanOrEqual(3);
    expect(res.scored).toBeGreaterThanOrEqual(3);
    expect(res.rows.length).toBe(res.scored * 4);
    // files written
    const sentinelScores = readScores(scoresPathFor(root, 'sentinel'));
    expect(sentinelScores.length).toBe(8); // 2 runs x 4 checks
    const gardenerScores = readScores(scoresPathFor(root, 'gardener'));
    expect(gardenerScores.length).toBeGreaterThanOrEqual(4);
  });

  it('is idempotent: re-running upserts instead of duplicating', () => {
    scoreHistory(root);
    scoreHistory(root);
    const sentinelScores = readScores(scoresPathFor(root, 'sentinel'));
    expect(sentinelScores.length).toBe(8); // still 8, not 16/24
  });

  it('does not write when persist is false', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'agent-eval-dryrun-'));
    try {
      mkdirSync(join(fresh, 'sentinel'), { recursive: true });
      writeFileSync(join(fresh, 'sentinel', '2026-06-08-1815.md'), GOOD_TRANSCRIPT, 'utf8');
      const res = scoreHistory(fresh, { persist: false });
      expect(res.scored).toBe(1);
      expect(res.written).toEqual([]);
      expect(readScores(scoresPathFor(fresh, 'sentinel'))).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('filters by worker', () => {
    const res = scoreHistory(root, { workers: ['sentinel'], persist: false });
    expect(res.scores.every((s) => s.worker === 'sentinel')).toBe(true);
  });

  it('filters by a rolling window', () => {
    // window of 1 day ending 2026-06-08 keeps only the 06-08 transcripts.
    const res = scoreHistory(root, {
      window: 1,
      today: new Date('2026-06-08T23:00:00Z'),
      persist: false,
    });
    expect(res.scores.every((s) => s.runId.startsWith('2026-06-08'))).toBe(true);
    expect(res.scores.length).toBeGreaterThanOrEqual(1);
  });

  it('honors explicit from/to over window', () => {
    const res = scoreHistory(root, {
      fromDate: '2026-06-07',
      toDate: '2026-06-07',
      persist: false,
    });
    expect(res.scores.every((s) => s.runId.startsWith('2026-06-07'))).toBe(true);
  });

  it('returns newest-first scores', () => {
    const res = scoreHistory(root, { workers: ['sentinel'], persist: false });
    const ids = res.scores.map((s) => s.runId);
    const sorted = [...ids].sort().reverse();
    expect(ids).toEqual(sorted);
  });

  it('respects a limit', () => {
    const res = scoreHistory(root, { limit: 1, persist: false });
    expect(res.scores.length).toBe(1);
  });

  it('returns an empty result for a missing root', () => {
    const res = scoreHistory(join(root, 'does-not-exist'));
    expect(res.discovered).toBe(0);
    expect(res.scored).toBe(0);
    expect(res.rows).toEqual([]);
  });
});
