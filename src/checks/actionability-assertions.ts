/**
 * Actionability Assertions — the Tier-2/Tier-3 assertion factories.
 *
 * This seam holds the assertion factories that compose the heuristic
 * actionability pass (`analyzeActionability`) — and, for `toPassActionabilityJudge`,
 * the Tier-3 judge framework — into `Assertion` objects usable by the runner.
 *
 * It is split out of `./actionability.ts` (the public barrel) with **no behavior
 * change**: every factory below was moved here verbatim. The barrel re-exports
 * these symbols, so consumers keep a single `./actionability.js` import path.
 *
 * @tier mixed (2+3)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type { JudgeBackend, JudgeOptions } from './judge.js';
import { JudgeEvaluator } from './judge.js';
import type { ActionabilityOptions } from './actionability-types.js';
import { analyzeActionability } from './actionability-scoring.js';
import { ACTIONABILITY_RUBRIC } from './actionability-rubric.js';

/**
 * Assert that the output is actionable — a human can take a concrete next step from it.
 *
 * Uses Tier 2 heuristic analysis (sentence-level signal extraction).
 *
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toBeActionable(options: ActionabilityOptions = {}): Assertion {
  return {
    name: '[Tier 2] output is actionable',
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        return {
          status: result.pass ? 'pass' : 'fail',
          name: '[Tier 2] output is actionable',
          message: result.pass ? undefined : `Actionability score ${(result.score * 100).toFixed(0)}% below threshold`,
          expected: `score >= ${((options.minScore ?? 0.4) * 100).toFixed(0)}%, actionable ratio >= ${((options.minActionableRatio ?? 0.3) * 100).toFixed(0)}%`,
          actual: `score = ${(result.score * 100).toFixed(0)}%, actionable ratio = ${(result.actionableRatio * 100).toFixed(0)}%`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 2] output is actionable',
          message: `Actionability check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output has minimal filler content.
 *
 * @param maxFillerRatio - Maximum allowed filler ratio (0–1). Default: 0.4
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toHaveMinimalFiller(
  maxFillerRatio = 0.4,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.fillerRatio <= maxFillerRatio;
        const fillerKinds = [...new Set(result.fillerPatterns.map((f) => f.kind))];

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
          message: pass ? undefined : `Filler ratio ${(result.fillerRatio * 100).toFixed(0)}% exceeds ${(maxFillerRatio * 100).toFixed(0)}%`,
          expected: `<= ${(maxFillerRatio * 100).toFixed(0)}%`,
          actual: `${(result.fillerRatio * 100).toFixed(0)}% (${result.fillerPatterns.length} patterns: ${fillerKinds.join(', ')})`,
          evidence: result.fillerPatterns.slice(0, 5).map((f) => `[${f.kind}] "${f.text.slice(0, 60)}"`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] filler ratio <= ${(maxFillerRatio * 100).toFixed(0)}%`,
          message: `Filler check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output achieves a minimum specificity score.
 *
 * Specificity measures how concrete the references are — files, code, values vs. vague pointers.
 *
 * @param minSpecificity - Minimum specificity score (0–1). Default: 0.5
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toBeSpecific(
  minSpecificity = 0.5,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.specificityScore >= minSpecificity;

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
          message: pass ? undefined : `Specificity ${(result.specificityScore * 100).toFixed(0)}% below ${(minSpecificity * 100).toFixed(0)}%`,
          expected: `>= ${(minSpecificity * 100).toFixed(0)}%`,
          actual: `${(result.specificityScore * 100).toFixed(0)}% (${result.actionableElements.length} actionable elements)`,
          evidence: result.actionableElements.slice(0, 5).map((e) => `[${e.kind}] "${e.text.slice(0, 60)}"`).join('\n'),
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] specificity >= ${(minSpecificity * 100).toFixed(0)}%`,
          message: `Specificity check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output meets actionability standards using a judge with the ACTIONABILITY_RUBRIC.
 *
 * Use this when Tier 2 heuristics produce ambiguous results (confidence < 0.6).
 *
 * @param backend - The judge backend (LLM or rule-based)
 * @param options - Judge options
 * @tier 3 — Shared-Substrate Judgment
 */
export function toPassActionabilityJudge(
  backend: JudgeBackend,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, ACTIONABILITY_RUBRIC, options);

  return {
    name: '[Tier 3] judge: actionability',
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
          name: '[Tier 3] judge: actionability',
          message: status === 'pass'
            ? undefined
            : result.verdict === 'needs-human-review'
              ? `Judge confidence too low — needs human review`
              : `Actionability judge: fail (score=${result.overallScore.toFixed(2)})`,
          expected: `pass (>= ${options?.passThreshold ?? ACTIONABILITY_RUBRIC.passThreshold ?? 0.55})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)}, confidence=${result.confidenceValue.toFixed(2)})`,
          evidence: `Criteria: ${criteriaDetails}\nSummary: ${result.summary}`,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: '[Tier 3] judge: actionability',
          message: `Judge evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert that the output has a minimum actionability score.
 *
 * @param minScore - Minimum actionability score (0–1). Default: 0.4
 * @param options - Actionability analysis options
 * @tier 2 — Heuristic
 */
export function toHaveActionabilityAbove(
  minScore = 0.4,
  options: ActionabilityOptions = {},
): Assertion {
  return {
    name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      try {
        const opts: ActionabilityOptions = {
          ...options,
          taskText: options.taskText ?? context?.prompt,
        };
        const result = analyzeActionability(output, opts);

        const pass = result.score >= minScore;

        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
          message: pass ? undefined : `Score ${(result.score * 100).toFixed(0)}% below threshold ${(minScore * 100).toFixed(0)}%`,
          expected: `>= ${(minScore * 100).toFixed(0)}%`,
          actual: `${(result.score * 100).toFixed(0)}%`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 2] actionability score >= ${(minScore * 100).toFixed(0)}%`,
          message: `Score check failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
