/**
 * Judge Calibration System — Tier 3 Trust Verification
 *
 * Validates that a model-as-judge produces reliable scores by testing it
 * against a calibration set of pre-scored examples with known ground truth.
 *
 * The core problem: How do you know the judge is right?
 * Answer: Test it against examples where humans already know the answer.
 *
 * Outputs:
 * - Exact match rate: judge agrees with ground truth exactly
 * - Within-one rate: judge is within ±1 of ground truth (acceptable)
 * - Mean absolute error: average distance from ground truth
 * - Bias direction: positive = too generous, negative = too strict
 * - Per-criterion breakdown: which criteria are reliable vs unreliable
 *
 * Use calibration to:
 * 1. Validate a judge backend before trusting it in production
 * 2. Detect judge drift when models update
 * 3. Adjust pass thresholds based on measured bias
 * 4. Identify criteria where the judge is unreliable
 *
 * @tier 3 — Meta-evaluation (evaluates the evaluator)
 * @module
 */

import type { Rubric, JudgeBackend, RawJudgeResponse, JudgeContext } from './judge.js';
import { computeVerdict, getMaxScore, getMinScore } from './judge.js';

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
      const lastResponse = sampleResults[sampleResults.length - 1]!;
      const verdict = computeVerdict(lastResponse, rubric);
      if ((verdict.verdict === 'pass' || verdict.verdict === 'fail') &&
          verdict.verdict === example.expectedVerdict) {
        verdictMatches++;
      }
      verdictTotal++;
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
      const median = scores[Math.floor(scores.length / 2)]!;
      result.set(criterion.id, median);
    }
  }

  return result;
}

// ─── CALIBRATION SET BUILDER ────────────────────────────────────────────────────

/**
 * Fluent builder for creating calibration sets.
 *
 * @example
 * ```ts
 * const calSet = buildCalibrationSet('Code Review Calibration', 'Code Review Quality')
 *   .example('Good review with specific fixes')
 *     .output('The auth module has a SQL injection vulnerability on line 42...')
 *     .task('Review this PR for security issues')
 *     .scores({ actionability: 4, accuracy: 5, completeness: 3 })
 *     .verdict('pass')
 *     .notes('Identifies real bug, gives specific fix')
 *     .done()
 *   .example('Vague review with no specifics')
 *     .output('Looks good overall. Maybe consider some edge cases.')
 *     .task('Review this PR for security issues')
 *     .scores({ actionability: 1, accuracy: 2, completeness: 1 })
 *     .verdict('fail')
 *     .notes('No specific issues identified, no actionable feedback')
 *     .done()
 *   .build();
 * ```
 */
export function buildCalibrationSet(name: string, rubricName: string): CalibrationSetBuilder {
  return new CalibrationSetBuilder(name, rubricName);
}

export class CalibrationSetBuilder {
  private _name: string;
  private _rubricName: string;
  private _examples: CalibrationExample[] = [];
  private _version = 1;

  constructor(name: string, rubricName: string) {
    this._name = name;
    this._rubricName = rubricName;
  }

  /** Start building a new calibration example. */
  example(name: string): CalibrationExampleBuilder {
    return new CalibrationExampleBuilder(this, name);
  }

  /** Set the version number. */
  version(v: number): this {
    this._version = v;
    return this;
  }

  /** @internal */
  _addExample(ex: CalibrationExample): void {
    this._examples.push(ex);
  }

  /** Build the calibration set. */
  build(): CalibrationSet {
    if (this._examples.length === 0) {
      throw new Error('Calibration set must have at least one example');
    }
    return {
      name: this._name,
      rubricName: this._rubricName,
      examples: this._examples,
      lastValidated: new Date().toISOString(),
      version: this._version,
    };
  }
}

export class CalibrationExampleBuilder {
  private _parent: CalibrationSetBuilder;
  private _name: string;
  private _output = '';
  private _task = '';
  private _references?: string[];
  private _expectedScores: Record<string, number> = {};
  private _expectedVerdict?: 'pass' | 'fail';
  private _notes?: string;

  constructor(parent: CalibrationSetBuilder, name: string) {
    this._parent = parent;
    this._name = name;
  }

  output(text: string): this { this._output = text; return this; }
  task(text: string): this { this._task = text; return this; }
  references(refs: string[]): this { this._references = refs; return this; }
  scores(scores: Record<string, number>): this { this._expectedScores = scores; return this; }
  verdict(v: 'pass' | 'fail'): this { this._expectedVerdict = v; return this; }
  notes(text: string): this { this._notes = text; return this; }

  /** Finish this example and return to the set builder. */
  done(): CalibrationSetBuilder {
    this._parent._addExample({
      name: this._name,
      output: this._output,
      task: this._task,
      references: this._references,
      expectedScores: this._expectedScores,
      expectedVerdict: this._expectedVerdict,
      notes: this._notes,
    });
    return this._parent;
  }
}

// ─── DRIFT DETECTION ────────────────────────────────────────────────────────────

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

/**
 * Detect drift between two calibration snapshots.
 *
 * Use this to detect when model updates or config changes cause
 * the judge to score differently on the same calibration set.
 *
 * @param baseline - Previous calibration snapshot
 * @param current - Current calibration report
 * @param driftThreshold - Minimum change to flag as drift. Default: 0.1
 */
export function detectDrift(
  baseline: CalibrationSnapshot,
  current: CalibrationReport,
  driftThreshold = 0.1,
): DriftResult {
  const biasDelta = current.bias - baseline.report.bias;
  const withinOneDelta = current.withinOneRate - baseline.report.withinOneRate;
  const exactMatchDelta = current.exactMatchRate - baseline.report.exactMatchRate;

  const driftedCriteria: DriftResult['driftedCriteria'] = [];

  for (const currentCrit of current.criteria) {
    const baselineCrit = baseline.report.criteria.find(c => c.criterionId === currentCrit.criterionId);
    if (!baselineCrit) continue;

    const critBiasDelta = currentCrit.bias - baselineCrit.bias;
    const critMaeDelta = currentCrit.meanAbsoluteError - baselineCrit.meanAbsoluteError;

    if (Math.abs(critBiasDelta) > driftThreshold || Math.abs(critMaeDelta) > driftThreshold) {
      driftedCriteria.push({
        criterionId: currentCrit.criterionId,
        biasDelta: critBiasDelta,
        maeDelta: critMaeDelta,
      });
    }
  }

  const drifted =
    Math.abs(biasDelta) > driftThreshold ||
    Math.abs(withinOneDelta) > driftThreshold ||
    driftedCriteria.length > 0;

  const parts: string[] = [];
  if (drifted) {
    if (Math.abs(biasDelta) > driftThreshold) {
      parts.push(`Bias shifted ${biasDelta > 0 ? 'more generous' : 'more strict'} by ${Math.abs(biasDelta).toFixed(2)}`);
    }
    if (withinOneDelta < -driftThreshold) {
      parts.push(`Accuracy dropped: withinOne ${(withinOneDelta * 100).toFixed(1)}%`);
    }
    if (driftedCriteria.length > 0) {
      parts.push(`${driftedCriteria.length} criteria drifted: ${driftedCriteria.map(c => c.criterionId).join(', ')}`);
    }
  }

  return {
    drifted,
    biasDelta,
    withinOneDelta,
    exactMatchDelta,
    driftedCriteria,
    summary: drifted ? parts.join('. ') : 'No significant drift detected',
  };
}
