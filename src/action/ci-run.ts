/**
 * CI Single-Run Completeness Evaluator - Phase 4 CI Integration
 *
 * The action *adapter* projects a fleet {@link Scorecard} into a gate. This
 * module sharpens the signal that feeds a gate for **one CI run** - a single
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
 * either; a *completeness + staleness* check can.
 *
 * Independence (the core axis is independent -> corruptible): every signal here
 * is Tier 1 / Tier 2 and computed from artifacts the evaluated agent did not get
 * to write the reference for -
 *   - **Completeness** (Tier 1, {@link scoreCompleteness}): pure structural
 *     analysis of the agent's own text - empty / stub / truncated / low-substance.
 *     The agent cannot forge "non-empty"; the bytes are the bytes.
 *   - **Staleness** (Tier 1, {@link module:action/ci-run-staleness}): the failure
 *     mode completeness *cannot* see - a run that responded, on-topic, at length,
 *     but emitted **nothing a human can act on**. This is the open-issue cluster
 *     directly: a review that sits stale with no actionable output, a check
 *     abandoned mid-task, or a prior comment reposted verbatim with no new work.
 *     It is distinct from completeness (the output is non-empty, even
 *     substantive) and **not** merely on-topic - it is a **no-op**. The detector
 *     counts *concrete actionable artifacts* the agent did produce (file
 *     references, line numbers, code suggestions, actionable directives,
 *     structured review findings), flags pure-acknowledgement output ("LGTM",
 *     "looks good") below a substance floor, folds in {@link detectAbandonment}
 *     truncation/intent-without-follow-through signals, and - when given the
 *     prior comment and/or a run timeline - {@link detectParroting}
 *     verbatim-repost and {@link analyzeStaleness} timeout/abandonment. All of it
 *     is artifact pattern-counting and timestamp math; the "actionability" signal
 *     here is **not** a model-as-judge verdict - it asks "are concrete artifacts
 *     *present*?", never "is this *good*?".
 *   - **Relevance / task-grounding** (Tier 2, {@link module:action/ci-run-relevance}):
 *     the failure neither of the above can see - an output that is well-formed
 *     *and* superficially actionable yet about the **wrong thing**. The canonical
 *     case is a project guidance file ("use pnpm", "prefer named exports") posted
 *     verbatim instead of a review of the diff: it is long and structured
 *     (passes completeness) and littered with paths, inline code, and directive
 *     words (passes staleness), but it shares almost no salient vocabulary with
 *     the prompt it was asked to address. {@link analyzeTaskGrounding} measures
 *     the fraction of the **prompt's** salient terms the output echoes - the
 *     reference point is the prompt, which the agent did not write, so a
 *     fluent-but-off-task dump cannot forge coverage. It is deliberately
 *     orthogonal to staleness: an on-topic no-op scores *high* on grounding
 *     (it names the topics) and is caught by staleness instead.
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
 * The three scoring seams live in sibling modules so each stays focused:
 *   - {@link module:action/ci-run-types} - shared types + the `round4` helper.
 *   - {@link module:action/ci-run-staleness} - the Tier 1 no-op detection.
 *   - {@link module:action/ci-run-relevance} - the Tier 2 task-grounding.
 * This module is the orchestration: it runs completeness, wires the three checks
 * into one synthetic scorecard, and projects the fleet gate. The public surface
 * (`scoreCiRun`, `evaluateCiRun`, `analyzeActionability`, `analyzeCiStaleness`,
 * `analyzeTaskGrounding`, and the result types) is re-exported here unchanged.
 *
 * @tier 1+2 - Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import {
  checkCompleteness,
  type CompletenessResult,
} from '../checks/completeness.js';
import { aggregateScorecard } from '../monitoring/scorecard.js';
import type { CheckScore, TranscriptScore } from '../monitoring/scorer.js';

import { evaluateForAction } from './adapter.js';
import type { ActionEvidence, EvaluateForActionOptions } from './adapter.js';
import { analyzeCiStaleness, scoreStaleness } from './ci-run-staleness.js';
import { analyzeTaskGrounding, scoreRelevance } from './ci-run-relevance.js';
import {
  DEFAULT_MIN_ACTIONABLE_ARTIFACTS,
  DEFAULT_MIN_PROMPT_RELEVANCE,
  DEFAULT_RELEVANCE_MIN_OUTPUT_CHARS,
  DEFAULT_RELEVANCE_MIN_PROMPT_TERMS,
  DEFAULT_TRIVIAL_OUTPUT_CHARS,
  DEFAULT_WORKER,
  round4,
  type CiCheckResult,
  type CiCheckStatus,
  type EvaluateCiRunOptions,
  type CiRunEvaluation,
  type StalenessAnalysis,
  type TaskGroundingResult,
} from './ci-run-types.js';

// ─── RE-EXPORTS (keep the public surface stable across the module split) ──────────

export {
  analyzeActionability,
  analyzeCiStaleness,
} from './ci-run-staleness.js';
export { analyzeTaskGrounding } from './ci-run-relevance.js';
export type {
  CiCheckStatus,
  CiCheckResult,
  EvaluateCiRunOptions,
  CiRunEvaluation,
  ActionableArtifacts,
  StalenessAnalysis,
  TaskGroundingResult,
} from './ci-run-types.js';

// ─── COMPLETENESS (TIER 1) ───────────────────────────────────────────────────────

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

// ─── SCORECARD WIRING ────────────────────────────────────────────────────────────

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
 * pure scoring core (no scorecard / gate yet) - useful when a caller wants the
 * signals without the Action projection.
 *
 * @param options - The prompt, the output, and thresholds.
 */
