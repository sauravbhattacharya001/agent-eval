/**
 * Timeout/Staleness Detector - type vocabulary.
 *
 * The shared types for the Tier 1 staleness/timeout detector: the run
 * timeline model (events + timeout budget), the per-check option bags, and
 * the analysis result/issue shapes. This module is **logic-free** (no runtime
 * code, no regex tables) so the type contract has a single home and can be
 * imported without pulling in the detection engine.
 *
 * Re-exported from `./staleness.js` so consumers keep one import path.
 *
 * @tier 1 - Deterministic
 * @module
 */

// ─── TYPES ──────────────────────────────────────────────────────────────────────

/** A timestamped event from an agent run. */
export interface RunEvent {
  /** ISO-8601 timestamp or Unix ms. */
  timestamp: string | number;
  /** Event type/label. */
  type: 'start' | 'output' | 'tool_call' | 'tool_result' | 'end' | 'heartbeat' | 'error' | string;
  /** Optional content or description of the event. */
  content?: string;
}

/** Timeline of an agent run for staleness analysis. */
export interface RunTimeline {
  /** When the run started. */
  startedAt: string | number;
  /** When the run ended (if it did). */
  endedAt?: string | number;
  /** Ordered events within the run. */
  events?: RunEvent[];
  /** Maximum allowed duration in ms. */
  timeoutMs?: number;
  /** The final output text (optional — for content-based abandonment detection). */
  output?: string;
}

/** Options for timeout detection. */
export interface TimeoutOptions {
  /** Maximum allowed duration in ms. Overrides timeline.timeoutMs if set. */
  maxDurationMs?: number;
  /** Grace period after timeout before declaring failure (ms). Default: 0. */
  gracePeriodMs?: number;
}

/** Options for staleness detection. */
export interface StalenessOptions {
  /** Maximum gap between events before declaring stale (ms). Default: 300000 (5 min). */
  maxGapMs?: number;
  /** Minimum events expected for the run to be considered active. Default: 2. */
  minEvents?: number;
  /** Whether a missing end event means the run was abandoned. Default: true. */
  requireEndEvent?: boolean;
}

/** Options for abandonment detection in output text. */
export interface AbandonmentOptions {
  /** Custom abandonment marker patterns. Added to built-in patterns. */
  customPatterns?: RegExp[];
  /** Whether to check for incomplete sentences at the end. Default: true. */
  checkIncompleteSentence?: boolean;
  /** Whether to check for TODO/placeholder markers. Default: true. */
  checkTodoMarkers?: boolean;
  /** Whether to check for mid-code truncation (unbalanced brackets). Default: true. */
  checkUnbalancedCode?: boolean;
  /** Minimum output length to apply abandonment checks. Default: 10. */
  minLengthForCheck?: number;
}

/** Options for progress analysis. */
export interface ProgressOptions {
  /** Minimum expected output events (non-heartbeat). Default: 1. */
  minOutputEvents?: number;
  /** Maximum consecutive heartbeat-only events before flagging stall. Default: 5. */
  maxConsecutiveHeartbeats?: number;
  /** Whether to require content growth across events. Default: false. */
  requireContentGrowth?: boolean;
}

/** Result from staleness analysis. */
export interface StalenessResult {
  /** Whether the run is considered stale/timed-out/abandoned. */
  isStale: boolean;
  /** Specific issues detected. */
  issues: StalenessIssue[];
  /** Computed run duration in ms (NaN if start is missing). */
  durationMs: number;
  /** Longest gap between events (ms). NaN if fewer than 2 events. */
  longestGapMs: number;
  /** Number of events with actual output content. */
  outputEventCount: number;
  /** Whether the run has an end event. */
  hasEndEvent: boolean;
  /** Human-readable summary. */
  summary: string;
}

/** A specific staleness issue detected. */
export interface StalenessIssue {
  /** Issue category. */
  kind: 'timeout' | 'stale_gap' | 'no_output' | 'abandoned' | 'no_progress' | 'no_end';
  /** Human-readable description. */
  message: string;
  /** Severity: error means definitely broken, warning means likely broken. */
  severity: 'error' | 'warning';
  /** Evidence for the issue. */
  evidence?: string;
}
