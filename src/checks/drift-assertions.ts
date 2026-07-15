/**
 * Drift assertion factories — the Tier 3 drift `Assertion` builders.
 *
 * These wrap the drift analysis engine (`analyzeDrift`, see ./drift.ts) in the
 * `Assertion` shape consumed by the runner. They live in a sibling module so the
 * orchestrator file (`./drift.ts`) stays focused on the analysis pipeline itself
 * (decomposition → segmentation → mapping → scoring). Each factory is re-exported
 * from `./drift.js` so the public surface is unchanged; every consumer keeps
 * importing them, and `analyzeDrift`, from `./drift.js`.
 *
 * @tier 3 — Shared-Substrate Judgment (uses judge when heuristics are ambiguous)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type { JudgeBackend, JudgeOptions } from './judge.js';
import { JudgeEvaluator } from './judge.js';
import { DRIFT_RUBRIC } from './drift-rubric.js';
import type { DriftKind, DriftAnalysisOptions } from './drift-types.js';
import { analyzeDrift } from './drift.js';

/**
 * Create an assertion that checks for task drift using the full analysis pipeline.
 *
 * This is the primary drift assertion — it decomposes the task, segments the output,
 * maps requirements, and detects drift patterns.
 *
 * @param options - Drift analysis options (thresholds, judge config)
 * @tier 3 — Uses heuristics (Tier 1+2) and optionally model-as-judge (Tier 3)
 */
export function toNotDrift(options?: DriftAnalysisOptions): Assertion {
  const threshold = 1 - (options?.coverageThreshold ?? 0.6);

  return {
    name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no task drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output, options);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] no task drift`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      if (result.onTask) {
        return {
          status: 'pass',
          name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no task drift (max drift: ${threshold.toFixed(2)})`,
        message: result.summary,
        expected: `drift score < ${threshold.toFixed(2)}`,
        actual: `drift score = ${result.driftScore.toFixed(2)}`,
        evidence: result.issues.map((i) => `${i.kind}: ${i.description}`).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks requirement coverage — what proportion
 * of the task's requirements are addressed in the output.
 *
 * @param minCoverage - Minimum proportion of requirements to address (0–1). Default: 0.6
 * @tier 3 — Multi-tier analysis (decomposition + relevance scoring)
 */
