/**
 * Direct-seam tests for the pure per-check scoring engine (`scorer-checks.ts`).
 *
 * `scorer.test.ts` exercises the whole pipeline through `scoreTranscript`; this
 * file pins the individual, now-isolated pure functions the orchestrator drives:
 * the option-resolution helpers (`resolveTimeout`, `resolveRunMetadata`) and the
 * three per-check scorers (`scoreStaleness`, `scoreVerification`,
 * `scoreCompleteness`) in isolation. Testing them directly makes the seams the
 * split exposed a first-class contract — every branch (map vs single-record
 * metadata, timeout fallbacks, the verification outcome/duration/completion
 * mismatches) is covered without a full transcript round-trip.
 *
 * Fixtures embed identity in the `# <Worker> Run` heading, but the scorer
 * derives `startedAtMs` (and the synthetic start/end timeline events) from the
 * FILENAME — so every fixture is parsed with a matching `filename` hint via
 * `build(md, filename)`, exactly as the on-disk path does.
 *
 * @tier 1+2 - Deterministic + Heuristic (no AI, reproducible, offline)
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_OUTPUT_WORDS,
  DEFAULT_TIMEOUT_BUDGETS,
  resolveRunMetadata,
  resolveTimeout,
  scoreCompleteness,
  scoreStaleness,
  scoreVerification,
} from '../src/monitoring/scorer-checks.js';
import type { RunMetadata } from '../src/monitoring/scorer.js';
import { parseTranscript } from '../src/monitoring/transcript-reader.js';
import type { Transcript } from '../src/monitoring/types.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────────

/** A healthy, substantive sentinel run with a clean 17-minute duration. */
const GOOD = `# Sentinel Run - 2026-06-08 18:15 PT

## Task
Implement the badge command handler in the WinSentinel CLI, build it, run the
test suite, and push the feature to main.

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
pass - the badge command handler was fully implemented, tested, and pushed

## Errors & Retries
- Initial dotnet build failed on a missing restore - ran restore first

## Duration
18:15 PT -> 18:32 PT (17 minutes)
`;
const GOOD_FILE = 'sentinel/2026-06-08-1815.md';

/** An IN-PROGRESS stub with empty deliverables. */
const EMPTY = `# Gardener Run - 2026-06-08 09:00 PT

## Task
Review open repositories, pick a maintenance task, implement it, and push.

## Actions Taken

## Key Outputs

## Outcome
IN-PROGRESS

## Duration
09:00 PT ->
`;
const EMPTY_FILE = 'gardener/2026-06-08-0900.md';

/** A run that claims success, ~2 hours long (for duration-mismatch tests). */
const CLAIMS_PASS = `# Builder Run - 2026-06-08 10:00 PT

## Task
Build a new feature end to end and push it to main.

## Actions Taken
1. Cloned the repository into a temp working directory
2. Implemented the requested feature with production-quality code
3. Added unit tests covering the new behavior and edge cases
4. Ran the full build and test suite until everything was green

## Key Outputs
- Commit abc1234: implement the requested feature with tests
- All build and test steps completed successfully before pushing

## Outcome
pass - the feature shipped and the suite is green

## Duration
10:00 PT -> 12:00 PT (2 hours)
`;
const CLAIMS_PASS_FILE = 'builder/2026-06-08-1000.md';

/** Parse a fixture with a filename hint so the scorer derives `startedAtMs`
 * (and the synthetic start/end timeline events) exactly as the disk path does. */
function build(md: string, filename: string): Transcript {
  return parseTranscript(md, { filename });
}

// ─── resolveTimeout ────────────────────────────────────────────────────────────────

describe('resolveTimeout', () => {
  it('returns a single numeric budget applied to any worker', () => {
    expect(resolveTimeout('sentinel', 5000)).toBe(5000);
    expect(resolveTimeout('anything', 5000)).toBe(5000);
  });

  it('reads a per-worker map entry when present', () => {
    expect(resolveTimeout('sentinel', { sentinel: 1234, blog: 999 })).toBe(1234);
  });

  it('returns undefined for a worker missing from an explicit map (no default fallback)', () => {
    // An explicit map is authoritative: a worker not in it gets no penalty
    // rather than silently inheriting a built-in budget.
    expect(resolveTimeout('ghost', { sentinel: 1234 })).toBeUndefined();
  });

  it('falls back to the built-in default budget when no option is supplied', () => {
    expect(resolveTimeout('sentinel', undefined)).toBe(DEFAULT_TIMEOUT_BUDGETS.sentinel);
    expect(resolveTimeout('builder', undefined)).toBe(DEFAULT_TIMEOUT_BUDGETS.builder);
  });

  it('returns undefined for an unknown worker when relying on defaults', () => {
    expect(resolveTimeout('mystery-worker', undefined)).toBeUndefined();
  });
});

