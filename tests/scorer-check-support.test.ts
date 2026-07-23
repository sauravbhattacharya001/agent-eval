/**
 * Direct-seam tests for the check-support scaffolding (`scorer-check-support.ts`).
 *
 * The non-scoring scaffolding (default budgets, the shared `CheckOutcome` shape,
 * and the `resolveTimeout` / `resolveRunMetadata` option resolvers) was
 * extracted from `scorer-checks.ts` so it can be tested without touching the
 * scoring logic. `scorer-checks.test.ts` already exercises these via the
 * re-export; this file pins them at their new home so the seam is a first-class
 * contract and the re-export can never silently drift from the source module.
 *
 * @tier 1+2 - Deterministic + Heuristic (no AI, reproducible, offline)
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_OUTPUT_WORDS,
  DEFAULT_TIMEOUT_BUDGETS,
  resolveRunMetadata,
  resolveTimeout,
} from '../src/monitoring/scorer-check-support.js';
// The same symbols must be reachable through the scorer-checks re-export.
import * as viaChecks from '../src/monitoring/scorer-checks.js';
import type { RunMetadata } from '../src/monitoring/scorer.js';

describe('scorer-check-support: re-export parity', () => {
  it('scorer-checks re-exports the identical support bindings', () => {
    expect(viaChecks.DEFAULT_MIN_OUTPUT_WORDS).toBe(DEFAULT_MIN_OUTPUT_WORDS);
    expect(viaChecks.DEFAULT_TIMEOUT_BUDGETS).toBe(DEFAULT_TIMEOUT_BUDGETS);
    expect(viaChecks.resolveTimeout).toBe(resolveTimeout);
    expect(viaChecks.resolveRunMetadata).toBe(resolveRunMetadata);
  });
});

describe('scorer-check-support: constants', () => {
  it('has a positive default word floor', () => {
    expect(DEFAULT_MIN_OUTPUT_WORDS).toBeGreaterThan(0);
  });

  it('ships conservative per-worker timeout budgets', () => {
    for (const [worker, ms] of Object.entries(DEFAULT_TIMEOUT_BUDGETS)) {
      expect(ms, `${worker} budget`).toBeGreaterThan(0);
    }
    // tempcheck/scrubme are short jobs; builder/gardener get the widest window.
    expect(DEFAULT_TIMEOUT_BUDGETS.builder).toBeGreaterThan(DEFAULT_TIMEOUT_BUDGETS.tempcheck);
  });
});

describe('scorer-check-support: resolveTimeout', () => {
  it('returns a flat numeric override for every worker', () => {
    expect(resolveTimeout('builder', 12_345)).toBe(12_345);
    expect(resolveTimeout('anything', 12_345)).toBe(12_345);
  });

  it('reads a per-worker map, undefined when the worker is absent', () => {
    const map = { sentinel: 999 };
    expect(resolveTimeout('sentinel', map)).toBe(999);
    expect(resolveTimeout('builder', map)).toBeUndefined();
  });

  it('falls back to the built-in defaults when no option is given', () => {
    expect(resolveTimeout('builder', undefined)).toBe(DEFAULT_TIMEOUT_BUDGETS.builder);
    expect(resolveTimeout('unknown-worker', undefined)).toBeUndefined();
  });
});

describe('scorer-check-support: resolveRunMetadata', () => {
  const single: RunMetadata = { exitStatus: 'ok', exitCode: 0 };

  it('returns undefined when no metadata is supplied', () => {
    expect(resolveRunMetadata('r1', 'builder', undefined)).toBeUndefined();
  });

  it('applies a single record (identified by its own known keys) to any run', () => {
    expect(resolveRunMetadata('any', 'builder', single)).toBe(single);
  });

  it('resolves a map by exact runId, then worker/runId, then worker', () => {
    const byRunId = { r1: single };
    expect(resolveRunMetadata('r1', 'builder', byRunId)).toBe(single);

    const byPath = { 'builder/r1': single };
    expect(resolveRunMetadata('r1', 'builder', byPath)).toBe(single);

    const byWorker = { builder: single };
    expect(resolveRunMetadata('r1', 'builder', byWorker)).toBe(single);
  });

  it('returns undefined when a map has no matching key', () => {
    expect(resolveRunMetadata('r1', 'builder', { gardener: single })).toBeUndefined();
  });
});
