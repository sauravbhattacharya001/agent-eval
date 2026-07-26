/**
 * Judge Calibration System - Engine barrel
 *
 * Aggregates the calibration engine seams into the single `./calibration-analysis.js`
 * import path used by the public barrel (`./calibration.js`):
 * - ./calibration-engine.js   - `calibrate` (runs the judge against ground truth)
 * - ./calibration-builder.js  - `buildCalibrationSet` + the fluent builder classes
 * - ./calibration-drift.js    - `detectDrift` (diffs two calibration snapshots)
 *
 * The type vocabulary lives in `./calibration-types.js`.
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

export { calibrate } from './calibration-engine.js';
export {
  buildCalibrationSet,
  CalibrationSetBuilder,
  CalibrationExampleBuilder,
} from './calibration-builder.js';
export { detectDrift } from './calibration-drift.js';
