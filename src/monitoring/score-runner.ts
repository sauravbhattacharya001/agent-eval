/**
 * Score Runner — orchestrates discover → load → score → persist.
 *
 * This is the one-call entry point a cron worker (or the CLI) uses to bring a
 * worker's `scores.jsonl` up to date:
 *
 *     scoreHistory('…/transcripts', { workers: ['sentinel'], window: 7 })
 *
 * It deliberately sits *above* the pure scorer (`scorer.ts`) and the pure store
 * (`scores-store.ts`) so each of those stays independently testable. The runner
 * just wires them to the filesystem.
 *
 * @tier 1+2
 * @module
 */

import { discoverTranscripts, loadTranscript, rollingWindow } from './discovery.js';
import type { DiscoveryOptions } from './discovery.js';
import { scoreTranscript } from './scorer.js';
import type { CheckScore, ScoreTranscriptOptions, TranscriptScore } from './scorer.js';
import { writeScoresByWorker } from './scores-store.js';
import type { WriteScoresOptions } from './scores-store.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Options for {@link scoreHistory}. */
export interface ScoreHistoryOptions extends ScoreTranscriptOptions {
  /** Restrict to specific workers (directory names under the root). */
  workers?: readonly string[];
  /** Inclusive `YYYY-MM-DD` lower bound. */
  fromDate?: string;
  /** Inclusive `YYYY-MM-DD` upper bound. */
  toDate?: string;
  /**
   * Convenience: score only the trailing `window` calendar days (relative to
   * {@link ScoreHistoryOptions.today}). Overridden by explicit from/to dates.
   */
  window?: number;
  /** Reference "today" for {@link ScoreHistoryOptions.window}. Default: now. */
  today?: Date;
  /** Cap the number of transcripts scored (after date filtering + sort). */
  limit?: number;
  /**
   * Whether to write results to `scores.jsonl`. Default: true. Set false for a
   * dry run that returns scores without touching disk.
   */
  persist?: boolean;
  /** Write mode forwarded to the store. Default: 'upsert' (idempotent). */
  writeMode?: WriteScoresOptions['mode'];
  /** Subdirectories to ignore when scanning the root. */
  excludeWorkers?: readonly string[];
}

/** Result of a {@link scoreHistory} run. */
export interface ScoreHistoryResult {
  /** Per-transcript scores, newest first. */
  scores: TranscriptScore[];
  /** Flat score rows that were produced. */
  rows: CheckScore[];
  /** Number of transcript files discovered after filtering. */
  discovered: number;
  /** Number of transcripts successfully parsed + scored. */
  scored: number;
  /** Number of files that failed to parse/score. */
  failed: number;
  /** Parse/score failures: file path → error message. */
  errors: Array<{ path: string; error: string }>;
  /** Per-worker persistence summaries (empty when `persist: false`). */
  written: Array<{ path: string; added: number; replaced: number; total: number }>;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Discover, parse, score, and (optionally) persist transcript scores under a
 * transcripts root.
 *
 * Failures are isolated per file: one unparseable transcript is recorded in
 * {@link ScoreHistoryResult.errors} and does not abort the batch. This matters
 * for a cron job — a single corrupt transcript should never block scoring of
 * the other 50.
 *
 * @param root - Transcripts root containing per-worker subdirectories.
 * @param options - Filtering, scoring thresholds, and persistence controls.
 */
export function scoreHistory(root: string, options: ScoreHistoryOptions = {}): ScoreHistoryResult {
  const persist = options.persist ?? true;

  // Resolve the date window.
  let fromDate = options.fromDate;
  let toDate = options.toDate;
  if (options.window !== undefined && fromDate === undefined && toDate === undefined) {
    const win = rollingWindow(options.window, options.today ?? new Date());
    fromDate = win.fromDate;
    toDate = win.toDate;
  }

  const discoveryOpts: DiscoveryOptions = {
    ...(options.workers ? { workers: options.workers } : {}),
    ...(options.excludeWorkers ? { excludeWorkers: options.excludeWorkers } : {}),
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    order: 'desc',
  };

  const files = discoverTranscripts(root, discoveryOpts);

  const scores: TranscriptScore[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const file of files) {
    try {
      const transcript = loadTranscript(file);
      scores.push(scoreTranscript(transcript, options));
    } catch (e) {
      errors.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const rows = scores.flatMap((s) => s.checks);

  let written: ScoreHistoryResult['written'] = [];
  if (persist && rows.length > 0) {
    const mode = options.writeMode ?? 'upsert';
    written = writeScoresByWorker(root, rows, { mode }).map((w) => ({
      path: w.path,
      added: w.added,
      replaced: w.replaced,
      total: w.total,
    }));
  }

  return {
    scores,
    rows,
    discovered: files.length,
    scored: scores.length,
    failed: errors.length,
    errors,
    written,
  };
}
