/**
 * Timeout/Staleness Detector — Tier 1 Deterministic Check
 *
 * Detects agent runs that timed out, went stale, or were abandoned:
 * - Timeout detection: did the run exceed its allocated time budget?
 * - Staleness detection: was output produced but then abandoned mid-task?
 * - Activity gap detection: long periods of inactivity within a run
 * - Abandonment markers: common patterns indicating premature termination
 * - Progress tracking: did the agent make forward progress or stall?
 *
 * All checks are deterministic — timestamp analysis and pattern matching with no AI.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

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

// ─── CONSTANTS ──────────────────────────────────────────────────────────────────

/** Built-in patterns that indicate an abandoned or interrupted output. */
const ABANDONMENT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\.\.\.$/, label: 'trailing ellipsis (incomplete thought)' },
  { pattern: /\[(?:TODO|FIXME|PLACEHOLDER|TBD|WIP)\]/i, label: 'TODO/placeholder marker' },
  { pattern: /(?:I'll|Let me|I will|I need to|I should|Next,? I)[\s\S]{0,30}$/, label: 'stated intent without follow-through' },
  { pattern: /```[\w]*\n[^`]*$/, label: 'unclosed code block' },
  { pattern: /<!--\s*[^>]*$/, label: 'unclosed HTML comment' },
  { pattern: /\n\s*[-*]\s*$/, label: 'empty list item at end' },
  { pattern: /(?:Step|Part|Section)\s+\d+[:.]\s*$/, label: 'empty section header at end' },
  { pattern: /\|\s*[-:]+\s*\|[\s\S]{0,5}$/, label: 'incomplete table' },
  { pattern: />\s*$/, label: 'empty blockquote at end' },
];

/** Patterns indicating a stalled/looping agent. */
const STALL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:error|failed|retry).*(?:error|failed|retry).*(?:error|failed|retry)/is, label: 'repeated errors (possible retry loop)' },
  { pattern: /(.{50,})\1{2,}/s, label: 'repeated content block' },
];

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
 * Detect abandonment markers in the output text.
 */
export function detectAbandonment(output: string, options: AbandonmentOptions = {}): StalenessIssue[] {
  const {
    customPatterns = [],
    checkIncompleteSentence = true,
    checkTodoMarkers = true,
    checkUnbalancedCode = true,
    minLengthForCheck = 10,
  } = options;

  if (output.length < minLengthForCheck) return [];

  const issues: StalenessIssue[] = [];
  const trimmed = output.trimEnd();

  // Check built-in abandonment patterns
  for (const { pattern, label } of ABANDONMENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output shows abandonment signal: ${label}`,
        evidence: `Matched pattern at end of output: "${trimmed.slice(-80)}"`,
      });
    }
  }

  // Check custom patterns
  for (const pattern of customPatterns) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output matches custom abandonment pattern: ${pattern.source}`,
        evidence: `Pattern: ${pattern.toString()}`,
      });
    }
  }

  // Check for incomplete sentence at the end
  if (checkIncompleteSentence) {
    // Get last non-empty line
    const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
    const lastLineRaw = lines[lines.length - 1];
    const lastLine = lastLineRaw ? lastLineRaw.trim() : '';
    if (lastLine.length > 0) {
      // Skip if it's a code block, heading, list marker, etc.
      const isStructural = /^[#>|`\-*\d]/.test(lastLine) || /^[\[\(]/.test(lastLine);
      if (!isStructural && lastLine.length > 15) {
        // Sentence should end with punctuation
        const endsWithPunctuation = /[.!?;:)\]"'`]$/.test(lastLine);
        if (!endsWithPunctuation) {
          issues.push({
            kind: 'abandoned',
            severity: 'warning',
            message: 'Output ends mid-sentence (no terminal punctuation)',
            evidence: `Last line: "${lastLine.slice(-60)}"`,
          });
        }
      }
    }
  }

  // Check for TODO markers embedded in the text
  if (checkTodoMarkers) {
    const todoPattern = /\b(?:TODO|FIXME|PLACEHOLDER|TBD|XXX|HACK)\b/gi;
    const matches = trimmed.match(todoPattern);
    if (matches && matches.length > 0) {
      issues.push({
        kind: 'abandoned',
        severity: 'warning',
        message: `Output contains ${matches.length} TODO/placeholder marker(s)`,
        evidence: `Found: ${[...new Set(matches)].join(', ')}`,
      });
    }
  }

  // Check for unbalanced code constructs
  if (checkUnbalancedCode) {
    const unbalanced = detectUnbalancedCode(trimmed);
    if (unbalanced) {
      issues.push({
        kind: 'abandoned',
        severity: 'error',
        message: `Output has unbalanced code: ${unbalanced}`,
        evidence: `Detected in output text (truncation mid-code)`,
      });
    }
  }

  // Check stall patterns
  for (const { pattern, label } of STALL_PATTERNS) {
    if (pattern.test(trimmed)) {
      issues.push({
        kind: 'no_progress',
        severity: 'warning',
        message: `Output shows stall signal: ${label}`,
        evidence: `Matched stall pattern in output`,
      });
    }
  }

  return issues;
}

