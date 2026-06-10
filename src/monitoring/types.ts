/**
 * Production Monitoring - Shared Types
 *
 * Types for parsing, scoring, and tracking historical agent runs from
 * structured transcript markdown files.
 *
 * @tier 1 - Deterministic (pure parsing, no AI)
 * @module
 */

// ─── WORKER IDENTITY ───────────────────────────────────────────────────────────

/**
 * Built-in worker names that produce transcripts. Custom workers are allowed
 * (the type is widened to a plain string), these are just the canonical ones
 * we ship parsers and rubrics for.
 */
export type WorkerName =
  | 'builder'
  | 'gardener'
  | 'sentinel'
  | 'eval'
  | 'tempcheck'
  | 'scrubme'
  | 'blog'
  | 'profile-refresh'
  | 'memory-backup'
  | 'memory-dreaming'
  | (string & {});

/** Outcome status reported by the worker itself in the `## Outcome` section. */
export type OutcomeStatus = 'pass' | 'fail' | 'partial' | 'unknown';

// ─── PARSED TRANSCRIPT ─────────────────────────────────────────────────────────

/**
 * One section of a transcript (e.g. `## Actions Taken`). We keep the raw text
 * verbatim; structural extraction (numbered list items, commit SHAs, file
 * paths) lives on the parent {@link Transcript} object.
 */
export interface TranscriptSection {
  /** Section heading text without leading `##` markers, e.g. "Actions Taken". */
  heading: string;
  /** Normalized lower-case slug, e.g. "actions-taken". */
  slug: string;
  /** Raw section body, trimmed. */
  body: string;
  /** Heading depth (number of leading `#`). Always >= 2 for sections. */
  depth: number;
  /** 0-based line index of the heading in the source. */
  startLine: number;
  /** 0-based line index of the last line of the body (inclusive). */
  endLine: number;
}

/** Parsed run duration. */
export interface ParsedDuration {
  /** Total duration in milliseconds. NaN if not parseable. */
  ms: number;
  /** Original duration string from the transcript. */
  raw: string;
  /** True if a numeric duration was extracted; false if value is approximate or missing. */
  exact: boolean;
}

/** Identity inferred from the transcript filename and `# <Worker> Run` heading. */
export interface TranscriptIdentity {
  /** Worker name inferred from the directory + heading, lower-case. */
  worker: WorkerName;
  /** Run start ISO-8601 timestamp parsed from the filename, e.g. "2026-06-08T18:15:00-07:00". */
  startedAt: string;
  /** Unix-ms representation of {@link startedAt}, useful for sorting. */
  startedAtMs: number;
  /** Original filename (basename only, no directory). */
  filename: string;
  /** Date string in `YYYY-MM-DD` form, in PT (the canonical worker timezone). */
  date: string;
  /** Local time string `HH:mm` from the filename. */
  time: string;
}

/** A reference to a commit, file, or URL surfaced inside a transcript. */
export interface TranscriptReference {
  /** What kind of reference this is. */
  kind: 'commit' | 'file' | 'url' | 'pr' | 'issue';
  /** Verbatim matched text, e.g. "fd2f36a" or "src/runner.ts". */
  value: string;
  /** Section slug where this reference was found, e.g. "key-outputs". */
  section: string;
}

/**
 * Fully parsed transcript ready for downstream scoring. This object is the
 * canonical input to historical scorers, trend detectors, and scorecard
 * generators.
 */
export interface Transcript {
  /** Identity (worker + start time + filename). */
  identity: TranscriptIdentity;
  /** Top-level title, e.g. "Sentinel Run - 2026-06-08 18:15 PT". */
  title: string;
  /** All `## ...` sections in order of appearance. */
  sections: TranscriptSection[];
  /** Quick-access map of section slug → section, e.g. `bySlug["actions-taken"]`. */
  bySlug: Readonly<Record<string, TranscriptSection>>;
  /** `## Task` body or `''` if missing. */
  task: string;
  /** `## Actions Taken` body or `''` if missing. */
  actions: string;
  /** Numbered/bulleted action items extracted from the actions section. */
  actionItems: string[];
  /** `## Key Outputs` body or `''` if missing. */
  keyOutputs: string;
  /** `## Outcome` body or `''` if missing. */
  outcomeBody: string;
  /** Normalized outcome status, derived from outcomeBody. */
  outcome: OutcomeStatus;
  /** `## Errors & Retries` body or `''` if missing. */
  errors: string;
  /** Whether the worker reported errors (errors body is non-trivially populated). */
  hadErrors: boolean;
  /** `## Duration` body or `''` if missing. */
  durationBody: string;
  /** Parsed duration. */
  duration: ParsedDuration;
  /** Estimated end timestamp (startedAt + duration). undefined if duration unparseable. */
  endedAt: string | undefined;
  /** Estimated end timestamp in Unix-ms. NaN if unparseable. */
  endedAtMs: number;
  /** Commit SHAs, file paths, URLs surfaced anywhere in the transcript. */
  references: TranscriptReference[];
  /** Total number of source lines parsed. */
  lineCount: number;
  /** Path the transcript was loaded from, if known. */
  source?: string;
  /** Soft validation issues encountered while parsing (missing sections, etc.). */
  warnings: string[];
}

// ─── PARSE OPTIONS ─────────────────────────────────────────────────────────────

/** Options for {@link parseTranscript}. */
export interface ParseTranscriptOptions {
  /** Filename hint when not parsing from disk; used to infer worker + start time. */
  filename?: string;
  /** Optional explicit worker override; supersedes filename inference. */
  worker?: WorkerName;
  /** Optional source path recorded on the resulting transcript. */
  source?: string;
  /**
   * Override for the canonical worker timezone. Filenames embed PT wall-clock
   * times by convention; this lets tests pin a specific UTC offset without
   * relying on the host clock. Default: `'-07:00'` (PT during DST). Pass
   * `'auto'` to consult the parsed date and pick PST/PDT automatically.
   */
  defaultTimezone?: string | 'auto';
}
