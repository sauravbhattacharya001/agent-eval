/**
 * Confidence Labeling — Multi-Signal Analysis Engine
 *
 * The pure scoring engine for verdict reliability. Each `extract*` function turns
 * one facet of a `JudgeResult` into a normalized `ConfidenceSignal` (self-reported
 * confidence, evidence quality, score consistency, boundary proximity, coverage
 * completeness, reasoning quality); `assessConfidence` aggregates them into a
 * weighted `ConfidenceAssessment`; `labelVerdict` maps that assessment onto a
 * possibly-overridden `LabeledVerdict`.
 *
 * No IO and no judge transport here — these are deterministic functions over an
 * already-produced `JudgeResult`. The type vocabulary lives in
 * ./confidence-types.js; the public barrel ./confidence.js re-exports this engine
 * and wraps it in assertion factories.
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator's certainty)
 * @module
 */

import type { JudgeResult, JudgeVerdict } from './judge.js';
import type {
  ConfidenceSignal,
  ConfidenceSignalId,
  ConfidenceAssessment,
  ConfidenceRecommendation,
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './confidence-types.js';

// ═══ DEFAULT WEIGHTS ═════════════════════════════════════════════════════════════

const DEFAULT_SIGNAL_WEIGHTS: Record<ConfidenceSignalId, number> = {
  'self-reported': 0.25,
  'evidence-quality': 0.20,
  'score-consistency': 0.20,
  'boundary-proximity': 0.15,
  'coverage-completeness': 0.10,
  'reasoning-quality': 0.10,
};

// ═══ SIGNAL EXTRACTORS ═══════════════════════════════════════════════════════════

/**
 * Extract self-reported confidence signal.
 * Uses the judge's own confidence value — the weighted average across criteria.
 */
export function extractSelfReportedConfidence(
  result: JudgeResult,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const minSelfReported = options.minSelfReported ?? 0.4;
  const value = result.confidenceValue;
  const flagged = value < minSelfReported;

  let reasoning: string;
  if (value >= 0.8) {
    reasoning = `Judge self-reports high confidence (${value.toFixed(2)})`;
  } else if (value >= 0.5) {
    reasoning = `Judge self-reports moderate confidence (${value.toFixed(2)})`;
  } else {
    reasoning = `Judge self-reports LOW confidence (${value.toFixed(2)}) — below minimum ${minSelfReported}`;
  }

  return {
    id: 'self-reported',
    name: 'Self-Reported Confidence',
    score: value,
    weight: (options.signalWeights?.['self-reported'] ?? DEFAULT_SIGNAL_WEIGHTS['self-reported']),
    reasoning,
    flagged,
  };
}

/**
 * Extract evidence quality signal.
 * Measures how much concrete evidence the judge cited.
 */
export function extractEvidenceQuality(
  result: JudgeResult,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const minEvidencePerCriterion = options.minEvidencePerCriterion ?? 1;
  const criteriaCount = result.criterionScores.length;

  if (criteriaCount === 0) {
    return {
      id: 'evidence-quality',
      name: 'Evidence Quality',
      score: 0,
      weight: (options.signalWeights?.['evidence-quality'] ?? DEFAULT_SIGNAL_WEIGHTS['evidence-quality']),
      reasoning: 'No criteria scored — no evidence possible',
      flagged: true,
    };
  }

  let wellEvidenced = 0;
  let totalEvidence = 0;
  const underEvidenced: string[] = [];

  for (const cs of result.criterionScores) {
    const evidenceCount = cs.evidence.length;
    totalEvidence += evidenceCount;
    if (evidenceCount >= minEvidencePerCriterion) {
      wellEvidenced++;
    } else {
      underEvidenced.push(cs.criterionId);
    }
  }

  const evidenceRatio = wellEvidenced / criteriaCount;
  const avgEvidence = totalEvidence / criteriaCount;
  const richnessBonus = Math.min(0.2, avgEvidence * 0.05);

  const score = Math.min(1, evidenceRatio + richnessBonus);
  const flagged = evidenceRatio < 0.5;

  let reasoning: string;
  if (flagged) {
    reasoning = `Only ${wellEvidenced}/${criteriaCount} criteria have sufficient evidence. Under-evidenced: ${underEvidenced.join(', ')}`;
  } else if (evidenceRatio === 1) {
    reasoning = `All ${criteriaCount} criteria have ${minEvidencePerCriterion}+ evidence citations (${totalEvidence} total)`;
  } else {
    reasoning = `${wellEvidenced}/${criteriaCount} criteria well-evidenced (${totalEvidence} total citations)`;
  }

  return {
    id: 'evidence-quality',
    name: 'Evidence Quality',
    score,
    weight: (options.signalWeights?.['evidence-quality'] ?? DEFAULT_SIGNAL_WEIGHTS['evidence-quality']),
    reasoning,
    flagged,
  };
}

/**
 * Extract score consistency signal.
 * Checks if criterion scores are wildly inconsistent.
 */
export function extractScoreConsistency(
  result: JudgeResult,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const maxRange = options.maxScoreRange ?? 0.6;
  const scores = result.criterionScores;

  if (scores.length < 2) {
    return {
      id: 'score-consistency',
      name: 'Score Consistency',
      score: 1.0,
      weight: (options.signalWeights?.['score-consistency'] ?? DEFAULT_SIGNAL_WEIGHTS['score-consistency']),
      reasoning: 'Only one criterion — consistency not applicable',
      flagged: false,
    };
  }

  const normalizedScores = scores.map((s) => s.normalizedScore);
  const min = Math.min(...normalizedScores);
  const max = Math.max(...normalizedScores);
  const range = max - min;

  const mean = normalizedScores.reduce((a, b) => a + b, 0) / normalizedScores.length;
  const variance = normalizedScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / normalizedScores.length;
  const stdDev = Math.sqrt(variance);

  const rangeScore = Math.max(0, 1 - range / maxRange);
  const stdDevPenalty = Math.max(0, (stdDev - 0.15) / 0.3);
  const score = Math.max(0, rangeScore - stdDevPenalty * 0.3);
  const flagged = range > maxRange;

  const outliers: string[] = [];
  if (flagged) {
    for (const cs of scores) {
      if (cs.normalizedScore === min || cs.normalizedScore === max) {
        outliers.push(`${cs.criterionId}=${cs.normalizedScore.toFixed(2)}`);
      }
    }
  }

  let reasoning: string;
  if (range <= 0.2) {
    reasoning = `Scores are consistent (range=${range.toFixed(2)}, \u03C3=${stdDev.toFixed(2)})`;
  } else if (flagged) {
    reasoning = `Large score range ${range.toFixed(2)} exceeds max ${maxRange}. Outliers: ${outliers.join(', ')}`;
  } else {
    reasoning = `Moderate score variation (range=${range.toFixed(2)}, \u03C3=${stdDev.toFixed(2)}) — within acceptable limits`;
  }

  return {
    id: 'score-consistency',
    name: 'Score Consistency',
    score,
    weight: (options.signalWeights?.['score-consistency'] ?? DEFAULT_SIGNAL_WEIGHTS['score-consistency']),
    reasoning,
    flagged,
  };
}

/**
 * Extract boundary proximity signal.
 * Detects when the overall score is right at the pass/fail threshold.
 */
export function extractBoundaryProximity(
  result: JudgeResult,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const passThreshold = options.passThreshold ?? 0.6;
  const margin = options.borderlineMargin ?? 0.1;

  const distance = Math.abs(result.overallScore - passThreshold);
  const isNearBoundary = distance < margin;

  const score = isNearBoundary ? distance / margin : 1.0;
  const flagged = isNearBoundary;

  let reasoning: string;
  if (distance < 0.02) {
    reasoning = `Score ${result.overallScore.toFixed(3)} is AT the threshold ${passThreshold} — verdict could easily flip`;
  } else if (isNearBoundary) {
    reasoning = `Score ${result.overallScore.toFixed(3)} is within ${margin} of threshold ${passThreshold} (distance=${distance.toFixed(3)}) — borderline`;
  } else {
    reasoning = `Score ${result.overallScore.toFixed(3)} is ${distance.toFixed(3)} from threshold ${passThreshold} — clear ${result.overallScore >= passThreshold ? 'pass' : 'fail'}`;
  }

  return {
    id: 'boundary-proximity',
    name: 'Boundary Proximity',
    score,
    weight: (options.signalWeights?.['boundary-proximity'] ?? DEFAULT_SIGNAL_WEIGHTS['boundary-proximity']),
    reasoning,
    flagged,
  };
}

/**
 * Extract coverage completeness signal.
 * Checks whether all expected criteria were actually scored.
 */
export function extractCoverageCompleteness(
  result: JudgeResult,
  expectedCriteriaCount: number,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const actual = result.criterionScores.length;
  const coverage = expectedCriteriaCount > 0 ? actual / expectedCriteriaCount : 0;

  const unscored = result.criterionScores.filter(
    (cs) => cs.reasoning === 'No score provided by judge',
  );
  const effectiveCoverage = expectedCriteriaCount > 0
    ? (actual - unscored.length) / expectedCriteriaCount
    : 0;

  const score = effectiveCoverage;
  const flagged = effectiveCoverage < 0.8;

  let reasoning: string;
  if (effectiveCoverage === 1) {
    reasoning = `All ${expectedCriteriaCount} criteria scored`;
  } else if (unscored.length > 0) {
    reasoning = `${unscored.length} criteria received no real score. Effective coverage: ${(effectiveCoverage * 100).toFixed(0)}%`;
  } else {
    reasoning = `Only ${actual}/${expectedCriteriaCount} criteria present in results (${(coverage * 100).toFixed(0)}%)`;
  }

  return {
    id: 'coverage-completeness',
    name: 'Coverage Completeness',
    score,
    weight: (options.signalWeights?.['coverage-completeness'] ?? DEFAULT_SIGNAL_WEIGHTS['coverage-completeness']),
    reasoning,
    flagged,
  };
}

/**
 * Extract reasoning quality signal.
 * Checks if reasoning is substantive vs. boilerplate.
 */
export function extractReasoningQuality(
  result: JudgeResult,
  options: ConfidenceLabelingOptions,
): ConfidenceSignal {
  const minLength = options.minReasoningLength ?? 20;
  const scores = result.criterionScores;

  if (scores.length === 0) {
    return {
      id: 'reasoning-quality',
      name: 'Reasoning Quality',
      score: 0,
      weight: (options.signalWeights?.['reasoning-quality'] ?? DEFAULT_SIGNAL_WEIGHTS['reasoning-quality']),
      reasoning: 'No criteria to assess reasoning quality',
      flagged: true,
    };
  }

  const boilerplatePatterns = [
    /^(good|bad|okay|fine|acceptable|adequate|sufficient|satisfactory)\.?$/i,
    /^the (output|response|answer) (is|was) (good|bad|okay|fine|adequate)\.?$/i,
    /^(meets|does not meet) (expectations|requirements)\.?$/i,
    /^(no|n\/a|none|nothing)\.?$/i,
    /^see above\.?$/i,
  ];

  let substantiveCount = 0;
  let boilerplateCount = 0;
  let emptyCount = 0;

  for (const cs of scores) {
    const reasoning = cs.reasoning.trim();

    if (reasoning.length === 0) {
      emptyCount++;
    } else if (reasoning.length < minLength) {
      boilerplateCount++;
    } else if (boilerplatePatterns.some((p) => p.test(reasoning))) {
      boilerplateCount++;
    } else {
      substantiveCount++;
    }
  }

  const total = scores.length;
  const substantiveRatio = substantiveCount / total;
  const score = substantiveRatio;
  const flagged = substantiveRatio < 0.5;

  let reasoning: string;
  if (substantiveRatio === 1) {
    reasoning = `All ${total} criteria have substantive reasoning`;
  } else if (flagged) {
    const issues: string[] = [];
    if (emptyCount > 0) issues.push(`${emptyCount} empty`);
    if (boilerplateCount > 0) issues.push(`${boilerplateCount} boilerplate`);
    reasoning = `Only ${substantiveCount}/${total} criteria have substantive reasoning (${issues.join(', ')})`;
  } else {
    reasoning = `${substantiveCount}/${total} criteria have substantive reasoning`;
  }

  return {
    id: 'reasoning-quality',
    name: 'Reasoning Quality',
    score,
    weight: (options.signalWeights?.['reasoning-quality'] ?? DEFAULT_SIGNAL_WEIGHTS['reasoning-quality']),
    reasoning,
    flagged,
  };
}

// ═══ AGGREGATE CONFIDENCE ════════════════════════════════════════════════════════

/**
 * Assess overall confidence in a judge result by aggregating multiple signals.
 */
export function assessConfidence(
  result: JudgeResult,
  expectedCriteriaCount: number,
  options: ConfidenceLabelingOptions = {},
): ConfidenceAssessment {
  const minConfidence = options.minConfidence ?? 0.6;
  const maxFlaggedSignals = options.maxFlaggedSignals ?? 3;

  const signals: ConfidenceSignal[] = [
    extractSelfReportedConfidence(result, options),
    extractEvidenceQuality(result, options),
    extractScoreConsistency(result, options),
    extractBoundaryProximity(result, options),
    extractCoverageCompleteness(result, expectedCriteriaCount, options),
    extractReasoningQuality(result, options),
  ];

  // Normalize weights
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight > 0) {
    for (const s of signals) {
      s.weight = s.weight / totalWeight;
    }
  }

  const overallConfidence = signals.reduce(
    (sum, s) => sum + s.score * s.weight,
    0,
  );

  const flaggedSignals = signals.filter((s) => s.flagged);

  let recommendation: ConfidenceRecommendation;
  let trustworthy: boolean;

  if (flaggedSignals.length >= maxFlaggedSignals) {
    recommendation = 'contradictory';
    trustworthy = false;
  } else if (overallConfidence < minConfidence) {
    recommendation = 'needs-review';
    trustworthy = false;
  } else if (flaggedSignals.some((s) => s.id === 'boundary-proximity')) {
    recommendation = 'borderline';
    trustworthy = false;
  } else if (flaggedSignals.some((s) => s.id === 'evidence-quality')) {
    recommendation = 'low-evidence';
    trustworthy = overallConfidence >= minConfidence + 0.1;
  } else {
    recommendation = 'trust-verdict';
    trustworthy = true;
  }

  const summary = buildAssessmentSummary(overallConfidence, recommendation, flaggedSignals);

  return {
    overallConfidence,
    recommendation,
    signals,
    flaggedSignals,
    trustworthy,
    summary,
  };
}

