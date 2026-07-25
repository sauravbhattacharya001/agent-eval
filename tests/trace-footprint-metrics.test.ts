/**
 * Direct unit tests for the extracted PROOF readers + metric reducers in
 * `trace-footprint-metrics.ts`. The end-to-end behaviour is covered by
 * `trace-footprint.test.ts`; these tests pin the seams in isolation so a future
 * refactor of any single reducer is caught locally.
 *
 * PROOF-only invariant checks: `isErrorResult` never treats absence of an error
 * flag as failure, and `toolOutcomes` uses `tool_name` strictly as a label.
 */
import { describe, expect, it } from 'vitest';
import {
  isErrorResult,
  numericValue,
  toolOutcomes,
  retryStats,
  recoveryStats,
  tokenTotals,
} from '../src/checks/trace-footprint-metrics.js';
import { ingestTrace, type TraceSession } from '../src/monitoring/trace-provenance.js';
import type { ToolOutcome } from '../src/checks/trace-footprint-types.js';

const oc = (
  eventIndex: number,
  toolName: string,
  isError: boolean,
  durationMs: number | null = null,
): ToolOutcome => ({ eventIndex, toolName, isError, durationMs });

describe('isErrorResult (PROOF verdict)', () => {
  it('treats explicit is_error === true as an error', () => {
    expect(isErrorResult({ is_error: true })).toBe(true);
  });
  it('treats a non-zero numeric exit_code as an error', () => {
    expect(isErrorResult({ exit_code: 2 })).toBe(true);
    expect(isErrorResult({ exit_code: 0 })).toBe(false);
  });
  it('treats absence of any error flag as NOT an error', () => {
    expect(isErrorResult({})).toBe(false);
    expect(isErrorResult(null)).toBe(false);
    expect(isErrorResult('boom')).toBe(false);
    expect(isErrorResult({ is_error: 'true' })).toBe(false); // string, not boolean true
    expect(isErrorResult({ exit_code: '2' })).toBe(false); // string, not number
  });
});

describe('numericValue', () => {
  it('returns finite numbers and null otherwise', () => {
    expect(numericValue(3)).toBe(3);
    expect(numericValue(0)).toBe(0);
    expect(numericValue(NaN)).toBeNull();
    expect(numericValue(Infinity)).toBeNull();
    expect(numericValue('5')).toBeNull();
    expect(numericValue(undefined)).toBeNull();
  });
});

describe('toolOutcomes', () => {
  it('yields one outcome per tool_output, ordered by event, with tool_name as label only', () => {
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'read', tool_output: { is_error: false }, duration_ms: 10 },
        },
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'exec', tool_output: { is_error: true, exit_code: 1 }, duration_ms: 20 },
        },
        { event_type: 'model_response', output_data: 'thinking...' }, // no tool_output → excluded
      ],
    } as unknown as TraceSession;
    const outcomes = toolOutcomes(ingestTrace(session));
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ toolName: 'read', isError: false, durationMs: 10 });
    expect(outcomes[1]).toMatchObject({ toolName: 'exec', isError: true, durationMs: 20 });
  });
});

describe('retryStats', () => {
  it('counts a same-tool streak only when it starts from an error', () => {
    const streak = retryStats([oc(0, 'exec', true), oc(1, 'exec', true), oc(2, 'exec', false)]);
    expect(streak).toEqual({ longestRetryStreak: 3, retryCount: 2 });
  });
  it('does not count a same-tool run that started from success', () => {
    expect(retryStats([oc(0, 'exec', false), oc(1, 'exec', false)])).toEqual({
      longestRetryStreak: 0,
      retryCount: 0,
    });
  });
  it('handles empty input', () => {
    expect(retryStats([])).toEqual({ longestRetryStreak: 0, retryCount: 0 });
  });
});

describe('recoveryStats', () => {
  it('marks an error recovered when a later success follows', () => {
    expect(recoveryStats([oc(0, 'a', true), oc(1, 'b', false)])).toEqual({
      recoveredErrors: 1,
      unrecoveredErrors: 0,
      recoveryRate: 1,
    });
  });
  it('excludes a trailing error with no subsequent call', () => {
    expect(recoveryStats([oc(0, 'a', false), oc(1, 'b', true)])).toEqual({
      recoveredErrors: 0,
      unrecoveredErrors: 0,
      recoveryRate: 1,
    });
  });
  it('marks an error unrecovered when only errors follow', () => {
    expect(recoveryStats([oc(0, 'a', true), oc(1, 'b', true)])).toEqual({
      recoveredErrors: 0,
      unrecoveredErrors: 1,
      recoveryRate: 0,
    });
  });
});

describe('tokenTotals', () => {
  it('prefers the collector session rollup when present', () => {
    const session = { total_tokens_in: 100, total_tokens_out: 50 } as TraceSession;
    expect(tokenTotals(session, [])).toEqual({ tokensIn: 100, tokensOut: 50 });
  });
  it('falls back to summing per-event token records', () => {
    const records = [
      { eventIndex: 0, path: 'tokens_in', value: 10, label: 'proof' },
      { eventIndex: 0, path: 'tokens_out', value: 4, label: 'proof' },
      { eventIndex: 1, path: 'tokens_in', value: 20, label: 'proof' },
    ] as never;
    expect(tokenTotals({} as TraceSession, records)).toEqual({ tokensIn: 30, tokensOut: 4 });
  });
});