export function scoreCiRun(
  options: EvaluateCiRunOptions,
): {
  checks: CiCheckResult[];
  completeness: CompletenessResult;
  staleness: StalenessAnalysis;
  relevance: TaskGroundingResult;
} {
  const minActionableArtifacts = options.minActionableArtifacts ?? DEFAULT_MIN_ACTIONABLE_ARTIFACTS;
  const trivialOutputChars = options.trivialOutputChars ?? DEFAULT_TRIVIAL_OUTPUT_CHARS;
  const minPromptRelevance = options.minPromptRelevance ?? DEFAULT_MIN_PROMPT_RELEVANCE;
  const relevanceMinPromptTerms =
    options.relevanceMinPromptTerms ?? DEFAULT_RELEVANCE_MIN_PROMPT_TERMS;
  const relevanceMinOutputChars =
    options.relevanceMinOutputChars ?? DEFAULT_RELEVANCE_MIN_OUTPUT_CHARS;

  // Tier 1 - structural completeness of the agent's own output.
  const completeness = checkCompleteness(options.output, options.completenessOptions);

  // Tier 1 - staleness / no-op: did the run emit anything actionable, or is it a
  // stale no-op (nothing to act on, reposted prior comment, abandoned, timed
  // out)? This is the failure completeness cannot see - an output can be
  // complete, even substantive, yet still say nothing actionable.
  const staleness = analyzeCiStaleness(options);

  // Tier 2 - relevance / task-grounding: is the output actually about THIS
  // prompt, or boilerplate that ignored the task? This is the failure neither
  // completeness nor staleness can see - a verbatim guidance-file dump is
  // well-formed (passes completeness) and superficially actionable (passes
  // staleness: it has paths, code, directives), yet shares almost no vocabulary
  // with the diff it was asked to review (the #1302 mode).
  const relevance = analyzeTaskGrounding(
    options.prompt ?? '',
    options.output,
    relevanceMinPromptTerms,
  );

  const checks: CiCheckResult[] = [
    scoreCompleteness(completeness),
    scoreStaleness(staleness, options.output, minActionableArtifacts, trivialOutputChars),
    scoreRelevance(relevance, options.output, minPromptRelevance, relevanceMinOutputChars),
  ];

  return { checks, completeness, staleness, relevance };
}

