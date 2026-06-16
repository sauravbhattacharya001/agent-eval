/**
 * Shared types and the rounding helper for the CI single-run evaluator
 * ({@link module:action/ci-run}).
 *
 * These declarations are split out of `ci-run.ts` so the evaluator's three
 * scoring seams - completeness, staleness/no-op ({@link module:action/ci-run-staleness}),
 * and relevance/task-grounding ({@link module:action/ci-run-relevance}) - can share
 * one type vocabulary without importing each other. `ci-run.ts` re-exports every
 * public type here, so the package's public surface is unchanged.
 *
 * @tier 1+2 - Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { CompletenessOptions, CompletenessResult } from '../checks/completeness.js';
import type {
  AbandonmentOptions,
  RunTimeline,
  StalenessIssue,
  StalenessResult,
} from '../checks/staleness.js';

import type { ActionEvaluation, EvaluateForActionOptions } from './adapter.js';

/** Verdict for one single-run check, mirroring `CheckScore.status`. */
export type CiCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

/** One scored check for a single CI run. */
export interface CiCheckResult {
  /** Which check produced this (one of the canonical scorer check names). */
  check: 'completeness' | 'staleness' | 'relevance';
  /** Independence tier: 1 = deterministic, 2 = heuristic. */
  tier: 1 | 2;
  /** Normalized score in [0, 1], 1 = best. */
  score: number;
  /** Verdict against the check's own pass criteria. */
  status: CiCheckStatus;
  /** Short human-readable explanation. */
  summary: string;
  /** Structured detail for debugging / outputs. */
  detail?: Record<string, number | string | boolean>;
}

/** Options for {@link evaluateCiRun}. */
export interface EvaluateCiRunOptions {
  /** The prompt / task the agent was given (PR title+body, issue text, ...). */
  prompt: string;
  /** The agent's output (the review, comment, or change summary it produced). */
  output: string;
  /**
   * Logical name for this run, used as the single "worker" on the synthetic
   * scorecard and in the summary. Default: `ci-run`.
   */
  worker?: string;
  /** Extra completeness options forwarded to {@link checkCompleteness}. */
  completenessOptions?: CompletenessOptions;
  /**
   * Minimum number of distinct *concrete actionable artifacts* (file refs, line
   * numbers, code suggestions, actionable directives, structured findings) the
   * output must contain to pass the staleness check. Below this it is a `warn`
   * (low-substance / nothing actionable); zero artifacts on a non-trivial output
   * is a hard `fail` (a no-op review). Default: 2.
   */
  minActionableArtifacts?: number;
  /**
   * Minimum fraction (0-1) of the prompt's *salient vocabulary* the output must
   * echo to pass the **relevance** (task-grounding) check. A genuine review of a
   * specific diff reuses the prompt's nouns - the files, symbols, and concepts it
   * was asked about - so it covers most of them; parroted boilerplate (a project
   * guidance file posted verbatim, the #1302 mode) covers almost none. Below this
   * an output that is *substantive* (see {@link relevanceMinPromptTerms} /
   * {@link relevanceMinOutputChars}) is a hard `fail` - it ignored THIS task.
   * Default: 0.25.
   */
  minPromptRelevance?: number;
  /**
   * The relevance check only runs when the prompt carries at least this many
   * distinct salient terms (after stopword removal). A one-word or empty prompt
   * cannot ground anything, so the check `skip`s rather than guessing. Default: 4.
   */
  relevanceMinPromptTerms?: number;
  /**
   * The relevance check only *fails* an output at least this long. A genuinely
   * short answer ("Use `INCR` on the login limiter.") may legitimately echo only
   * one or two prompt terms; the parroting failure mode is a *long* off-topic
   * dump. Below this length, low coverage is a `warn`, not a hard `fail`.
   * Default: 200.
   */
  relevanceMinOutputChars?: number;
  /**
   * The agent's *previous* output for the same target (e.g. the prior review
   * comment on this PR). When supplied, the staleness check flags a verbatim or
   * near-verbatim **repost** (the #1302 "posts the same thing again" no-op) using
   * {@link detectParroting}. Omit if there is no prior output.
   */
  previousOutput?: string;
  /**
   * Similarity (0-1) at/above which the output is considered a repost of
   * `previousOutput`. Default: 0.9.
   */
  repostThreshold?: number;
  /**
   * Optional run timeline (start/end/events/timeout). When supplied, the
   * staleness check folds in {@link analyzeStaleness} - timeout, large activity
   * gaps, missing end event - the #1361 "check abandoned, timed out at the 2hr
   * stale limit" mode. The timeline's `output` is filled from `output` if unset.
   */
  timeline?: RunTimeline;
  /** Extra abandonment options forwarded to {@link detectAbandonment}. */
  abandonmentOptions?: AbandonmentOptions;
  /**
   * Output shorter than this many characters is treated as trivially short for
   * the purpose of the no-op gate: zero artifacts on an output at/under this
   * length is a `warn` rather than a hard `fail` (a terse "LGTM" on a clean diff
   * is weak, but not the same failure as a long review that says nothing). The
   * pure-acknowledgement detector still applies below this length. Default: 80.
   */
  trivialOutputChars?: number;
  /** Gate / no-data / score-floor options for the final {@link evaluateForAction}. */
  action?: EvaluateForActionOptions;
  /** Override the timestamp recorded on the synthetic score (testing). */
  now?: Date;
}