function buildAssessmentSummary(
  confidence: number,
  recommendation: ConfidenceRecommendation,
  flagged: ConfidenceSignal[],
): string {
  const confStr = (confidence * 100).toFixed(0);
  switch (recommendation) {
    case 'trust-verdict':
      return `Confidence ${confStr}% — verdict is trustworthy`;
    case 'needs-review':
      return `Confidence ${confStr}% — too low to trust. Flagged: ${flagged.map((s) => s.name).join(', ')}`;
    case 'low-evidence':
      return `Confidence ${confStr}% — verdict may be correct but evidence is thin`;
    case 'borderline':
      return `Confidence ${confStr}% — score is at the pass/fail boundary`;
    case 'contradictory':
      return `Confidence ${confStr}% — multiple signals disagree (${flagged.length} flagged)`;
  }
}

// ═══ VERDICT LABELING ════════════════════════════════════════════════════════════

/**
 * Apply confidence labeling to a judge result.
 * Never overrides FROM "needs-human-review" — respect existing uncertainty.
 */
export function labelVerdict(
  result: JudgeResult,
  rubricCriteriaCount: number,
  options: ConfidenceLabelingOptions = {},
): LabeledVerdict {
  const assessment = assessConfidence(result, rubricCriteriaCount, options);

  if (result.verdict === 'needs-human-review') {
    return {
      originalVerdict: result.verdict,
      labeledVerdict: 'needs-human-review',
      overridden: false,
      assessment,
      judgeResult: result,
    };
  }

  const shouldOverride = !assessment.trustworthy;
  const labeledVerdict: JudgeVerdict = shouldOverride ? 'needs-human-review' : result.verdict;

  return {
    originalVerdict: result.verdict,
    labeledVerdict,
    overridden: shouldOverride,
    assessment,
    judgeResult: result,
  };
}