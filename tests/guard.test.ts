/**
 * Tests for the behavioral guard — the free runtime kill-switch.
 *
 * Drives the guard with synthetic event streams and asserts it (a) lets a
 * healthy run continue, (b) stops on each failure mode with the right reason,
 * and (c) captures a usable RunTimeline for downstream triage/capture.
 */

import { describe, it, expect } from 'vitest';
import { createGuard } from '../src/action/guard.js';
import * as api from '../src/index.js';
import type { RunEvent } from '../src/checks/staleness.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (sec: number): number => T0 + sec * 1000;

function ev(sec: number, type: RunEvent['type'], content?: string): RunEvent {
  return { timestamp: at(sec), type, content };
}

describe('createGuard — healthy run continues', () => {
  it('never stops a short, varied, in-budget run', () => {
    const g = createGuard({ maxTokens: 1_000_000, maxDurationMs: 60_000, maxGapMs: 30_000 });
    g.observe(ev(0, 'start'));
    expect(g.observe(ev(1, 'output', 'reading the config file'), 1000).action).toBe('continue');
    expect(g.observe(ev(2, 'tool_call', 'edit app.ts line 12'), 2000).action).toBe('continue');
    expect(g.observe(ev(3, 'tool_result', 'ok'), 2500).action).toBe('continue');
    const v = g.observe(ev(4, 'output', 'done, all good'), 3000);
    expect(v.action).toBe('continue');
    expect(v.tokenUsage).toBe(3000);
  });

  it('finish() on a cleanly-ended run does not fabricate a stop', () => {
    const g = createGuard({ maxTokens: 1_000_000 });
    g.observe(ev(0, 'start'));
    g.observe(ev(1, 'output', 'working'), 500);
    g.observe(ev(2, 'end', 'clean stop'), 800);
    const { verdict, timeline } = g.finish();
    expect(verdict.action).toBe('continue');
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(true);
    expect(timeline.endedAt).toBeDefined();
  });
});

describe('createGuard — runaway (token ceiling)', () => {
  it('stops the instant cumulative tokens cross the ceiling', () => {
    const g = createGuard({ maxTokens: 1_000_000 });
    g.observe(ev(0, 'start'));
    expect(g.observe(ev(1, 'output', 'chugging'), 900_000).action).toBe('continue');
    const v = g.observe(ev(2, 'output', 'still chugging'), 1_050_000);
    expect(v.action).toBe('stop');
    expect(v.reason).toBe('runaway');
    expect(v.tokenUsage).toBe(1_050_000);
  });

  it('latches stopped: subsequent observes keep returning stop', () => {
    const g = createGuard({ maxTokens: 100 });
    g.observe(ev(0, 'start'));
    expect(g.observe(ev(1, 'output', 'x'), 200).reason).toBe('runaway');
    // even a clean event afterwards stays stopped
    expect(g.observe(ev(2, 'output', 'y'), 50).action).toBe('stop');
  });
});

describe('createGuard — timeout (wall clock)', () => {
  it('stops when runtime exceeds the budget', () => {
    const g = createGuard({ maxDurationMs: 10_000 });
    g.observe(ev(0, 'start'));
    g.observe(ev(5, 'output', 'half way'), 100);
    const v = g.observe(ev(11, 'output', 'over budget'), 200);
    expect(v.action).toBe('stop');
    expect(v.reason).toBe('timeout');
  });
});

describe('createGuard — loop (repeated output)', () => {
  it('stops when the same output line repeats', () => {
    const g = createGuard({ loopThreshold: 0.5 });
    g.observe(ev(0, 'start'));
    // Same action narrated over and over — classic stuck loop.
    let v = g.observe(ev(1, 'output', 'retrying the same edit on app.ts'));
    v = g.observe(ev(2, 'output', 'retrying the same edit on app.ts'));
    v = g.observe(ev(3, 'output', 'retrying the same edit on app.ts'));
    v = g.observe(ev(4, 'output', 'retrying the same edit on app.ts'));
    expect(v.action).toBe('stop');
    expect(v.reason).toBe('loop');
  });

  it('does NOT flag varied progress as a loop', () => {
    const g = createGuard({ loopThreshold: 0.5 });
    g.observe(ev(0, 'start'));
    g.observe(ev(1, 'output', 'step one: read file'));
    g.observe(ev(2, 'output', 'step two: parse header'));
    g.observe(ev(3, 'output', 'step three: write output'));
    const v = g.observe(ev(4, 'output', 'step four: verify result'));
    expect(v.action).toBe('continue');
  });
});

describe('createGuard — stall (big gap between events while live)', () => {
  it('stops when the inter-event gap exceeds maxGapMs', () => {
    const g = createGuard({ maxGapMs: 60_000 });
    g.observe(ev(0, 'start'));
    g.observe(ev(1, 'output', 'starting work'), 100);
    // 10-minute silence, then another event => stale_gap (error severity).
    const v = g.observe(ev(601, 'output', 'finally back'), 200);
    expect(v.action).toBe('stop');
    expect(v.reason).toBe('stall');
  });
});

describe('createGuard — abandoned (no clean end at finish)', () => {
  it('finish() flags a run that just stopped emitting with no end event', () => {
    const g = createGuard({ maxDurationMs: 3_600_000, maxGapMs: 600_000 });
    g.observe(ev(0, 'start'));
    g.observe(ev(1, 'tool_call', 'edit app.ts'), 1000);
    // ...no further events, no 'end' — the run was abandoned.
    const { verdict } = g.finish();
    expect(verdict.action).toBe('stop');
    expect(['abandoned', 'stall', 'timeout']).toContain(verdict.reason);
  });
});

describe('createGuard — trajectory capture', () => {
  it('snapshot() and finish() expose the full event timeline for triage', () => {
    const g = createGuard({ maxTokens: 1_000_000, maxDurationMs: 60_000 });
    g.observe(ev(0, 'start'));
    g.observe(ev(1, 'output', 'a'), 100);
    g.observe(ev(2, 'tool_call', 'b'), 200);
    const snap = g.snapshot();
    expect(snap.events).toHaveLength(3);
    expect(snap.startedAt).toBe(at(0));
    const { timeline } = g.finish();
    expect(timeline.events!.length).toBeGreaterThanOrEqual(3);
    expect(timeline.timeoutMs).toBe(60_000);
  });
});

describe('createGuard — public API surface', () => {
  it('is exported from the package root as a callable', () => {
    expect(typeof api.createGuard).toBe('function');
  });

  it('the root-exported guard produces a working verdict end to end', () => {
    const g = api.createGuard({ maxTokens: 100 });
    g.observe({ timestamp: at(0), type: 'start' });
    const v = g.observe({ timestamp: at(1), type: 'output', content: 'x' }, 200);
    expect(v.action).toBe('stop');
    expect(v.reason).toBe('runaway');
  });
});
