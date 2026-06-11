/**
 * CI Single-Run Completeness Evaluator — Phase 4 CI Integration
 *
 * The action *adapter* projects a fleet {@link Scorecard} into a gate. This
 * module sharpens the signal that feeds a gate for **one CI run** — a single
 * agent invocation against a single prompt (one PR review, one issue triage,
 * one code-change comment). It answers the narrow, high-value question a CI
 * Action actually has the inputs to answer at cleanup time:
 *
 *   > "Did the agent address THIS prompt, or produce empty / stub / boilerplate
 *   >  output that ignored the task?"
 *
 * This is the exact failure mode the open issues on the target Action describe:
 * a review that posts a project's guidance file verbatim instead of a structured
 * review of the diff, or a run that finishes "successfully" having said nothing
 * about the thing it was asked to look at. A crash check (`exit 0`) cannot see
 * either; a *completeness + coverage* check can.
 *
 * Independence (the core axis is independent -> corruptible): every signal here
 * is Tier 1 / Tier 2 and computed from artifacts the evaluated agent did not get
 * to write the reference for —
 *   - **Completeness** (Tier 1, {@link checkCompleteness}): pure structural
 *     analysis of the agent's own text — empty / stub / truncated / low-substance.
 *     The agent cannot forge "non-empty"; the bytes are the bytes.
 *   - **Keyword coverage** (Tier 2, {@link scoreKeywordCoverage}): the *prompt*
 *     supplies the reference topics, and the agent never wrote the prompt. The
 *     agent cannot grade its own coverage because it didn't author the baseline.
 * No model-as-judge, offline, reproducible.
 *
 * The result is the **same** {@link ActionEvaluation} shape the fleet adapter
 * emits, so the entire downstream I/O layer is reused unchanged:
 *
 *     const ev = evaluateCiRun({ prompt, output, worker: 'claude-review' });
 *     process.exitCode = emitActionResult(ev);   // outputs + step summary + exit
 *
 * It does this by scoring the run into a single synthetic {@link TranscriptScore}
 * and running it through the very same `aggregateScorecard -> evaluateForAction`
 * path the fleet uses. One run becomes a one-worker scorecard; the gate, the
 * outputs, and the rendered summary table all fall out for free.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import {
  checkCompleteness,
  type CompletenessOptions,
  type CompletenessResult,
} from '../checks/completeness.js';
import {
  scoreKeywordCoverage,
  identifyTopicGaps,
  type KeywordCoverageScore,
  type KeywordCoverageScoringOptions,
  type TopicGapResult,
} from '../checks/keyword-coverage.js';
import { aggregateScorecard } from '../monitoring/scorecard.js';
import type { CheckScore, TranscriptScore } from '../monitoring/scorer.js';

import { evaluateForAction } from './adapter.js';
import type { ActionEvaluation, EvaluateForActionOptions } from './adapter.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Verdict for one single-run check, mirroring {@link CheckScore.status}. */
export type CiCheckStatus = 'pass' | 'fail' | 'warn';

