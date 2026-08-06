/**
 * Tests for the Scores Store — the JSONL persistence layer for historical
 * {@link CheckScore} rows (`src/monitoring/scores-store.ts`).
 *
 * Until now this pillar-2 disk layer was only exercised *indirectly* through
 * the scorer / trend runners. These tests hit its public functions through
 * their OWN module path and pin the behaviours that make the store safe for a
 * twice-daily cron:
 *
 *   - JSONL resilience: blank + malformed lines are skipped, never fatal, and
 *     rows that don't match the {@link CheckScore} shape (the `isCheckScore`
 *     guard) are dropped rather than trusted.
 *   - Round-trip: `serializeScoresJsonl` → `parseScoresJsonl` is identity for
 *     well-formed rows, with a trailing newline on non-empty output and an
 *     empty string for zero rows.
 *   - Idempotent upsert: re-writing the same `(worker, runId, check)` key
 *     replaces in place (converges) rather than duplicating; later rows win.
 *   - Fan-out + guards: `writeScoresByWorker` routes each worker to its own
 *     file; `writeScoresFor` rejects mixed-worker input; `readAllScores`
 *     concatenates per-worker files and tolerates a missing root.
 *
 * Pure fs + JSON, no AI, no network. Same input → same output.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import type { CheckScore } from '../src/monitoring/scorer.js';

/** Build a well-formed CheckScore row with sensible defaults. */
function row(overrides: Partial<CheckScore> = {}): CheckScore {
  return {
    worker: 'sentinel',
    runId: '2026-08-05-1800',
    startedAt: '2026-08-05T18:00:00.000Z',
    startedAtMs: Date.parse('2026-08-05T18:00:00.000Z'),
    check: 'staleness',
    tier: 1,
    score: 1,
    status: 'pass',
    summary: 'ok',
    ...overrides,
  } as CheckScore;
}

