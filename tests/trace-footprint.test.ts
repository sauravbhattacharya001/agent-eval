/**
 * Tests for behavioural footprint (Section F, slice 2) — the PROOF-only run
 * metrics that feed harness×model selection.
 *
 * These tests pin the HARD GUARDRAIL that keeps slice 2 a Tier 1+2 pillar:
 *   1. Every success/error/timing/token figure comes from PROOF — the harness's
 *      own `tool_output` (`is_error`/`exit_code`), timing, and token meters.
 *   2. The model's chosen `tool_name` is used ONLY to attribute a retry streak
 *      to "the same tool" — NEVER to decide whether a call succeeded. Flipping a
 *      claim (renaming a tool, rewriting narration) cannot change the verdict;
 *      flipping the harness result (is_error) is the only thing that moves it.
 *   3. `analyzeFootprint` is pure + read-only: it never mutates its input.
 *   4. Edge cases: no tool calls, errors at the end of a run (no recovery debt),
 *      missing timing/tokens.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  analyzeFootprint,
  toCompleteWithinSteps,
  toHaveToolErrorRateBelow,
  toNotThrash,
  toRecoverFromErrors,
} from '../src/checks/trace-footprint.js';
import { ingestTrace, type TraceSession } from '../src/monitoring/trace-provenance.js';

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'agent-trace-sessions',
);

function loadSession(name: string): TraceSession {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf-8')) as TraceSession;
}

// ─── Happy-path run (sentinel: score then push, no errors) ──────────────────────

describe('analyzeFootprint — clean run', () => {
  it('counts steps and tool calls from PROOF event types', () => {
    const fp = analyzeFootprint(loadSession('sentinel-push'));
    // 5 events: llm, decision, tool, tool, llm → 2 tool calls.
    expect(fp.totalEvents).toBe(5);
    expect(fp.toolCalls).toBe(2);
  });

  it('reports zero errors and a perfect recovery rate when nothing failed', () => {
    const fp = analyzeFootprint(loadSession('sentinel-push'));
    expect(fp.toolErrors).toBe(0);
    expect(fp.toolErrorRate).toBe(0);
    expect(fp.longestRetryStreak).toBe(0);
    expect(fp.retryCount).toBe(0);
    // No recoverable errors → no recovery debt → rate 1.
    expect(fp.recoveryRate).toBe(1);
    expect(fp.recoveredErrors).toBe(0);
    expect(fp.unrecoveredErrors).toBe(0);
  });

  it('sums PROOF tool durations and prefers the collector token rollup', () => {
    const fp = analyzeFootprint(loadSession('sentinel-push'));
    expect(fp.toolDurationMs).toBe(5180 + 760);
    // total_tokens_in/out on the session are the collector rollup (PROOF).
    expect(fp.tokensIn).toBe(3400);
    expect(fp.tokensOut).toBe(880);
  });

  it('records one outcome per tool call, attributed to its event + tool label', () => {
    const fp = analyzeFootprint(loadSession('sentinel-push'));
    expect(fp.outcomes.map((o) => o.toolName)).toEqual(['run_command', 'git_push']);
    expect(fp.outcomes.every((o) => o.isError === false)).toBe(true);
    // Event indices come straight from the provenance records (events 2 and 3).
    expect(fp.outcomes.map((o) => o.eventIndex)).toEqual([2, 3]);
  });
});

// ─── Error / retry / recovery run ───────────────────────────────────────────────

describe('analyzeFootprint — error, retry, and recovery', () => {
  it('counts harness-reported tool errors from is_error / exit_code (PROOF only)', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    // 5 tool calls: build(err), build(err), edit(ok), build(ok), push(ok).
    expect(fp.toolCalls).toBe(5);
    expect(fp.toolErrors).toBe(2);
    expect(fp.toolErrorRate).toBeCloseTo(0.4, 5);
  });

  it('detects a same-tool retry-after-error streak (thrash)', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    // The two consecutive failing `run_build` calls are a retry streak of 2.
    expect(fp.longestRetryStreak).toBe(2);
    expect(fp.retryCount).toBe(1);
  });

  it('credits recovery when a later tool call eventually succeeds', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    // Both build errors are followed by later successes → both recovered.
    expect(fp.recoveredErrors).toBe(2);
    expect(fp.unrecoveredErrors).toBe(0);
    expect(fp.recoveryRate).toBe(1);
  });

  it('summary mentions the key behavioural signals', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    expect(fp.summary).toContain('5 tool calls');
    expect(fp.summary).toContain('2 errors');
    expect(fp.summary).toContain('retry streak 2');
    expect(fp.summary).toContain('recovered');
  });
});

// ─── PROOF-only invariants (the guardrail) ──────────────────────────────────────

describe('analyzeFootprint — PROOF only (claims are never evidence)', () => {
  it('uses the harness result, NOT the chosen tool name, to decide error vs success', () => {
    // Same harness PROOF (is_error: true) under two different model-chosen tool
    // names → both still errors. The CLAIM (tool_name) does not move the verdict.
    const session: TraceSession = {
      session_id: 's',
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'totally_fine_tool', tool_output: { is_error: true } },
        },
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'scary_sounding_tool', tool_output: { is_error: false } },
        },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.toolErrors).toBe(1);
    expect(fp.outcomes[0].isError).toBe(true); // is_error:true wins despite friendly name
    expect(fp.outcomes[1].isError).toBe(false); // is_error:false wins despite scary name
  });

  it('treats a non-zero exit_code as an error even without is_error', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 't', tool_output: { exit_code: 2 } } },
        { event_type: 'tool_call', tool_call: { tool_name: 't', tool_output: { exit_code: 0 } } },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.outcomes.map((o) => o.isError)).toEqual([true, false]);
  });

  it('ignores model narration and decision_trace entirely (CLAIM, not counted)', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'llm_call', output_data: { text: 'I definitely succeeded at everything' } },
        {
          event_type: 'decision',
          decision_trace: { reasoning: 'all good', confidence: 0.99 },
        },
      ],
    };
    const fp = analyzeFootprint(session);
    // No tool calls at all → no error/recovery signal can be fabricated by text.
    expect(fp.toolCalls).toBe(0);
    expect(fp.toolErrors).toBe(0);
    expect(fp.totalEvents).toBe(2);
  });

  it('does NOT mutate the input session (read-only toward trace data)', () => {
    const session = loadSession('build-retry-recover');
    const before = JSON.stringify(session);
    analyzeFootprint(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it('accepts an already-ingested TraceProvenance without re-ingesting', () => {
    const tp = ingestTrace(loadSession('build-retry-recover'));
    const fromProvenance = analyzeFootprint(tp);
    const fromSession = analyzeFootprint(loadSession('build-retry-recover'));
    // Behavioural signals (steps/errors/timing) are identical either way — they
    // come from per-event PROOF records that both paths share.
    expect(fromProvenance.toolCalls).toBe(fromSession.toolCalls);
    expect(fromProvenance.toolErrors).toBe(fromSession.toolErrors);
    expect(fromProvenance.toolDurationMs).toBe(fromSession.toolDurationMs);
    expect(fromProvenance.longestRetryStreak).toBe(fromSession.longestRetryStreak);
    // Tokens differ by design: with the raw session we use the collector rollup
    // (total_tokens_*, the authoritative PROOF); with only the provenance we
    // fall back to summing per-event token meters. In this fixture the rollup
    // (5200) intentionally exceeds the per-event sum (1500+2000=3500).
    expect(fromSession.tokensIn).toBe(5200);
    expect(fromProvenance.tokensIn).toBe(3500);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────────

describe('analyzeFootprint — edge cases', () => {
  it('handles a run with no tool calls (rate 0, recovery 1)', () => {
    const fp = analyzeFootprint({ events: [{ event_type: 'llm_call' }] });
    expect(fp.toolCalls).toBe(0);
    expect(fp.toolErrorRate).toBe(0);
    expect(fp.recoveryRate).toBe(1);
    expect(fp.outcomes).toEqual([]);
  });

  it('excludes a trailing error from recovery debt (no later call to recover with)', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: false } } },
        { event_type: 'tool_call', tool_call: { tool_name: 'b', tool_output: { is_error: true } } },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.toolErrors).toBe(1);
    // The final error has no subsequent tool call → not counted as unrecovered.
    expect(fp.recoveredErrors).toBe(0);
    expect(fp.unrecoveredErrors).toBe(0);
    expect(fp.recoveryRate).toBe(1);
  });

  it('flags an unrecovered error when no later call succeeds', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: true } } },
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: true } } },
      ],
    };
    const fp = analyzeFootprint(session);
    // First error has a later call (also failing) → unrecovered. Second is trailing.
    expect(fp.recoveredErrors).toBe(0);
    expect(fp.unrecoveredErrors).toBe(1);
    expect(fp.recoveryRate).toBe(0);
  });

  it('falls back to summing per-event token meters when no session rollup is present', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'llm_call', tokens_in: 100, tokens_out: 40 },
        { event_type: 'llm_call', tokens_in: 50, tokens_out: 10 },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.tokensIn).toBe(150);
    expect(fp.tokensOut).toBe(50);
  });

  it('tolerates missing tool durations (counts what is present)', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: false } } },
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'b', tool_output: { is_error: false }, duration_ms: 250 },
        },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.toolDurationMs).toBe(250);
  });

  it('treats a null or non-object tool_output as not-an-error', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: null } },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.outcomes[0].isError).toBe(false);
    expect(fp.toolErrors).toBe(0);
  });
});

// ─── Threshold flags + proof-only predicates ────────────────────────────────────

describe('footprint threshold flags and predicates', () => {
  it('trips withinStepBudget / excessiveErrors / thrashing against options', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'), {
      maxToolCalls: 3,
      maxToolErrorRate: 0.3,
      maxRetryStreak: 1,
    });
    expect(fp.withinStepBudget).toBe(false); // 5 > 3
    expect(fp.excessiveErrors).toBe(true); // 0.4 > 0.3
    expect(fp.thrashing).toBe(true); // streak 2 > 1
  });

  it('defaults to permissive thresholds (no budget, half-error tolerance)', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    expect(fp.withinStepBudget).toBe(true); // Infinity budget
    expect(fp.excessiveErrors).toBe(false); // 0.4 <= 0.5
    expect(fp.thrashing).toBe(false); // streak 2 <= 2
  });

  it('predicates give a stable mechanical verdict over PROOF', () => {
    const fp = analyzeFootprint(loadSession('build-retry-recover'));
    expect(toCompleteWithinSteps(fp, 5)).toBe(true);
    expect(toCompleteWithinSteps(fp, 4)).toBe(false);
    expect(toHaveToolErrorRateBelow(fp, 0.4)).toBe(true);
    expect(toHaveToolErrorRateBelow(fp, 0.39)).toBe(false);
    expect(toNotThrash(fp, 2)).toBe(true);
    expect(toNotThrash(fp, 1)).toBe(false);
    expect(toRecoverFromErrors(fp)).toBe(true);
  });

  it('toRecoverFromErrors is false when an error never recovers', () => {
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: true } } },
        { event_type: 'tool_call', tool_call: { tool_name: 'a', tool_output: { is_error: true } } },
      ],
    };
    expect(toRecoverFromErrors(analyzeFootprint(session))).toBe(false);
  });
});

// ─── Malformed / partial provenance (robustness over imperfect traces) ──────────
//
// Real traces are imperfect: a harness may log a tool RESULT (PROOF) but omit
// the chosen tool_name (CLAIM), emit a partial token rollup, or carry a
// non-numeric timing/exit field. The footprint must stay mechanical and never
// crash, NaN-poison an aggregate, or silently invent a success/failure. These
// pin that behaviour so a later refactor can't regress it.

describe('analyzeFootprint — malformed / partial provenance', () => {
  it('labels a tool result with no tool_name as <unknown> and still groups a same-tool retry streak', () => {
    // PROOF (tool_output) is present but the CLAIM (tool_name) was never emitted.
    // The fallback label must be stable so two un-named errored calls still count
    // as the SAME tool for retry-streak attribution (PROOF drives the verdict;
    // the missing label only affects grouping, and it groups deterministically).
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_output: { is_error: true } } },
        { event_type: 'tool_call', tool_call: { tool_output: { is_error: true } } },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.outcomes.map((o) => o.toolName)).toEqual(['<unknown>', '<unknown>']);
    expect(fp.toolErrors).toBe(2);
    // Same fallback label on both → a retry streak of 2 (the first errored).
    expect(fp.longestRetryStreak).toBe(2);
    expect(fp.retryCount).toBe(1);
  });

  it('treats an empty-string tool_name as <unknown> (no zero-length label leaks through)', () => {
    // The ingest guard keeps `<unknown>` for an empty tool_name, so the label is
    // never a confusing '' in a summary or retry attribution.
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: '', tool_output: { is_error: false } } },
      ],
    };
    expect(analyzeFootprint(session).outcomes[0].toolName).toBe('<unknown>');
  });

  it('counts a non-finite exit_code (NaN) as an error — a garbage exit is not a pass', () => {
    // isErrorResult admits any non-zero numeric exit_code; NaN is `typeof
    // number` and `!== 0`, so it is treated as an error. This is deliberate:
    // absence of a clean exit_code 0 must never be scored as success.
    const session: TraceSession = {
      events: [
        { event_type: 'tool_call', tool_call: { tool_name: 't', tool_output: { exit_code: NaN } } },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.outcomes[0].isError).toBe(true);
    expect(fp.toolErrors).toBe(1);
  });

  it('ignores a non-numeric duration_ms instead of NaN-poisoning the total', () => {
    // numericValue rejects a non-finite/non-number duration, so a malformed
    // timing field contributes 0 — the aggregate stays a clean number.
    const session: TraceSession = {
      events: [
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'a', tool_output: { is_error: false }, duration_ms: 'fast' as unknown as number },
        },
        {
          event_type: 'tool_call',
          tool_call: { tool_name: 'b', tool_output: { is_error: false }, duration_ms: 120 },
        },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(Number.isFinite(fp.toolDurationMs)).toBe(true);
    expect(fp.toolDurationMs).toBe(120);
  });

  it('handles a PARTIAL token rollup per-direction (rollup for one, per-event sum for the other)', () => {
    // Only total_tokens_in is present on the session. tokensIn uses that PROOF
    // rollup; tokensOut independently falls back to summing the per-event PROOF
    // meters — the two directions are resolved separately, not all-or-nothing.
    const session: TraceSession = {
      total_tokens_in: 999,
      events: [
        { event_type: 'llm_call', tokens_in: 10, tokens_out: 7 },
        { event_type: 'llm_call', tokens_in: 5, tokens_out: 3 },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.tokensIn).toBe(999); // authoritative rollup
    expect(fp.tokensOut).toBe(10); // 7 + 3 per-event fallback
  });

  it('ignores a non-finite token rollup and falls back to the per-event sum', () => {
    // A NaN rollup is not a usable PROOF number → numericValue rejects it and the
    // per-event meters are summed instead (no NaN leaks into the footprint).
    const session: TraceSession = {
      total_tokens_in: NaN,
      events: [
        { event_type: 'llm_call', tokens_in: 4, tokens_out: 2 },
        { event_type: 'llm_call', tokens_in: 6, tokens_out: 1 },
      ],
    };
    const fp = analyzeFootprint(session);
    expect(fp.tokensIn).toBe(10); // 4 + 6 (rollup rejected)
    expect(fp.tokensOut).toBe(3); // 2 + 1
  });
});
