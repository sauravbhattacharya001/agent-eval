/**
 * Transcript Reader - Phase 3.5 Tier 1 Production Monitoring
 *
 * Pure-deterministic parser that turns the structured worker-transcript
 * markdown files written by the cron workers into typed {@link Transcript}
 * objects. The shape is fixed by `worker-common.md`:
 *
 *     # <Worker Name> Run — YYYY-MM-DD HH:mm PT
 *
 *     ## Task
 *     ...
 *     ## Actions Taken
 *     1. ...
 *     ## Key Outputs
 *     ## Outcome
 *     pass / fail / partial
 *     ## Errors & Retries
 *     ## Duration
 *     N minutes
 *
 * No AI, no network, no clock dependence. Same input ⇒ same output, always.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type {
  ParsedDuration,
  ParseTranscriptOptions,
  OutcomeStatus,
  Transcript,
  TranscriptIdentity,
  TranscriptReference,
  TranscriptSection,
  WorkerName,
} from './types.js';

// ─── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Parse a transcript markdown string into a structured {@link Transcript}.
 *
 * Tolerant of minor format drift: missing sections produce empty strings and
 * a warning; unknown sections are preserved on `transcript.sections`. The
 * function never throws on well-formed UTF-8 input; truly malformed input
 * (binary, HTML) yields a transcript with empty sections and a warning so
 * downstream scorers can flag it.
 */
export function parseTranscript(
  source: string,
  options: ParseTranscriptOptions = {},
): Transcript {
  const warnings: string[] = [];
  const lines = source.split(/\r?\n/);

  const title = extractTitle(lines);
  if (!title) {
    warnings.push('Missing top-level `# <Worker> Run …` title');
  }

  const sections = extractSections(lines);
  const bySlug: Record<string, TranscriptSection> = {};
  for (const s of sections) {
    if (bySlug[s.slug]) {
      warnings.push(`Duplicate section "${s.heading}" - using first occurrence`);
      continue;
    }
    bySlug[s.slug] = s;
  }

  const identity = inferIdentity(title, options, warnings);

  const task = bySlug['task']?.body ?? '';
  if (!task) warnings.push('Missing `## Task` section');

  const actionsSection = bySlug['actions-taken'] ?? bySlug['actions'];
  const actions = actionsSection?.body ?? '';
  if (!actions) warnings.push('Missing `## Actions Taken` section');
  const actionItems = extractListItems(actions);

  const keyOutputsSection = bySlug['key-outputs'] ?? bySlug['outputs'];
  const keyOutputs = keyOutputsSection?.body ?? '';

  const outcomeBody = bySlug['outcome']?.body ?? '';
  const outcome = parseOutcome(outcomeBody);

  const errorsSection = bySlug['errors-retries'] ?? bySlug['errors'] ?? bySlug['errors-and-retries'];
  const errors = errorsSection?.body ?? '';
  const hadErrors = isNonTrivialErrorsBody(errors);

  const durationBody = bySlug['duration']?.body ?? '';
  const duration = parseDuration(durationBody);

  let endedAt: string | undefined;
  let endedAtMs = Number.NaN;
  if (Number.isFinite(duration.ms) && Number.isFinite(identity.startedAtMs)) {
    endedAtMs = identity.startedAtMs + duration.ms;
    endedAt = new Date(endedAtMs).toISOString();
  }

  const references = extractReferences(sections);

  return {
    identity,
    title,
    sections,
    bySlug,
    task,
    actions,
    actionItems,
    keyOutputs,
    outcomeBody,
    outcome,
    errors,
    hadErrors,
    durationBody,
    duration,
    endedAt,
    endedAtMs,
    references,
    lineCount: lines.length,
    source: options.source,
    warnings,
  };
}

/**
 * Slugify a section heading deterministically. Lower-cases, strips emoji /
 * punctuation, collapses runs of separators to a single hyphen.
 */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract the top-level `# Title` line. Returns `''` when absent.
 */
export function extractTitle(lines: readonly string[]): string {
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) return line.slice(2).trim();
    // First non-blank non-heading line aborts: title must be at the top.
    if (line.trim() !== '' && !line.startsWith('#')) break;
  }
  return '';
}

/**
 * Extract every `## ...` (depth >= 2) section with its body. Sections at depth
 * 1 are treated as the title and excluded.
 */
