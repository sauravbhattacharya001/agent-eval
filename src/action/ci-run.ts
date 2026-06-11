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
 *   - **Relevance** (Tier 2, {@link analyzeRelevance}): the *dual* of coverage.
 *     Coverage is recall ("did the output mention what the prompt asked?");
 *     relevance is precision ("is the output *spending its words on* the prompt,
 *     or on generic advice / boilerplate filler?"). It is the exact tell for an
 *     output that name-drops the prompt's keywords but is mostly about something
 *     else — "is this review about THIS PR, not generic advice?" The prompt is,
 *     again, a reference the agent never authored, and TF-IDF cosine similarity
 *     is computed from the byte content, not from anything the agent controls.
 *   - **Staleness** (Tier 1, {@link scoreStaleness}): the failure mode the
 *     completeness/coverage/relevance trio *cannot* see — a run that responded,
 *     on-topic, at length, but emitted **nothing a human can act on**. This is
 *     the open-issue cluster directly: a review that sits stale with no
 *     actionable output, a check abandoned mid-task, or a prior comment reposted
 *     verbatim with no new work. It is distinct from completeness (the output is
 *     non-empty, even substantive) and from relevance (it may be perfectly
 *     on-topic) — it is a **no-op**. The detector counts *concrete actionable
 *     artifacts* the agent did produce (file references, line numbers, code
 *     suggestions, actionable directives, structured review findings), flags
 *     pure-acknowledgement output ("LGTM", "looks good") below a substance floor,
 *     folds in {@link detectAbandonment} truncation/intent-without-follow-through
 *     signals, and — when given the prior comment and/or a run timeline —
 *     {@link detectParroting} verbatim-repost and {@link analyzeStaleness}
 *     timeout/abandonment. All of it is artifact pattern-counting and timestamp
 *     math; the "actionability" signal here is **not** a model-as-judge verdict —
 *     it asks "are concrete artifacts *present*?", never "is this *good*?".
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
  detectParroting,
} from '../checks/diff.js';
import {
  analyzeStaleness,
  detectAbandonment,
  formatDuration,
  type AbandonmentOptions,
  type RunTimeline,
  type StalenessIssue,
  type StalenessResult,
} from '../checks/staleness.js';
import {
  scoreKeywordCoverage,
  identifyTopicGaps,
  type KeywordCoverageScore,
  type KeywordCoverageScoringOptions,
  type TopicGapResult,
} from '../checks/keyword-coverage.js';
import {
  analyzeRelevance,
  type RelevanceOptions,
  type RelevanceResult,
} from '../checks/relevance.js';
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
  check: 'completeness' | 'keyword-coverage' | 'relevance' | 'staleness';
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
  /**
   * Minimum relevance (TF-IDF cosine similarity between prompt and output) in
   * [0, 1] to pass the relevance check. Default: 0.2 — the same default the
   * Tier 2 relevance assertion uses. Below this the output is mostly *not about*
   * the prompt (generic advice / boilerplate that happens to be present).
   */
  relevanceThreshold?: number;
  /**
   * At/under this relevance score the run is a hard failure to be *about* the
   * prompt (not just a warning). Default: 0.08 — at this level the output and
   * the prompt share almost no weighted vocabulary, i.e. the output is generic
   * filler unrelated to THIS task.
   */
  offTopicThreshold?: number;
  /** Extra completeness options forwarded to {@link checkCompleteness}. */
  completenessOptions?: CompletenessOptions;
  /** Extra keyword-coverage options forwarded to {@link scoreKeywordCoverage}. */
  keywordOptions?: KeywordCoverageScoringOptions;
  /** Extra relevance options forwarded to {@link analyzeRelevance}. */
  relevanceOptions?: RelevanceOptions;
  /**
   * Minimum number of distinct *concrete actionable artifacts* (file refs, line
   * numbers, code suggestions, actionable directives, structured findings) the
   * output must contain to pass the staleness check. Below this it is a `warn`
   * (low-substance / nothing actionable); zero artifacts on a non-trivial output
   * is a hard `fail` (a no-op review). Default: 2.
   */
  minActionableArtifacts?: number;
  /**
   * The agent's *previous* output for the same target (e.g. the prior review
   * comment on this PR). When supplied, the staleness check flags a verbatim or
   * near-verbatim **repost** (the #1302 "posts the same thing again" no-op) using
   * {@link detectParroting}. Omit if there is no prior output.
   */
  previousOutput?: string;
  /**
   * Similarity (0–1) at/above which the output is considered a repost of
   * `previousOutput`. Default: 0.9.
   */
  repostThreshold?: number;
  /**
   * Optional run timeline (start/end/events/timeout). When supplied, the
   * staleness check folds in {@link analyzeStaleness} — timeout, large activity
   * gaps, missing end event — the #1361 "check abandoned, timed out at the 2hr
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
  /** The Tier 2 relevance analysis (precision: is the output *about* the prompt?). */
  relevance: RelevanceResult;
  /** The Tier 1 staleness analysis (no-op: did it emit anything actionable?). */
  staleness: StalenessAnalysis;
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

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

