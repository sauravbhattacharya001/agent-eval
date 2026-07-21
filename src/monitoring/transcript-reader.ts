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
  ParseTranscriptOptions,
  OutcomeStatus,
  Transcript,
  TranscriptSection,
} from './types.js';

// Identity inference (worker name + start timestamp from the filename, plus
// the Pacific-Time DST offset math) lives in its own module - a self-contained
// cluster of filename/timezone helpers. Imported here for `parseTranscript`.
import { inferIdentity } from './transcript-identity.js';

// The natural-language `## Duration` grammar lives in its own module (the
// subtlest sub-parser here). Re-exported below so `parseDuration` keeps its
// historical import path off `transcript-reader.js`.
import { parseDuration } from './duration-parser.js';

export { parseDuration } from './duration-parser.js';

// Artifact-reference scanning (commit SHAs / paths / URLs / issue numbers)
// lives in its own module - a self-contained bank of independent regexes plus
// the `looksLikePath` guard. Re-exported below so `extractReferences` keeps
// its historical import path off `transcript-reader.js`.
import { extractReferences } from './reference-extractor.js';

export { extractReferences } from './reference-extractor.js';

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
    // Only level-2 (`##`) headings delimit top-level transcript sections. The
    // canonical schema (Task / Actions Taken / Key Outputs / Outcome / …) is
    // all `##`. Deeper headings (`###`+) are sub-structure WITHIN a section
    // (e.g. `### Setup`, `### Task 1` under `## Actions Taken`) and must be
    // folded into the enclosing section body — otherwise the section is cut
    // off at the first subheading and its list items are lost (0 actions).
    if (headingMatch && (headingMatch[1] ?? '').length === 2) {
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
  // Strip leading markdown emphasis / decoration so a bold or emoji-prefixed
  // outcome line still parses. Real transcripts write things like
  // "**PASS** - ...", "__done__", "`pass`", or "\u2705 PASS" — without this the
  // leading `**`/emoji defeats the token match and the whole run silently
  // reads as `unknown`, which in turn defeats every outcome-aware check.
  const cleaned = head.replace(/^[^a-z]+/i, '');
  // Take the leading run of letters as the token. We deliberately do NOT use
  // a trailing \b here: markdown like "__done__" has no word boundary before
  // the underscore, so \b would fail to match. A greedy [a-z]+ stops at the
  // first non-letter (space, dash, underscore, asterisk) which is exactly right.
  const tokenMatch = /^([a-z]+)/.exec(cleaned);
  const token = tokenMatch ? tokenMatch[1] : cleaned;
  if (token === 'pass' || token === 'passed' || token === 'success' || token === 'succeeded' || token === 'ok' || token === 'completed' || token === 'done')
    return 'pass';
  if (token === 'fail' || token === 'failed' || token === 'failure' || token === 'error' || token === 'errored' || token === 'crashed') return 'fail';
  if (token === 'partial' || token === 'incomplete' || token === 'mixed' || token === 'partially')
    return 'partial';
  return 'unknown';
}

// `parseDuration` (the natural-language `## Duration` grammar) lives in
// `./duration-parser.ts` and `extractReferences` (artifact-reference scanning)
// lives in `./reference-extractor.ts`; both are re-exported at the top of this
// module so their public import paths off `transcript-reader.js` are unchanged.

// ─── INTERNAL ──────────────────────────────────────────────────────────────────

// Identity inference (`inferIdentity` + its filename/timezone helpers) now
// lives in `./transcript-identity.ts`; it is imported at the top of this
// module. What remains here is the errors-body triviality heuristic.

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

// `extractReferences` (artifact-reference scanning) and its `looksLikePath`
// guard now live in `./reference-extractor.ts` and are re-exported at the top
// of this module.