export function extractSections(lines: readonly string[]): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  let current: TranscriptSection | null = null;
  const bodyBuf: string[] = [];

  const flush = (endLine: number): void => {
    if (current) {
      current.body = bodyBuf.join('\n').trim();
      current.endLine = endLine;
      sections.push(current);
    }
    bodyBuf.length = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(raw);
    if (headingMatch) {
      flush(i - 1);
      const hashes = headingMatch[1] ?? '';
      const heading = (headingMatch[2] ?? '').trim();
      current = {
        heading,
        slug: slugifyHeading(heading),
        body: '',
        depth: hashes.length,
        startLine: i,
        endLine: i,
      };
      continue;
    }
    if (current) bodyBuf.push(raw);
  }
  flush(lines.length - 1);
  return sections;
}

/**
 * Extract numbered (`1.`, `2.`) or bulleted (`-`, `*`, `+`) list items from a
 * section body. Trailing continuation lines are folded into the preceding
 * item. Returns the cleaned item text without the numeric/bullet prefix.
 */
export function extractListItems(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  let current: string | null = null;
  const itemRe = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/;
  for (const raw of lines) {
    const m = itemRe.exec(raw);
    if (m) {
      if (current !== null) out.push(current.trim());
      current = m[1] ?? '';
      continue;
    }
    if (current !== null) {
      const trimmed = raw.trim();
      if (trimmed === '') {
        out.push(current.trim());
        current = null;
      } else {
        current += ` ${trimmed}`;
      }
    }
  }
  if (current !== null) out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Normalize an `## Outcome` body into a status. We look at the first line.
 *
 * - `pass` / `success` / `succeeded` / `completed` / `ok` → 'pass'
 * - `fail` / `failed` / `failure` / `error` (when alone) → 'fail'
 * - `partial` / `incomplete` / `mixed` → 'partial'
 * - everything else (or blank) → 'unknown'
 */
export function parseOutcome(body: string): OutcomeStatus {
  if (!body) return 'unknown';
  const first = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return 'unknown';
  const head = first.toLowerCase();
  // Match leading word, allow punctuation/dashes after.
  const tokenMatch = /^([a-z]+)\b/.exec(head);
  const token = tokenMatch ? tokenMatch[1] : head;
  if (token === 'pass' || token === 'passed' || token === 'success' || token === 'succeeded' || token === 'ok' || token === 'completed' || token === 'done')
    return 'pass';
  if (token === 'fail' || token === 'failed' || token === 'failure' || token === 'error' || token === 'errored' || token === 'crashed') return 'fail';
  if (token === 'partial' || token === 'incomplete' || token === 'mixed' || token === 'partially')
    return 'partial';
  return 'unknown';
}

/**
 * Parse a duration string like:
 *   - "~15 minutes total"
 *   - "18:00 → 18:14 PT (~14 minutes)"
 *   - "Start 09:00 PT  End ~09:05 PT, ~5 minutes"
 *   - "1h 23m"
 *   - "45 sec"
 *
 * Strategy: try the explicit "h/m/s" tokens first, fall back to a numeric
 * value with a unit word. If two clock times are present, use their diff
 * if no explicit duration is found.
 */
export function parseDuration(body: string): ParsedDuration {
  const raw = body.trim();
  if (!raw) return { ms: Number.NaN, raw, exact: false };

  // 1) Try explicit tokens like "1h 23m 4s", "1 h", "23 min", "5 s".
  let totalMs = 0;
  let matchedAny = false;
  const lower = raw.toLowerCase();

  // Hours.
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 3_600_000;
    matchedAny = true;
  }
  // Minutes (must NOT match "min..." inside "minutes" twice; \b after handles it).
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 60_000;
    matchedAny = true;
  }
  // Seconds.
  for (const m of lower.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/g)) {
    totalMs += parseFloat(m[1] ?? '0') * 1_000;
    matchedAny = true;
  }

  if (matchedAny && totalMs > 0) {
    const approx = /~/.test(raw) || /about\s+/i.test(raw) || /approx/i.test(raw);
    return { ms: totalMs, raw, exact: !approx };
  }

  // 2) Try clock-time diff: "HH:mm ... HH:mm" (with optional "PT").
  const clockMatches = [...raw.matchAll(/\b(\d{1,2}):(\d{2})\b/g)];
  if (clockMatches.length >= 2) {
    const first = clockMatches[0]!;
    const last = clockMatches[clockMatches.length - 1]!;
    const startH = parseInt(first[1] ?? '0', 10);
    const startM = parseInt(first[2] ?? '0', 10);
    const endH = parseInt(last[1] ?? '0', 10);
    const endM = parseInt(last[2] ?? '0', 10);
    let diffMin = endH * 60 + endM - (startH * 60 + startM);
    if (diffMin < 0) diffMin += 24 * 60; // crossed midnight
    if (diffMin > 0) {
      const approx = /~/.test(raw) || /about/i.test(raw);
      return { ms: diffMin * 60_000, raw, exact: !approx };
    }
  }

  // 3) Bare number → assume minutes, the most common unit in our transcripts.
  const numMatch = /(\d+(?:\.\d+)?)/.exec(raw);
  if (numMatch) {
    return { ms: parseFloat(numMatch[1] ?? '0') * 60_000, raw, exact: false };
  }

  return { ms: Number.NaN, raw, exact: false };
}