/** One scored check for a single CI run. */
export interface CiCheckResult {
  /** Which check produced this (one of the canonical scorer check names). */
  check: 'completeness' | 'keyword-coverage';
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
  /** The prompt / task the agent was given (PR title+body, issue text, …). */
  prompt: string;
  /** The agent's output (the review, comment, or change summary it produced). */
  output: string;
  /**
   * Logical name for this run, used as the single "worker" on the synthetic
   * scorecard and in the summary. Default: `ci-run`.
   */
  worker?: string;
  /**
   * Minimum keyword-coverage score in [0, 1] to pass the coverage check.
   * Default: 0.4 (CI prompts are often terse; a moderate bar catches "ignored
   * the prompt entirely" without demanding exhaustive coverage).
   */
  coverageThreshold?: number;
  /**
   * Below this coverage score the run is treated as a hard failure to *address*
   * the prompt (not just a warning). Default: 0.15 — at/under this the output is
   * essentially unrelated to the task (e.g. boilerplate posted verbatim).
   */
  ignoredPromptThreshold?: number;
  /** Extra completeness options forwarded to {@link checkCompleteness}. */
  completenessOptions?: CompletenessOptions;
  /** Extra keyword-coverage options forwarded to {@link scoreKeywordCoverage}. */
  keywordOptions?: KeywordCoverageScoringOptions;
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
  /** The CI-shaped evaluation — identical shape to the fleet adapter's output. */
  evaluation: ActionEvaluation;
  /** Per-check results for this single run. */
  checks: CiCheckResult[];
  /** The Tier 1 completeness analysis. */
  completeness: CompletenessResult;
  /** The Tier 2 keyword-coverage analysis. */
  coverage: KeywordCoverageScore;
  /** The Tier 2 topic-gap analysis (which important topics were missed). */
  gaps: TopicGapResult;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

const DEFAULT_WORKER = 'ci-run';
const DEFAULT_COVERAGE_THRESHOLD = 0.4;
const DEFAULT_IGNORED_PROMPT_THRESHOLD = 0.15;

// ─── HELPERS ──────────────────────────────────────────────────────────────────────

/** Round to 4 decimals; pass through non-finite values unchanged. */
function round4(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Score the Tier 1 completeness check into a single-run result. Errors fail the
 * check; warnings-only pass but lower the score so a degraded-but-present output
 * is distinguishable from a clean one. The score is a graded penalty (1 minus a
 * fixed cost per error / a smaller cost per warning) so it is meaningful in a
 * trend, not just a boolean.
 */
function scoreCompleteness(result: CompletenessResult): CiCheckResult {
  const errors = result.violations.filter((v) => v.severity === 'error');
  const warnings = result.violations.filter((v) => v.severity === 'warning');

  // Graded penalty: each error is expensive, each warning mild; clamp to [0,1].
  const penalty = errors.length * 0.5 + warnings.length * 0.15;
  const score = round4(Math.max(0, 1 - penalty));
  const status: CiCheckStatus = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';

  const summary =
    status === 'pass'
      ? `complete: ${result.metrics.wordCount}w, ${result.metrics.sentenceCount} sentence(s)`
      : [
          errors.length > 0 ? `${errors.length} error(s): ${errors.map((v) => v.message).join('; ')}` : '',
          warnings.length > 0 ? `${warnings.length} warning(s)` : '',
        ]
          .filter(Boolean)
          .join(' · ');

  return {
    check: 'completeness',
    tier: 1,
    score,
    status,
    summary,
    detail: {
      words: result.metrics.wordCount,
      chars: result.metrics.charCount,
      errors: errors.length,
      warnings: warnings.length,
      isStub: result.metrics.isStub,
      isTruncated: result.metrics.isTruncated,
    },
  };
}

/**
 * Score the Tier 2 keyword-coverage check into a single-run result. The score is
 * the coverage score itself. Below `ignoredPromptThreshold` it is a hard `fail`
 * (the output essentially ignored the prompt); between that and
 * `coverageThreshold` it is a `warn` (partial); at/above it `pass`.
 */
function scoreCoverage(
  coverage: KeywordCoverageScore,
  gaps: TopicGapResult,
  coverageThreshold: number,
  ignoredPromptThreshold: number,
): CiCheckResult {
  const score = round4(coverage.score);

  let status: CiCheckStatus;
  if (coverage.totalKeywords === 0) {
    // No extractable topics in the prompt — nothing to measure; treat as pass.
    status = 'pass';
  } else if (score <= ignoredPromptThreshold) {
    status = 'fail';
  } else if (score < coverageThreshold) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  const missed = coverage.keywords.filter((k) => !k.covered).slice(0, 5).map((k) => k.term);
  const summary =
    coverage.totalKeywords === 0
      ? 'no extractable topics in prompt'
      : status === 'pass'
        ? `covers ${(score * 100).toFixed(0)}% of prompt topics (${coverage.coveredCount}/${coverage.totalKeywords})`
        : status === 'fail'
          ? `ignored prompt: ${(score * 100).toFixed(0)}% coverage, missing ${missed.join(', ') || 'key topics'}`
          : `partial: ${(score * 100).toFixed(0)}% coverage, missing ${missed.join(', ') || 'some topics'}`;

  return {
    check: 'keyword-coverage',
    tier: 2,
    score,
    status,
    summary,
    detail: {
      coverage: score,
      covered: coverage.coveredCount,
      total: coverage.totalKeywords,
      gapSeverity: gaps.severity,
      gaps: gaps.gapCount,
    },
  };
}

/** Map a single-run {@link CiCheckResult} to a scorecard {@link CheckScore} row. */
function toCheckScore(
  c: CiCheckResult,
  worker: string,
  runId: string,
  startedAt: string,
  startedAtMs: number,
  scoredAt: string,
): CheckScore {
  return {
    worker,
    runId,
    startedAt,
    startedAtMs,
    check: c.check,
    tier: c.tier,
    score: c.score,
    status: c.status,
    summary: c.summary,
    detail: c.detail,
    scoredAt,
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Run the deterministic + heuristic single-run checks against one CI agent
 * output and return the per-check results plus the raw analyses. This is the
 * pure scoring core (no scorecard / gate yet) — useful when a caller wants the
 * signals without the Action projection.
 *
 * @param options - The prompt, the output, and thresholds.
 */
export function scoreCiRun(
  options: EvaluateCiRunOptions,
): { checks: CiCheckResult[]; completeness: CompletenessResult; coverage: KeywordCoverageScore; gaps: TopicGapResult } {
  const coverageThreshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const ignoredPromptThreshold = options.ignoredPromptThreshold ?? DEFAULT_IGNORED_PROMPT_THRESHOLD;

  // Tier 1 — structural completeness of the agent's own output.
  const completeness = checkCompleteness(options.output, options.completenessOptions);

  // Tier 2 — does the output cover the topics the prompt asked about? The prompt
  // is the reference the agent never authored.
  const keywordOpts: KeywordCoverageScoringOptions = {
    minCoverage: coverageThreshold,
    ...options.keywordOptions,
  };
  const coverage = scoreKeywordCoverage(options.prompt, options.output, keywordOpts);
  const gaps = identifyTopicGaps(options.prompt, options.output, keywordOpts);

  const checks: CiCheckResult[] = [
    scoreCompleteness(completeness),
    scoreCoverage(coverage, gaps, coverageThreshold, ignoredPromptThreshold),
  ];

  return { checks, completeness, coverage, gaps };
}

/**
 * Evaluate a single CI run for output completeness against its prompt, returning
 * the same {@link ActionEvaluation} the fleet adapter produces (so it plugs
 * straight into `emitActionResult` / `toActionOutputs` / `renderActionSummary`).
 *
 * The run is scored into one synthetic {@link TranscriptScore} and pushed through
 * the same `aggregateScorecard -> evaluateForAction` path the fleet uses: one run
 * becomes a one-worker scorecard, and the gate / outputs / summary all derive
 * from it. By default the worker grades on its single run's pass rate, so a run
 * with any failing check trips the gate (`gate: 'watch'` by default here, which
 * is stricter than the fleet default — a single CI run should be clean).
 *
 * @param options - Prompt, output, worker name, thresholds, and gate options.
 */
export function evaluateCiRun(options: EvaluateCiRunOptions): CiRunEvaluation {
  const worker = options.worker ?? DEFAULT_WORKER;
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const startedAtMs = now.getTime();
  const runId = startedAt.replace(/[:.]/g, '-');

  const { checks, completeness, coverage, gaps } = scoreCiRun(options);

  // Build the synthetic per-transcript score (the roll-up the scorecard expects).
  const checkScores = checks.map((c) =>
    toCheckScore(c, worker, runId, startedAt, startedAtMs, startedAt),
  );
  const scored = checkScores.filter((c) => c.status !== 'skip');
  const failCount = scored.filter((c) => c.status === 'fail').length;
  const warnCount = scored.filter((c) => c.status === 'warn').length;
  const scoreValues = scored.map((c) => c.score);
  const overall = scoreValues.length > 0 ? round4(scoreValues.reduce((a, v) => a + v, 0) / scoreValues.length) : Number.NaN;
  const worst = scoreValues.length > 0 ? round4(Math.min(...scoreValues)) : Number.NaN;

  const transcript: TranscriptScore = {
    worker,
    runId,
    startedAt,
    startedAtMs,
    reportedOutcome: failCount > 0 ? 'fail' : 'pass',
    checks: checkScores,
    overall,
    worst,
    failCount,
    warnCount,
  };

  // Run the single synthetic transcript through the same fleet aggregation +
  // gate. A single clean run should pass; any failing check should trip it, so
  // the default gate here is `watch` (stricter than the fleet's `at-risk`).
  const scorecard = aggregateScorecard([transcript], { now });
  const actionOptions: EvaluateForActionOptions = {
    gate: 'watch',
    ...options.action,
  };
  const evaluation = evaluateForAction(scorecard, actionOptions);

  return { evaluation, checks, completeness, coverage, gaps };
}