const DEFAULT_WORKER = 'ci-run';
const DEFAULT_COVERAGE_THRESHOLD = 0.4;
const DEFAULT_IGNORED_PROMPT_THRESHOLD = 0.15;
const DEFAULT_RELEVANCE_THRESHOLD = 0.2;
const DEFAULT_OFF_TOPIC_THRESHOLD = 0.08;
const DEFAULT_MIN_ACTIONABLE_ARTIFACTS = 2;
const DEFAULT_REPOST_THRESHOLD = 0.9;
const DEFAULT_TRIVIAL_OUTPUT_CHARS = 80;

/**
 * Phrases that, when they dominate a short output, mark it as a pure
 * acknowledgement with no substantive review attached ("LGTM", "looks good to
 * me", "no changes needed"). Matched case-insensitively against the whole
 * (trimmed, collapsed) output; only decisive when the output is also short and
 * carries no concrete artifacts, so a long review that merely *contains* "looks
 * good" is not penalized.
 */
const ACKNOWLEDGEMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^(?:lgtm|looks good(?: to me)?|ship it|approved?|\+1|👍)\b/i, label: 'bare approval' },
  { pattern: /\bno (?:changes?|issues?|concerns?|comments?|problems?) (?:needed|found|here)\b/i, label: 'no-findings ack' },
  { pattern: /\b(?:all|everything) (?:looks? )?good\b/i, label: 'everything-good ack' },
  { pattern: /\bnothing (?:to add|to change|stands out)\b/i, label: 'nothing-to-add ack' },
];

/**
 * Patterns that count as **concrete actionable artifacts** — evidence a human
 * can act on. Presence-counted, never quality-judged. Each distinct *kind* that
 * fires contributes at most once to the artifact count (so one long code block
 * doesn't outweigh a file ref + a line number + a directive). This is the
 * opposite signal to {@link ACKNOWLEDGEMENT_PATTERNS}: an output rich in these is
 * not stale even if terse; an output with none is a no-op even if verbose.
 */
