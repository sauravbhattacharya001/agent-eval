/**
 * Tests for staleness detection: abandonment, progress, combined analysis, and assertions
 */

import { describe, it, expect } from 'vitest';
import {
  detectAbandonment,
  analyzeProgress,
  analyzeStaleness,
  toCompleteWithinTimeout,
  toNotBeAbandoned,
  toNotBeStale,
  toNotBeStalled,
  toBeProductiveRun,
} from '../src/checks/staleness.js';
import type { RunTimeline, RunEvent } from '../src/checks/staleness.js';

// ─── detectAbandonment ──────────────────────────────────────────────────────────

describe('detectAbandonment', () => {
  it('detects trailing ellipsis', () => {
    const issues = detectAbandonment('Here is the analysis of the code...');
    expect(issues.some(i => i.message.includes('trailing ellipsis'))).toBe(true);
  });

  it('detects unclosed code block', () => {
    const output = 'Here is the code:\n```typescript\nfunction foo() {\n  return 42;\n';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('unclosed code block'))).toBe(true);
  });

  it('detects TODO markers', () => {
    const output = 'The implementation is ready.\n[TODO] Add error handling for edge cases.';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('TODO/placeholder'))).toBe(true);
  });

  it('detects stated intent without follow-through', () => {
    const output = "I analyzed the code and found an issue. Let me fix it";
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('stated intent'))).toBe(true);
  });

  it('detects unbalanced code in code blocks', () => {
    const output = '```js\nfunction hello() {\n  if (true) {\n    console.log("hi");\n```';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('unbalanced code'))).toBe(true);
  });

  it('detects incomplete sentences', () => {
    const output = 'The server configuration requires specific settings in the environment variable that';
    const issues = detectAbandonment(output, { checkIncompleteSentence: true });
    expect(issues.some(i => i.message.includes('mid-sentence'))).toBe(true);
  });

  it('accepts well-terminated output', () => {
    const output = 'The analysis is complete. All tests pass and the code is ready for review.';
    const issues = detectAbandonment(output);
    expect(issues.length).toBe(0);
  });

  it('skips short output below minLengthForCheck', () => {
    const issues = detectAbandonment('ok', { minLengthForCheck: 10 });
    expect(issues.length).toBe(0);
  });

  it('matches custom patterns', () => {
    const output = 'Result: INCOMPLETE_RUN detected in output stream.';
    const issues = detectAbandonment(output, { customPatterns: [/INCOMPLETE_RUN/] });
    expect(issues.some(i => i.message.includes('custom abandonment pattern'))).toBe(true);
  });

  it('detects empty list item at end', () => {
    const output = 'Steps to fix:\n- Update the config\n- ';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('empty list item'))).toBe(true);
  });

  it('detects repeated error loops (stall)', () => {
    const output = 'Error: connection failed\nRetrying...\nError: connection failed\nRetrying...\nError: connection failed';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.kind === 'no_progress')).toBe(true);
  });

  it('respects checkTodoMarkers=false', () => {
    const output = 'The function works. TODO: add more test cases later.';
    const issues = detectAbandonment(output, { checkTodoMarkers: false });
    expect(issues.filter(i => i.message.includes('TODO/placeholder marker')).length).toBe(0);
  });

  it('respects checkUnbalancedCode=false', () => {
    const output = '```js\nfunction foo() {\n  if (true) {\n```';
    const issues = detectAbandonment(output, { checkUnbalancedCode: false });
    expect(issues.filter(i => i.message.includes('unbalanced code')).length).toBe(0);
  });

  it('respects checkIncompleteSentence=false', () => {
    const output = 'The configuration needs to be updated with additional parameters for the system to';
    const issues = detectAbandonment(output, { checkIncompleteSentence: false });
    expect(issues.filter(i => i.message.includes('mid-sentence')).length).toBe(0);
  });

  it('detects empty section header at end', () => {
    const output = 'Introduction done.\n\nStep 2: ';
    const issues = detectAbandonment(output);
    expect(issues.some(i => i.message.includes('empty section header'))).toBe(true);
  });
});

// ─── analyzeProgress ────────────────────────────────────────────────────────────