/**
 * Detect unbalanced brackets/delimiters indicating code truncation.
 * Returns a description of the imbalance, or null if balanced.
 */
function detectUnbalancedCode(text: string): string | null {
  // Only check within code blocks or code-like content
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;
  const codeSegments: string[] = [];

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match[1] !== undefined) {
      codeSegments.push(match[1]);
    }
  }

  // If no code blocks, check the whole text only if it looks like code
  const textToCheck = codeSegments.length > 0
    ? codeSegments.join('\n')
    : (/[{}\[\]()]/.test(text) && /(?:function|class|const|let|var|if|for|while|import|export|def|fn)\b/.test(text) ? text : null);

  if (!textToCheck) return null;

  let braces = 0;
  let brackets = 0;
  let parens = 0;

  for (const ch of textToCheck) {
    switch (ch) {
      case '{': braces++; break;
      case '}': braces--; break;
      case '[': brackets++; break;
      case ']': brackets--; break;
      case '(': parens++; break;
      case ')': parens--; break;
    }
  }

  const issues: string[] = [];
  if (braces > 0) issues.push(`${braces} unclosed brace(s)`);
  if (braces < 0) issues.push(`${-braces} extra closing brace(s)`);
  if (brackets > 0) issues.push(`${brackets} unclosed bracket(s)`);
  if (brackets < 0) issues.push(`${-brackets} extra closing bracket(s)`);
  if (parens > 0) issues.push(`${parens} unclosed parenthesis(es)`);
  if (parens < 0) issues.push(`${-parens} extra closing parenthesis(es)`);

  return issues.length > 0 ? issues.join(', ') : null;
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

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert that a run completed within its timeout.
 *
 * Evaluates the output text for signs of timeout/staleness, but for full
 * timeline-based checking, use `toNotBeStale` with a RunTimeline.
 *
 * @param maxDurationMs - Maximum allowed duration in ms. Required.
 * @param startedAt - When the run started (ISO-8601 or Unix ms).
 * @param endedAt - When the run ended (ISO-8601 or Unix ms). Optional — uses current time if not provided.
 */
