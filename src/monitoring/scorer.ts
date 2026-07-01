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
 *     CheckScore[]  (staleness, completeness, verification, …)
 *        │
 *        ▼  appendScores / writeScoresFor (scores-store.ts)
 *     transcripts/<worker>/scores.jsonl
 *
 * Module layout (this file is the orchestration surface; the pieces it drives
 * live alongside it, re-exported here so consumers keep one import path at
 * `./scorer.js`):
 *
 *   - `./scorer-types.js`  — the type vocabulary ({@link CheckScore},
 *                            {@link TranscriptScore}, {@link ScoreTranscriptOptions},
 *                            {@link RunMetadata}, …). Only types, no logic.
 *   - `./scorer-checks.js` — the pure per-check engine ({@link scoreStaleness},
 *                            {@link scoreVerification}, {@link scoreCompleteness})
 *                            plus the option-resolution helpers and default
 *                            budgets. No IO, no clock beyond what it's handed.
 *   - this file            — resolves options, assembles the {@link CheckScore}
 *                            rows, and computes the roll-up ({@link scoreTranscript},
 *                            {@link scoreTranscripts}, {@link toScoreRows}).
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 * @module
 */

import {
  DEFAULT_MIN_OUTPUT_WORDS,
  resolveRunMetadata,
  resolveTimeout,
  scoreCompleteness,
  scoreStaleness,
  scoreVerification,
} from './scorer-checks.js';
import type {
  CheckScore,
  ScoreTranscriptOptions,
  TranscriptScore,
} from './scorer-types.js';
import type { Transcript } from './types.js';

// Re-export the type vocabulary so consumers keep a single import path at
// `./scorer.js` and never have to reach into `./scorer-types.js` directly.
export type {
  ScoreTier,
  ScoreStatus,
  CheckName,
  CheckScore,
  TranscriptScore,
  ScoreTranscriptOptions,
  RunMetadata,
} from './scorer-types.js';

/**
 * Score one parsed transcript with all Tier 1 + Tier 2 historical checks.
 *
 * Returns a {@link TranscriptScore} containing one {@link CheckScore} per check
 * plus a roll-up. Checks that cannot run (e.g. completeness with no deliverables) are
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
  const meta = resolveRunMetadata(runId, worker, options.runMetadata);
  const verification = scoreVerification(transcript, meta);

  const checks: CheckScore[] = [
    { ...base, check: 'staleness', tier: 1, ...stale },
    { ...base, check: 'completeness', tier: 1, ...complete },
    { ...base, check: 'verification', tier: 1, ...verification },
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