/**
 * The result of evaluating one CI run. It carries the full {@link ActionEvaluation}
 * (so it drops straight into `emitActionResult`) plus the per-check breakdown and
 * the raw analysis results for callers that want to drill in.
 */
export interface CiRunEvaluation {
  /** The CI-shaped evaluation - identical shape to the fleet adapter's output. */
  evaluation: ActionEvaluation;
  /** Per-check results for this single run. */
  checks: CiCheckResult[];
  /** The Tier 1 completeness analysis. */
  completeness: CompletenessResult;
  /** The Tier 1 staleness analysis (no-op: did it emit anything actionable?). */
  staleness: StalenessAnalysis;
  /** The Tier 2 task-grounding analysis (is the output about THIS prompt?). */
  relevance: TaskGroundingResult;
}

/** Which concrete actionable artifacts were found in the output. */
export interface ActionableArtifacts {
  /** Distinct artifact kinds that fired (e.g. `['file-ref', 'directive']`). */
  kinds: string[];
  /** Human-readable labels for the kinds that fired. */
  labels: string[];
  /** Count of distinct artifact kinds present (length of {@link kinds}). */
  count: number;
}

/**
 * The combined staleness / no-op analysis for one CI run. It rolls up the
 * artifact scan, the pure-acknowledgement check, output-text abandonment, and
 * (when inputs were supplied) repost and timeline-staleness signals.
 */
export interface StalenessAnalysis {
  /** Concrete actionable artifacts found in the output. */
  artifacts: ActionableArtifacts;
  /** True if the output is a bare acknowledgement with no substance. */
  isAcknowledgementOnly: boolean;
  /** The acknowledgement label that matched, if any. */
  acknowledgement?: string;
  /** Abandonment issues found in the output text (truncation, dangling intent). */
  abandonment: StalenessIssue[];
  /** True if `previousOutput` was supplied and the output is a near-verbatim repost. */
  isRepost: boolean;
  /** Similarity to `previousOutput` (NaN if no previous output was supplied). */
  repostSimilarity: number;
  /** Timeline staleness analysis (undefined if no timeline was supplied). */
  timeline?: StalenessResult;
}

/**
 * The Tier 2 task-grounding analysis for one CI run: how much of the prompt's
 * salient vocabulary the output actually engages with. This is the signal that
 * separates a real review of a specific diff (which reuses the task's nouns -
 * the files, symbols, and concepts it was asked about) from boilerplate that
 * ignores the task entirely (a project guidance file reposted verbatim - #1302).
 *
 * It is **independent** in the Tier-2 sense: the reference point is the *prompt*,
 * which the evaluated agent did not write. An agent cannot fake overlap with a
 * task it never read. It is deliberately distinct from staleness (an output can
 * be richly actionable yet about the wrong thing, or on-topic yet a no-op) and
 * from completeness (a long, well-formed answer can still be off-task).
 */
export interface TaskGroundingResult {
  /**
   * Fraction (0-1) of the prompt's distinct salient terms that appear in the
   * output - the primary grounding signal. Normalized by *prompt* terms (not
   * output length), so a short on-topic answer is not penalized for brevity.
   * `NaN` when the prompt had too few salient terms to ground against.
   */
  promptCoverage: number;
  /** Jaccard overlap (0-1) of prompt vs. output salient-term sets (secondary). */
  jaccard: number;
  /** The distinct salient prompt terms the check grounds against. */
  promptTerms: string[];
  /** Prompt terms that the output echoed (the grounded subset). */
  matchedTerms: string[];
  /** Prompt terms entirely absent from the output (the task topics it skipped). */
  missingTerms: string[];
  /**
   * True when the prompt was too thin (fewer than `relevanceMinPromptTerms`
   * salient terms) to ground anything - the check `skip`s in this case.
   */
  promptTooThin: boolean;
}

// ─── DEFAULTS ────────────────────────────────────────────────────────────────────

/** Default worker label for a CI run with no explicit name. */
export const DEFAULT_WORKER = 'ci-run';
/** Default minimum distinct actionable-artifact kinds for a passing staleness check. */
export const DEFAULT_MIN_ACTIONABLE_ARTIFACTS = 2;
/** Default similarity at/above which an output counts as a verbatim repost. */
export const DEFAULT_REPOST_THRESHOLD = 0.9;
/** Default char length at/under which an artifact-free output only warns (not fails). */
export const DEFAULT_TRIVIAL_OUTPUT_CHARS = 80;
/** Default minimum prompt-vocabulary coverage for a passing relevance check. */
export const DEFAULT_MIN_PROMPT_RELEVANCE = 0.25;
/** Default minimum salient prompt terms required before relevance grades. */
export const DEFAULT_RELEVANCE_MIN_PROMPT_TERMS = 4;
/** Default output length at/above which low relevance hard-fails (vs. warns). */
export const DEFAULT_RELEVANCE_MIN_OUTPUT_CHARS = 200;

// ─── SHARED HELPERS ──────────────────────────────────────────────────────────────

/** Round to 4 decimals; pass through non-finite values unchanged. */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}
