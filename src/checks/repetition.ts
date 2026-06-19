/**
 * Repetition/Loop Detection - Tier 2 Heuristic Check
 *
 * Detects agents that are repeating themselves or stuck in loops:
 * - Sentence-level repetition: same or near-identical sentences repeated
 * - Paragraph/block repetition: entire blocks duplicated verbatim or near-verbatim
 * - Structural loops: repeated patterns (e.g. "Step 1... Step 1..." or cycling tool calls)
 * - N-gram saturation: when a small set of phrases dominates the output
 * - Incremental stalling: output that keeps saying the same thing in different words
 *
 * All checks are deterministic - no AI calls, pure text analysis.
 *
 * This file is the **public barrel** for the repetition check and the home of the
 * assertion factories that wrap the detectors into Jest/Vitest-style assertions.
 * The supporting seams live alongside it and are re-exported here so the public
 * surface stays a single `./repetition.js` import path:
 * - `./repetition-types.js`    - the type vocabulary (options, instances, results)
 * - `./repetition-analysis.js` - normalize/split/similarity + the 4 detectors
 *
 * @tier 2 - Heuristic (no AI, detects behavioral patterns)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  RepetitionOptions,
  LoopDetectionOptions,
  NgramSaturationOptions,
  FullRepetitionOptions,
} from './repetition-types.js';
import {
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
  analyzeFullRepetition,
} from './repetition-analysis.js';

// ---- TYPE RE-EXPORTS ----
// The repetition type vocabulary lives in ./repetition-types.js; re-export it
// here so consumers keep a single `./repetition.js` import path.
export type {
  RepetitionOptions,
  RepetitionInstance,
  RepetitionKind,
  RepetitionResult,
  LoopDetectionOptions,
  LoopInstance,
  LoopResult,
  NgramSaturationOptions,
  NgramSaturationResult,
  FullRepetitionOptions,
  FullRepetitionResult,
} from './repetition-types.js';

// ---- ANALYSIS RE-EXPORTS ----
// The pure text-analysis engine (normalize/split/similarity + the 4 detectors)
// lives alongside in ./repetition-analysis.js.
export {
  splitSentences,
  splitParagraphs,
  splitLines,
  segmentSimilarity,
  analyzeRepetition,
  detectLoops,
  analyzeNgramSaturation,
  analyzeFullRepetition,
} from './repetition-analysis.js';

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that the output does not contain excessive repetition.
 * Detects verbatim and near-duplicate sentences/paragraphs.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for repetition detection.
 */
