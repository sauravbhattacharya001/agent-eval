/**
 * Scores Store — JSONL persistence for historical {@link CheckScore} rows.
 *
 * Scores live next to the transcripts they describe:
 *
 *     transcripts/<worker>/scores.jsonl
 *
 * One JSON object per line, append-only by default. JSONL is chosen over a
 * single JSON array on purpose: it is crash-safe (a half-written final line is
 * recoverable), greppable, and cheap to append to without rewriting the whole
 * file. The trend detector and scorecard read these rows back; nothing else in
 * the framework needs a database.
 *
 * Idempotency: re-scoring the same run should not duplicate rows. {@link
 * writeScoresFor} and {@link upsertScores} key on `(worker, runId, check)` and
 * replace prior rows for that key, so a twice-daily cron that re-scores recent
 * transcripts converges instead of growing without bound.
 *
 * @tier 1 — Deterministic (pure fs + JSON, no AI)
 * @module
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckScore } from './scorer.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Result of a write operation against a scores file. */
export interface WriteScoresResult {
  /** Absolute path written. */
  path: string;
  /** Rows added. */
  added: number;
  /** Rows replaced (same `(worker, runId, check)` key existed before). */
  replaced: number;
  /** Total rows in the file after the write. */
  total: number;
}

/** Options controlling how scores are persisted. */
export interface WriteScoresOptions {
  /**
   * Append mode. `'upsert'` (default) replaces rows with the same
   * `(worker, runId, check)` key — idempotent re-scoring. `'append'` blindly
   * appends (faster, but a re-run duplicates rows). `'replace'` truncates the
   * file and writes only the supplied rows.
   */
  mode?: 'upsert' | 'append' | 'replace';
}

// ─── PATHS ──────────────────────────────────────────────────────────────────────

/**
 * Resolve the scores file path for a worker under a transcripts root.
 * `<root>/<worker>/scores.jsonl`.
 */
export function scoresPathFor(root: string, worker: string): string {
  return join(root, worker, 'scores.jsonl');
}

// ─── READ ──────────────────────────────────────────────────────────────────────

/**
 * Read and parse a `scores.jsonl` file. Malformed lines are skipped (not
 * fatal) so one bad row can't poison the whole history. Returns `[]` if the
 * file does not exist.
 *
 * @param path - Absolute path to a `scores.jsonl` file.
 */
export function readScores(path: string): CheckScore[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseScoresJsonl(text);
}

/**
 * Read all worker score files under a transcripts root and concatenate them.
 *
 * @param root - Transcripts root containing per-worker subdirectories.
 * @param workers - Optional explicit worker list; defaults to scanning the root.
 */
export function readAllScores(root: string, workers?: readonly string[]): CheckScore[] {
  const names = workers ?? listWorkerDirs(root);
  const out: CheckScore[] = [];
  for (const w of names) {
    out.push(...readScores(scoresPathFor(root, w)));
  }
  return out;
}

/**
 * Parse raw JSONL text into {@link CheckScore} rows, skipping blank and
 * malformed lines (bad JSON, wrong shape, or a non-finite `score`). Exposed
 * for callers that already have the text in hand (e.g. tests, streamed input).
 */
export function parseScoresJsonl(text: string): CheckScore[] {
  const out: CheckScore[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (isCheckScore(obj)) out.push(obj);
    } catch {
      // Skip malformed line — JSONL is resilient by design.
    }
  }
  return out;
}