const ACTIONABLE_ARTIFACT_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; label: string }> = [
  // A path-like token with a slash or a known source extension, optionally
  // backtick-quoted: src/auth/login.ts, `config.yml`, lib/index.js.
  {
    id: 'file-ref',
    pattern:
      /(?:^|[\s`(])[\w./-]*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp|cs|php|sql|sh|ya?ml|json|toml|md|css|scss|html)\b|(?:^|[\s`])[\w-]+\/[\w./-]+/m,
    label: 'file reference',
  },
  // Explicit line references: "line 42", "L42", "lines 10-20", ":42:".
  {
    id: 'line-ref',
    pattern: /\b(?:lines?|L)\s*\d+(?:\s*[-–]\s*\d+)?\b|:\d+(?::\d+)?\b/i,
    label: 'line number',
  },
  // A fenced code block (a concrete suggested snippet/patch).
  { id: 'code-block', pattern: /```[\s\S]*?```/, label: 'code suggestion (fenced block)' },
  // An inline code span naming a concrete symbol/API/command: `INCR`,
  // `SET ... EX`, `useEffect`. Requires at least one code-ish character (a
  // non-space) so empty backticks don't count. A real review points at named
  // identifiers; pure prose rarely uses backticks at all.
  { id: 'inline-code', pattern: /`[^`\n]+`/, label: 'inline code reference' },
  // A diff/patch suggestion: a fenced/leading patch line (+/-) or unified-diff
  // syntax. NOT the bare word "diff" (which appears in prose like "review your
  // diff"); it must be actual patch syntax.
  { id: 'diff', pattern: /^[+-]{1,3}\s+\S|@@\s*-?\d+(?:,\d+)?\s*\+?\d*|\bgit diff\b|\bdiff --git\b/m, label: 'diff/patch' },
  // Actionable directive: a recommendation/imperative cue. Two ways to fire:
  //   (a) a strong recommendation word that is essentially never a noun in
  //       review prose (should, must, consider, recommend, suggest, please,
  //       need(s) to, ought to, instead of, refactor, rename, extract, replace,
  //       wrap in/with) — these signal "do X";
  //   (b) an imperative-form action verb at the START of a sentence or list item
  //       ("Use INCR", "Add a guard", "Remove the cast") — anchored so polysemous
  //       nouns mid-sentence ("the rate-limiting change", "the result set") do
  //       NOT match.
  {
    id: 'directive',
    pattern:
      /\b(?:should|must|consider|recommends?|recommended|suggests?|please|needs? to|ought to|instead of|refactor|rename|extract|replace|wrap (?:it |this |the )?(?:in|with))\b|(?:^|\n)\s*(?:[-*]|\d+[.)]\s)?\s*(?:use|add|remove|delete|move|fix|avoid|guard|handle|validate|rename|extract|replace|return|throw|set)\b|\b(?:use|call|add|pass|return|throw|wrap|replace|rename|set|import|export|await|guard|prefer)\s+(?:an?|the|a\s)?\s*`[^`\n]+`/im,
    label: 'actionable directive',
  },
  // Structured review findings: "Issue:", "Bug:", "Suggestion:", "nit:", numbered
  // or bulleted finding lists.
  {
    id: 'finding',
    pattern: /^\s*(?:[-*]|\d+[.)])\s+\S|(?:^|\n)\s*(?:issue|bug|suggestion|nit|warning|risk|concern|problem|note|todo)\s*[:\-]/im,
    label: 'structured finding',
  },
];

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

/**
 * Score the Tier 2 relevance check into a single-run result. This is the *dual*
 * of keyword coverage: coverage asks "did the output mention the prompt's
 * topics?" (recall), relevance asks "is the output *about* the prompt, or is it
 * generic filler?" (precision). The primary signal is TF-IDF cosine similarity
 * between prompt and output ({@link analyzeRelevance}); we also surface a
 * precision proxy — of the output's most distinctive terms, the fraction that
 * overlap the prompt rather than being off-topic "extra" terms — as supporting
 * evidence, plus the dominant off-topic terms themselves.
 *
 * At/under `offTopicThreshold` the output is essentially unrelated to the prompt
 * (hard `fail`); between that and `relevanceThreshold` it is a `warn` (drifting /
 * padded with generic advice); at/above it `pass`. An empty prompt or output is
 * unmeasurable and treated as a `pass` (completeness already catches the empty
 * output; an empty prompt is the caller's bug, not the agent's).
 */
function scoreRelevance(
  relevance: RelevanceResult,
  relevanceThreshold: number,
  offTopicThreshold: number,
): CiCheckResult {
  const score = round4(relevance.score);

  // Precision proxy from term *counts* (not weights — shared/extra weights live
  // on different scales in RelevanceResult, so a weight ratio is not comparable).
  // Of the output's distinctive terms (shared-with-prompt + off-topic extras),
  // what fraction overlap the prompt? Low = the output's vocabulary is off-topic.
  const sharedCount = relevance.sharedTerms.length;
  const extraCount = relevance.extraTerms.length;
  const distinctive = sharedCount + extraCount;
  const precision = distinctive > 0 ? round4(sharedCount / distinctive) : 0;

  // Unmeasurable (empty prompt or output) -> nothing to judge here.
  const measurable = sharedCount + relevance.missingTerms.length > 0;

  let status: CiCheckStatus;
  if (!measurable) {
    status = 'pass';
  } else if (score <= offTopicThreshold) {
    status = 'fail';
  } else if (score < relevanceThreshold) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  const offTopic = relevance.extraTerms.slice(0, 5).map((t) => t.term).filter(Boolean);
  const summary = !measurable
    ? 'not measurable (empty prompt or output)'
    : status === 'pass'
      ? `on-topic: ${(score * 100).toFixed(0)}% similarity to prompt`
      : status === 'fail'
        ? `off-topic: ${(score * 100).toFixed(0)}% similarity${offTopic.length ? `, dominated by ${offTopic.join(', ')}` : ''}`
        : `drifting: ${(score * 100).toFixed(0)}% similarity${offTopic.length ? `, off-topic terms ${offTopic.join(', ')}` : ''}`;

  return {
    check: 'relevance',
    tier: 2,
    score,
    status,
    summary,
    detail: {
      similarity: score,
      precision,
      sharedTerms: sharedCount,
      extraTerms: extraCount,
      missingTerms: relevance.missingTerms.length,
    },
  };
}