export function toAddressRequirements(minCoverage = 0.6): Assertion {
  return {
    name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] addresses requirements`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);
      const pass = result.requirementCoverage >= minCoverage;

      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] addresses >= ${(minCoverage * 100).toFixed(0)}% of requirements`,
        message: pass ? undefined :
          `Only ${(result.requirementCoverage * 100).toFixed(0)}% of requirements addressed (need ${(minCoverage * 100).toFixed(0)}%)`,
        expected: `>= ${(minCoverage * 100).toFixed(0)}% coverage`,
        actual: `${(result.requirementCoverage * 100).toFixed(0)}% (${result.requirements.filter((_, i) =>
          result.segments.some((s) => s.addressesRequirements.includes(i)),
        ).length}/${result.requirements.length})`,
        evidence: result.requirements.map((r, i) => {
          const covered = result.segments.some((s) => s.addressesRequirements.includes(i));
          return `${covered ? '\u2713' : '\u2717'} [${r.action}] ${r.subject}`;
        }).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that checks the drift score is below a maximum.
 *
 * @param maxDrift - Maximum acceptable drift score (0–1). Default: 0.4
 * @tier 3 — Multi-tier analysis
 */
export function toHaveDriftBelow(maxDrift = 0.4): Assertion {
  return {
    name: `[Tier 3] drift score < ${maxDrift}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      if (result.needsReview) {
        return {
          status: 'skip',
          name: `[Tier 3] drift score < ${maxDrift}`,
          message: `Low confidence (${result.confidence.toFixed(2)}) — needs human review`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      }

      const pass = result.driftScore < maxDrift;
      return {
        status: pass ? 'pass' : 'fail',
        name: `[Tier 3] drift score < ${maxDrift}`,
        message: pass ? undefined : `Drift score ${result.driftScore.toFixed(2)} exceeds maximum ${maxDrift}`,
        expected: `< ${maxDrift}`,
        actual: `${result.driftScore.toFixed(2)}`,
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that detects specific drift patterns.
 * Fails if any issue of the specified kind(s) is found above the severity threshold.
 *
 * @param kinds - Drift kinds to check for (or all if omitted)
 * @param maxSeverity - Maximum severity before failing. Default: 0.5
 * @tier 3 — Pattern-based detection
 */
export function toNotExhibitDrift(
  kinds?: DriftKind[],
  maxSeverity = 0.5,
): Assertion {
  const kindsLabel = kinds ? kinds.join(', ') : 'any';

  return {
    name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] no ${kindsLabel} drift`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      const result = await analyzeDrift(task, output);

      // Filter issues to the requested kinds
      const relevant = kinds
        ? result.issues.filter((i) => kinds.includes(i.kind))
        : result.issues;
      const severe = relevant.filter((i) => i.severity >= maxSeverity);

      if (severe.length === 0) {
        return {
          status: 'pass',
          name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
          evidence: relevant.length === 0
            ? 'No drift issues detected'
            : `Minor issues below threshold: ${relevant.map((i) => i.kind).join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `[Tier 3] no ${kindsLabel} drift (severity < ${maxSeverity})`,
        message: `${severe.length} drift issue(s) above severity ${maxSeverity}`,
        evidence: severe.map((i) =>
          `${i.kind} (severity: ${i.severity.toFixed(2)}): ${i.description}`,
        ).join('\n'),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Create an assertion that uses the full Tier 3 judge for drift assessment.
 * This assertion always invokes the judge backend for maximum accuracy,
 * at the cost of requiring an LLM call.
 *
 * @param backend - Judge backend to use for evaluation
 * @param options - Judge options (thresholds, retries)
 * @tier 3 — Always invokes model-as-judge
 */
export function toPassDriftJudge(
  backend: JudgeBackend,
  options?: JudgeOptions,
): Assertion {
  const evaluator = new JudgeEvaluator(backend, DRIFT_RUBRIC, options);

  return {
    name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      const task = context?.prompt ?? '';

      if (!task) {
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: 'No task/prompt provided — set EvalContext.prompt',
          durationMs: performance.now() - start,
        };
      }

      try {
        // First run heuristic analysis for context
        const driftResult = await analyzeDrift(task, output);

        const result = await evaluator.evaluate(output, {
          task,
          artifacts: {
            'heuristic-analysis': `Drift score: ${driftResult.driftScore.toFixed(2)}, ` +
              `Coverage: ${(driftResult.requirementCoverage * 100).toFixed(0)}%, ` +
              `Issues: ${driftResult.issues.map((i) => i.kind).join(', ') || 'none'}`,
            'requirements': driftResult.requirements.map((r) => `[${r.action}] ${r.subject}`).join('\n'),
          },
        });

        const status = result.verdict === 'pass' ? 'pass'
          : result.verdict === 'needs-human-review' ? 'skip'
          : 'fail';

        return {
          status,
          name: `[Tier 3] drift judge: ${DRIFT_RUBRIC.name}`,
          message: status === 'pass' ? undefined :
            status === 'skip'
              ? `Judge confidence too low (${result.confidenceValue.toFixed(2)}) — needs human review`
              : `Judge verdict: fail (score=${result.overallScore.toFixed(2)})`,
          expected: `pass (>= ${options?.passThreshold ?? DRIFT_RUBRIC.passThreshold ?? 0.6})`,
          actual: `${result.verdict} (score=${result.overallScore.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'error',
          name: `[Tier 3] drift judge`,
          message: `Drift judge evaluation failed: ${message}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
