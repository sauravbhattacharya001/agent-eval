/**
 * Transcript Contract (v1)
 * ========================
 *
 * The agent-eval transcript contract is the interface between transcript
 * PRODUCERS (an AI agent following an instruction block, a tool like AgentLens,
 * or a hand-written file) and the agent-eval CONSUMER (parsing + scoring).
 *
 * This module is the single source of truth for that contract. The schema here
 * MUST stay in sync with:
 *   - CONTRACT.md          (human-readable spec + copy-paste agent instructions)
 *   - the parser           (src/monitoring/transcript-reader.ts)
 *
 * Design note: the parser is deliberately liberal in what it ACCEPTS (it will
 * still parse a transcript that bends the rules). This validator defines what
 * is CONSIDERED COMPLIANT, so producers can be told exactly how to conform and
 * CI can fail loudly when they don't. "Be liberal in what you accept, strict in
 * what you validate."
 */

import type { OutcomeStatus, Transcript } from './types.js';
import { parseTranscript } from './transcript-reader.js';

/** Severity of a contract violation. */
export type ViolationSeverity = 'error' | 'warning';

/** A single contract violation, tied to the section/field that broke it. */
export interface ContractViolation {
  /** Stable machine code, e.g. 'missing-section', 'outcome-unrecognized'. */
  code: string;
  /** Severity: 'error' blocks compliance; 'warning' is advisory. */
  severity: ViolationSeverity;
  /** The section slug or field this concerns, e.g. 'outcome', 'duration'. */
  field: string;
  /** Human-readable explanation + how to fix. */
  message: string;
}

/** Result of validating a transcript against the contract. */
export interface ContractValidationResult {
  /** True when there are zero 'error'-severity violations. */
  valid: boolean;
  /** Contract version validated against. */
  version: string;
  /** All violations found (errors and warnings). */
  violations: ContractViolation[];
  /** Convenience: only the 'error'-severity violations. */
  errors: ContractViolation[];
  /** Convenience: only the 'warning'-severity violations. */
  warnings: ContractViolation[];
}

/** A required section in the contract. */
export interface ContractSection {
  /** Canonical heading text, e.g. 'Actions Taken'. */
  heading: string;
  /** Normalized slug used for lookup, e.g. 'actions-taken'. */
  slug: string;
  /** Whether the section must be present and non-empty. */
  required: boolean;
  /** Short description of what belongs in the section. */
  description: string;
}

/** The canonical outcome tokens a `## Outcome` section may resolve to. */
export const CONTRACT_OUTCOME_TOKENS: readonly Exclude<OutcomeStatus, 'unknown'>[] = [
  'pass',
  'fail',
  'partial',
] as const;

/**
 * The v1 transcript contract: the ordered set of `##` sections plus the rules
 * each must satisfy. This mirrors the schema in worker-common.md / CONTRACT.md.
 */
export const TRANSCRIPT_CONTRACT_V1 = {
  version: 'transcript-contract@v1',
  /** The title line must be a level-1 `# ...` heading. */
  requiresTitle: true,
  sections: [
    {
      heading: 'Task',
      slug: 'task',
      required: true,
      description: 'The task or prompt the run was given.',
    },
    {
      heading: 'Actions Taken',
      slug: 'actions-taken',
      required: true,
      description: 'A list of what was actually done (repos, files, commands, commits).',
    },
    {
      heading: 'Key Outputs',
      slug: 'key-outputs',
      required: true,
      description: 'The concrete deliverables (commit SHAs, code, issues, summaries).',
    },
    {
      heading: 'Outcome',
      slug: 'outcome',
      required: true,
      description: 'One of pass / fail / partial, with a short reason.',
    },
    {
      heading: 'Errors & Retries',
      slug: 'errors-retries',
      required: false,
      description: 'Any failures hit and how they were handled. Omit or leave empty if none.',
    },
    {
      heading: 'Duration',
      slug: 'duration',
      required: true,
      description: 'start -> end and/or total minutes.',
    },
  ] satisfies ContractSection[],
} as const;

/**
 * Decide whether an `## Outcome` body is the not-yet-finished IN-PROGRESS stub.
 *
 * We inspect ONLY the **leading token** of the first non-empty line — the same
 * place {@link parseOutcome} reads the `pass`/`fail`/`partial` token from. A
 * genuinely finished transcript may legitimately *mention* the phrase in its
 * reason prose (e.g. `pass - dogfood: the known scrubme IN-PROGRESS stubs`); a
 * substring test against the line (let alone the whole body) would mis-flag
 * that as not-yet-finished. The sentinel only counts when it is what the line
 * *leads with* — `IN-PROGRESS`, `IN-PROGRESS - will fill in later`, etc.
 */
