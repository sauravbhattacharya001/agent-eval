/**
 * Transcript Identity - filename + timezone resolution for worker transcripts.
 *
 * A self-contained cluster that derives the run's {@link TranscriptIdentity}
 * (worker name, start timestamp, date/time) from two hints: the parsed heading
 * title and the filename (`transcripts/<worker>/YYYY-MM-DD-HHmm.md`). The
 * filename is trusted for the start timestamp because it is generated
 * programmatically; the title is only a fallback for the worker name.
 *
 * Why a separate module? Identity inference is a distinct concern from the
 * section/outcome/duration structure that `transcript-reader.ts` owns - it is
 * its own bundle of fiddly, individually-testable helpers: the
 * `YYYY-MM-DD-HHmm.md` filename grammar, path basename/parent-dir extraction
 * (both POSIX and Windows separators), and the approximate Pacific-Time DST
 * offset calculator with its March/November Sunday-boundary math. Isolating it
 * here gives that clock/filename logic its own home and its own direct test
 * suite, and keeps the parser focused on document structure. `parseTranscript`
 * imports {@link inferIdentity}; the public API is unchanged.
 *
 * No AI, no network, no clock dependence. Same input => same output, always.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { ParseTranscriptOptions, TranscriptIdentity, WorkerName } from './types.js';

/**
 * Build a {@link TranscriptIdentity} by combining the heading title and the
 * filename hint. We trust the filename for the start timestamp because it is
 * generated programmatically; the title is used only as a fallback for the
 * worker name.
 */
export function inferIdentity(
  title: string,
  options: ParseTranscriptOptions,
  warnings: string[],
): TranscriptIdentity {
  const filename = options.filename ?? '';
  const baseFilename = basenameOf(filename);

  // Filenames are `YYYY-MM-DD-HHmm.md`.
  const fileMatch = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.md$/i.exec(baseFilename);
  let date = '';
  let time = '';
  if (fileMatch) {
    date = fileMatch[1] ?? '';
    const hh = fileMatch[2] ?? '00';
    const mm = fileMatch[3] ?? '00';
    time = `${hh}:${mm}`;
  } else if (baseFilename) {
    warnings.push(`Filename "${baseFilename}" does not match YYYY-MM-DD-HHmm.md`);
  }

  const tz = resolveTimezone(date, options.defaultTimezone);
  let startedAt = '';
  let startedAtMs = Number.NaN;
  if (date && time) {
    startedAt = `${date}T${time}:00${tz}`;
    const parsed = Date.parse(startedAt);
    startedAtMs = Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  // Worker inference order: explicit option → filename's parent dir → title prefix.
  let worker: WorkerName = options.worker ?? '';
  if (!worker) {
    const dirWorker = parentDirectoryName(filename);
    if (dirWorker) worker = dirWorker;
  }
  if (!worker && title) {
    const titleMatch = /^([A-Za-z][A-Za-z0-9_\- ]*?)\s+Run\b/i.exec(title);
    if (titleMatch && titleMatch[1]) {
      worker = titleMatch[1].toLowerCase().replace(/\s+/g, '-');
    }
  }
  if (!worker) worker = 'unknown';

  return {
    worker,
    startedAt,
    startedAtMs,
    filename: baseFilename,
    date,
    time,
  };
}

/**
 * Resolve the UTC offset for a transcript. An explicit override wins; `'auto'`
 * infers the Pacific-Time offset from the date; otherwise defaults to PDT.
 */
export function resolveTimezone(date: string, override?: string | 'auto'): string {
  if (override && override !== 'auto') return override;
  if (override === 'auto' && date) {
    return inferPacificOffset(date);
  }
  return '-07:00';
}

/**
 * Approximate Pacific Time DST offset. PDT (UTC-7) ≈ second Sunday of March
 * to first Sunday of November; PST (UTC-8) the rest of the year. Sufficient
 * for transcript timestamps which only need minute-level accuracy.
 */
export function inferPacificOffset(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return '-07:00';
  const year = parseInt(m[1] ?? '0', 10);
  const month = parseInt(m[2] ?? '0', 10);
  const day = parseInt(m[3] ?? '0', 10);
  // Crude: March (post-second-Sunday) through October is PDT.
  if (month > 3 && month < 11) return '-07:00';
  if (month < 3 || month > 11) return '-08:00';
  // March/November - approximate Sunday boundaries.
  // Second Sunday of March:
  if (month === 3) {
    const firstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSunday = 1 + ((7 - firstDow) % 7) + 7;
    return day >= secondSunday ? '-07:00' : '-08:00';
  }
  // First Sunday of November:
  const firstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return day < firstSunday ? '-07:00' : '-08:00';
}

/** Extract the basename (final path segment) from a POSIX or Windows path. */
export function basenameOf(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

/** Extract the parent directory name (used as the worker hint), lower-cased. */
export function parentDirectoryName(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const segments = norm.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return '';
  return (segments[segments.length - 2] ?? '').toLowerCase();
}