/**
 * Evaluate a single CI run for output quality against its prompt, returning the
 * same {@link ActionEvaluation} the fleet adapter produces (so it plugs straight
 * into `emitActionResult` / `toActionOutputs` / `renderActionSummary`).
 *
 * Three independent checks run, all Tier 1/2 (no model-as-judge): structural
 * **completeness** (Tier 1), **staleness** (Tier 1 - no-op detection: did it emit
 * anything actionable?), and **relevance** (Tier 2 - task-grounding: is the
 * output about THIS prompt, or off-task boilerplate?). The relevance check
 * `skip`s (and so does not affect the gate) when no gradable prompt is supplied.
 *
 * The run is scored into one synthetic {@link TranscriptScore} and pushed through
 * the same `aggregateScorecard -> evaluateForAction` path the fleet uses: one run
 * becomes a one-worker scorecard, and the gate / outputs / summary all derive
 * from it. By default the worker grades on its single run's pass rate, so a run
 * with any failing check trips the gate (`gate: 'watch'` by default here, which
 * is stricter than the fleet default - a single CI run should be clean).
 *
 * On top of the fleet projection, the per-check **reasons** are spliced into
 * `evaluation.evidence` (and therefore `eval_evidence`): the worker-level
 * scorecard line names the failing check, while these add the specific
 * `summary` ("no-op: bare acknowledgement only …") a maintainer needs to act on
 * without re-running. Reasons are added only when at least one check failed.
 *
 * @param options - Prompt, output, worker name, thresholds, and gate options.
 */
export function evaluateCiRun(options: EvaluateCiRunOptions): CiRunEvaluation {
  const worker = options.worker ?? DEFAULT_WORKER;
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const startedAtMs = now.getTime();
  const runId = startedAt.replace(/[:.]/g, '-');

  const { checks, completeness, staleness, relevance } = scoreCiRun(options);

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

  // Enrich the evidence with the *specific* per-check reasons. The fleet adapter
  // can only see the synthetic scorecard, so on its own `eval_evidence` reads
  // `claude-review: at-risk (0% pass), top failure: staleness (1)` — it names the
  // failing check but not *why* it failed. For a single CI run we still have the
  // rich per-check `summary` in hand ("no-op: bare acknowledgement only …"), which
  // is the line a maintainer actually needs to act on. Splice those reasons in so
  // the gate's `eval_evidence` is self-explanatory without a re-run.
  evaluation.evidence = withCheckReasons(evaluation.evidence, checks, worker);

  return { evaluation, checks, completeness, staleness, relevance };
}

/**
 * Map a single-run check status to the {@link ActionEvidence} severity used by
 * the shared adapter (so the per-check reasons render with the same icons as the
 * worker-level findings): a hard fail is `critical`, a `warn` is `warning`.
 */
function severityForStatus(status: CiCheckStatus): ActionEvidence['severity'] {
  return status === 'fail' ? 'critical' : 'warning';
}

/**
 * Prepend the concrete per-check reasons (the rich {@link CiCheckResult.summary})
 * for every failing — and, if any check failed, every warning — check ahead of
 * the worker-level evidence the fleet adapter produced.
 *
 * Why this shape:
 *   - **Failing checks always surface their reason.** `staleness: no-op: bare
 *     acknowledgement only (bare approval)` is what tells a reviewer the run
 *     said nothing actionable; without it the gate just says "staleness failed".
 *   - **Warnings ride along only when something failed.** A clean run that merely
 *     warns (e.g. a thin-but-non-empty review) should not spam `eval_evidence`
 *     on a pass; but once the gate is already red, an adjacent warning is useful
 *     context for the human triaging it.
 *   - **Pure projection, no new judgement.** Every string here is a `summary`
 *     the deterministic checks already computed — this only changes *where* that
 *     signal is surfaced, keeping the module Tier 1/Tier 2.
 *
 * The original worker-level evidence (grade + pass rate + trend) is preserved
 * after the per-check lines so both the headline grade and the specific cause
 * are visible.
 */
function withCheckReasons(
  existing: readonly ActionEvidence[],
  checks: readonly CiCheckResult[],
  worker: string,
): ActionEvidence[] {
  const anyFail = checks.some((c) => c.status === 'fail');
  if (!anyFail) return [...existing];

  const reasons: ActionEvidence[] = checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => ({
      worker,
      severity: severityForStatus(c.status),
      message: `${worker}/${c.check}: ${c.summary}`,
    }));

  return [...reasons, ...existing];
}
