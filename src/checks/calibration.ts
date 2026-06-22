/**
 * Judge Calibration System - Tier 3 Trust Verification
 *
 * Validates that a model-as-judge produces reliable scores by testing it
 * against a calibration set of pre-scored examples with known ground truth.
 *
 * The core problem: How do you know the judge is right?
 * Answer: Test it against examples where humans already know the answer.
 *
 * This file is the **public barrel** for judge calibration. The supporting
 * seams live alongside it and are re-exported here so the public surface
 * stays a single `./calibration.js` import path:
 * - ./calibration-types.js    - the type vocabulary (example/set/report/
 *                               options + drift snapshot/result model)
 * - ./calibration-analysis.js - the engine (calibrate / buildCalibrationSet /
 *                               detectDrift)
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

// --- TYPE RE-EXPORTS -----------------------------------------------------------
// The calibration type vocabulary lives in ./calibration-types.js; re-export it
// here so consumers keep a single `./calibration.js` import path.
export type {
  CalibrationExample,
  CalibrationSet,
  CriterionCalibration,
  CriterionDelta,
  CalibrationReport,
  CalibrationOptions,
  CalibrationSnapshot,
  DriftResult,
} from './calibration-types.js';

// --- ENGINE RE-EXPORTS ---------------------------------------------------------
// The calibration engine, set builder, and drift detector live in
// ./calibration-analysis.js; re-export them through this barrel.
export {
  calibrate,
  buildCalibrationSet,
  CalibrationSetBuilder,
  CalibrationExampleBuilder,
  detectDrift,
} from './calibration-analysis.js';