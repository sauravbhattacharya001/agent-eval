/**
 * Historical Scorer — Phase 3.5 Production Monitoring
 *
 * Runs the existing Tier 1 + Tier 2 checks against a parsed {@link Transcript}
 * and produces a flat list of {@link CheckScore} rows — one per check. These
 * rows are what the trend detector and weekly scorecard build on, and what
 * gets persisted to `transcripts/<worker>/scores.jsonl`.
 *
 * Why score saved transcripts at all? The whole point of agent-eval is that
 * research-time safety ≠ runtime safety. A worker can pass every check the day
 * it ships and silently rot three weeks later (completeness dropping, durations
 * spiking, error rate climbing). Scoring the historical record turns "looks
 * fine" into a measurable signal.
 *
 * Independence note (the framework's core axis is independent → corruptible):
 * every check used here is Tier 1 or Tier 2. The transcript is an artifact the
 * worker wrote, but the *scoring* of it is done by deterministic parsers and
 * heuristics the worker never touched. We deliberately do NOT invoke any
 * Tier 3 model-as-judge check here — historical scoring must be reproducible,
 * offline, and free of shared-substrate judgement. Trend lines you can't
 * reproduce are worse than no trend lines.
 *
 * Pipeline shape:
 *
 *     Transcript
 *        │
 *        ▼  scoreTranscript
 *     CheckScore[]  (staleness, completeness, relevance, keyword-coverage, …)
 *        │
 *        ▼  appendScores / writeScoresFor (scores-store.ts)
 *     transcripts/<worker>/scores.jsonl
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import { checkCompleteness } from '../checks/completeness.js';
import type { KeywordCoverageScoringOptions } from '../checks/keyword-coverage.js';
import { scoreKeywordCoverage } from '../checks/keyword-coverage.js';
import type { RelevanceOptions } from '../checks/relevance.js';
import { analyzeRelevance } from '../checks/relevance.js';
import { analyzeStaleness, formatDuration } from '../checks/staleness.js';

import { transcriptToTimeline } from './timeline-bridge.js';
import type { Transcript } from './types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** Tier of the check that produced a score. Mirrors the framework hierarchy. */
export type ScoreTier = 1 | 2;

/** Pass/fail/marginal verdict for a single check. */
export type ScoreStatus = 'pass' | 'fail' | 'warn' | 'skip';

/** Canonical check identifiers the historical scorer emits. */
export type CheckName =
  | 'staleness'
  | 'completeness'
  | 'relevance'
  | 'keyword-coverage';

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
  /** Relevance threshold to count as a pass. Default: 0.12 (transcripts are terse). */
  relevanceThreshold?: number;
  /** Keyword-coverage threshold to count as a pass. Default: 0.4. */
  coverageThreshold?: number;
  /** Override for the timestamp recorded on score rows (testing). */
  now?: Date;
  /** Extra relevance options forwarded to {@link analyzeRelevance}. */
  relevanceOptions?: RelevanceOptions;
  /** Extra keyword-coverage options forwarded to {@link scoreKeywordCoverage}. */
  keywordOptions?: KeywordCoverageScoringOptions;
}

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

const DEFAULT_MIN_OUTPUT_WORDS = 20;
const DEFAULT_RELEVANCE_THRESHOLD = 0.12;
const DEFAULT_COVERAGE_THRESHOLD = 0.4;

/** Default per-worker timeout budgets (ms). Conservative, used only if caller
 * does not supply their own. These mirror the cron cadence headroom — a run
 * that blows well past these is genuinely anomalous, not just slow. */