describe('analyzeProgress', () => {
  it('flags runs with no output events', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'heartbeat' },
        { timestamp: '2026-06-06T10:02:00Z', type: 'heartbeat' },
      ],
    };
    const issues = analyzeProgress(timeline, { minOutputEvents: 1 });
    expect(issues.some(i => i.kind === 'no_progress')).toBe(true);
  });

  it('flags excessive consecutive heartbeats', () => {
    const events: RunEvent[] = [
      { timestamp: 1000, type: 'start' },
      { timestamp: 2000, type: 'output' },
    ];
    for (let i = 0; i < 10; i++) {
      events.push({ timestamp: 3000 + i * 1000, type: 'heartbeat' });
    }
    const timeline: RunTimeline = { startedAt: 1000, events };
    const issues = analyzeProgress(timeline, { maxConsecutiveHeartbeats: 5 });
    expect(issues.some(i => i.message.includes('consecutive heartbeat'))).toBe(true);
  });

  it('passes a run with good output activity', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'output', content: 'Starting' },
        { timestamp: '2026-06-06T10:02:00Z', type: 'tool_call', content: 'Read file' },
        { timestamp: '2026-06-06T10:03:00Z', type: 'tool_result', content: 'Content' },
        { timestamp: '2026-06-06T10:04:00Z', type: 'output', content: 'Done' },
      ],
    };
    expect(analyzeProgress(timeline).length).toBe(0);
  });

  it('flags lack of content growth when required', () => {
    const timeline: RunTimeline = {
      startedAt: 0,
      events: [
        { timestamp: 1000, type: 'output', content: 'same length text here!' },
        { timestamp: 2000, type: 'output', content: 'same length text too!' },
        { timestamp: 3000, type: 'output', content: 'still same length!!' },
      ],
    };
    const issues = analyzeProgress(timeline, { requireContentGrowth: true });
    expect(issues.some(i => i.message.includes('not growing'))).toBe(true);
  });

  it('passes content growth with growing output', () => {
    const timeline: RunTimeline = {
      startedAt: 0,
      events: [
        { timestamp: 1000, type: 'output', content: 'Start' },
        { timestamp: 2000, type: 'output', content: 'Starting analysis of the codebase' },
        { timestamp: 3000, type: 'output', content: 'Starting analysis of the codebase, found 5 issues' },
      ],
    };
    const issues = analyzeProgress(timeline, { requireContentGrowth: true });
    expect(issues.filter(i => i.message.includes('not growing')).length).toBe(0);
  });
});

// ─── analyzeStaleness (combined) ────────────────────────────────────────────────

describe('analyzeStaleness', () => {
  it('healthy run returns isStale=false', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T10:05:00Z',
      timeoutMs: 3_600_000,
      output: 'The code review is complete. All issues have been addressed.',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'output' },
        { timestamp: '2026-06-06T10:03:00Z', type: 'tool_call' },
        { timestamp: '2026-06-06T10:04:00Z', type: 'tool_result' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'end' },
      ],
    };
    const result = analyzeStaleness(timeline);
    expect(result.isStale).toBe(false);
    expect(result.issues.length).toBe(0);
    expect(result.hasEndEvent).toBe(true);
  });

  it('stale run returns isStale=true', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      timeoutMs: 3_600_000,
      output: 'Starting the review...',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'output' },
        { timestamp: '2026-06-06T12:30:00Z', type: 'heartbeat' },
      ],
    };
    const result = analyzeStaleness(timeline);
    expect(result.isStale).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('computes correct metrics', () => {
    const timeline: RunTimeline = {
      startedAt: 1000,
      endedAt: 61000,
      events: [
        { timestamp: 1000, type: 'start' },
        { timestamp: 5000, type: 'output' },
        { timestamp: 30000, type: 'tool_call' },
        { timestamp: 60000, type: 'output' },
        { timestamp: 61000, type: 'end' },
      ],
    };
    const result = analyzeStaleness(timeline);
    expect(result.durationMs).toBe(60000);
    expect(result.outputEventCount).toBe(3);
    expect(result.hasEndEvent).toBe(true);
    expect(result.longestGapMs).toBe(30000);
  });

  it('marks stale when multiple warnings accumulate (>=3)', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      output: 'Starting analysis. Let me check the code...',
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:01:00Z', type: 'heartbeat' },
      ],
    };
    const result = analyzeStaleness(timeline, {
      staleness: { requireEndEvent: true, minEvents: 3 },
    });
    expect(result.isStale).toBe(true);
  });

  it('summary includes duration and event count', () => {
    const timeline: RunTimeline = {
      startedAt: 0,
      endedAt: 60000,
      events: [
        { timestamp: 0, type: 'start' },
        { timestamp: 30000, type: 'output' },
        { timestamp: 60000, type: 'end' },
      ],
    };
    const result = analyzeStaleness(timeline);
    expect(result.summary).toContain('Duration');
    expect(result.summary).toContain('Events');
  });
});

// ─── Assertion: toCompleteWithinTimeout ─────────────────────────────────────────

describe('toCompleteWithinTimeout', () => {
  it('passes when within timeout', () => {
    const a = toCompleteWithinTimeout(3_600_000, '2026-06-06T10:00:00Z', '2026-06-06T10:30:00Z');
    expect(a.evaluate('output').status).toBe('pass');
  });

  it('fails when exceeds timeout', () => {
    const a = toCompleteWithinTimeout(3_600_000, '2026-06-06T10:00:00Z', '2026-06-06T12:00:00Z');
    const r = a.evaluate('output');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('2.0h');
  });

  it('returns error for invalid start', () => {
    const a = toCompleteWithinTimeout(3_600_000, 'bad', '2026-06-06T12:00:00Z');
    expect(a.evaluate('').status).toBe('error');
  });

  it('returns error for invalid end', () => {
    const a = toCompleteWithinTimeout(3_600_000, '2026-06-06T10:00:00Z', 'bad');
    expect(a.evaluate('').status).toBe('error');
  });

  it('accepts numeric timestamps', () => {
    const start = Date.parse('2026-06-06T10:00:00Z');
    const a = toCompleteWithinTimeout(3_600_000, start, start + 1_800_000);
    expect(a.evaluate('output').status).toBe('pass');
  });
});

