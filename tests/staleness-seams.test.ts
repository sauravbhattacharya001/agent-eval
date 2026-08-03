/**
 * Seam tests for the Staleness/timeout check split.
 *
 * `staleness.ts` was split into two sibling seams - `staleness-types.ts` (the
 * logic-free type vocabulary: timeline, options, results) and
 * `staleness-detection.ts` (the deterministic detection engine: timestamp utils,
 * pattern tables, per-axis detectors, and the combined `analyzeStaleness`
 * roll-up) - with `staleness.ts` kept as the public barrel (re-exporting
 * everything) plus the assertion factories (`toCompleteWithinTimeout`,
 * `toNotBeAbandoned`, `toNotBeStale`, `toNotBeStalled`, `toBeProductiveRun`).
 *
 * The behavioural suites (`staleness.test.ts`, `staleness-assertions.test.ts`)
 * import from `staleness.js` and therefore only reach the moved units
 * transitively. These tests pin the seam boundary itself:
 *   1. each detector is importable from its OWN new module, and
 *   2. `staleness.js` re-exports the *same function reference* (the barrel
 *      cannot silently diverge from the detection seam),
 * plus direct unit checks that exercise the detection seam through its own home
 * and confirm the assertion factories still compose those detectors.
 */

import { describe, it, expect } from 'vitest';

// Detection seam - imported directly from its new home.
import {
  parseTimestamp as parseTimestampSeam,
  formatDuration as formatDurationSeam,
  detectTimeout as detectTimeoutSeam,
  detectStaleness as detectStalenessSeam,
  detectAbandonment as detectAbandonmentSeam,
  analyzeProgress as analyzeProgressSeam,
  analyzeStaleness as analyzeStalenessSeam,
  ABANDONMENT_PATTERNS as ABANDONMENT_PATTERNS_SEAM,
  STALL_PATTERNS as STALL_PATTERNS_SEAM,
  detectUnbalancedCode as detectUnbalancedCodeSeam,
} from '../src/checks/staleness-detection.js';

// Pattern-table + code-balance seam - the static, content-agnostic building
// blocks that the abandonment detector consumes, imported from their own home.
import {
  ABANDONMENT_PATTERNS as ABANDONMENT_PATTERNS_HOME,
  STALL_PATTERNS as STALL_PATTERNS_HOME,
  detectUnbalancedCode as detectUnbalancedCodeHome,
} from '../src/checks/staleness-patterns.js';

// Abandonment seam - the output-text-only detector, imported from its own home.
import { detectAbandonment as detectAbandonmentHome } from '../src/checks/staleness-abandonment.js';

// Public barrel - what consumers import.
import {
  parseTimestamp,
  formatDuration,
  detectTimeout,
  detectStaleness,
  detectAbandonment,
  analyzeProgress,
  analyzeStaleness,
  toCompleteWithinTimeout,
  toNotBeAbandoned,
  toNotBeStale,
  toNotBeStalled,
  toBeProductiveRun,
} from '../src/checks/staleness.js';

// Pure type-vocabulary seam - importable on its own and structurally compatible
// with the barrel's re-export of the same names.
import type {
  RunTimeline as RunTimelineTypeSeam,
  RunEvent as RunEventTypeSeam,
  StalenessIssue as StalenessIssueTypeSeam,
} from '../src/checks/staleness-types.js';

// === RE-EXPORT IDENTITY ==========================================================

describe('staleness.ts re-exports the same references as its seams', () => {
  it('detection seam (staleness-detection.ts) - utility functions', () => {
    expect(parseTimestamp).toBe(parseTimestampSeam);
    expect(formatDuration).toBe(formatDurationSeam);
  });

  it('detection seam (staleness-detection.ts) - per-axis detectors', () => {
    expect(detectTimeout).toBe(detectTimeoutSeam);
    expect(detectStaleness).toBe(detectStalenessSeam);
    expect(detectAbandonment).toBe(detectAbandonmentSeam);
    expect(analyzeProgress).toBe(analyzeProgressSeam);
    expect(analyzeStaleness).toBe(analyzeStalenessSeam);
  });

  it('abandonment seam (staleness-abandonment.ts) is the same reference everywhere', () => {
    // detectAbandonment now lives in its own module; both the barrel and the
    // detection engine must re-export that exact reference (no divergence).
    expect(detectAbandonment).toBe(detectAbandonmentHome);
    expect(detectAbandonmentSeam).toBe(detectAbandonmentHome);
  });

  it('pattern seam (staleness-patterns.ts) is re-exported by the detection engine', () => {
    // The pattern tables + code-balance helper were extracted to their own home;
    // staleness-detection.ts re-exports the same references.
    expect(ABANDONMENT_PATTERNS_SEAM).toBe(ABANDONMENT_PATTERNS_HOME);
    expect(STALL_PATTERNS_SEAM).toBe(STALL_PATTERNS_HOME);
    expect(detectUnbalancedCodeSeam).toBe(detectUnbalancedCodeHome);
  });

  it('pattern seam: detectUnbalancedCode flags truncated code and passes balanced code', () => {
    expect(detectUnbalancedCodeHome('```js\nfunction f() {\n')).toContain('unclosed brace');
    expect(detectUnbalancedCodeHome('```js\nconst x = [1, 2, 3];\n```')).toBeNull();
    // Non-code prose without code-like keywords is ignored entirely.
    expect(detectUnbalancedCodeHome('just some prose with no brackets')).toBeNull();
  });

  it('types seam is structurally compatible with the barrel re-export', () => {
    // Compile-time guard: the type names resolve from the standalone types
    // module and are assignable to the shapes the detectors consume/produce.
    const event: RunEventTypeSeam = { timestamp: 0, type: 'start' };
    const timeline: RunTimelineTypeSeam = { startedAt: 0, events: [event] };
    const issue: StalenessIssueTypeSeam = { kind: 'timeout', message: 'x', severity: 'error' };
    expect(timeline.events?.[0]?.type).toBe('start');
    expect(issue.kind).toBe('timeout');
  });
});

