/**
 * Judge Calibration System - Engine
 *
 * Runs a model-as-judge against a calibration set of pre-scored examples and
 * measures how closely it matches human-assigned ground truth (exact-match /
 * within-one / mean-absolute-error / bias), then reports whether the judge is
 * calibrated and by how much its threshold should be nudged.
 *
 * The set builder lives in `./calibration-builder.js`; drift detection lives in
 * `./calibration-drift.js`; the type vocabulary in `./calibration-types.js`.
 * All three are re-exported through the public barrel (`./calibration.js`) via
 * `./calibration-analysis.js`.
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

import type { Rubric, JudgeBackend, RawJudgeResponse, JudgeContext } from './judge.js';
import { computeVerdict, getMaxScore, getMinScore } from './judge.js';
import type {
  CalibrationSet,
  CriterionCalibration,
  CriterionDelta,
  CalibrationReport,
  CalibrationOptions,
} from './calibration-types.js';

// ─── CALIBRATION ENGINE ─────────────────────────────────────────────────────────

/**
 * Run calibration against a judge backend.
 *
 * Tests the judge against a set of pre-scored examples and measures
 * how closely it matches human-assigned ground truth.
 *
 * @example
 * ```ts
 * const report = await calibrate(backend, rubric, calibrationSet);
 * if (!report.calibrated) {
 *   console.warn(`Judge is unreliable! Bias: ${report.bias}, withinOne: ${report.withinOneRate}`);
 * }
 * ```
 */
export async function calibrate(
  backend: JudgeBackend,
  rubric: Rubric,
  calibrationSet: CalibrationSet,
  options: CalibrationOptions = {},
): Promise<CalibrationReport> {
  const start = performance.now();
  const {
    minWithinOneRate = 0.85,
    minExactMatchRate = 0.5,
    maxBias = 0.5,
    samples = 1,
  } = options;

  const allDeltas: CriterionDelta[] = [];
  const criteriaMap = new Map<string, CriterionDelta[]>();
  let verdictMatches = 0;
  let verdictTotal = 0;

  // Initialize criteria tracking
  for (const criterion of rubric.criteria) {
    criteriaMap.set(criterion.id, []);
  }

  // Run each calibration example
  for (const example of calibrationSet.examples) {
    // Run multiple samples for consistency
    const sampleResults: RawJudgeResponse[] = [];
    for (let s = 0; s < samples; s++) {
      const context: JudgeContext = {
        task: example.task,
        references: example.references,
        chainOfThought: true,
      };

      try {
        const response = await backend.evaluate(example.output, rubric, context);
        sampleResults.push(response);
      } catch {
        // Skip failed evaluations
        continue;
      }
    }

    if (sampleResults.length === 0) continue;

    // Use median scores across samples
    const medianScores = computeMedianScores(sampleResults, rubric);

    // Compare each criterion against ground truth
    for (const [criterionId, expectedScore] of Object.entries(example.expectedScores)) {
      const actualScore = medianScores.get(criterionId);
      if (actualScore === undefined) continue;

      const delta: CriterionDelta = {
        exampleName: example.name,
        expected: expectedScore,
        actual: actualScore,
        delta: actualScore - expectedScore,
      };

      allDeltas.push(delta);
      criteriaMap.get(criterionId)?.push(delta);
    }

    // Check verdict accuracy
    if (example.expectedVerdict && sampleResults.length > 0) {
      const lastResponse = sampleResults[sampleResults.length - 1];
      if (lastResponse) {
        const verdict = computeVerdict(lastResponse, rubric);
        if ((verdict.verdict === 'pass' || verdict.verdict === 'fail') &&
            verdict.verdict === example.expectedVerdict) {
          verdictMatches++;
        }
        verdictTotal++;
      }
    }
  }

  // Compute overall metrics
  const exactMatches = allDeltas.filter(d => d.delta === 0).length;
  const withinOne = allDeltas.filter(d => Math.abs(d.delta) <= 1).length;
  const totalDeltas = allDeltas.length;

  const exactMatchRate = totalDeltas > 0 ? exactMatches / totalDeltas : 0;
  const withinOneRate = totalDeltas > 0 ? withinOne / totalDeltas : 0;
  const meanAbsoluteError = totalDeltas > 0
    ? allDeltas.reduce((sum, d) => sum + Math.abs(d.delta), 0) / totalDeltas
    : 0;
  const bias = totalDeltas > 0
    ? allDeltas.reduce((sum, d) => sum + d.delta, 0) / totalDeltas
    : 0;

  // Per-criterion calibration
  const criteria: CriterionCalibration[] = [];
  for (const [criterionId, deltas] of criteriaMap) {
    if (deltas.length === 0) continue;

    const cExact = deltas.filter(d => d.delta === 0).length / deltas.length;
    const cWithinOne = deltas.filter(d => Math.abs(d.delta) <= 1).length / deltas.length;
    const cMAE = deltas.reduce((sum, d) => sum + Math.abs(d.delta), 0) / deltas.length;
    const cBias = deltas.reduce((sum, d) => sum + d.delta, 0) / deltas.length;

    criteria.push({
      criterionId,
      sampleCount: deltas.length,
      exactMatchRate: cExact,
      withinOneRate: cWithinOne,
      meanAbsoluteError: cMAE,
      bias: cBias,
      deltas,
      reliable: cWithinOne >= 0.8,
    });
  }

  // Find worst misses
  const worstMisses = [...allDeltas]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  // Determine if calibrated
  const calibrated =
    withinOneRate >= minWithinOneRate &&
    exactMatchRate >= minExactMatchRate &&
    Math.abs(bias) <= maxBias;

  // Suggest threshold adjustment based on bias
  // If judge is +0.3 generous on average, raise threshold by 0.3 * normalization_factor
  const maxScaleRange = rubric.criteria.length > 0
    ? Math.max(...rubric.criteria.map(c => getMaxScore(c) - getMinScore(c)))
    : 1;
  const suggestedThresholdAdjustment = maxScaleRange > 0 ? bias / maxScaleRange : 0;

  return {
    backendName: backend.name,
    rubricName: rubric.name,
    exampleCount: calibrationSet.examples.length,
    exactMatchRate,
    withinOneRate,
    meanAbsoluteError,
    bias,
    criteria,
    worstMisses,
    calibrated,
    suggestedThresholdAdjustment,
    verdictAccuracy: verdictTotal > 0 ? verdictMatches / verdictTotal : undefined,
    durationMs: performance.now() - start,
  };
}

/**
 * Compute median scores across multiple judge samples.
 */
function computeMedianScores(
  responses: RawJudgeResponse[],
  rubric: Rubric,
): Map<string, number> {
  const result = new Map<string, number>();

  for (const criterion of rubric.criteria) {
    const scores: number[] = [];
    for (const response of responses) {
      const score = response.scores.find(s => s.criterionId === criterion.id);
      if (score) scores.push(score.score);
    }

    if (scores.length > 0) {
      scores.sort((a, b) => a - b);
      const median = scores[Math.floor(scores.length / 2)];
      if (median !== undefined) result.set(criterion.id, median);
    }
  }

  return result;
}
