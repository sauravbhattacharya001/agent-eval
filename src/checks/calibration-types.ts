/**
 * Judge Calibration System - Type Vocabulary
 *
 * The types shared by the calibration engine (`./calibration-analysis.js`)
 * and the public barrel (`./calibration.js`): the calibration example/set
 * model, the per-criterion and overall report shapes, run options, and the
 * drift-detection snapshot/result. Kept dependency-free so both the engine
 * and any consumer can import them without pulling in runtime code.
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** A single calibration example with known ground-truth scores. */
export interface CalibrationExample {
  /** Human-readable name for this example. */
  name: string;
  /** The output text being evaluated. */
  output: string;
  /** The task/prompt that produced the output. */
  task: string;
  /** Reference materials (optional). */
  references?: string[];
  /** Human-graded ground truth: criterion ID → expected score. */
  expectedScores: Record<string, number>;
  /** Notes explaining why these scores were assigned. */
  notes?: string;
  /** Expected overall verdict (optional). */
  expectedVerdict?: 'pass' | 'fail';
}

/** A complete calibration set for a rubric. */
export interface CalibrationSet {
  /** Name of this calibration set. */
  name: string;
  /** The rubric being calibrated against. */
  rubricName: string;
  /** Calibration examples with known ground truth. */
  examples: CalibrationExample[];
  /** When this calibration set was last validated by humans. */
  lastValidated?: string;
  /** Version — increment when examples change. */
  version?: number;
}

/** Result of calibrating a single criterion. */
export interface CriterionCalibration {
  /** Criterion ID. */
  criterionId: string;
  /** Number of examples that had this criterion scored. */
  sampleCount: number;
  /** Exact match rate (judge === ground truth). */
  exactMatchRate: number;
  /** Within-one rate (|judge - ground truth| <= 1). */
  withinOneRate: number;
  /** Mean absolute error. */
  meanAbsoluteError: number;
  /** Bias: positive = too generous, negative = too strict. */
  bias: number;
  /** Individual deltas for each example. */
  deltas: CriterionDelta[];
  /** Whether this criterion is reliable (withinOne >= 0.8). */
  reliable: boolean;
}

/** Delta for a single example on a single criterion. */
export interface CriterionDelta {
  /** Example name. */
  exampleName: string;
  /** Expected score (ground truth). */
  expected: number;
  /** Actual score (judge output). */
  actual: number;
  /** Delta (actual - expected). Positive = judge too generous. */
  delta: number;
}

/** Overall calibration report. */
export interface CalibrationReport {
  /** Backend that was calibrated. */
  backendName: string;
  /** Rubric that was used. */
  rubricName: string;
  /** Number of examples in the calibration set. */
  exampleCount: number;
  /** Overall exact match rate across all criteria and examples. */
  exactMatchRate: number;
  /** Overall within-one rate. */
  withinOneRate: number;
  /** Overall mean absolute error. */
  meanAbsoluteError: number;
  /** Overall bias direction. */
  bias: number;
  /** Per-criterion calibration results. */
  criteria: CriterionCalibration[];
  /** Examples where the judge was most wrong. */
  worstMisses: CriterionDelta[];
  /** Whether the judge passes calibration (withinOne >= 0.85 overall). */
  calibrated: boolean;
  /** Suggested threshold adjustment based on measured bias. */
  suggestedThresholdAdjustment: number;
  /** Verdict accuracy: how often did judge agree with expected verdict. */
  verdictAccuracy?: number;
  /** Duration of calibration run in ms. */
  durationMs: number;
}

/** Options for running calibration. */
export interface CalibrationOptions {
  /** Minimum within-one rate to consider calibrated. Default: 0.85 */
  minWithinOneRate?: number;
  /** Minimum exact match rate to consider calibrated. Default: 0.5 */
  minExactMatchRate?: number;
  /** Maximum acceptable bias magnitude. Default: 0.5 */
  maxBias?: number;
  /** Number of times to run each example (for consistency check). Default: 1 */
  samples?: number;
}

// ─── DRIFT DETECTION TYPES ──────────────────────────────────────────────────────

/** Stored calibration snapshot for drift comparison. */
export interface CalibrationSnapshot {
  /** When this snapshot was taken. */
  timestamp: string;
  /** Backend name. */
  backendName: string;
  /** Model version (if known). */
  modelVersion?: string;
  /** The calibration report at this point. */
  report: CalibrationReport;
}

/** Result of drift detection between two snapshots. */
export interface DriftResult {
  /** Whether drift was detected. */
  drifted: boolean;
  /** Change in bias. */
  biasDelta: number;
  /** Change in withinOne rate. */
  withinOneDelta: number;
  /** Change in exact match rate. */
  exactMatchDelta: number;
  /** Criteria that drifted significantly. */
  driftedCriteria: Array<{ criterionId: string; biasDelta: number; maeDelta: number }>;
  /** Summary description of drift. */
  summary: string;
}