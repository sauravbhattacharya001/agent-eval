/**
 * Confidence Labeling — Aggregation & Verdict Labeling
 *
 * The aggregation half of the confidence engine. `assessConfidence` gathers the
 * six per-facet signals (from ./confidence-signals.js), normalizes their weights,
 * and rolls them into a weighted `ConfidenceAssessment` with a recommendation;
 * `labelVerdict` maps that assessment onto a possibly-overridden `LabeledVerdict`.
 *
 * No IO and no judge transport here — these are deterministic functions over an
 * already-produced `JudgeResult`. The type vocabulary lives in
 * ./confidence-types.js; the public barrel ./confidence.js re-exports this engine
 * (via ./confidence-analysis.js) and wraps it in assertion factories.
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator's certainty)
 * @module
 */

import type { JudgeResult, JudgeVerdict } from './judge.js';
import type {
  ConfidenceSignal,
  ConfidenceAssessment,
  ConfidenceRecommendation,
  ConfidenceLabelingOptions,
  LabeledVerdict,
} from './confidence-types.js';
import {
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
} from './confidence-signals.js';

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
