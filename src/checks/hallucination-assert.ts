/**
 * Hallucination check — assertion scaffolding.
 *
 * Every `toNotHallucinate` / `toBeFullyGrounded` / … assertion factory in
 * `./hallucination.js` shares the exact same shell: merge the caller's
 * references with any on the `EvalContext`, time the run with
 * `performance.now()`, invoke {@link analyzeHallucination}, shape the
 * pass/fail result, and translate any thrown error into an `error`-status
 * `AssertionResult`. This module owns that shell so the factories only have to
 * express the part that actually differs between them — the pass/fail decision
 * over an already-computed {@link HallucinationResult}.
 *
 * Extracting this seam removed five near-identical try/catch/timing blocks from
 * the public barrel with **no behavior change**: the timing source, the
 * reference-merge order (`[...references, ...context.references]`), and the
 * error message shape are all preserved exactly.
 *
 * @module
 */

import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type { HallucinationOptions, HallucinationResult } from './hallucination-types.js';
import { analyzeHallucination } from './hallucination-verification.js';

/**
 * Decide the assertion outcome from a completed hallucination analysis.
 *
 * Implementations return everything *except* `name` and `durationMs` — those
 * are filled in by {@link makeHallucinationAssertion} so each factory stays
 * focused on its own pass/fail rule.
 */
export type HallucinationDecision = (
  result: HallucinationResult,
) => Omit<AssertionResult, 'name' | 'durationMs'>;

/**
 * Build a hallucination assertion from a name, a verb used in the failure
 * message when the analysis itself throws, the caller's references + options,
 * and a decision function.
 *
 * The returned assertion performs the shared work (reference merge, timing,
 * analysis, uniform error handling) and delegates only the pass/fail shaping
 * to `decide`.
 */
export function makeHallucinationAssertion(
  name: string,
  errorVerb: string,
  references: string[],
  options: HallucinationOptions,
  decide: HallucinationDecision,
): Assertion {
  return {
    name,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();
      try {
        const refs = [...references, ...(context?.references ?? [])];
        const result = await analyzeHallucination(output, refs, options);
        return {
          name,
          durationMs: performance.now() - start,
          ...decide(result),
        };
      } catch (err) {
        return {
          status: 'error',
          name,
          message: `${errorVerb} failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