/** Serialize rows to JSONL text (trailing newline included when non-empty). */
export function serializeScoresJsonl(rows: readonly CheckScore[]): string {
  if (rows.length === 0) return '';
  return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

// ─── WRITE ──────────────────────────────────────────────────────────────────────

/**
 * Write score rows to an explicit `scores.jsonl` path, creating parent
 * directories as needed. Honors {@link WriteScoresOptions.mode}.
 *
 * @param path - Absolute path to the `scores.jsonl` file.
 * @param rows - New rows to persist.
 * @param options - Write mode (default: upsert).
 */
export function writeScores(
  path: string,
  rows: readonly CheckScore[],
  options: WriteScoresOptions = {},
): WriteScoresResult {
  const mode = options.mode ?? 'upsert';
  ensureDir(dirname(path));

  if (mode === 'replace') {
    writeFileSync(path, serializeScoresJsonl(rows), 'utf8');
    return { path, added: rows.length, replaced: 0, total: rows.length };
  }

  if (mode === 'append') {
    const existing = readScores(path);
    const merged = [...existing, ...rows];
    writeFileSync(path, serializeScoresJsonl(merged), 'utf8');
    return { path, added: rows.length, replaced: 0, total: merged.length };
  }

  // upsert
  const existing = readScores(path);
  const { merged, added, replaced } = upsertRows(existing, rows);
  writeFileSync(path, serializeScoresJsonl(merged), 'utf8');
  return { path, added, replaced, total: merged.length };
}

/**
 * Write score rows for one worker under a transcripts root, routing to
 * `<root>/<worker>/scores.jsonl`. All rows must belong to the same worker;
 * mixed-worker input throws (each worker owns its own file).
 *
 * @param root - Transcripts root.
 * @param rows - Rows for a single worker.
 * @param options - Write mode.
 */
export function writeScoresFor(
  root: string,
  rows: readonly CheckScore[],
  options: WriteScoresOptions = {},
): WriteScoresResult {
  const first = rows[0];
  if (first === undefined) {
    return { path: '', added: 0, replaced: 0, total: 0 };
  }
  const worker = first.worker;
  for (const r of rows) {
    if (r.worker !== worker) {
      throw new Error(
        `writeScoresFor: all rows must share one worker; got "${worker}" and "${r.worker}". ` +
          `Group rows by worker (e.g. with groupRowsByWorker) before writing.`,
      );
    }
  }
  return writeScores(scoresPathFor(root, worker), rows, options);
}

/**
 * Persist rows spanning multiple workers, fanning out to each worker's file.
 * Returns one {@link WriteScoresResult} per worker touched.
 *
 * @param root - Transcripts root.
 * @param rows - Rows for any number of workers.
 * @param options - Write mode applied per-file.
 */
export function writeScoresByWorker(
  root: string,
  rows: readonly CheckScore[],
  options: WriteScoresOptions = {},
): WriteScoresResult[] {
  const groups = groupRowsByWorker(rows);
  const results: WriteScoresResult[] = [];
  for (const [, group] of groups) {
    results.push(writeScoresFor(root, group, options));
  }
  return results;
}

/**
 * Upsert rows into an existing array (pure — no I/O). Exposed for callers that
 * manage their own persistence. Later rows win on key collision.
 */
export function upsertScores(
  existing: readonly CheckScore[],
  incoming: readonly CheckScore[],
): CheckScore[] {
  return upsertRows(existing, incoming).merged;
}

// ─── GROUPING / KEYS ──────────────────────────────────────────────────────────

/** The dedupe key for a score row: worker + run + check. */
export function scoreKey(row: CheckScore): string {
  return `${row.worker}\u0000${row.runId}\u0000${row.check}`;
}

/** Group rows by worker, preserving first-seen order. */
export function groupRowsByWorker(rows: readonly CheckScore[]): Map<string, CheckScore[]> {
  const map = new Map<string, CheckScore[]>();
  for (const r of rows) {
    const list = map.get(r.worker);
    if (list) list.push(r);
    else map.set(r.worker, [r]);
  }
  return map;
}

// ─── INTERNAL ──────────────────────────────────────────────────────────────────

function upsertRows(
  existing: readonly CheckScore[],
  incoming: readonly CheckScore[],
): { merged: CheckScore[]; added: number; replaced: number } {
  const byKey = new Map<string, CheckScore>();
  const order: string[] = [];

  for (const row of existing) {
    const k = scoreKey(row);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, row);
  }

  let added = 0;
  let replaced = 0;
  for (const row of incoming) {
    const k = scoreKey(row);
    if (byKey.has(k)) replaced += 1;
    else {
      added += 1;
      order.push(k);
    }
    byKey.set(k, row);
  }

  const merged: CheckScore[] = [];
  for (const k of order) {
    const row = byKey.get(k);
    if (row !== undefined) merged.push(row);
  }
  return { merged, added, replaced };
}

function ensureDir(dir: string): void {
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function listWorkerDirs(root: string): string[] {
  // Directory scan; tolerate a missing root.
  try {
    return readdirSync(root).filter((entry: string) => {
      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function isCheckScore(obj: unknown): obj is CheckScore {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.worker === 'string' &&
    typeof o.runId === 'string' &&
    typeof o.check === 'string' &&
    // A non-finite score (Infinity/-Infinity from a JSONL literal like `1e999`,
    // or a NaN sentinel) is treated as malformed and dropped: it would poison
    // every downstream mean/z-score/rollup, breaking this store's core promise
    // that one bad row can't corrupt the whole history.
    typeof o.score === 'number' &&
    Number.isFinite(o.score) &&
    typeof o.status === 'string'
  );
}
