/**
 * Actionability Judge — Tier 2+3 "Can a human act on this, or is it filler?"
 *
 * This module evaluates whether an agent's output provides concrete,
 * actionable information that a human can use to make a decision or take
 * a step forward. It catches common failure modes:
 *
 * - Vague platitudes ("consider best practices", "ensure quality")
 * - Hedge-heavy non-answers ("it depends", "there are many approaches")
 * - Restating the question without answering it
 * - Generic advice unanchored to the specific task/context
 * - Missing concrete details (no paths, no code, no steps, no examples)
 *
 * Architecture:
 * - Tier 2 (heuristic): Sentence-level signal extraction — imperative verbs,
 *   specificity markers, hedge detection, concreteness scoring
 * - Tier 3 (judge): Structured rubric evaluation for subjective actionability
 *   when heuristics are insufficient
 *
 * Key design decision: Actionability is task-type-dependent. A code review
 * needs specific file/line references; a summary needs key facts; a how-to
 * needs numbered steps. The module classifies the expected response type
 * and applies type-appropriate scoring.
 *
 * This file is the **public barrel** for the actionability check and the home
 * of the Tier-3 wiring — the built-in `ACTIONABILITY_RUBRIC` and the assertion
 * factories that compose the heuristic pass with the judge framework. The
 * supporting seams live alongside it and are re-exported here so the public
 * surface stays a single `./actionability.js` import path:
 * - `./actionability-types.js`      — the type vocabulary (elements, fillers, results)
 * - `./actionability-patterns.js`   — regex tables + response-type classifier
 * - `./actionability-extraction.js` — sentence splitting + signal/filler extraction
 * - `./actionability-scoring.js`    — per-sentence + overall scoring engine
 *
 * @tier mixed (2+3)
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  JudgeBackend,
  Rubric,
  JudgeOptions,
} from './judge.js';
import {
  buildRubric,
  JudgeEvaluator,
} from './judge.js';
import type { ActionabilityOptions } from './actionability-types.js';
import { analyzeActionability } from './actionability-scoring.js';

// ─── TYPE RE-EXPORTS ──────────────────────────────────────────────────────────
// The actionability type vocabulary lives in ./actionability-types.js;
// re-export it here so consumers keep a single `./actionability.js` import path.
export type {
  ResponseType,
  ActionableElement,
  ActionableKind,
  FillerPattern,
  FillerKind,
  SentenceAnalysis,
  ActionabilityOptions,
  ActionabilityResult,
} from './actionability-types.js';

// ─── PATTERN / CLASSIFICATION RE-EXPORTS ─────────────────────────────────────────
// The regex tables are module-internal; only the task→type classifier is public.
export { detectResponseType } from './actionability-patterns.js';

// ─── EXTRACTION RE-EXPORTS ───────────────────────────────────────────────────────
// The Tier-2 heuristic pass: sentence segmentation + signal/filler extraction.
export {
  splitIntoSentences,
  extractActionableElements,
  detectFiller,
} from './actionability-extraction.js';

// ─── SCORING RE-EXPORTS ──────────────────────────────────────────────────────────
// Per-sentence scoring + the top-level analyzer that ties the pass together.
export {
  scoreSentence,
  analyzeActionability,
} from './actionability-scoring.js';

// ═══ RUBRIC ═════════════════════════════════════════════════════════════════════

/**
 * Built-in rubric for Tier 3 actionability judging.
 * Used when heuristic scoring is ambiguous (confidence < 0.6).
 */
export const ACTIONABILITY_RUBRIC: Rubric = buildRubric('Actionability')
  .describe(
    'Evaluates whether an agent\'s output provides concrete, actionable information ' +
    'that a human can use to make a decision or take a next step. ' +
    'The judge evaluates ONLY the output artifact — not the agent\'s intent or reasoning.',
  )
  .passAt(0.55)
  .confidenceAt(0.6)
  .criterion('specificity', 'Does the output reference specific files, functions, values, or resources?')
    .weight(0.35)
    .level(1, 'No specifics', 'Only vague references: "the file", "the function", "a value"')
    .level(2, 'Some specifics', 'A few concrete names, but mostly vague')
    .level(3, 'Mostly specific', 'Most references are to named files, functions, or values')
    .level(4, 'Highly specific', 'Consistently names files, lines, functions, config keys, versions')
    .level(5, 'Precise', 'Every reference is exact — full paths, line numbers, code snippets')
    .done()
  .criterion('directness', 'Does the output provide clear directions or is it hedged/equivocating?')
    .weight(0.3)
    .level(1, 'All filler', 'Entirely hedged/vague: "you might consider", "it depends"')
    .level(2, 'Mostly hedged', 'Some direction mixed with heavy hedging')
    .level(3, 'Balanced', 'Clear direction given but with some unnecessary caveats')
    .level(4, 'Direct', 'Clear recommendations with minimal hedging')
    .level(5, 'Decisive', 'Unambiguous instructions — human can act immediately')
    .done()
  .criterion('next-steps', 'Does the output give the human a clear next action to take?')
    .weight(0.2)
    .level(1, 'No next step', 'Output ends without any suggested action')
    .level(2, 'Vague next step', '"You should look into this" without specifics')
    .level(3, 'General next step', 'Suggests an action but missing details on how')
    .level(4, 'Clear next step', 'States what to do next with enough detail to start')
    .level(5, 'Complete next steps', 'Full step-by-step plan, ready to execute')
    .done()
  .criterion('contextual-fit', 'Is the output tailored to the specific task, or is it generic advice?')
    .weight(0.15)
    .level(1, 'Generic', 'Could apply to any project/task — not tailored')
    .level(2, 'Somewhat tailored', 'Mentions the task topic but advice is generic')
    .level(3, 'Moderately tailored', 'References task-specific details in parts')
    .level(4, 'Well-tailored', 'Clearly written for this specific task/context')
    .level(5, 'Perfectly fitted', 'Every suggestion is grounded in the specific context provided')
    .done()
  .build();

// ═══ ASSERTION FACTORIES ════════════════════════════════════════════════════════

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