// ─── resolveRunMetadata ──────────────────────────────────────────────────────────

describe('resolveRunMetadata', () => {
  const single: RunMetadata = { exitStatus: 'ok', exitCode: 0 };

  it('returns undefined when no metadata option is supplied', () => {
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', undefined)).toBeUndefined();
  });

  it('treats a record with its own known keys as a single record (applied directly)', () => {
    expect(resolveRunMetadata('any-run', 'any-worker', single)).toEqual(single);
  });

  it('resolves a map keyed by exact runId', () => {
    const map = { '2026-06-08-1815': single };
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', map)).toEqual(single);
  });

  it('resolves a map keyed by `worker/runId`', () => {
    const meta: RunMetadata = { exitStatus: 'error' };
    const map = { 'sentinel/2026-06-08-1815': meta };
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', map)).toEqual(meta);
  });

  it('falls back to a worker-keyed entry', () => {
    const meta: RunMetadata = { exitStatus: 'timeout' };
    const map = { sentinel: meta };
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', map)).toEqual(meta);
  });

  it('prefers an exact runId over a worker-level fallback', () => {
    const exact: RunMetadata = { exitStatus: 'ok' };
    const workerLevel: RunMetadata = { exitStatus: 'error' };
    const map = { '2026-06-08-1815': exact, sentinel: workerLevel };
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', map)).toEqual(exact);
  });

  it('returns undefined when nothing in the map matches', () => {
    const map = { 'other/run': { exitStatus: 'ok' as const } };
    expect(resolveRunMetadata('2026-06-08-1815', 'sentinel', map)).toBeUndefined();
  });
});

// ─── scoreStaleness ──────────────────────────────────────────────────────────────

describe('scoreStaleness', () => {
  it('scores a healthy run as a pass with full credit', () => {
    const r = scoreStaleness(build(GOOD, GOOD_FILE), DEFAULT_TIMEOUT_BUDGETS.sentinel);
    expect(r.status).toBe('pass');
    expect(r.score).toBe(1);
    expect(r.summary).toContain('ok');
    expect(r.detail.errors).toBe(0);
    expect(r.detail.hasEnd).toBe(true);
  });

  it('flags an over-budget run as stale (fail) via the timeout signal', () => {
    // CLAIMS_PASS runs ~2h; a 1-minute budget makes it blow past the timeout.
    const r = scoreStaleness(build(CLAIMS_PASS, CLAIMS_PASS_FILE), 60_000);
    expect(r.status).toBe('fail');
    expect(r.score).toBeLessThan(1);
    expect(r.summary).toContain('stale');
    expect(r.summary).toContain('timeout');
  });

  it('does not penalize a long run when no timeout budget is set', () => {
    const r = scoreStaleness(build(CLAIMS_PASS, CLAIMS_PASS_FILE), undefined);
    expect(r.status).toBe('pass');
    expect(r.score).toBe(1);
  });

  it('flags a stub with no deliverables / no finished outcome', () => {
    const r = scoreStaleness(build(EMPTY, EMPTY_FILE), DEFAULT_TIMEOUT_BUDGETS.gardener);
    expect(r.score).toBeLessThan(1);
    expect(['warn', 'fail']).toContain(r.status);
  });

  it('always reports a numeric detail block', () => {
    const r = scoreStaleness(build(GOOD, GOOD_FILE), undefined);
    expect(typeof r.detail.durationMs).toBe('number');
    expect(typeof r.detail.outputEvents).toBe('number');
  });
});

// ─── scoreVerification ───────────────────────────────────────────────────────────