export function toNotRepeat(options?: RepetitionOptions & { maxScore?: number }): Assertion {
  const maxScore = options?.maxScore ?? 0.3;

  return {
    name: `no excessive repetition (max score: ${maxScore})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeRepetition(output, options);

      if (result.score <= maxScore) {
        return {
          status: 'pass',
          name: `no excessive repetition (max score: ${maxScore})`,
          evidence:
            `Repetition score: ${result.score.toFixed(3)}. ` +
            `${result.uniqueSegments}/${result.totalSegments} segments are unique`,
          durationMs: performance.now() - start,
        };
      }

      const topInstance = result.instances[0];
      return {
        status: 'fail',
        name: `no excessive repetition (max score: ${maxScore})`,
        message: 'Output contains excessive repetition',
        expected: `repetition score <= ${maxScore}`,
        actual: `score = ${result.score.toFixed(3)} (${result.instances.length} repeated segments)`,
        evidence: topInstance
          ? `Most repeated (${topInstance.count}x, ${topInstance.kind}): "${topInstance.text}"`
          : 'Multiple segments are repeated',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output is not stuck in a loop.
 * Detects cyclic patterns where the agent repeats sequences of steps.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for loop detection.
 */
export function toNotLoop(options?: LoopDetectionOptions & { maxLoopRatio?: number }): Assertion {
  const maxLoopRatio = options?.maxLoopRatio ?? 0.3;

  return {
    name: `no loop patterns (max ratio: ${maxLoopRatio})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = detectLoops(output, options);

      if (!result.hasLoop || result.loopRatio <= maxLoopRatio) {
        return {
          status: 'pass',
          name: `no loop patterns (max ratio: ${maxLoopRatio})`,
          evidence: result.hasLoop
            ? `Minor loops detected (ratio: ${result.loopRatio.toFixed(3)}) — within tolerance`
            : 'No loop patterns detected',
          durationMs: performance.now() - start,
        };
      }

      const longest = result.longestLoop;
      return {
        status: 'fail',
        name: `no loop patterns (max ratio: ${maxLoopRatio})`,
        message: 'Output is stuck in a loop',
        expected: `loop ratio <= ${maxLoopRatio}`,
        actual: `loop ratio = ${result.loopRatio.toFixed(3)} (${result.loops.length} loop patterns)`,
        evidence: longest
          ? `Longest loop: ${longest.repetitions} repetitions of ${longest.cycleLength}-segment cycle starting at segment ${longest.startIndex}. ` +
            `First cycle element: "${longest.cycle[0]?.slice(0, 80) ?? ''}"`
          : `${result.loops.length} loop patterns detected`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does not have n-gram saturation
 * (a few phrases dominating the entire text).
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for saturation detection.
 */
export function toNotBeSaturated(options?: NgramSaturationOptions): Assertion {
  const threshold = options?.saturationThreshold ?? 0.3;

  return {
    name: `no n-gram saturation (threshold: ${threshold})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeNgramSaturation(output, options);

      if (!result.saturated) {
        return {
          status: 'pass',
          name: `no n-gram saturation (threshold: ${threshold})`,
          evidence:
            `Saturation score: ${result.score.toFixed(3)}. ` +
            `${result.uniqueNgrams} unique n-grams across ${result.totalNgrams} total`,
          durationMs: performance.now() - start,
        };
      }

      const topNgram = result.dominantNgrams[0];
      return {
        status: 'fail',
        name: `no n-gram saturation (threshold: ${threshold})`,
        message: 'Output is dominated by a small set of repeated phrases',
        expected: `saturation score < ${threshold}`,
        actual: `score = ${result.score.toFixed(3)}`,
        evidence: topNgram
          ? `Dominant phrase "${topNgram.ngram}" appears ${topNgram.count} times ` +
            `(${(topNgram.fraction * 100).toFixed(1)}% of all n-grams). ` +
            `Top ${result.dominantNgrams.length} phrases account for ${(result.score * 100).toFixed(1)}% of content`
          : 'High phrase repetition throughout the output',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output is not repetitive (combined check).
 * Runs all repetition detection methods and provides a unified verdict.
 *
 * @tier 2 — Heuristic
 * @param options - Configuration for full repetition analysis.
 */
export function toNotBeRepetitive(options?: FullRepetitionOptions): Assertion {
  const threshold = options?.threshold ?? 0.3;

  return {
    name: `not repetitive (threshold: ${threshold})`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeFullRepetition(output, options);

      if (!result.isRepetitive) {
        return {
          status: 'pass',
          name: `not repetitive (threshold: ${threshold})`,
          evidence:
            `Overall score: ${result.overallScore.toFixed(3)}. ${result.summary}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `not repetitive (threshold: ${threshold})`,
        message: 'Output shows signs of repetitive or looping behavior',
        expected: `overall repetition score < ${threshold}`,
        actual: `score = ${result.overallScore.toFixed(3)}`,
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert a maximum number of times any segment can repeat.
 * Simpler check — just counts repetitions without scoring.
 *
 * @tier 2 — Heuristic
 * @param maxRepetitions - Maximum allowed repetitions of any segment. Default: 3
 * @param options - Additional repetition options.
 */
export function toNotExceedRepetitions(
  maxRepetitions?: number,
  options?: RepetitionOptions,
): Assertion {
  const maxReps = maxRepetitions ?? 3;

  return {
    name: `no segment repeats > ${maxReps} times`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      const result = analyzeRepetition(output, { ...options, minRepetitions: 2 });

      const violators = result.instances.filter((inst) => inst.count > maxReps);

      if (violators.length === 0) {
        return {
          status: 'pass',
          name: `no segment repeats > ${maxReps} times`,
          evidence: result.hasRepetition
            ? `Some repetition found but within limit (max: ${result.instances[0]?.count ?? 0}x)`
            : 'No repeated segments detected',
          durationMs: performance.now() - start,
        };
      }

      const worst = violators[0] as (typeof violators)[number];
      return {
        status: 'fail',
        name: `no segment repeats > ${maxReps} times`,
        message: `A segment repeats ${worst.count} times (max allowed: ${maxReps})`,
        expected: `no segment repeats more than ${maxReps} times`,
        actual: `"${worst.text}" repeats ${worst.count} times`,
        evidence: `${violators.length} segment(s) exceed the repetition limit`,
        durationMs: performance.now() - start,
      };
    },
  };
}
