/**
 * Timeout/Staleness Detector - detection engine.
 *
 * The pure, deterministic core of the staleness check: timestamp parsing and
 * formatting, the per-timeline detectors (timeout, activity-gap staleness,
 * progress/stall) plus the combined `analyzeStaleness` roll-up. The static
 * pattern tables + code-balance helper live in `./staleness-patterns.js`, and
 * the output-text abandonment detector in `./staleness-abandonment.js`; both are
 * re-exported here so consumers keep a single import surface.
 *
 * No filesystem or network access - it operates only on the {@link RunTimeline}
 * and output text it is handed. The assertion factories that wrap these into
 * Jest/Vitest-style assertions live in `./staleness.js`, which re-exports this
 * module so consumers keep a single `./staleness.js` import path.
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  RunEvent,
  RunTimeline,
  TimeoutOptions,
  StalenessOptions,
  AbandonmentOptions,
  ProgressOptions,
  StalenessResult,
  StalenessIssue,
} from './staleness-types.js';
import { detectAbandonment } from './staleness-abandonment.js';

// Re-export the pattern tables + code-balance helper and the abandonment
// detector so `./staleness-detection.js` remains a single import surface.
export { ABANDONMENT_PATTERNS, STALL_PATTERNS, detectUnbalancedCode } from './staleness-patterns.js';
export { detectAbandonment } from './staleness-abandonment.js';

// ─── UTILITY FUNCTIONS ──────────────────────────────────────────────────────────

/**
 * Parse a timestamp (ISO-8601 string or Unix ms number) to ms since epoch.
 * Returns NaN for invalid timestamps.
 */
export function parseTimestamp(ts: string | number): number {
  if (typeof ts === 'number') {
    return ts;
  }
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? NaN : parsed;
}

/**
 * Format a duration in ms to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (Number.isNaN(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Detect timeout: did the run exceed its time budget?
 */
export function detectTimeout(timeline: RunTimeline, options: TimeoutOptions = {}): StalenessIssue | null {
  const maxDuration = options.maxDurationMs ?? timeline.timeoutMs;
  if (maxDuration === undefined) return null;

  const startMs = parseTimestamp(timeline.startedAt);
  if (Number.isNaN(startMs)) return null;

  let endMs: number;
  if (timeline.endedAt !== undefined) {
    endMs = parseTimestamp(timeline.endedAt);
    if (Number.isNaN(endMs)) return null;
  } else if (timeline.events && timeline.events.length > 0) {
    // Use the last event as a proxy for end time
    const lastEvt = timeline.events[timeline.events.length - 1];
    if (!lastEvt) return null;
    endMs = parseTimestamp(lastEvt.timestamp);
    if (Number.isNaN(endMs)) return null;
  } else {
    return null; // Cannot determine duration
  }

  const durationMs = endMs - startMs;
  const effectiveTimeout = maxDuration + (options.gracePeriodMs ?? 0);

  if (durationMs > effectiveTimeout) {
    return {
      kind: 'timeout',
      severity: 'error',
      message: `Run exceeded timeout: ${formatDuration(durationMs)} (limit: ${formatDuration(maxDuration)}${options.gracePeriodMs ? ` + ${formatDuration(options.gracePeriodMs)} grace` : ''})`,
      evidence: `Started: ${timeline.startedAt}, Duration: ${formatDuration(durationMs)}, Limit: ${formatDuration(maxDuration)}`,
    };
  }

  return null;
}

/**
 * Detect staleness: large gaps between events indicating the agent went idle.
 */
export function detectStaleness(timeline: RunTimeline, options: StalenessOptions = {}): StalenessIssue[] {
  const { maxGapMs = 300_000, minEvents = 2, requireEndEvent = true } = options;
  const issues: StalenessIssue[] = [];

  const events = timeline.events ?? [];

  // Check minimum event count
  if (events.length < minEvents) {
    issues.push({
      kind: 'no_output',
      severity: 'error',
      message: `Run produced only ${events.length} event(s) (minimum expected: ${minEvents}). Agent may not have started properly.`,
      evidence: `Event count: ${events.length}, minimum: ${minEvents}`,
    });
  }

  // Check for gaps between events
  if (events.length >= 2) {
    for (let i = 1; i < events.length; i++) {
      const prevEvent = events[i - 1];
      const currEvent = events[i];
      if (!prevEvent || !currEvent) continue;
      const prevMs = parseTimestamp(prevEvent.timestamp);
      const currMs = parseTimestamp(currEvent.timestamp);
      if (Number.isNaN(prevMs) || Number.isNaN(currMs)) continue;

      const gap = currMs - prevMs;
      if (gap > maxGapMs) {
        issues.push({
          kind: 'stale_gap',
          severity: 'warning',
          message: `${formatDuration(gap)} gap between events ${i - 1} and ${i} (max allowed: ${formatDuration(maxGapMs)})`,
          evidence: `Event ${i - 1} (${prevEvent.type}) at ${prevEvent.timestamp} → Event ${i} (${currEvent.type}) at ${currEvent.timestamp}`,
        });
      }
    }
  }

  // Check for missing end event
  if (requireEndEvent) {
    const hasEnd = events.some(e => e.type === 'end') || timeline.endedAt !== undefined;
    if (!hasEnd && events.length > 0) {
      const lastEvent = events[events.length - 1];
      issues.push({
        kind: 'no_end',
        severity: 'warning',
        message: 'Run has no end event — may have been abandoned or killed.',
        evidence: `Last event: ${lastEvent ? `${lastEvent.type} at ${lastEvent.timestamp}` : 'none'}`,
      });
    }
  }

  return issues;
}