/**
 * Scan an output for concrete actionable artifacts. Each artifact *kind* counts
 * at most once, so a single huge code block cannot masquerade as a thorough
 * review and one file ref + one directive + one finding beats one repeated
 * pattern. This is presence counting over artifacts, NOT a quality judgement:
 * the question is "is there anything here a human could act on?", never "is it
 * good?" — which keeps it Tier 1 (deterministic, forgery-resistant) rather than
 * model-as-judge.
 */
export function analyzeActionability(output: string): ActionableArtifacts {
  const text = output ?? '';
  const kinds: string[] = [];
  const labels: string[] = [];
  for (const { id, pattern, label } of ACTIONABLE_ARTIFACT_PATTERNS) {
    if (pattern.test(text)) {
      kinds.push(id);
      labels.push(label);
    }
  }
  return { kinds, labels, count: kinds.length };
}

/**
 * Detect a bare-acknowledgement output: a short response that is (essentially)
 * only an approval / no-findings note, with no concrete artifacts. The length
 * guard keeps a long, substantive review that merely contains the words "looks
 * good" from being mislabeled — the acknowledgement must *be* the output, not
 * appear in it.
 */
function detectAcknowledgementOnly(
  output: string,
  artifacts: ActionableArtifacts,
  trivialOutputChars: number,
): { isAck: boolean; label?: string } {
  const collapsed = output.replace(/\s+/g, ' ').trim();
  // Only short, artifact-free outputs are candidates for a pure ack.
  if (collapsed.length === 0 || collapsed.length > trivialOutputChars * 2 || artifacts.count > 0) {
    return { isAck: false };
  }
  for (const { pattern, label } of ACKNOWLEDGEMENT_PATTERNS) {
    if (pattern.test(collapsed)) return { isAck: true, label };
  }
  return { isAck: false };
}

/**
 * Run the full Tier 1 staleness / no-op analysis for one CI run: the artifact
 * scan, the acknowledgement-only check, output-text abandonment, and — when the
 * caller supplied them — verbatim-repost detection against a prior output and
 * timeline-based timeout/abandonment.
 */
export function analyzeCiStaleness(options: EvaluateCiRunOptions): StalenessAnalysis {
  const output = options.output ?? '';
  const trivialOutputChars = options.trivialOutputChars ?? DEFAULT_TRIVIAL_OUTPUT_CHARS;
  const repostThreshold = options.repostThreshold ?? DEFAULT_REPOST_THRESHOLD;

  const artifacts = analyzeActionability(output);
  const ack = detectAcknowledgementOnly(output, artifacts, trivialOutputChars);

  // Truncation / dangling-intent signals in the output text itself. We surface
  // only the *error*-severity ones (unbalanced code = real truncation) and the
  // "stated intent without follow-through" signal, which is the no-op tell.
  const abandonment = detectAbandonment(output, options.abandonmentOptions);

  // Verbatim repost of the prior comment (the #1302 "posts the same thing"
  // no-op). Only meaningful when a previous output was supplied.
  let isRepost = false;
  let repostSimilarity = Number.NaN;
  if (typeof options.previousOutput === 'string' && options.previousOutput.trim().length > 0) {
    const { isParroting, similarity } = detectParroting(output, options.previousOutput, {
      threshold: repostThreshold,
      ignoreWhitespace: true,
    });
    isRepost = isParroting;
    repostSimilarity = similarity;
  }

  // Timeline staleness (timeout / gaps / no end). Only when a timeline is given.
  let timeline: StalenessResult | undefined;
  if (options.timeline) {
    const fullTimeline: RunTimeline = {
      ...options.timeline,
      output: options.timeline.output ?? output,
    };
    timeline = analyzeStaleness(fullTimeline, {
      ...(options.abandonmentOptions ? { abandonment: options.abandonmentOptions } : {}),
    });
  }

  return {
    artifacts,
    isAcknowledgementOnly: ack.isAck,
    ...(ack.label ? { acknowledgement: ack.label } : {}),
    abandonment,
    isRepost,
    repostSimilarity,
    ...(timeline ? { timeline } : {}),
  };
}

