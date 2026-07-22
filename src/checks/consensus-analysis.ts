/**
 * Consensus Judge - Engine
 *
 * Runs the same judge evaluation multiple times and takes the median to
 * reduce non-determinism, and provides the consensus / adversarial assertion
 * factories built on this engine. The adversarial / cross-model backend
 * wrappers themselves live in `./consensus-judges.js`.
 *
 * Re-exported through the public barrel (`./consensus.js`); the type
 * vocabulary lives in `./consensus-types.js`.
 *
 * @tier 3 - Enhanced Judgment (more reliable than single-shot judge)
 * @module
 */

import type {
  JudgeBackend,
  Rubric,
  RawJudgeResponse,
  RawCriterionScore,
  JudgeContext,
} from './judge.js';
import { computeVerdict } from './judge.js';
import type { Assertion, AssertionResult, EvalContext } from '../core/types.js';
import type {
  ConsensusOptions,
  ConsensusResult,
  CriterionAgreement,
  AdversarialOptions,
} from './consensus-types.js';
import { AdversarialJudge } from './consensus-judges.js';

// Re-export the backend wrappers so this module's public surface (and the
// `./consensus.js` barrel) is unchanged after the split.
export { AdversarialJudge, CrossModelJudge } from './consensus-judges.js';

// ─── CONSENSUS JUDGE ────────────────────────────────────────────────────────────

/**
 * Run consensus judging — evaluate multiple times and take median.
 *
 * Reduces the impact of non-determinism in LLM-based judging.
 * A single judge run can vary ±1 score on repeated calls.
 * Consensus takes the median, making results more stable and trustworthy.
 *
 * @example
 * ```ts
 * const consensus = await runConsensus(backend, rubric, output, context, { samples: 5 });
 * if (!consensus.trustworthy) {
 *   console.warn('Judge disagreed with itself — needs human review');
 * }
 * ```
 */
export async function runConsensus(
  backend: JudgeBackend,
  rubric: Rubric,
  output: string,
  context: JudgeContext,
  options: ConsensusOptions = {},
): Promise<ConsensusResult> {
  const {
    samples = 3,
    maxDisagreement = 1,
    minAgreement = 0.7,
  } = options;

  // Collect samples
  const sampleResponses: RawJudgeResponse[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      const response = await backend.evaluate(output, rubric, context);
      sampleResponses.push(response);
    } catch {
      // Skip failed samples
    }
  }

  if (sampleResponses.length === 0) {
    throw new Error('All consensus samples failed — judge backend is unavailable');
  }

  // Compute median scores per criterion
  const medianResponse = computeMedianResponse(sampleResponses, rubric);

  // Compute per-criterion agreement
  const agreement: CriterionAgreement[] = [];
  const disagreements: string[] = [];

  for (const criterion of rubric.criteria) {
    const scores: number[] = [];
    for (const response of sampleResponses) {
      const score = response.scores.find(s => s.criterionId === criterion.id);
      if (score) scores.push(score.score);
    }

    if (scores.length === 0) continue;

    scores.sort((a, b) => a - b);
    const median = scores[Math.floor(scores.length / 2)] ?? 0;
    const first = scores[0] ?? 0;
    const last = scores[scores.length - 1] ?? 0;
    const range = last - first;
    const disagreed = range > maxDisagreement;

    if (disagreed) disagreements.push(criterion.id);

    agreement.push({
      criterionId: criterion.id,
      scores,
      median,
      range,
      disagreed,
    });
  }

  // Overall agreement ratio
  const agreedCount = agreement.filter(a => !a.disagreed).length;
  const overallAgreement = agreement.length > 0 ? agreedCount / agreement.length : 1;
  const trustworthy = overallAgreement >= minAgreement;

  // Compute final verdict using median scores
  const result = computeVerdict(medianResponse, rubric);

  return {
    result,
    sampleResponses,
    agreement,
    overallAgreement,
    disagreements,
    trustworthy,
  };
}

/**
 * Compute a median response from multiple judge samples.
 */