describe('scores-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-eval-scores-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── path resolution ───────────────────────────────────────────────────────

  describe('scoresPathFor', () => {
    it('resolves <root>/<worker>/scores.jsonl', () => {
      expect(scoresPathFor('/t/root', 'sentinel')).toBe(
        join('/t/root', 'sentinel', 'scores.jsonl'),
      );
    });
  });

  // ─── serialize / parse round-trip ────────────────────────────────────────────

  describe('serializeScoresJsonl / parseScoresJsonl', () => {
    it('serializes zero rows to an empty string (no stray newline)', () => {
      expect(serializeScoresJsonl([])).toBe('');
    });

    it('serializes non-empty rows with a trailing newline', () => {
      const text = serializeScoresJsonl([row(), row({ check: 'completeness' })]);
      expect(text.endsWith('\n')).toBe(true);
      // one JSON object per line, no blank final line beyond the terminator
      expect(text.trimEnd().split('\n')).toHaveLength(2);
    });

    it('round-trips well-formed rows (serialize → parse is identity)', () => {
      const rows = [row(), row({ runId: '2026-08-05-1200', check: 'drift', score: 0.5, status: 'warn' })];
      expect(parseScoresJsonl(serializeScoresJsonl(rows))).toEqual(rows);
    });

    it('skips blank lines', () => {
      const text = `\n${JSON.stringify(row())}\n\n   \n`;
      expect(parseScoresJsonl(text)).toHaveLength(1);
    });

    it('skips syntactically malformed JSON lines', () => {
      const text = `{not json\n${JSON.stringify(row())}\n}}}`;
      const parsed = parseScoresJsonl(text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.worker).toBe('sentinel');
    });

    it('drops well-formed JSON that is not a CheckScore (isCheckScore guard)', () => {
      const bad = [
        JSON.stringify({ hello: 'world' }), // missing all required fields
        JSON.stringify({ worker: 'x', runId: 'r', check: 'c', score: '1', status: 'pass' }), // score not a number
        JSON.stringify({ worker: 'x', runId: 'r', check: 'c', score: 1 }), // missing status
        JSON.stringify(null),
        JSON.stringify(42),
        JSON.stringify(['array']),
      ].join('\n');
      expect(parseScoresJsonl(`${bad}\n${JSON.stringify(row())}`)).toHaveLength(1);
    });

    it('handles CRLF line endings', () => {
      const text = `${JSON.stringify(row())}\r\n${JSON.stringify(row({ check: 'drift' }))}\r\n`;
      expect(parseScoresJsonl(text)).toHaveLength(2);
    });
  });

  // ─── read ────────────────────────────────────────────────────────────────────

  describe('readScores', () => {
    it('returns [] for a nonexistent file', () => {
      expect(readScores(join(dir, 'nope', 'scores.jsonl'))).toEqual([]);
    });

    it('reads back what writeScores wrote', () => {
      const path = scoresPathFor(dir, 'sentinel');
      writeScores(path, [row(), row({ check: 'drift' })]);
      expect(readScores(path)).toHaveLength(2);
    });

    it('recovers valid rows even when the file has a corrupt final line', () => {
      const path = scoresPathFor(dir, 'sentinel');
      mkdirSync(join(dir, 'sentinel'), { recursive: true });
      writeFileSync(path, `${JSON.stringify(row())}\n{ half-written`, 'utf8');
      expect(readScores(path)).toHaveLength(1);
    });
  });

  describe('readAllScores', () => {
    it('concatenates rows across per-worker files', () => {
      writeScoresFor(dir, [row({ worker: 'sentinel' })]);
      writeScoresFor(dir, [row({ worker: 'builder' }), row({ worker: 'builder', check: 'drift' })]);
      expect(readAllScores(dir)).toHaveLength(3);
    });

    it('honors an explicit worker allow-list', () => {
      writeScoresFor(dir, [row({ worker: 'sentinel' })]);
      writeScoresFor(dir, [row({ worker: 'builder' })]);
      const only = readAllScores(dir, ['builder']);
      expect(only).toHaveLength(1);
      expect(only[0]?.worker).toBe('builder');
    });

    it('tolerates a missing root (returns [])', () => {
      expect(readAllScores(join(dir, 'does-not-exist'))).toEqual([]);
    });

    it('ignores non-directory entries under the root', () => {
      writeFileSync(join(dir, 'stray.txt'), 'not a worker dir', 'utf8');
      writeScoresFor(dir, [row({ worker: 'sentinel' })]);
      expect(readAllScores(dir)).toHaveLength(1);
    });
  });

  // ─── write modes ──────────────────────────────────────────────────────────────

  describe('writeScores modes', () => {
    it('upsert (default) replaces a row with the same (worker, runId, check) key', () => {
      const path = scoresPathFor(dir, 'sentinel');
      const first = writeScores(path, [row({ score: 1, status: 'pass' })]);
      expect(first).toMatchObject({ added: 1, replaced: 0, total: 1 });

      const second = writeScores(path, [row({ score: 0, status: 'fail' })]);
      expect(second).toMatchObject({ added: 0, replaced: 1, total: 1 });

      const back = readScores(path);
      expect(back).toHaveLength(1);
      expect(back[0]?.status).toBe('fail'); // later row wins
    });

    it('append blindly appends (a re-run duplicates rows)', () => {
      const path = scoresPathFor(dir, 'sentinel');
      writeScores(path, [row()], { mode: 'append' });
      const res = writeScores(path, [row()], { mode: 'append' });
      expect(res.total).toBe(2);
      expect(res.replaced).toBe(0);
    });

    it('replace truncates the file and writes only the supplied rows', () => {
      const path = scoresPathFor(dir, 'sentinel');
      writeScores(path, [row(), row({ check: 'drift' }), row({ check: 'completeness' })]);
      const res = writeScores(path, [row({ check: 'format' })], { mode: 'replace' });
      expect(res).toMatchObject({ added: 1, replaced: 0, total: 1 });
      const back = readScores(path);
      expect(back).toHaveLength(1);
      expect(back[0]?.check).toBe('format');
    });

    it('creates parent directories as needed', () => {
      const path = join(dir, 'deep', 'nest', 'sentinel', 'scores.jsonl');
      writeScores(path, [row()]);
      expect(readScores(path)).toHaveLength(1);
    });

    it('upsert converges across three writes of the same run (idempotent cron)', () => {
      const path = scoresPathFor(dir, 'sentinel');
      const rows = [row({ check: 'staleness' }), row({ check: 'drift' })];
      writeScores(path, rows);
      writeScores(path, rows);
      const third = writeScores(path, rows);
      expect(third.total).toBe(2);
      expect(readScores(path)).toHaveLength(2);
    });
  });

  // ─── writeScoresFor guard + fan-out ─────────────────────────────────────────

  describe('writeScoresFor', () => {
    it('is a no-op for an empty row list', () => {
      const res = writeScoresFor(dir, []);
      expect(res).toEqual({ path: '', added: 0, replaced: 0, total: 0 });
    });

    it('routes rows to <root>/<worker>/scores.jsonl', () => {
      const res = writeScoresFor(dir, [row({ worker: 'builder' })]);
      expect(res.path).toBe(scoresPathFor(dir, 'builder'));
    });

    it('throws on mixed-worker input', () => {
      expect(() =>
        writeScoresFor(dir, [row({ worker: 'sentinel' }), row({ worker: 'builder' })]),
      ).toThrow(/all rows must share one worker/);
    });
  });

  describe('writeScoresByWorker', () => {
    it('fans out to one file per worker and returns one result each', () => {
      const results = writeScoresByWorker(dir, [
        row({ worker: 'sentinel' }),
        row({ worker: 'builder' }),
        row({ worker: 'builder', check: 'drift' }),
      ]);
      expect(results).toHaveLength(2);
      expect(readScores(scoresPathFor(dir, 'sentinel'))).toHaveLength(1);
      expect(readScores(scoresPathFor(dir, 'builder'))).toHaveLength(2);
    });

    it('returns [] for no rows', () => {
      expect(writeScoresByWorker(dir, [])).toEqual([]);
    });
  });

  // ─── pure helpers ────────────────────────────────────────────────────────────

  describe('scoreKey', () => {
    it('keys on worker + runId + check', () => {
      expect(scoreKey(row())).toBe('sentinel\u00002026-08-05-1800\u0000staleness');
    });

    it('distinguishes rows differing only in check', () => {
      expect(scoreKey(row({ check: 'drift' }))).not.toBe(scoreKey(row({ check: 'staleness' })));
    });
  });

  describe('groupRowsByWorker', () => {
    it('groups rows by worker preserving first-seen order', () => {
      const map = groupRowsByWorker([
        row({ worker: 'b' }),
        row({ worker: 'a' }),
        row({ worker: 'b', check: 'drift' }),
      ]);
      expect([...map.keys()]).toEqual(['b', 'a']);
      expect(map.get('b')).toHaveLength(2);
      expect(map.get('a')).toHaveLength(1);
    });
  });

  describe('upsertScores (pure)', () => {
    it('adds new keys and replaces existing ones, later row winning', () => {
      const existing = [row({ check: 'staleness', status: 'pass' })];
      const incoming = [row({ check: 'staleness', status: 'fail' }), row({ check: 'drift' })];
      const merged = upsertScores(existing, incoming);
      expect(merged).toHaveLength(2);
      const stale = merged.find((r) => r.check === 'staleness');
      expect(stale?.status).toBe('fail');
    });

    it('preserves existing-first ordering with new keys appended', () => {
      const existing = [row({ check: 'staleness' }), row({ check: 'drift' })];
      const incoming = [row({ check: 'completeness' })];
      const merged = upsertScores(existing, incoming);
      expect(merged.map((r) => r.check)).toEqual(['staleness', 'drift', 'completeness']);
    });
  });
});
