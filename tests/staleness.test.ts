/**
 * Tests for the Staleness/Timeout Detector — Tier 1 Deterministic Check
 */

import { describe, it, expect } from 'vitest';
import {
  parseTimestamp,
  formatDuration,
  detectTimeout,
  detectStaleness,
} from '../src/checks/staleness.js';
import type { RunTimeline } from '../src/checks/staleness.js';

// ─── parseTimestamp ─────────────────────────────────────────────────────────────

describe('parseTimestamp', () => {
  it('parses ISO-8601 strings', () => {
    const ts = parseTimestamp('2026-06-06T12:00:00Z');
    expect(ts).toBe(Date.parse('2026-06-06T12:00:00Z'));
  });

  it('passes through numeric timestamps (Unix ms)', () => {
    expect(parseTimestamp(1717675200000)).toBe(1717675200000);
  });

  it('returns NaN for invalid strings', () => {
    expect(Number.isNaN(parseTimestamp('not-a-date'))).toBe(true);
  });

  it('parses date-only strings', () => {
    const ts = parseTimestamp('2026-06-06');
    expect(Number.isNaN(ts)).toBe(false);
  });

  it('handles zero', () => {
    expect(parseTimestamp(0)).toBe(0);
  });
});

// ─── formatDuration ─────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(5000)).toBe('5.0s');
  });

  it('formats minutes', () => {
    expect(formatDuration(300_000)).toBe('5.0m');
    expect(formatDuration(90_000)).toBe('1.5m');
  });

  it('formats hours', () => {
    expect(formatDuration(7_200_000)).toBe('2.0h');
  });

  it('returns unknown for NaN', () => {
    expect(formatDuration(NaN)).toBe('unknown');
  });

  it('returns unknown for negative', () => {
    expect(formatDuration(-1000)).toBe('unknown');
  });
});

// ─── detectTimeout ──────────────────────────────────────────────────────────────

describe('detectTimeout', () => {
  it('detects a run that exceeded its timeout', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T12:30:00Z',
      timeoutMs: 7_200_000,
    };
    const issue = detectTimeout(timeline);
    expect(issue).not.toBeNull();
    expect(issue!.kind).toBe('timeout');
    expect(issue!.severity).toBe('error');
  });

  it('passes a run within timeout', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T11:00:00Z',
      timeoutMs: 7_200_000,
    };
    expect(detectTimeout(timeline)).toBeNull();
  });

  it('uses options.maxDurationMs over timeline.timeoutMs', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T10:10:00Z',
      timeoutMs: 7_200_000,
    };
    const issue = detectTimeout(timeline, { maxDurationMs: 300_000 });
    expect(issue).not.toBeNull();
    expect(issue!.kind).toBe('timeout');
  });

  it('respects grace period', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T12:05:00Z',
      timeoutMs: 7_200_000,
    };
    const issue = detectTimeout(timeline, { gracePeriodMs: 600_000 });
    expect(issue).toBeNull();
  });

  it('uses last event as end time when endedAt is missing', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      timeoutMs: 3_600_000,
      events: [
        { timestamp: '2026-06-06T10:30:00Z', type: 'output' },
        { timestamp: '2026-06-06T11:30:00Z', type: 'heartbeat' },
      ],
    };
    const issue = detectTimeout(timeline);
    expect(issue).not.toBeNull();
  });

  it('returns null when no timeout is set', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T20:00:00Z',
    };
    expect(detectTimeout(timeline)).toBeNull();
  });

  it('returns null for invalid start timestamp', () => {
    const timeline: RunTimeline = {
      startedAt: 'invalid',
      endedAt: '2026-06-06T12:00:00Z',
      timeoutMs: 3_600_000,
    };
    expect(detectTimeout(timeline)).toBeNull();
  });
});

// ─── detectStaleness ────────────────────────────────────────────────────────────

describe('detectStaleness', () => {
  it('detects large gaps between events', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'output' },
        { timestamp: '2026-06-06T10:15:00Z', type: 'heartbeat' },
        { timestamp: '2026-06-06T10:16:00Z', type: 'end' },
      ],
    };
    const issues = detectStaleness(timeline, { maxGapMs: 300_000 });
    const gapIssues = issues.filter(i => i.kind === 'stale_gap');
    expect(gapIssues.length).toBe(1);
  });

  it('flags runs with too few events', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [{ timestamp: '2026-06-06T10:00:00Z', type: 'start' }],
    };
    const issues = detectStaleness(timeline, { minEvents: 3 });
    expect(issues.some(i => i.kind === 'no_output')).toBe(true);
  });

  it('flags missing end event when required', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'output' },
      ],
    };
    const issues = detectStaleness(timeline, { requireEndEvent: true });
    expect(issues.some(i => i.kind === 'no_end')).toBe(true);
  });

  it('does not flag missing end when endedAt is set', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T10:10:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'output' },
      ],
    };
    const issues = detectStaleness(timeline, { requireEndEvent: true });
    expect(issues.filter(i => i.kind === 'no_end').length).toBe(0);
  });

  it('passes a healthy timeline', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T10:05:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'output' },
        { timestamp: '2026-06-06T10:03:00Z', type: 'tool_call' },
        { timestamp: '2026-06-06T10:04:00Z', type: 'tool_result' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'end' },
      ],
    };
    expect(detectStaleness(timeline).length).toBe(0);
  });

  it('does not flag end event when disabled', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'output' },
      ],
    };
    const issues = detectStaleness(timeline, { requireEndEvent: false });
    expect(issues.filter(i => i.kind === 'no_end').length).toBe(0);
  });
});