describe('scoreVerification', () => {
  it('skips (no score impact) when no metadata is supplied', () => {
    const r = scoreVerification(build(GOOD, GOOD_FILE), undefined);
    expect(r.status).toBe('skip');
    expect(r.summary).toContain('no run metadata');
    expect(r.detail).toEqual({});
  });

  it('passes when the self-report agrees with the orchestrator', () => {
    const r = scoreVerification(build(GOOD, GOOD_FILE), { exitStatus: 'ok', exitCode: 0 });
    expect(r.status).toBe('pass');
    expect(r.score).toBe(1);
    expect(r.detail.truthOutcome).toBe('pass');
  });

  it('hard-fails when the transcript claims pass but the run errored', () => {
    const r = scoreVerification(build(CLAIMS_PASS, CLAIMS_PASS_FILE), { exitStatus: 'error' });
    expect(r.status).toBe('fail');
    expect(r.score).toBeLessThan(1);
    expect(r.summary).toContain('claims "pass"');
    expect(r.detail.errors).toBe(1);
  });

  it('hard-fails a claimed pass when the exit code is non-zero (no exitStatus)', () => {
    const r = scoreVerification(build(CLAIMS_PASS, CLAIMS_PASS_FILE), { exitCode: 1 });
    expect(r.status).toBe('fail');
    expect(r.detail.truthOutcome).toBe('fail');
  });

  it('warns (not fails) when the transcript under-reports a real success', () => {
    // FAIL self-report on a run the orchestrator saw succeed → honest under-report.
    const failing = CLAIMS_PASS.replace(
      'pass - the feature shipped and the suite is green',
      'fail - could not finish, giving up',
    );
    const r = scoreVerification(build(failing, CLAIMS_PASS_FILE), { exitStatus: 'ok', exitCode: 0 });
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('reports "fail"');
  });

  it('warns when a finished transcript claims done but the run is still running', () => {
    const r = scoreVerification(build(GOOD, GOOD_FILE), { exitStatus: 'running' });
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('still running');
  });

  it('warns on a wide self-reported vs measured duration discrepancy', () => {
    // Transcript says ~2h; orchestrator measured ~1 minute → clock can't be trusted.
    const r = scoreVerification(build(CLAIMS_PASS, CLAIMS_PASS_FILE), {
      exitStatus: 'ok',
      exitCode: 0,
      durationMs: 60_000,
    });
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('disagrees with measured');
    expect(r.detail.measuredMs).toBe(60_000);
  });

  it('derives measured duration from start/end when durationMs is absent', () => {
    const r = scoreVerification(build(CLAIMS_PASS, CLAIMS_PASS_FILE), {
      exitStatus: 'ok',
      exitCode: 0,
      startedAt: '2026-06-08T17:00:00Z',
      endedAt: '2026-06-08T17:01:00Z', // 1 minute measured vs ~2h claimed
    });
    expect(r.status).toBe('warn');
    expect(r.detail.measuredMs).toBe(60_000);
  });

  it('does not flag a duration discrepancy within tolerance', () => {
    // Claimed ~2h (7_200_000ms), measured ~2h → ratio within [0.66, 1.5].
    const r = scoreVerification(build(CLAIMS_PASS, CLAIMS_PASS_FILE), {
      exitStatus: 'ok',
      exitCode: 0,
      durationMs: 7_000_000,
    });
    expect(r.status).toBe('pass');
  });
});

// ─── scoreCompleteness ───────────────────────────────────────────────────────────

describe('scoreCompleteness', () => {
  it('scores a substantive transcript as complete', () => {
    const r = scoreCompleteness(build(GOOD, GOOD_FILE), DEFAULT_MIN_OUTPUT_WORDS);
    expect(r.status).toBe('pass');
    expect(r.score).toBe(1);
    expect(r.summary).toContain('complete');
    expect(Number(r.detail.words)).toBeGreaterThan(DEFAULT_MIN_OUTPUT_WORDS);
  });

  it('fails outright when both deliverable sections are empty', () => {
    const r = scoreCompleteness(build(EMPTY, EMPTY_FILE), DEFAULT_MIN_OUTPUT_WORDS);
    expect(r.status).toBe('fail');
    expect(r.score).toBe(0);
    expect(r.summary).toContain('no deliverables');
    expect(r.detail.words).toBe(0);
  });

  it('penalizes a run below the word-count floor', () => {
    // Raise the floor so the otherwise-fine GOOD transcript is judged short.
    const r = scoreCompleteness(build(GOOD, GOOD_FILE), 10_000);
    expect(r.status).toBe('fail');
    expect(r.score).toBeLessThan(1);
    expect(r.summary).toContain('incomplete');
  });

  it('reports a unique-word ratio in the detail block', () => {
    const r = scoreCompleteness(build(GOOD, GOOD_FILE), DEFAULT_MIN_OUTPUT_WORDS);
    expect(typeof r.detail.uniqueRatio).toBe('number');
    expect(Number(r.detail.uniqueRatio)).toBeGreaterThan(0);
    expect(Number(r.detail.uniqueRatio)).toBeLessThanOrEqual(1);
  });
});
