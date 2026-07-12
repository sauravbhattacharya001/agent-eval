/**
 * Judge Framework — Tier 3 Shared-Substrate Judgment
 *
 * A structured rubric system for model-as-judge evaluation. This is the LAST
 * resort in the eval hierarchy — only used when Tier 1 (deterministic) and
 * Tier 2 (heuristic) checks cannot answer the question.
 *
 * Key design principles:
 * - Every judgment uses a structured rubric — no open-ended "is this good?"
 * - The judge evaluates ARTIFACTS only, never internal reasoning traces
 * - Confidence labeling: uncertain results become "needs-human-review" not pass/fail
 * - The judge task must be EASIER than the original task (grading < creating)
 * - Model-as-judge is a SIGNAL, not a verdict
 *
 * This module is the **public barrel** for the judge framework. The framework
 * is decomposed along clear seams and re-exported here so the public surface is
 * a single import path (`./judge.js`):
 * - `./judge-types.js`      — the type vocabulary (rubrics, scores, verdicts)
 * - `./judge-rubric.js`     — rubric authoring + validation + built-in rubrics
 * - `./judge-scoring.js`    — deterministic verdict computation
 * - `./judge-prompt.js`     — LLM prompt building + response parsing
 * - `./judge-evaluator.js`  — runtime backends (`RuleBasedJudge`) + `JudgeEvaluator`
 * - `./judge-assertions.js` — the Tier-3 assertion factories
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

// ─── TYPE RE-EXPORTS ──────────────────────────────────────────────────────────
// The judge framework's public type vocabulary lives in ./judge-types.js;
// re-export it here so consumers keep a single `./judge.js` import path.
export type {
  RubricCriterion,
  ScoringLevel,
  Rubric,
  JudgeConfidence,
  CriterionScore,
  JudgeVerdict,
  JudgeResult,
  JudgeOptions,
  JudgeBackend,
  JudgeContext,
  RawJudgeResponse,
  RawCriterionScore,
  RubricValidationError,
  JudgeParseError,
  ScoringFunction,
} from './judge-types.js';

// ─── RUBRIC AUTHORING RE-EXPORTS ────────────────────────────────────────────────
// Rubric validation, the fluent builder pair, and the built-in starter rubrics.
export {
  validateRubric,
  buildRubric,
  RubricBuilder,
  CriterionBuilder,
  BUILTIN_RUBRICS,
} from './judge-rubric.js';

// ─── SCORING ENGINE RE-EXPORTS ──────────────────────────────────────────────────
// Deterministic verdict computation, separated so it is testable without an LLM.
export {
  computeVerdict,
  normalizeCriterionWeights,
  getMaxScore,
  getMinScore,
  classifyConfidence,
} from './judge-scoring.js';

// ─── PROMPT / RESPONSE RE-EXPORTS ───────────────────────────────────────────────
// LLM prompt generation + response parsing + JSON extraction.
export {
  buildJudgePrompt,
  parseJudgeResponse,
  extractJson,
} from './judge-prompt.js';

// ─── RUNTIME RE-EXPORTS ─────────────────────────────────────────────────────────
// The no-LLM rule-based backend + the evaluator that combines a backend with a
// rubric and deterministic verdict computation.
export {
  RuleBasedJudge,
  JudgeEvaluator,
} from './judge-evaluator.js';

// ─── ASSERTION FACTORY RE-EXPORTS ───────────────────────────────────────────────
// The Tier-3 assertion factories that adapt a JudgeEvaluator into an Assertion.
export {
  toPassJudge,
  toScoreOnCriterion,
  toHaveJudgeConfidence,
  toMeetAllCriteria,
  toHaveJudgeSuggestions,
} from './judge-assertions.js';
