/**
 * Judge Framework — Type Vocabulary (Tier 3 Shared-Substrate Judgment)
 *
 * The shared type definitions for the model-as-judge framework: rubrics,
 * scoring levels, criterion scores, verdicts, backends, and raw responses.
 * Split out of `judge.ts` so the rubric, scoring, prompt, and evaluator seams
 * can each import the vocabulary without depending on one another.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

/** A single criterion in a rubric. */
export interface RubricCriterion {
  /** Short identifier for this criterion (e.g. "clarity", "accuracy"). */
  id: string;
  /** Human-readable description of what this criterion measures. */
  description: string;
  /** Weight of this criterion in the overall score (0–1). Weights are normalized. */
  weight?: number;
  /**
   * Scoring levels with concrete anchors.
   * Each level maps a numeric score to a description of what that score means.
   * Must have at least 2 levels. Scores need not be contiguous.
   */
  levels: ScoringLevel[];
}

/** A scoring level within a criterion. */
export interface ScoringLevel {
  /** Numeric score for this level (e.g. 1, 2, 3, 4, 5). */
  score: number;
  /** What this score means — a concrete anchor, not vague ("excellent"). */
  label: string;
  /** Detailed description with examples of what output at this level looks like. */
  description: string;
}

/** A complete rubric for judging agent output. */
export interface Rubric {
  /** Name of this rubric (e.g. "Code Review Quality"). */
  name: string;
  /** What this rubric evaluates — guides the judge. */
  description: string;
  /** The criteria to evaluate against. Must have at least one. */
  criteria: RubricCriterion[];
  /**
   * Overall pass threshold (0–1). A weighted average at or above this passes.
   * Default: 0.6
   */
  passThreshold?: number;
  /**
   * Minimum confidence required to issue a pass/fail verdict.
   * Below this, result is "needs-human-review". Default: 0.7
   */
  confidenceThreshold?: number;
}

/** Confidence level of a judgment. */
export type JudgeConfidence = 'high' | 'medium' | 'low';

/** Score for a single criterion from the judge. */
export interface CriterionScore {
  /** Criterion ID being scored. */
  criterionId: string;
  /** The numeric score assigned. */
  score: number;
  /** Maximum possible score for this criterion. */
  maxScore: number;
  /** Normalized score (0–1). */
  normalizedScore: number;
  /** Judge's explanation for why this score was given. */
  reasoning: string;
  /** Specific evidence from the output that supports the score. */
  evidence: string[];
  /** Confidence in this particular score. */
  confidence: JudgeConfidence;
}

/** Verdict from the judge: pass, fail, or needs review. */
export type JudgeVerdict = 'pass' | 'fail' | 'needs-human-review';

/** Complete result of a judge evaluation. */
export interface JudgeResult {
  /** Rubric used for evaluation. */
  rubricName: string;
  /** Overall verdict: pass, fail, or needs-human-review. */
  verdict: JudgeVerdict;
  /** Weighted average score (0–1). */
  overallScore: number;
  /** Per-criterion scores. */
  criterionScores: CriterionScore[];
  /** Overall confidence in the judgment. */
  confidence: JudgeConfidence;
  /** Numeric confidence value (0–1). */
  confidenceValue: number;
  /** Summary explanation of the overall judgment. */
  summary: string;
  /** Specific improvement suggestions. */
  suggestions: string[];
  /** Evaluation duration in milliseconds. */
  durationMs: number;
}

/** Options for running a judge evaluation. */
export interface JudgeOptions {
  /** Override the rubric's pass threshold. */
  passThreshold?: number;
  /** Override the rubric's confidence threshold. */
  confidenceThreshold?: number;
  /** Maximum number of retry attempts if parsing fails. Default: 2 */
  maxRetries?: number;
  /** Request that the judge explain its reasoning step by step. Default: true */
  chainOfThought?: boolean;
}

/**
 * Judge backend interface.
 *
 * Implementations provide the actual evaluation logic — either via an LLM call,
 * rule-based scoring, or human-in-the-loop.
 */
export interface JudgeBackend {
  /** Backend identifier. */
  readonly name: string;
  /**
   * Evaluate output against a rubric.
   * Returns raw criterion scores and reasoning — the framework handles
   * verdict determination and confidence labeling.
   */
  evaluate(
    output: string,
    rubric: Rubric,
    context: JudgeContext,
  ): Promise<RawJudgeResponse>;
}

/** Context passed to the judge backend. */
export interface JudgeContext {
  /** The original task/prompt given to the agent. */
  task: string;
  /** Reference materials the agent was given. */
  references?: string[];
  /** Additional artifacts: diffs, logs, side-effects, etc. */
  artifacts?: Record<string, string>;
  /** Whether to request chain-of-thought reasoning. */
  chainOfThought: boolean;
}

/** Raw response from a judge backend, before framework processing. */
export interface RawJudgeResponse {
  /** Per-criterion assessments. */
  scores: RawCriterionScore[];
  /** Overall summary from the judge. */
  summary: string;
  /** Improvement suggestions from the judge. */
  suggestions: string[];
}

/** Raw score for a single criterion from the backend. */
export interface RawCriterionScore {
  /** Criterion ID. */
  criterionId: string;
  /** Assigned score. */
  score: number;
  /** Judge's reasoning. */
  reasoning: string;
  /** Evidence quotes from the output. */
  evidence: string[];
  /** Self-reported confidence (0–1). */
  confidence: number;
}

/** Rubric validation error. */
export interface RubricValidationError {
  /** Path to the invalid field. */
  path: string;
  /** Description of the problem. */
  message: string;
}

/** Parse error from judge response. */
export interface JudgeParseError {
  /** What went wrong. */
  message: string;
  /** The raw response text that failed to parse. */
  rawResponse: string;
}

/**
 * A scoring function for rule-based judging.
 * Returns a score, reasoning, and evidence for a single criterion.
 */
export type ScoringFunction = (
  output: string,
  criterion: RubricCriterion,
  context: JudgeContext,
) => RawCriterionScore;
