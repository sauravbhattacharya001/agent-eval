/**
 * Historical Scorer — pure per-check engine (Phase 3.5 Production Monitoring)
 *
 * The individual Tier 1 + Tier 2 check scorers behind {@link scoreTranscript},
 * extracted so each is testable in isolation with no filesystem and only an
 * explicitly-passed clock. Everything here is a pure function of a parsed
 * {@link Transcript} (+ resolved options): given the same inputs it always
 * returns the same {@link CheckOutcome}.
 *
 * The orchestration that resolves options, assembles the {@link CheckScore}
 * rows, and computes the roll-up lives in `scorer.ts`; the persistence shape
 * lives in `scores-store.ts`. This file is the reproducible scoring core both
 * of them lean on.
 *
 * Independence note (the core axis is independent → corruptible): every check
 * here is Tier 1 or Tier 2. The transcript is an artifact the worker wrote, but
 * the *scoring* of it is done by deterministic parsers and heuristics the
 * worker never touched. No Tier 3 model-as-judge runs here — historical scoring
 * must be reproducible, offline, and free of shared-substrate judgement.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import { checkCompleteness } from '../checks/completeness.js';
import { analyzeStaleness, formatDuration } from '../checks/staleness.js';

import type { RunMetadata, ScoreStatus, ScoreTranscriptOptions } from './scorer-types.js';
import { transcriptToTimeline } from './timeline-bridge.js';
import type { Transcript, OutcomeStatus } from './types.js';

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

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────────

/** The deliverables text a transcript actually produced. */
function deliverables(t: Transcript): string {
  return [t.actions, t.keyOutputs].filter(Boolean).join('\n\n').trim();
}