export function toCompleteWithinTimeout(
  maxDurationMs: number,
  startedAt: string | number,
  endedAt?: string | number,
): Assertion {
  return {
    name: 'completes within timeout',
    evaluate(_output: string): AssertionResult {
      const start = performance.now();
      const startMs = parseTimestamp(startedAt);
      const actualEndMs = endedAt !== undefined ? parseTimestamp(endedAt) : Date.now();

      if (Number.isNaN(startMs)) {
        return {
          status: 'error',
          name: 'completes within timeout',
          message: `Invalid start timestamp: ${startedAt}`,
          durationMs: performance.now() - start,
        };
      }

      if (Number.isNaN(actualEndMs)) {
        return {
          status: 'error',
          name: 'completes within timeout',
          message: `Invalid end timestamp: ${endedAt}`,
          durationMs: performance.now() - start,
        };
      }

      const durationMs = actualEndMs - startMs;
      if (durationMs > maxDurationMs) {
        return {
          status: 'fail',
          name: 'completes within timeout',
          message: `Run took ${formatDuration(durationMs)} (limit: ${formatDuration(maxDurationMs)})`,
          expected: `Duration ≤ ${formatDuration(maxDurationMs)}`,
          actual: formatDuration(durationMs),
          evidence: `Start: ${startedAt}, End: ${endedAt ?? 'now'}, Duration: ${formatDuration(durationMs)}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'completes within timeout',
        evidence: `Completed in ${formatDuration(durationMs)} (limit: ${formatDuration(maxDurationMs)})`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does not show signs of abandonment or premature termination.
 *
 * Checks for:
 * - Trailing ellipsis, unclosed code blocks, TODO markers
 * - Incomplete sentences, empty section headers
 * - Unbalanced code (truncated mid-function)
 *
 * @param options - Abandonment detection options.
 */
export function toNotBeAbandoned(options: AbandonmentOptions = {}): Assertion {
  return {
    name: 'not abandoned',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const issues = detectAbandonment(output, options);

      if (issues.length > 0) {
        const errors = issues.filter(i => i.severity === 'error');
        const warnings = issues.filter(i => i.severity === 'warning');

        // Only fail on errors, or on multiple warnings
        const shouldFail = errors.length > 0 || warnings.length >= 2;

        return {
          status: shouldFail ? 'fail' : 'pass',
          name: 'not abandoned',
          message: shouldFail
            ? `Output shows ${issues.length} abandonment signal(s): ${issues.map(i => i.message).join('; ')}`
            : undefined,
          evidence: issues.map(i => `[${i.severity}] ${i.message}`).join('\n'),
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'not abandoned',
        evidence: 'No abandonment markers detected',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that a run timeline does not show staleness (gaps, no output, no end).
 *
 * Full timeline-based analysis combining timeout, gap, and progress checks.
 *
 * @param timeline - The run timeline to analyze.
 * @param options - Configuration for all staleness sub-checks.
 */
export function toNotBeStale(
  timeline: RunTimeline,
  options: {
    timeout?: TimeoutOptions;
    staleness?: StalenessOptions;
    progress?: ProgressOptions;
  } = {},
): Assertion {
  return {
    name: 'not stale',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const fullTimeline: RunTimeline = { ...timeline, output };
      const result = analyzeStaleness(fullTimeline, options);

      if (result.isStale) {
        return {
          status: 'fail',
          name: 'not stale',
          message: `Run is stale: ${result.issues.map(i => i.message).join('; ')}`,
          expected: 'Active, progressing run',
          actual: result.summary,
          evidence: result.issues.map(i => `[${i.severity}] ${i.kind}: ${i.message}`).join('\n'),
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'not stale',
        evidence: result.summary,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that the output does not contain stall patterns (looping, repeated errors).
 *
 * @param options - Custom stall patterns to check in addition to built-ins.
 */
export function toNotBeStalled(options: { customPatterns?: Array<{ pattern: RegExp; label: string }> } = {}): Assertion {
  const allPatterns = [...STALL_PATTERNS, ...(options.customPatterns ?? [])];

  return {
    name: 'not stalled',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const matches: string[] = [];

      for (const { pattern, label } of allPatterns) {
        if (pattern.test(output)) {
          matches.push(label);
        }
      }

      if (matches.length > 0) {
        return {
          status: 'fail',
          name: 'not stalled',
          message: `Output shows stall pattern(s): ${matches.join('; ')}`,
          evidence: `Detected: ${matches.join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'not stalled',
        evidence: 'No stall patterns detected',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert that a run produced meaningful output within expected time.
 *
 * Combines duration check + output substance check — a run that finishes fast
 * but produces nothing is just as bad as one that times out.
 *
 * @param startedAt - When the run started.
 * @param endedAt - When the run ended.
 * @param options - Configuration.
 */
export function toBeProductiveRun(
  startedAt: string | number,
  endedAt: string | number,
  options: {
    maxDurationMs?: number;
    minOutputLength?: number;
    abandonmentOptions?: AbandonmentOptions;
  } = {},
): Assertion {
  const { maxDurationMs = 7_200_000, minOutputLength = 50 } = options;

  return {
    name: 'productive run',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const issues: string[] = [];

      // Check duration
      const startMs = parseTimestamp(startedAt);
      const endMs = parseTimestamp(endedAt);

      if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
        const duration = endMs - startMs;
        if (duration > maxDurationMs) {
          issues.push(`Exceeded timeout: ${formatDuration(duration)} > ${formatDuration(maxDurationMs)}`);
        }
      }

      // Check output substance
      const trimmed = output.trim();
      if (trimmed.length < minOutputLength) {
        issues.push(`Output too short: ${trimmed.length} chars (minimum: ${minOutputLength})`);
      }

      // Check abandonment
      const abandonmentIssues = detectAbandonment(output, options.abandonmentOptions);
      const errorAbandonment = abandonmentIssues.filter(i => i.severity === 'error');
      if (errorAbandonment.length > 0) {
        issues.push(...errorAbandonment.map(i => i.message));
      }

      if (issues.length > 0) {
        return {
          status: 'fail',
          name: 'productive run',
          message: `Run was not productive: ${issues.join('; ')}`,
          expected: 'Completed within timeout with substantive output',
          actual: issues.join('; '),
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'pass',
        name: 'productive run',
        evidence: `Output: ${trimmed.length} chars, no abandonment signals`,
        durationMs: performance.now() - start,
      };
    },
  };
}