/**
 * Analyze progress within a run timeline.
 */
export function analyzeProgress(timeline: RunTimeline, options: ProgressOptions = {}): StalenessIssue[] {
  const {
    minOutputEvents = 1,
    maxConsecutiveHeartbeats = 5,
    requireContentGrowth = false,
  } = options;

  const events = timeline.events ?? [];
  const issues: StalenessIssue[] = [];

  // Count meaningful output events
  const outputEvents = events.filter(e =>
    e.type === 'output' || e.type === 'tool_call' || e.type === 'tool_result'
  );

  if (outputEvents.length < minOutputEvents) {
    issues.push({
      kind: 'no_progress',
      severity: 'error',
      message: `Run produced only ${outputEvents.length} output event(s) (minimum: ${minOutputEvents}). Agent may have stalled.`,
      evidence: `Output events: ${outputEvents.length}, heartbeats: ${events.filter(e => e.type === 'heartbeat').length}`,
    });
  }

  // Check for consecutive heartbeat-only runs (stall detection)
  let consecutiveHeartbeats = 0;
  let maxConsecutiveSeen = 0;

  for (const event of events) {
    if (event.type === 'heartbeat') {
      consecutiveHeartbeats++;
      maxConsecutiveSeen = Math.max(maxConsecutiveSeen, consecutiveHeartbeats);
    } else {
      consecutiveHeartbeats = 0;
    }
  }

  if (maxConsecutiveSeen > maxConsecutiveHeartbeats) {
    issues.push({
      kind: 'no_progress',
      severity: 'warning',
      message: `${maxConsecutiveSeen} consecutive heartbeat events with no output (max allowed: ${maxConsecutiveHeartbeats}). Agent appears stalled.`,
      evidence: `Longest heartbeat-only streak: ${maxConsecutiveSeen}`,
    });
  }

  // Check for content growth if required
  if (requireContentGrowth && outputEvents.length >= 2) {
    const contentLengths = outputEvents
      .filter((e): e is RunEvent & { content: string } => e.content !== undefined)
      .map(e => e.content.length);

    if (contentLengths.length >= 2) {
      // Check if later outputs are longer than earlier ones
      const growing = contentLengths.slice(1).some((len, i) => len > (contentLengths[i] ?? 0));
      if (!growing) {
        issues.push({
          kind: 'no_progress',
          severity: 'warning',
          message: 'Output content is not growing across events — agent may be stuck in a loop.',
          evidence: `Content lengths: [${contentLengths.join(', ')}]`,
        });
      }
    }
  }

  return issues;
}

/**
 * Run a full staleness analysis on a run timeline.
 *
 * Combines timeout, staleness gap, abandonment, and progress checks.
 */
export function analyzeStaleness(
  timeline: RunTimeline,
  options: {
    timeout?: TimeoutOptions;
    staleness?: StalenessOptions;
    abandonment?: AbandonmentOptions;
    progress?: ProgressOptions;
  } = {},
): StalenessResult {
  const issues: StalenessIssue[] = [];
  const events = timeline.events ?? [];

  // Timeout check
  const timeoutIssue = detectTimeout(timeline, options.timeout);
  if (timeoutIssue) issues.push(timeoutIssue);

  // Staleness gap check
  issues.push(...detectStaleness(timeline, options.staleness));

  // Abandonment markers in output
  if (timeline.output) {
    issues.push(...detectAbandonment(timeline.output, options.abandonment));
  }

  // Progress analysis
  issues.push(...analyzeProgress(timeline, options.progress));

  // Compute metrics
  const startMs = parseTimestamp(timeline.startedAt);
  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const endMs = timeline.endedAt !== undefined
    ? parseTimestamp(timeline.endedAt)
    : lastEvent
      ? parseTimestamp(lastEvent.timestamp)
      : NaN;

  const durationMs = (!Number.isNaN(startMs) && !Number.isNaN(endMs)) ? endMs - startMs : NaN;

  // Longest gap
  let longestGapMs = NaN;
  if (events.length >= 2) {
    longestGapMs = 0;
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      if (!prev || !curr) continue;
      const prevMs = parseTimestamp(prev.timestamp);
      const currMs = parseTimestamp(curr.timestamp);
      if (!Number.isNaN(prevMs) && !Number.isNaN(currMs)) {
        longestGapMs = Math.max(longestGapMs, currMs - prevMs);
      }
    }
  }

  const outputEventCount = events.filter(e =>
    e.type === 'output' || e.type === 'tool_call' || e.type === 'tool_result'
  ).length;

  const hasEndEvent = events.some(e => e.type === 'end') || timeline.endedAt !== undefined;

  const isStale = issues.some(i => i.severity === 'error') || issues.length >= 3;

  // Build summary
  const summaryParts: string[] = [];
  if (!Number.isNaN(durationMs)) summaryParts.push(`Duration: ${formatDuration(durationMs)}`);
  summaryParts.push(`Events: ${events.length} (${outputEventCount} output)`);
  if (!Number.isNaN(longestGapMs)) summaryParts.push(`Longest gap: ${formatDuration(longestGapMs)}`);
  summaryParts.push(`Issues: ${issues.length} (${issues.filter(i => i.severity === 'error').length} errors, ${issues.filter(i => i.severity === 'warning').length} warnings)`);
  summaryParts.push(`Verdict: ${isStale ? 'STALE' : 'OK'}`);

  return {
    isStale,
    issues,
    durationMs,
    longestGapMs,
    outputEventCount,
    hasEndEvent,
    summary: summaryParts.join(' | '),
  };
}