const DEFAULT_TIMEOUT_BUDGETS: Readonly<Record<string, number>> = {
  builder: 60 * 60_000,
  gardener: 60 * 60_000,
  sentinel: 45 * 60_000,
  eval: 45 * 60_000,
  blog: 45 * 60_000,
  tempcheck: 20 * 60_000,
  scrubme: 20 * 60_000,
};

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
function resolveTimeout(
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
function scoreStaleness(
  t: Transcript,
  timeoutMs: number | undefined,
): { score: number; status: ScoreStatus; summary: string; detail: Record<string, number | string | boolean> } {
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
 * Score completeness of the deliverables (actions + key outputs). Uses the
 * Tier 1 structural checker. The score is `1 - errorPenalty - warningPenalty`,
 * so a transcript with an empty/stub deliverables section scores near 0 while a
 * substantive one scores 1.
 */
function scoreCompleteness(
  t: Transcript,
  minWords: number,
): { score: number; status: ScoreStatus; summary: string; detail: Record<string, number | string | boolean> } {
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

/**
 * Score how relevant the deliverables are to the stated task using the Tier 2
 * TF-IDF cosine relevance check. Offline, no LLM. The normalized score is the
 * cosine similarity itself (already in [0, 1]); status compares it to the
 * threshold.
 *
 * Skipped when the transcript has no `## Task` section — relevance is undefined
 * without a reference point, and we never fabricate one.
 */
function scoreRelevance(
  t: Transcript,
  threshold: number,
  options: RelevanceOptions | undefined,
): { score: number; status: ScoreStatus; summary: string; detail: Record<string, number | string | boolean> } {
  const task = t.task.trim();
  const output = deliverables(t);

  if (!task || !output) {
    return {
      score: 0,
      status: 'skip',
      summary: !task ? 'no task section to compare against' : 'no deliverables to compare',
      detail: { skipped: true },
    };
  }

  const result = analyzeRelevance(task, output, { threshold, ...options });
  const score = clamp01(result.score);
  const status: ScoreStatus = result.relevant ? 'pass' : score >= threshold * 0.6 ? 'warn' : 'fail';
  const top = result.sharedTerms.slice(0, 3).map((s) => s.term).join(', ');

  return {
    score,
    status,
    summary: result.relevant
      ? `on-task (sim=${score.toFixed(2)}${top ? `, shared: ${top}` : ''})`
      : `low relevance (sim=${score.toFixed(2)}, threshold=${threshold})`,
    detail: {
      similarity: Number(score.toFixed(4)),
      threshold,
      sharedTerms: result.sharedTerms.length,
      missingTerms: result.missingTerms.length,
    },
  };
}

/**
 * Score keyword coverage — did the deliverables actually touch the key topics
 * the task implies? Tier 2 automatic topic extraction, no hand-written keyword
 * lists. Skipped without a task section, same rationale as relevance.
 */
function scoreCoverage(
  t: Transcript,
  threshold: number,
  options: KeywordCoverageScoringOptions | undefined,
): { score: number; status: ScoreStatus; summary: string; detail: Record<string, number | string | boolean> } {
  const task = t.task.trim();
  const output = deliverables(t);

  if (!task || !output) {
    return {
      score: 0,
      status: 'skip',
      summary: !task ? 'no task section to extract topics from' : 'no deliverables to score',
      detail: { skipped: true },
    };
  }

  const result = scoreKeywordCoverage(task, output, { minCoverage: threshold, ...options });
  const score = clamp01(result.score);
  const status: ScoreStatus = result.passing
    ? 'pass'
    : score >= threshold * 0.6
      ? 'warn'
      : 'fail';

  return {
    score,
    status,
    summary: result.passing
      ? `covered ${result.coveredCount}/${result.totalKeywords} key topics (${score.toFixed(2)})`
      : `missed topics: ${result.missedCount}/${result.totalKeywords} (${score.toFixed(2)} < ${threshold})`,
    detail: {
      coverage: Number(score.toFixed(4)),
      threshold,
      covered: result.coveredCount,
      missed: result.missedCount,
      total: result.totalKeywords,
    },
  };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────────

/**
 * Score one parsed transcript with all Tier 1 + Tier 2 historical checks.
 *
 * Returns a {@link TranscriptScore} containing one {@link CheckScore} per check
 * plus a roll-up. Checks that cannot run (e.g. relevance with no `## Task`) are
 * emitted with `status: 'skip'` and excluded from the roll-up rather than
 * silently dropped — a skipped check is information, not absence.
 *
 * @param transcript - Parsed transcript (from `parseTranscript` / `loadTranscript`).
 * @param options - Thresholds and per-worker timeout budgets.
 */
export function scoreTranscript(
  transcript: Transcript,
  options: ScoreTranscriptOptions = {},
): TranscriptScore {
  const {
    minOutputWords = DEFAULT_MIN_OUTPUT_WORDS,
    relevanceThreshold = DEFAULT_RELEVANCE_THRESHOLD,
    coverageThreshold = DEFAULT_COVERAGE_THRESHOLD,
    now = new Date(),
  } = options;

  const worker = String(transcript.identity.worker);
  const runId = transcript.identity.filename.replace(/\.md$/i, '');
  const startedAt = transcript.identity.startedAt;
  const startedAtMs = transcript.identity.startedAtMs;
  const scoredAt = now.toISOString();
  const timeoutMs = resolveTimeout(worker, options.timeoutMs);

  const base = {
    worker,
    runId,
    startedAt,
    startedAtMs,
    scoredAt,
    ...(transcript.source ? { source: transcript.source } : {}),
  };

  const stale = scoreStaleness(transcript, timeoutMs);
  const complete = scoreCompleteness(transcript, minOutputWords);
  const relevance = scoreRelevance(transcript, relevanceThreshold, options.relevanceOptions);
  const coverage = scoreCoverage(transcript, coverageThreshold, options.keywordOptions);

  const checks: CheckScore[] = [
    { ...base, check: 'staleness', tier: 1, ...stale },
    { ...base, check: 'completeness', tier: 1, ...complete },
    { ...base, check: 'relevance', tier: 2, ...relevance },
    { ...base, check: 'keyword-coverage', tier: 2, ...coverage },
  ];

  const scored = checks.filter((c) => c.status !== 'skip');
  const overall = scored.length > 0 ? scored.reduce((a, c) => a + c.score, 0) / scored.length : Number.NaN;
  const worst = scored.length > 0 ? Math.min(...scored.map((c) => c.score)) : Number.NaN;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return {
    worker,
    runId,
    startedAt,
    startedAtMs,
    reportedOutcome: transcript.outcome,
    checks,
    overall,
    worst,
    failCount,
    warnCount,
    ...(transcript.source ? { source: transcript.source } : {}),
  };
}

/**
 * Score a batch of transcripts. Thin convenience wrapper over
 * {@link scoreTranscript} that preserves input order.
 */
export function scoreTranscripts(
  transcripts: readonly Transcript[],
  options: ScoreTranscriptOptions = {},
): TranscriptScore[] {
  return transcripts.map((t) => scoreTranscript(t, options));
}

/**
 * Flatten a list of {@link TranscriptScore}s back into the raw {@link CheckScore}
 * rows, in the order they'd be appended to `scores.jsonl`. Useful for callers
 * that want the persistence shape without going through the store.
 */
export function toScoreRows(scores: readonly TranscriptScore[]): CheckScore[] {
  return scores.flatMap((s) => s.checks);
}
