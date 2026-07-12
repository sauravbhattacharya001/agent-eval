/**
 * Judge Assertions — Tier-3 assertion factories
 *
 * The `toPassJudge` / `toScoreOnCriterion` / `toHaveJudgeConfidence` /
 * `toMeetAllCriteria` / `toHaveJudgeSuggestions` assertion factories that adapt
 * a `JudgeEvaluator` into the framework's `Assertion` shape.
 *
 * Split out of `./judge.ts` along a runtime/assertion seam with no behavior
 * change; re-exported from `./judge.js` so the public import path is stable.
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type { JudgeBackend, JudgeOptions, Rubric } from './judge-types.js';
import { JudgeEvaluator } from './judge-evaluator.js';

/**
 * Create an assertion that evaluates output using a judge with a rubric.
 *
 * This is a Tier 3 assertion — it uses model-as-judge (or rule-based judge)
 * to evaluate subjective quality aspects.
 *
 * @param backend - The judge backend to use
 * @param rubric - The rubric to evaluate against
 * @param options - Judge options (thresholds, etc.)
 */
export function toPassJudge(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric, options);

  return {
    name: `[Tier 3] judge: ${rubric.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        const criteriaDetails = result.criterionScores
          .map((cs) => `${cs.criterionId}: ${cs.normalizedScore.toFixed(2)} (${cs.confidence})`)
          .join(', ');

        return {
          status,
          name: `[Tier 3] judge: ${rubric.name}`,
          message: status === 'pass'
            ? undefined
            : result.verdict === 'needs-human-review'
              ? `Judge confidence too low (${result.confidenceValue.toFixed(2)}) — needs human review`
              : `Judge verdict: fail (score=${result.overallScore.toFixed(2)}, threshold=${options?.passThreshold ?? rubric.passThreshold ?? 0.6})`,
          expected: `pass (>= ${options?.passThreshold ?? rubric.passThreshold ?? 0.6})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)}, confidence=${result.confidenceValue.toFixed(2)})`,
          evidence: `Criteria: ${criteriaDetails}\nSummary: ${result.summary}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge: ${rubric.name}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks a specific criterion score.
 *
 * @param backend - The judge backend to use
 * @param rubric - The rubric containing the criterion
 * @param criterionId - The criterion to check
 * @param minNormalizedScore - Minimum normalized score (0–1) to pass. Default: 0.6
 */
export function toScoreOnCriterion(
  backend: JudgeBackend,
  rubric: Rubric,
  criterionId: string,
  minNormalizedScore = 0.6,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] criterion: ${criterionId} >= ${minNormalizedScore}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const criterionScore = result.criterionScores.find((cs) => cs.criterionId === criterionId);
        if (!criterionScore) {
          return {
            status: 'error',
            name: `[Tier 3] criterion: ${criterionId}`,
            message: `Criterion "${criterionId}" not found in judge results`,
            durationMs: performance.now() - start,
          };
        }

        if (criterionScore.confidence === 'low') {
          return {
            status: 'skip',
            name: `[Tier 3] criterion: ${criterionId}`,
            message: `Low confidence on criterion "${criterionId}" — needs human review`,
            evidence: criterionScore.reasoning,
            durationMs: performance.now() - start,
          };
        }

        const pass = criterionScore.normalizedScore >= minNormalizedScore;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] criterion: ${criterionId} >= ${minNormalizedScore}`,
          message: pass ? undefined : `Criterion "${criterionId}" scored ${criterionScore.normalizedScore.toFixed(2)}, below threshold ${minNormalizedScore}`,
          expected: `>= ${minNormalizedScore}`,
          actual: `${criterionScore.normalizedScore.toFixed(2)} (${criterionScore.confidence} confidence)`,
          evidence: criterionScore.reasoning,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] criterion: ${criterionId}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks the judge's overall confidence.
 * If confidence is below the threshold, the assertion returns "needs-human-review" (skip).
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minConfidence - Minimum confidence value (0–1). Default: 0.7
 */
export function toHaveJudgeConfidence(
  backend: JudgeBackend,
  rubric: Rubric,
  minConfidence = 0.7,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] judge confidence >= ${minConfidence}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const pass = result.confidenceValue >= minConfidence;
        return {
          status: pass ? 'pass' : 'skip',
          name: `[Tier 3] judge confidence >= ${minConfidence}`,
          message: pass ? undefined : `Judge confidence ${result.confidenceValue.toFixed(2)} below threshold ${minConfidence} — needs human review`,
          expected: `confidence >= ${minConfidence}`,
          actual: `${result.confidenceValue.toFixed(2)} (${result.confidence})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge confidence >= ${minConfidence}`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that requires all criteria to meet minimum scores.
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minScores - Map of criterion ID → minimum normalized score
 */
export function toMeetAllCriteria(
  backend: JudgeBackend,
  rubric: Rubric,
  minScores: Record<string, number>,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] all criteria meet minimums`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const failures: string[] = [];
        const lowConfidence: string[] = [];

        for (const [criterionId, minScore] of Object.entries(minScores)) {
          const cs = result.criterionScores.find((s) => s.criterionId === criterionId);
          if (!cs) {
            failures.push(`"${criterionId}": not found in results`);
            continue;
          }
          if (cs.confidence === 'low') {
            lowConfidence.push(`"${criterionId}": low confidence`);
            continue;
          }
          if (cs.normalizedScore < minScore) {
            failures.push(`"${criterionId}": ${cs.normalizedScore.toFixed(2)} < ${minScore}`);
          }
        }

        if (lowConfidence.length > 0) {
          return {
            status: 'skip',
            name: `[Tier 3] all criteria meet minimums`,
            message: `Low confidence on: ${lowConfidence.join('; ')}`,
            evidence: result.summary,
            durationMs: performance.now() - start,
          };
        }

        const pass = failures.length === 0;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] all criteria meet minimums`,
          message: pass ? undefined : `Criteria below minimums: ${failures.join('; ')}`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] all criteria meet minimums`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Create an assertion that checks for the presence of improvement suggestions.
 * A judge that finds nothing to suggest may indicate shallow evaluation.
 *
 * @param backend - The judge backend
 * @param rubric - The rubric to evaluate against
 * @param minSuggestions - Minimum number of suggestions expected. Default: 1
 */
export function toHaveJudgeSuggestions(
  backend: JudgeBackend,
  rubric: Rubric,
  minSuggestions = 1,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, rubric);

  return {
    name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const result = await evaluator.evaluate(output, {
          task: context?.prompt ?? '',
          references: context?.references,
        });

        const count = result.suggestions.length;
        const pass = count >= minSuggestions;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
          message: pass ? undefined : `Judge provided ${count} suggestion(s), expected >= ${minSuggestions}`,
          expected: `>= ${minSuggestions} suggestions`,
          actual: `${count} suggestions`,
          evidence: result.suggestions.join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] judge provides >= ${minSuggestions} suggestion(s)`,
          message: `Judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
