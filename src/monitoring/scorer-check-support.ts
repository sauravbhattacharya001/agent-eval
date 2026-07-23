/**
 * Historical Scorer — check support (constants, option resolution, result shape)
 *
 * The non-scoring scaffolding behind {@link scoreTranscript}: the default
 * budgets, the shared {@link CheckOutcome} result shape, and the pure
 * option-resolution helpers ({@link resolveTimeout}, {@link resolveRunMetadata})
 * that turn caller-supplied options into the concrete inputs each individual
 * check scorer consumes. Extracted from `scorer-checks.ts` so the file that
 * holds the actual Tier 1 + Tier 2 scoring logic stays focused on scoring, and
 * so this scaffolding can be unit-tested in isolation.
 *
 * Everything here is a pure function of its arguments — no filesystem, no
 * network, no clock. Independence note: nothing here performs any judgement; it
 * only resolves options and defines the shared result shape the deterministic
 * check scorers return.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import type { RunMetadata, ScoreStatus, ScoreTranscriptOptions } from './scorer-types.js';

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/** Default minimum deliverable word count before completeness is penalized. */
export const DEFAULT_MIN_OUTPUT_WORDS = 20;

/** Default per-worker timeout budgets (ms). Conservative, used only if caller
 * does not supply their own. These mirror the cron cadence headroom — a run
 * that blows well past these is genuinely anomalous, not just slow. */
export const DEFAULT_TIMEOUT_BUDGETS: Readonly<Record<string, number>> = {
  builder: 60 * 60_000,
  gardener: 60 * 60_000,
  sentinel: 45 * 60_000,
  eval: 45 * 60_000,
  blog: 45 * 60_000,
  tempcheck: 20 * 60_000,
  scrubme: 20 * 60_000,
};

/** Known own-keys of a {@link RunMetadata} record, used to tell a single record
 * apart from a runId-keyed map. */
const RUN_METADATA_KEYS = ['exitStatus', 'startedAt', 'endedAt', 'durationMs', 'exitCode'] as const;

// ─── SHARED RESULT SHAPE ──────────────────────────────────────────────────────────

/**
 * The result of one individual check scorer. The orchestrator ({@link
 * scoreTranscript}) merges this with the row identity to build a
 * {@link CheckScore}. `detail` is always present (possibly empty) so callers
 * never have to null-check it.
 */
export interface CheckOutcome {
  /** Normalized score in [0, 1] where 1 is best. */
  score: number;
  /** Verdict derived from the score + the check's own pass criteria. */
  status: ScoreStatus;
  /** Short human-readable explanation of the score. */
  summary: string;
  /** Structured detail (counts, sub-scores) for debugging/trends. */
  detail: Record<string, number | string | boolean>;
}

// ─── OPTION RESOLUTION ─────────────────────────────────────────────────────────────

/** Resolve the timeout budget for a worker from the options. */
export function resolveTimeout(
  worker: string,
  opt: ScoreTranscriptOptions['timeoutMs'],
): number | undefined {
  if (typeof opt === 'number') return opt;
  if (opt && typeof opt === 'object') {
    const v = opt[worker];
    if (typeof v === 'number') return v;
    return undefined;
  }
  // Fall back to built-in defaults.
  return DEFAULT_TIMEOUT_BUDGETS[worker];
}

/**
 * Resolve the {@link RunMetadata} for a run from the options. Accepts either a
 * single record (applied to the scored transcript) or a map keyed by runId
 * (filename without `.md`); falls back to a `worker`-keyed entry for
 * convenience. Returns undefined when nothing matches.
 */
export function resolveRunMetadata(
  runId: string,
  worker: string,
  opt: ScoreTranscriptOptions['runMetadata'],
): RunMetadata | undefined {
  if (!opt || typeof opt !== 'object') return undefined;
  // A single RunMetadata record has at least one of its own known keys.
  const looksLikeSingle = RUN_METADATA_KEYS.some((k) => k in opt);
  if (looksLikeSingle) return opt as RunMetadata;
  const map = opt as Readonly<Record<string, RunMetadata>>;
  // Try, in order: exact runId (basename), `worker/runId`, then worker.
  return map[runId] ?? map[`${worker}/${runId}`] ?? map[worker];
}
