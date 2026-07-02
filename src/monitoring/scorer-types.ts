/**
 * Historical Scorer — type vocabulary (Phase 3.5 Production Monitoring)
 *
 * The shared type vocabulary for the historical scorer, split out so the pure
 * per-check engine (`scorer-checks.ts`) and the orchestration surface
 * (`scorer.ts`) speak the same types without a cycle. This file holds **only**
 * types — no logic, no constants, no IO.
 *
 * The orchestrator (`scorer.ts`) re-exports every public type below so consumers
 * keep one import path at `./scorer.js`.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

/** Tier of the check that produced a score. Mirrors the framework hierarchy. */
export type ScoreTier = 1 | 2;

/** Pass/fail/marginal verdict for a single check. */
export type ScoreStatus = 'pass' | 'fail' | 'warn' | 'skip';

/**
 * Canonical check identifiers a scored transcript can carry. The fleet
 * transcript scorer emits three of them - `staleness`, `completeness`, and
 * `verification` (see `scorer-checks.ts`). `relevance` is a reserved Tier-2
 * task-grounding identifier kept in the vocabulary for scores produced outside
 * this scorer; the disk scorer here does not emit it.
 */
export type CheckName =
  | 'staleness'
  | 'completeness'
  | 'verification'
  | 'relevance';

/**
 * One scored check for one transcript. This is the atomic row written to
 * `scores.jsonl`. Designed to be append-only and self-describing: each row
 * carries enough identity (worker, runId, check) to be filtered, sorted, and
 * trended without re-reading the source transcript.
 */
export interface CheckScore {
  /** Worker that produced the transcript, e.g. "sentinel". */
  worker: string;
  /**
   * Stable run identifier — the transcript filename without extension,
   * e.g. "2026-06-08-1815". Combined with `worker` this uniquely keys a run.
   */
  runId: string;
  /** Run start ISO-8601 timestamp (from the transcript identity). */
  startedAt: string;
  /** Run start Unix-ms (for cheap numeric sorting / windowing). */
  startedAtMs: number;
  /** The check that produced this score. */
  check: CheckName;
  /** Independence tier of the check (1 = deterministic, 2 = heuristic). */
  tier: ScoreTier;
  /**
   * Normalized score in [0, 1] where 1 is best. For pass/fail style checks
   * (e.g. staleness) this is 1 for pass and a graded penalty otherwise, so
   * trends are still meaningful.
   */
  score: number;
  /** Verdict derived from the score + the check's own pass criteria. */
  status: ScoreStatus;
  /** Short human-readable explanation of the score. */
  summary: string;
  /** Optional structured detail (counts, sub-scores) for debugging/trends. */
  detail?: Record<string, number | string | boolean>;
  /** Source transcript path, if known. */
  source?: string;
  /** When this score row was computed (ISO-8601). */
  scoredAt: string;
}

/**
 * All scores for a single transcript plus a roll-up. The roll-up is a cheap
 * aggregate so callers don't have to re-reduce the rows.
 */
export interface TranscriptScore {
  /** Worker name. */
  worker: string;
  /** Run identifier (filename stem). */
  runId: string;
  /** Run start ISO-8601. */
  startedAt: string;
  /** Run start Unix-ms. */
  startedAtMs: number;
  /** Self-reported outcome from the transcript (`pass`/`fail`/…). */
  reportedOutcome: string;
  /** Per-check rows. */
  checks: CheckScore[];
  /** Mean of all non-skipped check scores in [0, 1]. NaN if all skipped. */
  overall: number;
  /** Worst (minimum) non-skipped check score in [0, 1]. NaN if all skipped. */
  worst: number;
  /** Number of checks that failed. */
  failCount: number;
  /** Number of checks that warned. */
  warnCount: number;
  /** Source transcript path, if known. */
  source?: string;
}

/** Tunables for the historical scorer. */
export interface ScoreTranscriptOptions {
  /**
   * Worker-specific maximum run duration (ms) used by the staleness timeout
   * check. If omitted, no timeout penalty is applied (staleness still scores
   * gaps, missing-output, abandonment). Pass a map keyed by worker name to set
   * per-worker budgets, or a single number to apply one budget to all.
   */
  timeoutMs?: number | Readonly<Record<string, number>>;
  /**
   * Minimum word count expected in the combined deliverables (actions +
   * key-outputs). Below this, completeness is penalized. Default: 20.
   */
  minOutputWords?: number;
  /** Override for the timestamp recorded on score rows (testing). */
  now?: Date;
  /**
   * Optional GROUND-TRUTH run metadata from the orchestrator (cron/process
   * status), keyed independently of the transcript's self-report. When
   * supplied, the `verification` check cross-checks the transcript's claims
   * (outcome, completion, duration) against this trusted record and flags
   * mismatches — e.g. a transcript that says `pass` for a run the orchestrator
   * recorded as `error`, or a self-reported duration that disagrees with the
   * measured wall-clock. When omitted, the verification check is skipped
   * (transcript self-report is all that's available).
   *
   * Pass a single {@link RunMetadata} (applied to the scored transcript) or a
   * map keyed by runId (`<filename without .md>`) for batch scoring.
   */
  runMetadata?: RunMetadata | Readonly<Record<string, RunMetadata>>;
}

/**
 * Ground-truth metadata about a run, captured by the orchestrator rather than
 * self-reported by the agent. This is the trustworthy side-channel the
 * `verification` check grades the transcript against.
 */
export interface RunMetadata {
  /** Trusted run status from the orchestrator. */
  exitStatus?: 'ok' | 'error' | 'timeout' | 'killed' | 'running';
  /** Trusted wall-clock start (ISO-8601 or epoch ms). */
  startedAt?: string | number;
  /** Trusted wall-clock end (ISO-8601 or epoch ms). Absent => still running. */
  endedAt?: string | number;
  /** Trusted measured duration (ms). If omitted, derived from start/end. */
  durationMs?: number;
  /** Process exit code, when known (0 == success). */
  exitCode?: number;
}
