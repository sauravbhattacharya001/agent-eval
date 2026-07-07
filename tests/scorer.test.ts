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

/**
 * Regression fixture for the gardener-2026-06-09 false-positive: a run that
 * COMPLETED successfully (outcome: pass, real pushed commits) but had a long
 * wall-clock duration with few action items AND a populated `## Errors &
 * Retries` section describing *recovered* (non-fatal) errors.
 *
 * Before the timeline-bridge/scorer fix this tripped staleness twice over:
 *   1. evenly-distributed synthetic action timestamps across the long window
 *      produced > 5-minute "gaps" => stale_gap warnings, and
 *   2. hadErrors=true emitted a synthetic 'error' event => severity bump,
 * stacking to isStale even though nothing actually went wrong.
 * The run must now score staleness as a clean pass.
 */
const RECOVERED_ERRORS_TRANSCRIPT = `# Gardener Run - 2026-06-09 22:20 PT

## Task
Review open repositories, pick a maintenance task, implement it, and push.

## Actions Taken
1. Fixed a Python 3.10/3.11 compatibility bug in the ai repo and pushed it
2. Added dartdoc documentation comments to the everything repo and pushed it

## Key Outputs
- Commit 24f8937: fix Python 3.10/3.11 compatibility in the ai repository
- Commit 2f79325: add dartdoc documentation across the everything repository
- Both changes built clean and were pushed to their default branches

## Outcome
pass - both maintenance tasks were implemented, verified, and pushed

## Errors & Retries
- git commit -m mis-parsed under PowerShell on the first attempt; re-ran with
  the correct quoting and the commit succeeded
- Compare-Object emitted a harmless UTF-8 artifact warning that was ignored

## Duration
22:20 PT -> 22:40 PT - approximately 20 minutes total
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
      'staleness',
      'verification',
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
    expect(byCheck.verification).toBe(1);
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

  it('does not false-flag a completed run with recovered errors as stale (gardener-2026-06-09 regression)', () => {
    const t = parse(RECOVERED_ERRORS_TRANSCRIPT, '2026-06-09-2220.md');
    // 20-minute run, generous gardener budget => only real signals apply.
    const stale = scoreTranscript(t, { timeoutMs: 60 * 60_000 }).checks.find(
      (c) => c.check === 'staleness',
    )!;
    expect(stale.status).toBe('pass');
    expect(stale.score).toBe(1);
    // The recovered errors documented in ## Errors & Retries must NOT be
    // counted as a live error event for a run that reported pass.
    expect(stale.detail.errors).toBe(0);
  });

  it('still fails staleness for a genuinely abandoned run (no deliverables)', () => {
    // Guard the fix: a stub/abandoned run must STILL be caught. The empty
    // transcript has no real output and a 'partial' (non-success) outcome.
    const t = parse(EMPTY_TRANSCRIPT, '2026-06-08-0900.md');
    const stale = scoreTranscript(t).checks.find((c) => c.check === 'staleness')!;
    expect(stale.score).toBeLessThan(1);
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
    expect(rows.length).toBe(6); // 3 checks x 2 transcripts
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
      JSON.stringify(sampleRow({ check: 'verification', tier: 1 })),
    ].join('\n');
    const rows = parseScoresJsonl(text);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.check)).toEqual(['staleness', 'verification']);
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
    // A byte-garbage file: the transcript parser is *lenient*, so this still
    // parses (and scores) rather than throwing — it is NOT a hard failure.
    // It exists to prove the runner tolerates junk content, not to test the
    // error path (see the unreadable-at-load fixture below for that).
    writeFileSync(join(root, 'gardener', '2026-06-06-0900.md'), '\u0000\u0000', 'utf8');
    // A conforming *name* that cannot be read as a file: `loadTranscript`'s
    // readFileSync throws EISDIR here, which is the one reliable way to drive
    // the runner's per-file error-isolation branch (discovery lists it, load
    // fails). This is what actually exercises res.failed / res.errors.
    mkdirSync(join(root, 'gardener', '2026-06-05-0900.md'), { recursive: true });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers, scores, and persists scores.jsonl per worker', () => {
    const res = scoreHistory(root);
    expect(res.discovered).toBeGreaterThanOrEqual(3);
    expect(res.scored).toBeGreaterThanOrEqual(3);
    expect(res.rows.length).toBe(res.scored * 3);
    // files written
    const sentinelScores = readScores(scoresPathFor(root, 'sentinel'));
    expect(sentinelScores.length).toBe(6); // 2 runs x 3 checks
    const gardenerScores = readScores(scoresPathFor(root, 'gardener'));
    expect(gardenerScores.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent: re-running upserts instead of duplicating', () => {
    scoreHistory(root);
    scoreHistory(root);
    const sentinelScores = readScores(scoresPathFor(root, 'sentinel'));
    expect(sentinelScores.length).toBe(6); // still 6, not 12/18
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

  it('isolates a per-file load failure without aborting the batch', () => {
    // The unreadable `2026-06-05-0900.md` (a directory) is discovered but
    // throws on read. The runner must record it in errors/failed and STILL
    // score every readable transcript — one corrupt file never blocks the rest.
    const res = scoreHistory(root, { persist: false });
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(res.errors.length).toBe(res.failed);
    const bad = res.errors.find((e) => e.path.endsWith('2026-06-05-0900.md'));
    expect(bad).toBeDefined();
    expect(bad?.error).toMatch(/EISDIR|illegal operation|directory/i);
    // Isolation: the good sentinel runs were still scored despite the failure.
    expect(res.scored).toBeGreaterThanOrEqual(3);
    expect(res.scores.some((s) => s.worker === 'sentinel')).toBe(true);
    // discovered counts both the failures and the successes.
    expect(res.discovered).toBe(res.scored + res.failed);
  });

  it('reports failed as 0 when every discovered transcript loads', () => {
    const res = scoreHistory(root, { workers: ['sentinel'], persist: false });
    expect(res.failed).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('skips excluded workers', () => {
    const res = scoreHistory(root, { excludeWorkers: ['gardener'], persist: false });
    // gardener held the empty/garbage/unreadable fixtures; excluding it drops
    // both its scored rows and its load failure.
    expect(res.scores.every((s) => s.worker !== 'gardener')).toBe(true);
    expect(res.errors.every((e) => !e.path.includes('gardener'))).toBe(true);
    expect(res.failed).toBe(0);
    expect(res.scores.some((s) => s.worker === 'sentinel')).toBe(true);
  });

  it('forwards writeMode: append (blind append) instead of upserting', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'agent-eval-writemode-'));
    try {
      mkdirSync(join(fresh, 'sentinel'), { recursive: true });
      writeFileSync(join(fresh, 'sentinel', '2026-06-08-1815.md'), GOOD_TRANSCRIPT, 'utf8');
      // First pass writes 3 rows regardless of mode.
      const first = scoreHistory(fresh, { writeMode: 'append' });
      expect(first.written[0]?.total).toBe(3);
      // Second append pass blindly appends the same 3 rows — 6 total, no upsert.
      const second = scoreHistory(fresh, { writeMode: 'append' });
      expect(second.written[0]?.replaced).toBe(0);
      expect(second.written[0]?.total).toBe(6);
      expect(readScores(scoresPathFor(fresh, 'sentinel')).length).toBe(6);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('contentless prompt does not inflate failCount', () => {
  // Principle (regression): a structurally complete, on-task run must not be
  // counted as a failure just because its prompt was contentless. Tier 1 checks
  // GATE (did the agent do the thing? -> pass/fail); none of them should trip
  // here. Found by scoring a real SWE-agent HumanEvalFix run whose prompt
  // ("I have a function with a bug, can you help?") was contentless.
  const CONTENTLESS_PROMPT_RUN = `# SWE-agent HumanEvalFix python-0

## Task
I have a function that has a bug and needs to be fixed, can you help?

## Actions Taken
1. open solution.py
2. edit 5:5
3. python test.py
4. submit

## Key Outputs
\`\`\`diff
- if distance < threshold:
+ if abs(distance) < threshold:
\`\`\`

## Outcome
pass - submitted a patch

## Duration
4 steps (wall-clock not recorded)
`;

  it('does not count a contentless-prompt run as a failure', () => {
    const t = parseTranscript(CONTENTLESS_PROMPT_RUN, { filename: 'swe-agent/hef-0.md' });
    const s = scoreTranscript(t);
    // No Tier 1 gate failed here, so the run must not be counted as a failure.
    const tier1Fails = s.checks.filter((c) => c.tier === 1 && c.status === 'fail').length;
    expect(tier1Fails).toBe(0);
    expect(s.failCount).toBe(0);
  });
});