function computeMedianResponse(
  responses: RawJudgeResponse[],
  rubric: Rubric,
): RawJudgeResponse {
  const medianScores: RawCriterionScore[] = [];

  for (const criterion of rubric.criteria) {
    const allScores: { score: number; reasoning: string; evidence: string[]; confidence: number }[] = [];

    for (const response of responses) {
      const s = response.scores.find(sc => sc.criterionId === criterion.id);
      if (s) allScores.push(s);
    }

    if (allScores.length === 0) continue;

    // Sort by score, take median
    allScores.sort((a, b) => a.score - b.score);
    const medianEntry = allScores[Math.floor(allScores.length / 2)];
    if (!medianEntry) continue;

    medianScores.push({
      criterionId: criterion.id,
      score: medianEntry.score,
      reasoning: medianEntry.reasoning,
      evidence: medianEntry.evidence,
      confidence: medianEntry.confidence,
    });
  }

  // Use summary/suggestions from the response closest to the median
  const lastResponse = responses[responses.length - 1];

  return {
    scores: medianScores,
    summary: lastResponse?.summary ?? '',
    suggestions: lastResponse?.suggestions ?? [],
  };
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert using consensus judging (multiple samples, median scores).
 *
 * More reliable than single-shot `toPassJudge` — reduces non-determinism.
 *
 * @param backend - The judge backend
 * @param rubric - Rubric to evaluate against
 * @param options - Consensus and judge options
 */
export function toPassConsensusJudge(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: ConsensusOptions & { passThreshold?: number },
): Assertion {
  const passThreshold = options?.passThreshold ?? rubric.passThreshold ?? 0.6;

  return {
    name: `[Tier 3] consensus judge: ${rubric.name} (${options?.samples ?? 3} samples)`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();

      try {
        const judgeContext: JudgeContext = {
          task: context?.prompt ?? '',
          references: context?.references,
          chainOfThought: true,
        };

        const consensus = await runConsensus(backend, rubric, output, judgeContext, options);

        if (!consensus.trustworthy) {
          return {
            status: 'skip',
            name: `[Tier 3] consensus judge: ${rubric.name}`,
            message: `Judge disagreed with itself on: ${consensus.disagreements.join(', ')}`,
            evidence: `Agreement: ${(consensus.overallAgreement * 100).toFixed(0)}% — needs human review`,
            durationMs: performance.now() - start,
          };
        }

        const pass = consensus.result.overallScore >= passThreshold;
        return {
          status: pass ? 'pass' : 'fail',
          name: `[Tier 3] consensus judge: ${rubric.name}`,
          message: pass ? undefined : `Consensus score ${consensus.result.overallScore.toFixed(2)} below threshold ${passThreshold}`,
          expected: `>= ${passThreshold}`,
          actual: `${consensus.result.overallScore.toFixed(2)} (agreement: ${(consensus.overallAgreement * 100).toFixed(0)}%)`,
          evidence: consensus.result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 3] consensus judge: ${rubric.name}`,
          message: `Consensus judge failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert using adversarial judging (strict scoring, weakness-first).
 *
 * Counteracts positivity bias for a more honest evaluation.
 *
 * @param backend - The base judge backend (will be wrapped)
 * @param rubric - Rubric to evaluate against
 * @param options - Adversarial and judge options
 */
export function toPassAdversarialJudge(
  backend: JudgeBackend,
  rubric: Rubric,
  options?: AdversarialOptions & { passThreshold?: number },
): Assertion {
  const adversarial = new AdversarialJudge(backend, options);
  const passThreshold = options?.passThreshold ?? rubric.passThreshold ?? 0.6;

  return {
    name: `[Tier 3] adversarial judge: ${rubric.name}`,
    async evaluate(output: string, context?: EvalContext): Promise<AssertionResult> {
      const start = performance.now();

      try {
        const judgeContext: JudgeContext = {
          task: context?.prompt ?? '',
          references: context?.references,
          chainOfThought: true,
        };

        const response = await adversarial.evaluate(output, rubric, judgeContext);
        const result = computeVerdict(response, rubric, { passThreshold });

        const pass = result.verdict === 'pass';
        const review = result.verdict === 'needs-human-review';

        return {
          status: review ? 'skip' : pass ? 'pass' : 'fail',
          name: `[Tier 3] adversarial judge: ${rubric.name}`,
          message: review
            ? `Low confidence (${result.confidenceValue.toFixed(2)}) — needs human review`
            : pass ? undefined
            : `Adversarial score ${result.overallScore.toFixed(2)} below ${passThreshold}`,
          expected: `>= ${passThreshold} (adversarial)`,
          actual: `${result.overallScore.toFixed(2)} (confidence: ${result.confidenceValue.toFixed(2)})`,
          evidence: result.summary,
          durationMs: performance.now() - start,
        };
      } catch (err) {
        return {
          status: 'error',
          name: `[Tier 3] adversarial judge: ${rubric.name}`,
          message: `Adversarial judge failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: performance.now() - start,
        };
      }
    },
  };
}
