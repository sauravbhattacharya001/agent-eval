/**
 * Timeout/Staleness Detector - Tier 1 Deterministic Check
 *
 * Detects agent runs that timed out, went stale, or were abandoned:
 * - Timeout detection: did the run exceed its allocated time budget?
 * - Staleness detection: was output produced but then abandoned mid-task?
 * - Activity gap detection: long periods of inactivity within a run
 * - Abandonment markers: common patterns indicating premature termination
 * - Progress tracking: did the agent make forward progress or stall?
 *
 * All checks are deterministic - timestamp analysis and pattern matching with no AI.
 *
 * This file is the **public barrel** for the staleness check and the home of
 * the assertion factories that compose the detectors into Jest/Vitest-style
 * assertions. The supporting seams live alongside it and are re-exported here
 * so the public surface stays a single `./staleness.js` import path:
 * - `./staleness-types.js`     - the type vocabulary (timeline, options, results)
 * - `./staleness-detection.js` - the deterministic detection engine
 *
 * @tier 1 - Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type {
  RunTimeline,
  TimeoutOptions,
  StalenessOptions,
  AbandonmentOptions,
  ProgressOptions,
} from './staleness-types.js';
import {
  STALL_PATTERNS,
  parseTimestamp,
  formatDuration,
  detectAbandonment,
  analyzeStaleness,
} from './staleness-detection.js';

// === TYPE RE-EXPORTS =========================================================
// The staleness type vocabulary lives in ./staleness-types.js; re-export it
// here so consumers keep a single `./staleness.js` import path.
export type {
  RunEvent,
  RunTimeline,
  TimeoutOptions,
  StalenessOptions,
  AbandonmentOptions,
  ProgressOptions,
  StalenessResult,
  StalenessIssue,
} from './staleness-types.js';

// === DETECTION RE-EXPORTS ====================================================
// The deterministic detection engine (timestamp utils + per-axis detectors +
// the combined analyzeStaleness roll-up) lives alongside in
// ./staleness-detection.js.
export {
  parseTimestamp,
  formatDuration,
  detectTimeout,
  detectStaleness,
  detectAbandonment,
  analyzeProgress,
  analyzeStaleness,
} from './staleness-detection.js';

// === ASSERTION FACTORIES =====================================================

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
