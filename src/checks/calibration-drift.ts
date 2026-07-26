/**
 * Judge Calibration System - Drift Detection
 *
 * Detects when a model-as-judge scores differently on the same calibration set
 * across two snapshots (e.g. after a model update or config change), by diffing
 * a previous {@link CalibrationSnapshot} against a current {@link CalibrationReport}.
 * Re-exported through the public barrel (`./calibration.js`) via
 * `./calibration-analysis.js`.
 *
 * @tier 3 - Meta-evaluation (evaluates the evaluator)
 * @module
 */

import type {
  CalibrationReport,
  CalibrationSnapshot,
  DriftResult,
} from './calibration-types.js';

// ─── DRIFT DETECTION ────────────────────────────────────────────────────────────

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
