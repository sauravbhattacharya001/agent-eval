/**
 * Judge Framework — Scoring Engine (Tier 3 Shared-Substrate Judgment)
 *
 * The deterministic verdict-computation core, separated from the judge backend
 * so it can be tested without any LLM call. Given a backend's raw per-criterion
 * scores, it normalizes weights, clamps scores to each criterion's defined
 * range, computes the weighted overall score + confidence, and classifies the
 * verdict (pass / fail / needs-human-review).
 *
 * @tier 3 — Shared-Substrate Judgment (least independent, most forgeable)
 * @module
 */

import type {
  CriterionScore,
  JudgeOptions,
  JudgeResult,
  JudgeVerdict,
  RawJudgeResponse,
  Rubric,
  RubricCriterion,
  JudgeConfidence,
} from './judge-types.js';

/**
 * Compute the overall score and verdict from raw judge responses.
 *
 * This is the core scoring logic, separated from the judge backend
 * so it can be tested deterministically.
 */
export function computeVerdict(
  rawResponse: RawJudgeResponse,
  rubric: Rubric,
  options?: JudgeOptions,
): JudgeResult {
  const startTime = performance.now();
  const passThreshold = options?.passThreshold ?? rubric.passThreshold ?? 0.6;
  const confidenceThreshold = options?.confidenceThreshold ?? rubric.confidenceThreshold ?? 0.7;

  // Normalize criterion weights
  const weights = normalizeCriterionWeights(rubric.criteria);

  // Process each criterion score
  const criterionScores: CriterionScore[] = [];
  let weightedScoreSum = 0;
  let weightedConfidenceSum = 0;
  let totalWeight = 0;

  for (const criterion of rubric.criteria) {
    const raw = rawResponse.scores.find((s) => s.criterionId === criterion.id);
    const weight = weights.get(criterion.id) ?? 0;

    if (!raw) {
      // Missing score — treat as low-confidence zero
      criterionScores.push({
        criterionId: criterion.id,
        score: 0,
        maxScore: getMaxScore(criterion),
        normalizedScore: 0,
        reasoning: 'No score provided by judge',
        evidence: [],
        confidence: 'low',
      });
      totalWeight += weight;
      continue;
    }

    const maxScore = getMaxScore(criterion);
    const minScore = getMinScore(criterion);
    const range = maxScore - minScore;
    const clampedScore = Math.max(minScore, Math.min(maxScore, raw.score));
    const normalizedScore = range > 0 ? (clampedScore - minScore) / range : 0;

    const confidence = classifyConfidence(raw.confidence);

    criterionScores.push({
      criterionId: criterion.id,
      score: clampedScore,
      maxScore,
      normalizedScore,
      reasoning: raw.reasoning,
      evidence: raw.evidence,
      confidence,
    });

    weightedScoreSum += normalizedScore * weight;
    weightedConfidenceSum += raw.confidence * weight;
    totalWeight += weight;
  }

  // Compute overall score and confidence
  const overallScore = totalWeight > 0 ? weightedScoreSum / totalWeight : 0;
  const overallConfidenceValue = totalWeight > 0 ? weightedConfidenceSum / totalWeight : 0;
  const overallConfidence = classifyConfidence(overallConfidenceValue);

  // Determine verdict
  let verdict: JudgeVerdict;
  if (overallConfidenceValue < confidenceThreshold) {
    verdict = 'needs-human-review';
  } else if (overallScore >= passThreshold) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }

  return {
    rubricName: rubric.name,
    verdict,
    overallScore,
    criterionScores,
    confidence: overallConfidence,
    confidenceValue: overallConfidenceValue,
    summary: rawResponse.summary,
    suggestions: rawResponse.suggestions,
    durationMs: performance.now() - startTime,
  };
}

/**
 * Normalize criterion weights so they sum to 1.
 * Criteria without explicit weights share the remaining weight equally.
 */
export function normalizeCriterionWeights(criteria: RubricCriterion[]): Map<string, number> {
  const result = new Map<string, number>();
  if (criteria.length === 0) return result;

  let explicitWeightSum = 0;
  let unweightedCount = 0;

  for (const c of criteria) {
    if (c.weight !== undefined) {
      explicitWeightSum += c.weight;
    } else {
      unweightedCount++;
    }
  }

  // If all weights are explicit, normalize them
  if (unweightedCount === 0) {
    const factor = explicitWeightSum > 0 ? 1 / explicitWeightSum : 1 / criteria.length;
    for (const c of criteria) {
      result.set(c.id, (c.weight ?? 0) * factor);
    }
    return result;
  }

  // Distribute remaining weight among unweighted criteria
  const remaining = Math.max(0, 1 - explicitWeightSum);
  const equalShare = remaining / unweightedCount;

  for (const c of criteria) {
    result.set(c.id, c.weight ?? equalShare);
  }

  // Final normalization in case explicit weights exceed 1
  const total = Array.from(result.values()).reduce((s, v) => s + v, 0);
  if (total > 0 && Math.abs(total - 1) > 0.001) {
    const factor = 1 / total;
    for (const [id, w] of result) {
      result.set(id, w * factor);
    }
  }

  return result;
}

/** Get the maximum score from a criterion's levels. */
export function getMaxScore(criterion: RubricCriterion): number {
  if (criterion.levels.length === 0) return 0;
  return Math.max(...criterion.levels.map((l) => l.score));
}

/** Get the minimum score from a criterion's levels. */
export function getMinScore(criterion: RubricCriterion): number {
  if (criterion.levels.length === 0) return 0;
  return Math.min(...criterion.levels.map((l) => l.score));
}

/** Classify a numeric confidence value into a label. */
export function classifyConfidence(value: number): JudgeConfidence {
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  return 'low';
}
