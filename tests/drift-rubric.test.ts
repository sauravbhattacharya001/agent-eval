/**
 * Direct tests for the extracted drift rubric leaf module (`checks/drift-rubric.ts`).
 *
 * DRIFT_RUBRIC was pulled out of `checks/drift.ts` into its own leaf so it is
 * importable without the drift engine. These tests pin two things:
 *   1. The leaf is importable on its own (no dependency back on the orchestrator).
 *   2. The rubric's structural invariants — three criteria, five levels each,
 *      weights summing to 1, and the pass/confidence thresholds — are unchanged.
 *
 * The behavioural drift tests (in drift.test.ts) still cover how the rubric is
 * used by the judge; this file guards the rubric artifact itself.
 */
import { describe, it, expect } from 'vitest';
import { DRIFT_RUBRIC } from '../src/checks/drift-rubric.js';
import { DRIFT_RUBRIC as DRIFT_RUBRIC_VIA_DRIFT } from '../src/checks/drift.js';
import { validateRubric } from '../src/checks/judge.js';

describe('drift-rubric leaf module', () => {
  it('is importable directly from the leaf module', () => {
    expect(DRIFT_RUBRIC).toBeDefined();
    expect(DRIFT_RUBRIC.name).toBe('Task Drift Assessment');
  });

  it('is the same object re-exported from ./drift.js (surface unchanged)', () => {
    expect(DRIFT_RUBRIC_VIA_DRIFT).toBe(DRIFT_RUBRIC);
  });

  it('passes the rubric validator (well-formed)', () => {
    const errors = validateRubric(DRIFT_RUBRIC);
    expect(errors).toEqual([]);
  });

  it('has the three drift criteria in order', () => {
    expect(DRIFT_RUBRIC.criteria.map((c) => c.id)).toEqual([
      'task-address',
      'action-alignment',
      'focus',
    ]);
  });

  it('has criterion weights that sum to 1', () => {
    const total = DRIFT_RUBRIC.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('gives every criterion five scoring levels (1..5)', () => {
    for (const c of DRIFT_RUBRIC.criteria) {
      expect(c.levels.map((l) => l.score)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('pins the pass and confidence thresholds', () => {
    expect(DRIFT_RUBRIC.passThreshold).toBe(0.6);
    expect(DRIFT_RUBRIC.confidenceThreshold).toBe(0.65);
  });
});
