/**
 * Timeline Bridge - convert parsed transcripts into the existing
 * {@link RunTimeline} shape used by `src/checks/staleness.ts`.
 *
 * This is the glue that turns "Phase 3.5 - parse a markdown file" into "score
 * an existing transcript with Tier 1 staleness checks". One bridge function,
 * one helper to apply default thresholds.
 *
 * Why a separate module? Keeping this in `transcript-reader.ts` would couple
 * the parser to the staleness types. Keeping it in `staleness.ts` would make
 * `staleness.ts` know about transcripts. A bridge is the right shape.
 *
 * @tier 1 - Deterministic
 * @module
 */

import type { RunEvent, RunTimeline } from '../checks/staleness.js';

import type { Transcript } from './types.js';

// ─── PUBLIC API ────────────────────────────────────────────────────────────────

/** Options for {@link transcriptToTimeline}. */
export interface TimelineBridgeOptions {
  /** Maximum allowed run duration (ms) for downstream timeout checks. */
  timeoutMs?: number;
  /**
   * Whether to synthesize one event per action item. Default: true. Setting
   * this off produces a minimal timeline with only start/end events, which is
   * useful for tests that only care about durations.
   */
  expandActions?: boolean;
  /**
   * Whether to emit a synthetic 'error' event when {@link Transcript.hadErrors}
   * is true. Default: true.
   *
   * Note: a synthetic error event is only emitted for runs that did NOT
   * complete successfully. Errors documented under an `## Errors & Retries`
   * section of a run that still reported `pass`/`success` are *recovered*
   * errors, not live failures, and must not be surfaced as an error event
   * (doing so false-flags healthy runs as stale). See {@link transcriptToTimeline}.
   */
  emitErrorEvent?: boolean;
}

/**
 * Convert a {@link Transcript} into a {@link RunTimeline} suitable for the
 * existing Tier 1 staleness, timeout, and abandonment checks.
 *
 * - `startedAt` / `endedAt` come from the transcript identity + parsed
 *   duration.
 * - `events` contains a synthetic per-action event sequence so gap-based
 *   detectors have something to look at. Action timestamps are evenly
 *   distributed across the run window - we do not have per-step timing in
 *   the transcript format, so even spacing is the correct neutral choice.
 * - `output` is set to the transcript's `Key Outputs` section if present,
 *   so abandonment checks for unbalanced code / TODO markers run against
 *   the actual deliverables description.
 */
export function transcriptToTimeline(
  transcript: Transcript,
  options: TimelineBridgeOptions = {},
): RunTimeline {
  const expandActions = options.expandActions ?? true;
  const emitErrorEvent = options.emitErrorEvent ?? true;

  const startedAt = transcript.identity.startedAt || transcript.identity.startedAtMs;
  const endedAt = transcript.endedAt;
  const startMs = transcript.identity.startedAtMs;
  const endMs = Number.isFinite(transcript.endedAtMs)
    ? transcript.endedAtMs
    : Number.isFinite(startMs)
      ? startMs
      : Number.NaN;

  const events: RunEvent[] = [];
  if (Number.isFinite(startMs)) {
    events.push({
      timestamp: new Date(startMs).toISOString(),
      type: 'start',
      content: transcript.title || `${transcript.identity.worker} run`,
    });
  }

  if (
    expandActions &&
    transcript.actionItems.length > 0 &&
    Number.isFinite(startMs) &&
    Number.isFinite(endMs)
  ) {
    const span = Math.max(0, endMs - startMs);
    const n = transcript.actionItems.length;
    // Distribute actions evenly across the (start, end) interval, exclusive
    // of both endpoints so they do not collide with start/end events.
    for (let i = 0; i < n; i += 1) {
      const fraction = (i + 1) / (n + 1);
      const ts = startMs + Math.round(span * fraction);
      const item = transcript.actionItems[i] ?? '';
      events.push({
        timestamp: new Date(ts).toISOString(),
        type: 'output',
        content: truncate(item, 280),
      });
    }
  }

  // Emit a synthetic error event only when the run had errors AND did not
  // complete successfully. Recovered errors (hadErrors=true but outcome=pass)
  // are documented hiccups the run worked through, not live failures —
  // surfacing them as an error event false-flags healthy runs as stale.
  const completedOk = transcript.outcome === 'pass';
  if (emitErrorEvent && transcript.hadErrors && !completedOk && Number.isFinite(endMs)) {
    events.push({
      timestamp: new Date(endMs - 1).toISOString(),
      type: 'error',
      content: truncate(transcript.errors, 280),
    });
  }

  if (Number.isFinite(endMs) && transcript.outcome !== 'unknown') {
    events.push({
      timestamp: new Date(endMs).toISOString(),
      type: 'end',
      content: transcript.outcome,
    });
  }

  const timeline: RunTimeline = {
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    events,
    ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
    ...(transcript.keyOutputs ? { output: transcript.keyOutputs } : {}),
  };

  return timeline;
}

// ─── INTERNAL ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (!s) return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