/** Clamp a number into [0, 1]. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

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

/** Coerce an ISO string or epoch-ms value to epoch ms, or undefined. */
function toMs(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** The outcome a trusted exitStatus implies, for comparison with the self-report. */
function outcomeFromExitStatus(
  status: RunMetadata['exitStatus'],
  exitCode: number | undefined,
): OutcomeStatus | 'running' | undefined {
  if (status === 'ok') return 'pass';
  if (status === 'error' || status === 'timeout' || status === 'killed') return 'fail';
  if (status === 'running') return 'running';
  if (typeof exitCode === 'number') return exitCode === 0 ? 'pass' : 'fail';
  return undefined;
}

// ─── INDIVIDUAL CHECK SCORERS ─────────────────────────────────────────────────────

/**
 * Score staleness via the existing Tier 1 analyzer. We reuse
 * {@link transcriptToTimeline} so the historical path and the live path share
 * exactly one staleness implementation — no drift between "scored a transcript"
 * and "scored a live run".
 *
 * Scoring model: start at 1.0, subtract 0.5 per error issue and 0.15 per
 * warning, floored at 0. A run flagged `isStale` can still earn partial credit
 * if it only tripped a single warning, which keeps the trend line smooth.
 */
export function scoreStaleness(
  t: Transcript,
  timeoutMs: number | undefined,
): CheckOutcome {
  const timeline = transcriptToTimeline(t, timeoutMs !== undefined ? { timeoutMs } : {});
  // The transcript format has no per-step timing, so the bridge distributes
  // action events evenly across the run window. Those synthetic gaps are an
  // artifact of even spacing, not real idle periods — so we disable gap-based
  // staleness here (maxGapMs: Infinity). Every other signal stays active:
  // timeout (real duration vs budget), missing-output, missing-end, and
  // output-abandonment are all still meaningful on a summary transcript.
  const result = analyzeStaleness(timeline, {
    staleness: { maxGapMs: Number.POSITIVE_INFINITY },
  });

  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warnings = result.issues.filter((i) => i.severity === 'warning').length;

  const score = clamp01(1 - errors * 0.5 - warnings * 0.15);
  const status: ScoreStatus = result.isStale ? 'fail' : warnings > 0 ? 'warn' : 'pass';

  const summary = result.isStale
    ? `stale: ${result.issues.map((i) => i.kind).join(', ') || 'unknown'}`
    : warnings > 0
      ? `ok with ${warnings} warning(s)`
      : `ok (${formatDuration(result.durationMs)})`;

  return {
    score,
    status,
    summary,
    detail: {
      durationMs: Number.isFinite(result.durationMs) ? result.durationMs : -1,
      errors,
      warnings,
      outputEvents: result.outputEventCount,
      hasEnd: result.hasEndEvent,
    },
  };
}

/**
 * Cross-check the transcript's SELF-REPORTED claims against GROUND-TRUTH run
 * metadata from the orchestrator. This is the only check that can catch a
 * transcript that lies (or is simply wrong) about its own outcome/duration,
 * because every other check reads the same self-report it's grading.
 *
 * Skips (no score impact) when no metadata is supplied. Signals, worst-first:
 *  - outcome mismatch: transcript says `pass` but the run errored/was killed
 *    (or vice-versa) → hard fail. The single most valuable verification.
 *  - completion mismatch: transcript finished (pass/fail) but orchestrator says
 *    still running, or transcript is an IN-PROGRESS stub but the run ended.
 *  - duration discrepancy: self-reported duration disagrees with measured
 *    wall-clock by a wide margin → the agent's clock can't be trusted (warn).
 */
export function scoreVerification(
  t: Transcript,
  meta: RunMetadata | undefined,
): CheckOutcome {
  if (!meta) {
    return { score: 0, status: 'skip', summary: 'no run metadata supplied', detail: {} };
  }

  const detail: Record<string, number | string | boolean> = {};
  const problems: string[] = [];
  let errors = 0;
  let warnings = 0;

  const reported = t.outcome; // 'pass' | 'fail' | 'partial' | 'unknown'
  const truthOutcome = outcomeFromExitStatus(meta.exitStatus, meta.exitCode);
  if (meta.exitStatus) detail.exitStatus = meta.exitStatus;
  if (typeof meta.exitCode === 'number') detail.exitCode = meta.exitCode;
  detail.reportedOutcome = reported;

  // 1. Completion mismatch.
  const orchestratorRunning = truthOutcome === 'running';
  const transcriptFinished = reported === 'pass' || reported === 'fail' || reported === 'partial';
  if (orchestratorRunning && transcriptFinished) {
    warnings++;
    problems.push(`transcript reports "${reported}" but orchestrator says the run is still running`);
  }

  // 2. Outcome mismatch (the headline signal). Only when the run has finished
  //    and the transcript committed to a finished outcome.
  if (!orchestratorRunning && truthOutcome && transcriptFinished) {
    const reportedSuccess = reported === 'pass';
    const truthSuccess = truthOutcome === 'pass';
    if (reportedSuccess && !truthSuccess) {
      errors++;
      problems.push(
        `transcript claims "pass" but orchestrator recorded ${meta.exitStatus ?? `exit ${meta.exitCode}`} (failure)`,
      );
    } else if (!reportedSuccess && truthSuccess && reported === 'fail') {
      // Reported failure on a run the orchestrator saw succeed: less alarming
      // (honest under-reporting) but still a discrepancy worth flagging.
      warnings++;
      problems.push('transcript reports "fail" but orchestrator recorded success');
    }
    detail.truthOutcome = truthOutcome;
  }

  // 3. Duration honesty: self-reported vs measured wall-clock.
  const reportedMs = t.duration.ms;
  const measuredMs =
    meta.durationMs !== undefined && Number.isFinite(meta.durationMs)
      ? meta.durationMs
      : (() => {
          const s = toMs(meta.startedAt);
          const e = toMs(meta.endedAt);
          return s !== undefined && e !== undefined ? Math.max(0, e - s) : undefined;
        })();
  if (measuredMs !== undefined && Number.isFinite(reportedMs) && reportedMs > 0) {
    detail.reportedMs = reportedMs;
    detail.measuredMs = measuredMs;
    const ratio = reportedMs / measuredMs;
    // Flag when the self-report is off by >50% in either direction and the gap
    // is more than a token amount (avoid noise on very short runs).
    if ((ratio > 1.5 || ratio < 0.66) && Math.abs(reportedMs - measuredMs) > 60_000) {
      warnings++;
      problems.push(
        `self-reported duration (${formatDuration(reportedMs)}) disagrees with measured (${formatDuration(measuredMs)})`,
      );
    }
  } else if (measuredMs !== undefined) {
    detail.measuredMs = measuredMs;
  }

  detail.errors = errors;
  detail.warnings = warnings;

  const score = clamp01(1 - errors * 0.6 - warnings * 0.2);
  const status: ScoreStatus = errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  const summary =
    problems.length > 0
      ? problems.join('; ')
      : `verified against orchestrator (${meta.exitStatus ?? `exit ${meta.exitCode ?? '?'}`})`;

  return { score, status, summary, detail };
}

/**
 * Score completeness of the deliverables (actions + key outputs). Uses the
 * Tier 1 structural checker. The score is `1 - errorPenalty - warningPenalty`,
 * so a transcript with an empty/stub deliverables section scores near 0 while a
 * substantive one scores 1.
 */
export function scoreCompleteness(
  t: Transcript,
  minWords: number,
): CheckOutcome {
  const text = deliverables(t);

  if (!text) {
    return {
      score: 0,
      status: 'fail',
      summary: 'no deliverables (actions + key outputs both empty)',
      detail: { words: 0, errors: 1, warnings: 0 },
    };
  }

  const result = checkCompleteness(text, {
    length: { minWords },
  });

  const errors = result.violations.filter((v) => v.severity === 'error').length;
  const warnings = result.violations.filter((v) => v.severity === 'warning').length;
  const score = clamp01(1 - errors * 0.4 - warnings * 0.1);
  const status: ScoreStatus = result.complete ? (warnings > 0 ? 'warn' : 'pass') : 'fail';

  const summary = result.complete
    ? `complete (${result.metrics.wordCount}w${warnings > 0 ? `, ${warnings} warning(s)` : ''})`
    : `incomplete: ${result.violations
        .filter((v) => v.severity === 'error')
        .map((v) => v.message)
        .join('; ')}`;

  return {
    score,
    status,
    summary,
    detail: {
      words: result.metrics.wordCount,
      uniqueRatio: Number(result.metrics.uniqueWordRatio.toFixed(3)),
      errors,
      warnings,
    },
  };
}