// === DIRECT UNIT CHECKS THROUGH THE DETECTION SEAM ===============================

describe('detection seam: timestamp utilities', () => {
  it('parseTimestamp passes numbers through and parses ISO strings', () => {
    expect(parseTimestampSeam(1700)).toBe(1700);
    expect(parseTimestampSeam('2025-01-01T00:00:00.000Z')).toBe(Date.parse('2025-01-01T00:00:00.000Z'));
    expect(Number.isNaN(parseTimestampSeam('not-a-date'))).toBe(true);
  });

  it('formatDuration renders human-readable buckets and guards bad input', () => {
    expect(formatDurationSeam(500)).toBe('500ms');
    expect(formatDurationSeam(1500)).toBe('1.5s');
    expect(formatDurationSeam(90_000)).toBe('1.5m');
    expect(formatDurationSeam(3_600_000)).toBe('1.0h');
    expect(formatDurationSeam(NaN)).toBe('unknown');
    expect(formatDurationSeam(-5)).toBe('unknown');
    expect(formatDurationSeam(Infinity)).toBe('unknown');
    expect(formatDurationSeam(-Infinity)).toBe('unknown');
  });
});

describe('detection seam: per-axis detectors', () => {
  it('detectTimeout flags a run that exceeds its budget and clears one within it', () => {
    const over = detectTimeoutSeam({ startedAt: 0, endedAt: 10_000, timeoutMs: 5_000 });
    expect(over?.kind).toBe('timeout');
    expect(over?.severity).toBe('error');
    const under = detectTimeoutSeam({ startedAt: 0, endedAt: 3_000, timeoutMs: 5_000 });
    expect(under).toBeNull();
  });

  it('detectStaleness flags a large activity gap between events', () => {
    const issues = detectStalenessSeam(
      {
        startedAt: 0,
        events: [
          { timestamp: 0, type: 'start' },
          { timestamp: 10 * 60 * 1000, type: 'output' },
          { timestamp: 10 * 60 * 1000 + 1, type: 'end' },
        ],
      },
      { maxGapMs: 5 * 60 * 1000 },
    );
    expect(issues.some((i) => i.kind === 'stale_gap')).toBe(true);
  });

  it('detectAbandonment flags an unclosed code block as an error', () => {
    const issues = detectAbandonmentSeam('Here is the fix:\n```ts\nfunction go() {\n  return 1;');
    expect(issues.some((i) => i.kind === 'abandoned' && i.severity === 'error')).toBe(true);
  });

  it('analyzeProgress flags a heartbeat-only stall', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({ timestamp: i * 1000, type: 'heartbeat' as const }));
    const issues = analyzeProgressSeam({ startedAt: 0, events }, { maxConsecutiveHeartbeats: 5 });
    expect(issues.some((i) => i.kind === 'no_progress')).toBe(true);
  });

  it('analyzeStaleness rolls the axes into one verdict + summary', () => {
    const healthy = analyzeStalenessSeam({
      startedAt: 0,
      endedAt: 2_000,
      events: [
        { timestamp: 0, type: 'start' },
        { timestamp: 1_000, type: 'output', content: 'did the work and finished cleanly.' },
        { timestamp: 2_000, type: 'end' },
      ],
      output: 'Completed the task and verified the result.',
    });
    expect(healthy.isStale).toBe(false);
    expect(healthy.hasEndEvent).toBe(true);
    expect(healthy.summary).toMatch(/Verdict: OK/);
  });
});

// === ASSERTION FACTORIES STILL COMPOSE THE DETECTORS =============================

describe('barrel: assertion factories compose the detection seam', () => {
  it('toCompleteWithinTimeout fails an over-budget run and passes an in-budget one', () => {
    const fail = toCompleteWithinTimeout(5_000, 0, 10_000).evaluate('done');
    expect(fail).toMatchObject({ status: 'fail', name: 'completes within timeout' });
    const pass = toCompleteWithinTimeout(5_000, 0, 3_000).evaluate('done');
    expect(pass.status).toBe('pass');
  });

  it('toNotBeAbandoned fails on a hard abandonment signal (unbalanced code)', () => {
    const r = toNotBeAbandoned().evaluate('```ts\nfunction go() {\n  return 1;');
    expect(r.status).toBe('fail');
  });

  it('toNotBeStalled flags a repeated-error retry loop', () => {
    const r = toNotBeStalled().evaluate('error: failed retry; error: failed retry; error: failed retry');
    expect(r.status).toBe('fail');
    expect(r.name).toBe('not stalled');
  });

  it('toNotBeStale fails an abandoned, end-less, no-output timeline', () => {
    const r = toNotBeStale({
      startedAt: 0,
      events: [{ timestamp: 0, type: 'start' }],
    }).evaluate('I will start by');
    expect(r.status).toBe('fail');
    expect(r.name).toBe('not stale');
  });

  it('toBeProductiveRun fails a fast-but-empty run', () => {
    const r = toBeProductiveRun(0, 1_000, { minOutputLength: 50 }).evaluate('ok');
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/too short/);
  });
});