function outcomeBodyIsInProgress(body: string): boolean {
  const first = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return false;
  // Strip leading markdown emphasis / decoration (mirrors parseOutcome) so
  // "**IN-PROGRESS**" / "`in progress`" still reads as the sentinel.
  const cleaned = first.toLowerCase().replace(/^[^a-z]+/i, '');
  // The sentinel must be what the line LEADS with, anchored at the start.
  return /^in[-\s]?progress\b/.test(cleaned);
}

function makeResult(version: string, violations: ContractViolation[]): ContractValidationResult {
  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');
  return { valid: errors.length === 0, version, violations, errors, warnings };
}

/**
 * Validate an already-parsed {@link Transcript} against the v1 contract.
 *
 * @param t            Parsed transcript.
 * @param options.allowInProgress
 *   When true (default), a stub whose Outcome is "IN-PROGRESS" is treated as a
 *   valid not-yet-finished record (producers are told to write the stub first).
 *   When false, an IN-PROGRESS / unresolved outcome is an error \u2014 use this to
 *   validate FINISHED transcripts (e.g. in CI after a run completes).
 */
export function validateParsedTranscript(
  t: Transcript,
  options: { allowInProgress?: boolean } = {},
): ContractValidationResult {
  const allowInProgress = options.allowInProgress ?? true;
  const contract = TRANSCRIPT_CONTRACT_V1;
  const violations: ContractViolation[] = [];

  // 1. Title must be a non-empty `# ...` heading.
  if (contract.requiresTitle && (!t.title || !t.title.trim())) {
    violations.push({
      code: 'missing-title',
      severity: 'error',
      field: 'title',
      message: 'Transcript must start with a level-1 title heading, e.g. "# Builder Run - 2026-06-05 10:00 PT".',
    });
  }

  // 2. Required sections must be present and non-empty.
  for (const section of contract.sections) {
    const found = t.bySlug[section.slug];
    if (!found) {
      if (section.required) {
        violations.push({
          code: 'missing-section',
          severity: 'error',
          field: section.slug,
          message: `Missing required "## ${section.heading}" section. ${section.description}`,
        });
      }
      continue;
    }
    if (section.required && !found.body.trim()) {
      violations.push({
        code: 'empty-section',
        severity: 'error',
        field: section.slug,
        message: `"## ${section.heading}" is present but empty. ${section.description}`,
      });
    }
  }

  // 3. Outcome must resolve to a recognized token (pass/fail/partial),
  //    unless it's an allowed IN-PROGRESS stub.
  const outcomeSection = t.bySlug['outcome'];
  if (outcomeSection) {
    const isInProgress = outcomeBodyIsInProgress(outcomeSection.body);
    if (isInProgress) {
      if (!allowInProgress) {
        violations.push({
          code: 'outcome-in-progress',
          severity: 'error',
          field: 'outcome',
          message:
            'Outcome is still "IN-PROGRESS" but a finished transcript was expected. The run likely died before updating its outcome to pass/fail/partial.',
        });
      }
      // else: valid not-yet-finished stub; skip the token check.
    } else if (t.outcome === 'unknown') {
      violations.push({
        code: 'outcome-unrecognized',
        severity: 'error',
        field: 'outcome',
        message: `Outcome could not be recognized as one of ${CONTRACT_OUTCOME_TOKENS.join(' / ')}. Start the "## Outcome" line with a bare token, e.g. "pass - ...". Avoid wrapping it so it can't be read.`,
      });
    }
  }

  // 4. Actions Taken should contain at least one enumerable action item.
  if (t.bySlug['actions-taken'] && t.actionItems.length === 0 && t.bySlug['actions-taken'].body.trim()) {
    violations.push({
      code: 'actions-not-itemized',
      severity: 'warning',
      field: 'actions-taken',
      message:
        '"## Actions Taken" has prose but no list items. Use a numbered or bulleted list so each action is individually parseable.',
    });
  }

  // 5. Duration should be machine-parseable (advisory).
  const durationSection = t.bySlug['duration'];
  if (durationSection && durationSection.body.trim() && Number.isNaN(t.duration.ms)) {
    violations.push({
      code: 'duration-unparseable',
      severity: 'warning',
      field: 'duration',
      message:
        'Could not parse a duration. Use a clear form like "10:00 PT -> 10:14 PT" or "approximately 14 minutes" so run length can be measured.',
    });
  }

  return makeResult(contract.version, violations);
}

/**
 * Validate raw transcript markdown text against the v1 contract.
 * Parses with the standard reader, then applies {@link validateParsedTranscript}.
 */
export function validateTranscript(
  text: string,
  options: { allowInProgress?: boolean; filename?: string } = {},
): ContractValidationResult {
  const t = parseTranscript(text, options.filename ? { filename: options.filename } : {});
  return validateParsedTranscript(t, options);
}
