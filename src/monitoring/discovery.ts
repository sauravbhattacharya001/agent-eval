/**
 * Transcript Discovery - find and load transcript files from disk.
 *
 * Light wrapper over `node:fs` that walks the conventional layout:
 *
 *   <root>/<worker>/YYYY-MM-DD-HHmm.md
 *
 * Filters: by worker, by date range, by limit. Loading is lazy — the
 * discovery functions return file metadata, and {@link loadTranscript}
 * actually reads + parses one. Bulk parse helpers are provided too.
 *
 * @tier 1 - Deterministic
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseTranscript } from './transcript-reader.js';
import type { ParseTranscriptOptions, Transcript, WorkerName } from './types.js';

// ─── DISCOVERY TYPES ───────────────────────────────────────────────────────────

/** Lightweight file descriptor - cheap to enumerate without parsing. */
export interface TranscriptFile {
  /** Worker subdirectory name. */
  worker: WorkerName;
  /** Filename basename (no path), e.g. "2026-06-08-1815.md". */
  filename: string;
  /** Absolute path. */
  path: string;
  /** Date portion of filename, `YYYY-MM-DD`. Empty if filename non-conforming. */
  date: string;
  /** Time portion of filename, `HHmm`. Empty if filename non-conforming. */
  time: string;
  /** Filesystem mtime in ms (sometimes useful as a fallback). */
  mtimeMs: number;
}

/** Options for {@link discoverTranscripts}. */
export interface DiscoveryOptions {
  /** Restrict to one or more workers. */
  workers?: readonly WorkerName[];
  /** Inclusive lower bound `YYYY-MM-DD`. */
  fromDate?: string;
  /** Inclusive upper bound `YYYY-MM-DD`. */
  toDate?: string;
  /** Cap on results returned, after sorting. */
  limit?: number;
  /** Sort order. Default: 'desc' (newest first). */
  order?: 'asc' | 'desc';
  /**
   * Whether to include non-conforming filenames (no `YYYY-MM-DD-HHmm.md`).
   * Default: false (skip them silently).
   */
  includeNonConforming?: boolean;
  /** Subdirectories to skip when walking the root. */
  excludeWorkers?: readonly string[];
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Walk a transcripts root directory and return a sorted list of transcript
 * file descriptors. Does not read or parse files - call {@link loadTranscript}
 * or {@link parseTranscriptFiles} for that.
 *
 * @param root - Root directory containing per-worker subdirectories.
 */
export function discoverTranscripts(
  root: string,
  options: DiscoveryOptions = {},
): TranscriptFile[] {
  const out: TranscriptFile[] = [];
  const order = options.order ?? 'desc';
  const exclude = new Set((options.excludeWorkers ?? []).map((w) => w.toLowerCase()));
  const allowedWorkers = options.workers
    ? new Set(options.workers.map((w) => String(w).toLowerCase()))
    : null;

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const workerName = entry.toLowerCase();
    if (exclude.has(workerName)) continue;
    if (allowedWorkers && !allowedWorkers.has(workerName)) continue;
    const workerDir = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(workerDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    let files: string[];
    try {
      files = readdirSync(workerDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      const fileMatch = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.md$/i.exec(file);
      if (!fileMatch && !options.includeNonConforming) continue;
      const filePath = join(workerDir, file);

      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      const date = fileMatch?.[1] ?? '';
      const time = fileMatch ? `${fileMatch[2]}${fileMatch[3]}` : '';

      if (date) {
        if (options.fromDate && date < options.fromDate) continue;
        if (options.toDate && date > options.toDate) continue;
      }

      out.push({
        worker: workerName,
        filename: file,
        path: filePath,
        date,
        time,
        mtimeMs,
      });
    }
  }

  out.sort((a, b) => {
    const ka = a.date && a.time ? `${a.date}-${a.time}` : String(a.mtimeMs).padStart(20, '0');
    const kb = b.date && b.time ? `${b.date}-${b.time}` : String(b.mtimeMs).padStart(20, '0');
    return order === 'desc' ? (ka > kb ? -1 : ka < kb ? 1 : 0) : ka > kb ? 1 : ka < kb ? -1 : 0;
  });

  if (typeof options.limit === 'number' && options.limit >= 0) {
    return out.slice(0, options.limit);
  }
  return out;
}

/**
 * Read + parse a single transcript file from disk. Inherits identity hints
 * from the file path so the resulting {@link Transcript} has accurate worker,
 * start time, and source.
 */
export function loadTranscript(
  file: TranscriptFile | string,
  options: ParseTranscriptOptions = {},
): Transcript {
  const path = typeof file === 'string' ? file : file.path;
  const filename = typeof file === 'string' ? path : file.path;
  const worker = typeof file === 'string' ? undefined : file.worker;
  const text = readFileSync(path, 'utf8');
  return parseTranscript(text, {
    filename,
    source: path,
    ...(worker ? { worker } : {}),
    ...options,
  });
}

/**
 * Parse a batch of discovered transcript files. Failures are collected per
 * file rather than aborting the batch.
 */
export function parseTranscriptFiles(
  files: readonly TranscriptFile[],
  options: ParseTranscriptOptions = {},
): Array<{ file: TranscriptFile; transcript?: Transcript; error?: string }> {
  return files.map((file) => {
    try {
      const transcript = loadTranscript(file, options);
      return { file, transcript };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { file, error };
    }
  });
}

/**
 * Convenience: discover + parse transcripts in one call.
 */
export function loadTranscripts(
  root: string,
  options: DiscoveryOptions & ParseTranscriptOptions = {},
): Transcript[] {
  const files = discoverTranscripts(root, options);
  const parsed = parseTranscriptFiles(files, options);
  return parsed
    .map((r) => r.transcript)
    .filter((t): t is Transcript => t !== undefined);
}

// ─── DATE HELPERS ──────────────────────────────────────────────────────────────

/**
 * Build an inclusive `[fromDate, toDate]` window covering the last `days`
 * calendar days from `today`. Returns ISO date strings.
 */
export function rollingWindow(days: number, today: Date = new Date()): {
  fromDate: string;
  toDate: string;
} {
  // Normalize `days` to a finite, non-negative integer before any date math.
  // Callers pass this straight through from a CLI/config `window` value, so a
  // non-finite (NaN/Infinity) or fractional input is realistic. Without this
  // guard, `NaN`/`Infinity` flow into `setUTCDate(getUTCDate() - (days - 1))`,
  // producing an Invalid Date whose `isoDate(...)` renders the garbage bound
  // `NaN-NaN-NaN` - a silent corruption that then filters out (or in) the wrong
  // transcripts. A fractional `days` (e.g. 2.5) would likewise shift the start
  // bound by a partial day. Floor to a whole day; treat anything unusable as 0.
  const safeDays = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;

  if (safeDays <= 0) {
    const t = isoDate(today);
    return { fromDate: t, toDate: t };
  }
  const toDate = isoDate(today);
  const start = new Date(today.getTime());
  start.setUTCDate(start.getUTCDate() - (safeDays - 1));
  return { fromDate: isoDate(start), toDate };
}

function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
