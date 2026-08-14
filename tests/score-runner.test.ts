/**
 * Direct tests for the **score-runner** disk-wiring seam
 * (`src/monitoring/score-runner.ts`).
 *
 * `scoreHistory` is the one-call entry point a cron worker / the CLI uses to
 * bring a fleet's `scores.jsonl` up to date: it wires the pure discovery,
 * scorer, and store layers to the filesystem (discover -> load -> score ->
 * persist). Those three layers are each independently tested; this file pins
 * the *orchestration branches the runner owns on its own* — the subtle behaviour
 * a refactor could silently break:
 *
 *   - the `window` -> from/to date resolution (and that explicit dates win)
 *   - per-file error isolation: one corrupt transcript is recorded in `errors`
 *     and does NOT abort scoring of the rest of the fleet
 *   - `persist: false` returns scores without writing any `scores.jsonl`
 *   - `persist: true` writes one `scores.jsonl` per worker and reports `written`
 *   - `limit` caps the batch; `workers` restricts the scan
 *   - an empty root scores nothing and writes nothing (no crash)
 *
 * All fixtures are written to a real temp dir so the `node:fs` calls exercise
 * the actual discovery/store branches (no mocks).
 *
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scoreHistory } from '../src/monitoring/score-runner.js';

// ─── FIXTURES ─────────────────────────────────────────────────────────────────

/** A minimal contract-conforming transcript for a given date. */
function okTranscript(date: string): string {
  return `# Worker Run - ${date} 09:00 PT

## Task
Do a small, well-scoped thing.

## Actions Taken
1. Read the task file
2. Made the change
3. Ran the tests

## Key Outputs
- Commit abc1234: did the thing

## Outcome
pass - the thing was done

## Duration
09:00 -> 09:10 PT, 10 minutes
`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-eval-score-runner-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedWorker(worker: string, dates: string[]): void {
  mkdirSync(join(root, worker), { recursive: true });
  for (const date of dates) {
    writeFileSync(join(root, worker, `${date}-0900.md`), okTranscript(date));
  }
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe('scoreHistory (score-runner disk wiring)', () => {
  it('discovers, scores, and persists one scores.jsonl per worker', () => {
    seedWorker('builder', ['2026-06-05', '2026-06-06']);
    seedWorker('sentinel', ['2026-06-06']);

    const result = scoreHistory(root);

    expect(result.discovered).toBe(3);
    expect(result.scored).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    // rows are the flattened per-check scores across all transcripts
    expect(result.rows.length).toBe(result.scores.flatMap((s) => s.checks).length);

    // one scores.jsonl written per worker that had rows
    const workers = result.written.map((w) => w.path);
    expect(workers.some((p) => p.includes(join('builder', 'scores.jsonl')))).toBe(true);
    expect(workers.some((p) => p.includes(join('sentinel', 'scores.jsonl')))).toBe(true);
    expect(existsSync(join(root, 'builder', 'scores.jsonl'))).toBe(true);
    expect(existsSync(join(root, 'sentinel', 'scores.jsonl'))).toBe(true);
    for (const w of result.written) {
      expect(w.total).toBeGreaterThan(0);
    }
  });

  it('persist:false returns scores without touching disk', () => {
    seedWorker('builder', ['2026-06-05']);

    const result = scoreHistory(root, { persist: false });

    expect(result.scored).toBe(1);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.written).toEqual([]);
    expect(existsSync(join(root, 'builder', 'scores.jsonl'))).toBe(false);
  });

  it('isolates an unreadable transcript: it lands in errors, the rest still score', () => {
    seedWorker('builder', ['2026-06-05', '2026-06-06']);
    // Discovery walks by filename, so a *directory* named like a conforming
    // transcript is picked up, but loadTranscript's readFileSync throws (EISDIR).
    // The runner must isolate that failure and still score the two real files.
    mkdirSync(join(root, 'builder', '2026-06-07-0900.md'), { recursive: true });

    const result = scoreHistory(root, { persist: false });

    expect(result.discovered).toBe(3);
    expect(result.scored).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain('2026-06-07-0900.md');
    expect(result.errors[0]?.error).toBeTruthy();
  });

  it('window resolves to a trailing date range relative to `today`', () => {
    seedWorker('builder', ['2026-06-01', '2026-06-10', '2026-06-11']);

    // window:3 ending 2026-06-11 => [2026-06-09 .. 2026-06-11]; only 06-10/06-11 qualify.
    const result = scoreHistory(root, {
      persist: false,
      window: 3,
      today: new Date('2026-06-11T12:00:00Z'),
    });

    expect(result.discovered).toBe(2);
    expect(result.scored).toBe(2);
  });

  it('explicit from/to dates win over window', () => {
    seedWorker('builder', ['2026-06-01', '2026-06-10', '2026-06-11']);

    const result = scoreHistory(root, {
      persist: false,
      window: 1,
      today: new Date('2026-06-11T12:00:00Z'),
      fromDate: '2026-06-01',
      toDate: '2026-06-01',
    });

    // only the single in-range file, despite window:1 pointing at 06-11
    expect(result.discovered).toBe(1);
    expect(result.scored).toBe(1);
  });

  it('limit caps the batch and workers restricts the scan', () => {
    seedWorker('builder', ['2026-06-05', '2026-06-06', '2026-06-07']);
    seedWorker('sentinel', ['2026-06-06']);

    const limited = scoreHistory(root, { persist: false, limit: 2 });
    expect(limited.discovered).toBe(2);
    expect(limited.scored).toBe(2);

    const onlyBuilder = scoreHistory(root, { persist: false, workers: ['builder'] });
    expect(onlyBuilder.discovered).toBe(3);
    expect(
      onlyBuilder.scores.every((s) => s.checks.every((c) => c.worker === 'builder')),
    ).toBe(true);
  });

  it('an empty root scores nothing and writes nothing (no crash)', () => {
    const result = scoreHistory(root);

    expect(result.discovered).toBe(0);
    expect(result.scored).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.written).toEqual([]);
  });
});