// ─── Assertion: toNotBeAbandoned ────────────────────────────────────────────────

describe('toNotBeAbandoned', () => {
  it('passes for well-terminated output', () => {
    const a = toNotBeAbandoned();
    expect(a.evaluate('The analysis is complete. All checks pass.').status).toBe('pass');
  });

  it('fails for output with unbalanced code (error severity)', () => {
    const a = toNotBeAbandoned();
    const output = '```js\nfunction foo() {\n  if (x) {\n    return bar(\n```';
    expect(a.evaluate(output).status).toBe('fail');
  });

  it('passes with single warning (needs 2+ or error)', () => {
    const a = toNotBeAbandoned();
    expect(a.evaluate('The details about the topic...').status).toBe('pass');
  });

  it('fails with multiple warnings', () => {
    const a = toNotBeAbandoned({ checkIncompleteSentence: true });
    const output = 'Starting. TODO: finish review. The code needs work because';
    expect(a.evaluate(output).status).toBe('fail');
  });

  it('has correct assertion name', () => {
    expect(toNotBeAbandoned().name).toBe('not abandoned');
  });
});

// ─── Assertion: toNotBeStale ────────────────────────────────────────────────────

describe('toNotBeStale', () => {
  it('passes for healthy timeline', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      endedAt: '2026-06-06T10:05:00Z',
      timeoutMs: 3_600_000,
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T10:02:00Z', type: 'output' },
        { timestamp: '2026-06-06T10:05:00Z', type: 'end' },
      ],
    };
    const a = toNotBeStale(timeline);
    expect(a.evaluate('Good output here.').status).toBe('pass');
  });

  it('fails for stale timeline', () => {
    const timeline: RunTimeline = {
      startedAt: '2026-06-06T10:00:00Z',
      timeoutMs: 3_600_000,
      events: [
        { timestamp: '2026-06-06T10:00:00Z', type: 'start' },
        { timestamp: '2026-06-06T12:30:00Z', type: 'heartbeat' },
      ],
    };
    const r = toNotBeStale(timeline).evaluate('Minimal output');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('stale');
  });
});

// ─── Assertion: toNotBeStalled ──────────────────────────────────────────────────

describe('toNotBeStalled', () => {
  it('passes for normal output', () => {
    const a = toNotBeStalled();
    expect(a.evaluate('Clean analysis. No issues found.').status).toBe('pass');
  });

  it('fails for repeated error pattern', () => {
    const output = 'Error: refused. Retry\nError: refused. Retry\nError: refused. Done';
    const r = toNotBeStalled().evaluate(output);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('stall pattern');
  });

  it('detects custom stall patterns', () => {
    const a = toNotBeStalled({
      customPatterns: [{ pattern: /DEADLOCK/i, label: 'deadlock detected' }],
    });
    const r = a.evaluate('The process hit a DEADLOCK state.');
    expect(r.status).toBe('fail');
    expect(r.evidence).toContain('deadlock');
  });

  it('has correct assertion name', () => {
    expect(toNotBeStalled().name).toBe('not stalled');
  });
});

// ─── Assertion: toBeProductiveRun ───────────────────────────────────────────────

describe('toBeProductiveRun', () => {
  it('passes for a productive run', () => {
    const a = toBeProductiveRun(
      '2026-06-06T10:00:00Z',
      '2026-06-06T10:30:00Z',
      { maxDurationMs: 3_600_000, minOutputLength: 20 },
    );
    expect(a.evaluate('The analysis is complete. Found 3 issues and fixed them all.').status).toBe('pass');
  });

  it('fails for timeout', () => {
    const a = toBeProductiveRun(
      '2026-06-06T10:00:00Z',
      '2026-06-06T12:30:00Z',
      { maxDurationMs: 3_600_000 },
    );
    const r = a.evaluate('Long output that took too long to produce but is otherwise fine and complete.');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('timeout');
  });

  it('fails for too-short output', () => {
    const a = toBeProductiveRun(
      '2026-06-06T10:00:00Z',
      '2026-06-06T10:05:00Z',
      { minOutputLength: 100 },
    );
    expect(a.evaluate('Short.').status).toBe('fail');
  });

  it('fails for abandoned output with code errors', () => {
    const a = toBeProductiveRun(
      '2026-06-06T10:00:00Z',
      '2026-06-06T10:05:00Z',
    );
    const output = '```js\nfunction doWork() {\n  if (condition) {\n    process(\n```';
    expect(a.evaluate(output).status).toBe('fail');
  });

  it('has correct assertion name', () => {
    expect(toBeProductiveRun('2026-06-06T10:00:00Z', '2026-06-06T10:05:00Z').name).toBe('productive run');
  });
});
