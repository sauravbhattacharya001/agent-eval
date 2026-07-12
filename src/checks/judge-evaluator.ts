/**
 * Judge Runtime — backends + evaluator
 *
 * The runtime pieces that wire the judge framework together: the no-LLM
 * `RuleBasedJudge` backend and the `JudgeEvaluator` that combines a backend
 * with a rubric + deterministic verdict computation.
 *
 * Split out of `./judge.ts` along a runtime/assertion seam with no behavior
 * change; re-exported from `./judge.js` so the public import path is stable.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type {
  JudgeBackend,
  JudgeContext,
  JudgeOptions,
  JudgeResult,
  RawCriterionScore,
  RawJudgeResponse,
  Rubric,
  ScoringFunction,
} from './judge-types.js';
import { validateRubric } from './judge-rubric.js';
import { computeVerdict, getMinScore } from './judge-scoring.js';

// ─── RULE-BASED JUDGE BACKEND ───────────────────────────────────────────────────

/**
 * Rule-based judge backend — no LLM required.
 *
 * Uses programmatic scoring functions for each criterion.
 * Ideal for deterministic aspects of Tier 3 evaluation that don't need
 * an LLM but still use the rubric framework for structured scoring.
 */
export class RuleBasedJudge implements JudgeBackend {
  readonly name = 'rule-based';
  private scoringFunctions: Map<string, ScoringFunction>;

  constructor(scoringFunctions: Record<string, ScoringFunction>) {
    this.scoringFunctions = new Map(Object.entries(scoringFunctions));
  }

  async evaluate(
    output: string,
    rubric: Rubric,
    context: JudgeContext,
  ): Promise<RawJudgeResponse> {
    const scores: RawCriterionScore[] = [];

    for (const criterion of rubric.criteria) {
      const fn = this.scoringFunctions.get(criterion.id);
      if (fn) {
        scores.push(fn(output, criterion, context));
      } else {
        // No scoring function — mark as low confidence
        scores.push({
          criterionId: criterion.id,
          score: getMinScore(criterion),
          reasoning: `No scoring function registered for criterion "${criterion.id}"`,
          evidence: [],
          confidence: 0,
        });
      }
    }

    return {
      scores,
      summary: 'Rule-based evaluation complete',
      suggestions: [],
    };
  }
}

// ─── JUDGE EVALUATOR ────────────────────────────────────────────────────────────

/**
 * Main judge evaluator — combines a backend with rubric + verdict computation.
 *
 * Usage:
 * ```ts
 * const judge = new JudgeEvaluator(backend, rubric);
 * const result = await judge.evaluate(output, { task: 'Review this PR' });
 * // result.verdict → 'pass' | 'fail' | 'needs-human-review'
 * ```
 */
export class JudgeEvaluator {
  private backend: JudgeBackend;
  private rubric: Rubric;
  private options: JudgeOptions;

  constructor(backend: JudgeBackend, rubric: Rubric, options?: JudgeOptions) {
    const errors = validateRubric(rubric);
    if (errors.length > 0) {
      const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Invalid rubric "${rubric.name}":\n${messages}`);
    }

    this.backend = backend;
    this.rubric = rubric;
    this.options = options ?? {};
  }

  /** Evaluate output and return a structured verdict. */
  async evaluate(
    output: string,
    context: Omit<JudgeContext, 'chainOfThought'>,
  ): Promise<JudgeResult> {
    const fullContext: JudgeContext = {
      ...context,
      chainOfThought: this.options.chainOfThought ?? true,
    };

    const rawResponse = await this.backend.evaluate(output, this.rubric, fullContext);
    return computeVerdict(rawResponse, this.rubric, this.options);
  }

  /** Get the rubric being used. */
  getRubric(): Rubric {
    return this.rubric;
  }

  /** Get the backend name. */
  getBackendName(): string {
    return this.backend.name;
  }
}