// ─── INTERNAL ──────────────────────────────────────────────────────────────────

/**
 * Build a {@link TranscriptIdentity} by combining the heading title and the
 * filename hint. We trust the filename for the start timestamp because it is
 * generated programmatically; the title is used only as a fallback for the
 * worker name.
 */
function inferIdentity(
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
    if (titleMatch) {
      worker = titleMatch[1]!.toLowerCase().replace(/\s+/g, '-');
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

function resolveTimezone(date: string, override?: string | 'auto'): string {
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
function inferPacificOffset(date: string): string {
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

function basenameOf(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function parentDirectoryName(p: string): string {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const segments = norm.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return '';
  return segments[segments.length - 2]!.toLowerCase();
}

/**
 * The errors body conventionally says "no errors" / "none" when nothing went
 * wrong. Treat those as no errors; anything else with non-trivial content is
 * an error.
 */
function isNonTrivialErrorsBody(body: string): boolean {
  if (!body) return false;
  const norm = body
    .replace(/[\s\W]+/g, ' ')
    .toLowerCase()
    .trim();
  if (!norm) return false;
  const NEGATIVE_PATTERNS = [
    /^no errors?\b/,
    /^none\b/,
    /^n a\b/, // "n/a" after stripping
    /^no failures?\b/,
    /^no retries?\b/,
    /^no issues\b/,
    /^nothing\b/,
    /^no errors? encountered\b/,
  ];
  for (const re of NEGATIVE_PATTERNS) if (re.test(norm)) return false;
  // Body length matters - a few words might still be informational ("no problems")
  return norm.split(' ').length >= 2;
}

/**
 * Surface commit SHAs, file paths, URLs, PR/issue links from anywhere in the
 * transcript. Used by downstream Tier 1 verifiers to spot-check that
 * referenced artifacts actually exist.
 */
export function extractReferences(sections: readonly TranscriptSection[]): TranscriptReference[] {
  const out: TranscriptReference[] = [];
  const seen = new Set<string>();

  const add = (kind: TranscriptReference['kind'], value: string, section: string): void => {
    const key = `${kind}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value, section });
  };

  for (const s of sections) {
    const slug = s.slug;
    const body = s.body;
    if (!body) continue;

    // URLs (with optional surrounding markdown link).
    for (const m of body.matchAll(/https?:\/\/[^\s<>'`)\]]+/g)) {
      const v = (m[0] ?? '').replace(/[.,;:!?)]+$/, '');
      if (v) add('url', v, slug);
    }

    // PR/issue references like #1234 - common in repo-related transcripts.
    for (const m of body.matchAll(/(?:^|[^\w])#(\d{2,7})\b/g)) {
      add('issue', `#${m[1]}`, slug);
    }

    // Commit SHAs - 7-40 hex chars, surrounded by word boundaries / backticks.
    for (const m of body.matchAll(/(?:^|[^A-Fa-f0-9`])`?([0-9a-f]{7,40})`?(?=\b)/g)) {
      const sha = (m[1] ?? '').toLowerCase();
      // Filter out obvious false positives (e.g. all zeros).
      if (/^0+$/.test(sha)) continue;
      add('commit', sha, slug);
    }

    // Backtick-quoted file paths and bare paths with extensions.
    for (const m of body.matchAll(/`([^`\n]{1,160})`/g)) {
      const v = (m[1] ?? '').trim();
      if (looksLikePath(v)) add('file', v, slug);
    }
    for (const m of body.matchAll(/(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|py|cs|csproj|mjs|sql|sh|toml|html|css))(?=\s|[.,;:)]|$)/g)) {
      const v = (m[1] ?? '').trim();
      if (looksLikePath(v)) add('file', v, slug);
    }
  }
  return out;
}

function looksLikePath(s: string): boolean {
  if (!s || s.length > 200) return false;
  if (s.includes(' ')) return false;
  if (/^https?:/i.test(s)) return false;
  if (/^[0-9a-f]{7,40}$/i.test(s)) return false; // sha
  if (s.includes('/') || s.includes('\\') || /\.[a-z0-9]{1,8}$/i.test(s)) return true;
  return false;
}
