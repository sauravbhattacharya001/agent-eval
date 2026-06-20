/**
 * Confidence Labeling — Type Vocabulary
 *
 * The pure value types for multi-signal verdict reliability: the per-signal
 * shape (`ConfidenceSignal`), the aggregate assessment (`ConfidenceAssessment`),
 * the labeling configuration (`ConfidenceLabelingOptions`), the labeled-verdict
 * record (`LabeledVerdict`), and the closed `ConfidenceSignalId` /
 * `ConfidenceRecommendation` unions. No analysis or judging logic lives here —
 * the engine in ./confidence-analysis.js consumes these, and the public barrel
 * ./confidence.js re-exports them so the import path stays a single
 * `./confidence.js` for every consumer.
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator's certainty)
 * @module
 */

import type { JudgeResult, JudgeVerdict } from './judge.js';

/** Individual confidence signal with a normalized score (0–1). */
export interface ConfidenceSignal {
  /** Signal identifier. */
  id: ConfidenceSignalId;
  /** Human-readable name. */
  name: string;
  /** Signal score (0 = no confidence, 1 = full confidence). */
  score: number;
  /** Weight of this signal in the aggregate (0–1). */
  weight: number;
  /** Explanation of how this score was derived. */
  reasoning: string;
  /** Whether this signal alone would trigger a review flag. */
  flagged: boolean;
}

/** Known confidence signal identifiers. */
export type ConfidenceSignalId =
  | 'self-reported'
  | 'evidence-quality'
  | 'score-consistency'
  | 'boundary-proximity'
  | 'coverage-completeness'
  | 'reasoning-quality';

/** Aggregate confidence assessment. */
export interface ConfidenceAssessment {
  /** Final confidence score (0–1). */
  overallConfidence: number;
  /** Recommended verdict modification. */
  recommendation: ConfidenceRecommendation;
  /** Individual signal breakdowns. */
  signals: ConfidenceSignal[];
  /** Signals that triggered a review flag. */
  flaggedSignals: ConfidenceSignal[];
  /** Whether the original verdict should be trusted. */
  trustworthy: boolean;
  /** Human-readable summary. */
  summary: string;
}

/** What the confidence system recommends. */
export type ConfidenceRecommendation =
  | 'trust-verdict'
  | 'needs-review'
  | 'low-evidence'
  | 'borderline'
  | 'contradictory';

/** Configuration for confidence labeling. */
export interface ConfidenceLabelingOptions {
  /** Minimum aggregate confidence to trust a verdict (0–1). Default: 0.6 */
  minConfidence?: number;
  /** Minimum self-reported confidence from judge (0–1). Default: 0.4 */
  minSelfReported?: number;
  /** Minimum evidence items per criterion. Default: 1 */
  minEvidencePerCriterion?: number;
  /** Maximum allowed range between criterion scores (0–1). Default: 0.6 */
  maxScoreRange?: number;
  /** Borderline margin around pass/fail threshold (0–1). Default: 0.1 */
  borderlineMargin?: number;
  /** Minimum reasoning length (chars) to consider substantive. Default: 20 */
  minReasoningLength?: number;
  /** Custom signal weights override. */
  signalWeights?: Partial<Record<ConfidenceSignalId, number>>;
  /** Number of flagged signals that immediately triggers review. Default: 3 */
  maxFlaggedSignals?: number;
  /** Pass threshold (needed for boundary proximity). Default: 0.6 */
  passThreshold?: number;
}

/** Result of applying confidence labeling to a verdict. */
export interface LabeledVerdict {
  /** Original verdict from the judge. */
  originalVerdict: JudgeVerdict;
  /** Labeled verdict (may be overridden to 'needs-human-review'). */
  labeledVerdict: JudgeVerdict;
  /** Whether the verdict was overridden. */
  overridden: boolean;
  /** The confidence assessment that led to this label. */
  assessment: ConfidenceAssessment;
  /** Original judge result. */
  judgeResult: JudgeResult;
}