/**
 * Score the Tier 1 staleness check into a single-run result. This is the no-op
 * detector: a run can pass completeness (non-empty, even substantive), coverage
 * (mentions the topics), and relevance (on-topic) and still be a **stale no-op**
 * — it emitted nothing actionable, reposted the prior comment, abandoned
 * mid-task, or timed out. Those are exactly the open-issue failures a crash
 * check cannot see.
 *
 * Verdict precedence (worst wins):
 *   - **fail** if the timeline analysis found a hard error (timeout / no output),
 *     OR the output is a verbatim repost of the prior comment, OR the output is
 *     a bare acknowledgement, OR a non-trivial output (> `trivialOutputChars`)
 *     contains **zero** concrete actionable artifacts, OR the output text shows
 *     an error-severity abandonment signal (truncated mid-code).
 *   - **warn** if a trivially short output has zero artifacts, OR the artifact
 *     count is below `minActionableArtifacts` (thin but not empty), OR the
 *     timeline flagged a non-fatal staleness gap, OR there is a dangling-intent
 *     abandonment signal.
 *   - **pass** otherwise (enough actionable substance, no no-op signals).
 *
 * The score is a graded function of artifact richness minus penalties, so it is
 * meaningful in a trend rather than a bare boolean.
 */
function scoreStaleness(
  analysis: StalenessAnalysis,
  output: string,
  minActionableArtifacts: number,
  trivialOutputChars: number,
): CiCheckResult {
  const { artifacts } = analysis;
  const isTrivialLength = output.trim().length <= trivialOutputChars;
  const errorAbandon = analysis.abandonment.filter((i) => i.severity === 'error');
  const intentAbandon = analysis.abandonment.filter(
    (i) => i.kind === 'no_progress' || /intent|incomplete|ellipsis|empty/i.test(i.message),
  );
  const timelineErrors = analysis.timeline?.issues.filter((i) => i.severity === 'error') ?? [];
  const timelineWarnings = analysis.timeline?.issues.filter((i) => i.severity === 'warning') ?? [];

  // Hard no-op conditions.
  const failReasons: string[] = [];
  if (timelineErrors.length > 0) {
    failReasons.push(`run ${timelineErrors.map((i) => i.kind).join('/')} (${formatDuration(analysis.timeline?.durationMs ?? Number.NaN)})`);
  }
  if (analysis.isRepost) {
    failReasons.push(`reposts prior comment verbatim (${(analysis.repostSimilarity * 100).toFixed(0)}% identical)`);
  }
  if (analysis.isAcknowledgementOnly) {
    failReasons.push(`bare acknowledgement only (${analysis.acknowledgement})`);
  }
  if (!isTrivialLength && artifacts.count === 0) {
    failReasons.push('no actionable content (no file refs, line numbers, code, directives, or findings)');
  }
  if (errorAbandon.length > 0) {
    failReasons.push(errorAbandon.map((i) => i.message).join('; '));
  }

  // Soft (warn) conditions.
  const warnReasons: string[] = [];
  if (isTrivialLength && artifacts.count === 0) {
    warnReasons.push('very short with no actionable content');
  }
  if (artifacts.count > 0 && artifacts.count < minActionableArtifacts) {
    warnReasons.push(`thin: only ${artifacts.count} actionable artifact kind(s) (expected ≥ ${minActionableArtifacts})`);
  }
  if (timelineWarnings.length > 0) {
    warnReasons.push(`timeline: ${timelineWarnings.map((i) => i.kind).join(', ')}`);
  }
  if (intentAbandon.length > 0) {
    warnReasons.push(intentAbandon.map((i) => i.message).join('; '));
  }

  let status: CiCheckStatus;
  if (failReasons.length > 0) {
    status = 'fail';
  } else if (warnReasons.length > 0) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  // Graded score: start from coverage of artifact kinds, then subtract penalties.
  const totalKinds = ACTIONABLE_ARTIFACT_PATTERNS.length;
  const richness = totalKinds > 0 ? artifacts.count / totalKinds : 0;
  let penalty = 0;
  if (failReasons.length > 0) penalty += 0.6;
  penalty += warnReasons.length * 0.12;
  if (analysis.isRepost) penalty += 0.4;
  const score = round4(Math.max(0, Math.min(1, richness * 0.7 + 0.3 - penalty)));

  const summary =
    status === 'pass'
      ? `actionable: ${artifacts.count} artifact kind(s) present (${artifacts.labels.join(', ')})`
      : status === 'fail'
        ? `no-op: ${failReasons.join('; ')}`
        : `low-substance: ${warnReasons.join('; ')}`;

  return {
    check: 'staleness',
    tier: 1,
    score,
    status,
    summary,
    detail: {
      artifactKinds: artifacts.count,
      artifacts: artifacts.kinds.join(',') || 'none',
      ackOnly: analysis.isAcknowledgementOnly,
      repost: analysis.isRepost,
      repostSimilarity: Number.isFinite(analysis.repostSimilarity) ? round4(analysis.repostSimilarity) : 'n/a',
      abandonErrors: errorAbandon.length,
      timelineErrors: timelineErrors.length,
      timelineWarnings: timelineWarnings.length,
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
): {
  checks: CiCheckResult[];
  completeness: CompletenessResult;
  coverage: KeywordCoverageScore;
  gaps: TopicGapResult;
  relevance: RelevanceResult;
  staleness: StalenessAnalysis;
} {
  const coverageThreshold = options.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const ignoredPromptThreshold = options.ignoredPromptThreshold ?? DEFAULT_IGNORED_PROMPT_THRESHOLD;
  const relevanceThreshold = options.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const offTopicThreshold = options.offTopicThreshold ?? DEFAULT_OFF_TOPIC_THRESHOLD;
  const minActionableArtifacts = options.minActionableArtifacts ?? DEFAULT_MIN_ACTIONABLE_ARTIFACTS;
  const trivialOutputChars = options.trivialOutputChars ?? DEFAULT_TRIVIAL_OUTPUT_CHARS;

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

  // Tier 2 — relevance is the dual of coverage: is the output *about* the prompt
  // (precision), not just touching its keywords? Same prompt-as-reference logic.
  const relevanceOpts: RelevanceOptions = {
    threshold: relevanceThreshold,
    ...options.relevanceOptions,
  };
  const relevance = analyzeRelevance(options.prompt, options.output, relevanceOpts);

  // Tier 1 — staleness / no-op: did the run emit anything actionable, or is it a
  // stale no-op (nothing to act on, reposted prior comment, abandoned, timed
  // out)? This is the failure the trio above cannot see — an output can be
  // complete, cover the topics, and be on-topic, yet still say nothing useful.
  const staleness = analyzeCiStaleness(options);

  const checks: CiCheckResult[] = [
    scoreCompleteness(completeness),
    scoreCoverage(coverage, gaps, coverageThreshold, ignoredPromptThreshold),
    scoreRelevance(relevance, relevanceThreshold, offTopicThreshold),
    scoreStaleness(staleness, options.output, minActionableArtifacts, trivialOutputChars),
  ];

  return { checks, completeness, coverage, gaps, relevance, staleness };
}

/**
 * Evaluate a single CI run for output quality against its prompt, returning the
 * same {@link ActionEvaluation} the fleet adapter produces (so it plugs straight
 * into `emitActionResult` / `toActionOutputs` / `renderActionSummary`).
 *
 * Four independent checks run, all Tier 1 / Tier 2 (no model-as-judge): structural
 * **completeness**, **keyword coverage** (recall), **relevance** (precision), and
 * **staleness** (no-op detection — did it emit anything actionable?).
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

  const { checks, completeness, coverage, gaps, relevance, staleness } = scoreCiRun(options);

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

  return { evaluation, checks, completeness, coverage, gaps, relevance, staleness };
}
