/**
 * Confidence Labeling — Analysis Engine (barrel)
 *
 * The pure scoring engine for verdict reliability, split along its two internal
 * seams and re-exported here so existing importers keep a single `./confidence-analysis.js`
 * entry point:
 *
 * - ./confidence-signals.js     — the six `extract*` functions + `DEFAULT_SIGNAL_WEIGHTS`;
 *   each turns one facet of a `JudgeResult` into a normalized `ConfidenceSignal`.
 * - ./confidence-assessment.js  — `assessConfidence` aggregates the signals into a
 *   weighted `ConfidenceAssessment`, and `labelVerdict` maps that onto a
 *   possibly-overridden `LabeledVerdict`.
 *
 * No IO and no judge transport here — these are deterministic functions over an
 * already-produced `JudgeResult`. The type vocabulary lives in ./confidence-types.js;
 * the public barrel ./confidence.js re-exports this engine and wraps it in assertion
 * factories.
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator's certainty)
 * @module
 */

export {
  extractSelfReportedConfidence,
  extractEvidenceQuality,
  extractScoreConsistency,
  extractBoundaryProximity,
  extractCoverageCompleteness,
  extractReasoningQuality,
} from './confidence-signals.js';

export {
  assessConfidence,
  labelVerdict,
} from './confidence-assessment.js';
