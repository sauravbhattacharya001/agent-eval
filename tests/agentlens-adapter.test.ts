import { describe, it, expect } from 'vitest';

import { parseAgentLens, triageAgentLens } from '../src/adapters/agentlens.js';
import type { AgentLensExport } from '../src/adapters/agentlens.js';

/**
 * Direct tests for the AgentLens export adapter (`src/adapters/agentlens.ts`) — a
 * Tier-1 deterministic parser that maps an AgentLens session export
 * (`{ session, stats, events }`, the JSON `SessionExporter.as_json()` emits) into
 * agent-eval's neutral `BuiltSession` shape. This closes the loop between the two
 * tools: AgentLens records the run, agent-eval grades it.
 *
 * `parseAgentLens` / `triageAgentLens` are public barrel exports and previously
 * had no automated coverage (only a manual `dist`-based smoke script). These pins
 * lock in: the pre-computed `stats` token/duration/error accounting and its
 * events-based fallbacks, the runtime floor from event `duration_ms`, the
 * status→verdict mapping (`completed`/`active`/`error`), the never-ended →
 * abandoned/timeout determination, label derivation, reasoning carry-through,
 * tool-call signatures, and the export-envelope handling (single object / array /
 * NDJSON) fleet triage depends on.
 *
 * Every expected value was validated against the compiled adapter before being
 * asserted here.
 */

/** Serialize an AgentLens export the way the SDK writes it. */
function exp(e: AgentLensExport): string {
  return JSON.stringify(e);
}

const completed: AgentLensExport = {
  session: {
    session_id: 'als-clean',
    agent_name: 'bot',
    status: 'completed',
    started_at: '2026-01-01T00:00:00Z',
    ended_at: '2026-01-01T00:00:05Z',
  },
  stats: { total_tokens: 10 },
};

describe('parseAgentLens — envelope handling', () => {
  it('returns nothing for empty / whitespace text', () => {
    expect(parseAgentLens('')).toEqual([]);
    expect(parseAgentLens('   \n  ')).toEqual([]);
  });

  it('parses a single session object', () => {
    const s = parseAgentLens(exp(completed));
    expect(s).toHaveLength(1);
    expect(s[0].meta.sessionId).toBe('als-clean');
  });

  it('parses a JSON array of sessions', () => {
    const s = parseAgentLens(JSON.stringify([completed, { events: [] }]));
    expect(s).toHaveLength(2);
  });

  it('parses object-per-line NDJSON, skipping malformed lines', () => {
    // Regression: every AgentLens export line begins with `{`, so before the shared
    // dispatcher gained a `{`-leading NDJSON fallback this whole blob was routed into
    // the single-object branch and `JSON.parse` threw on the second line. NDJSON of
    // exports is a documented input, so it must round-trip.
    const ndjson = [
      exp(completed),
      'GARBAGE — not json',
      exp({ events: [{ event_type: 'llm_call', timestamp: '2026-01-01T00:00:01Z', tokens_in: 3, tokens_out: 4 }] }),
    ].join('\n');
    const s = parseAgentLens(ndjson);
    expect(s).toHaveLength(2);
    expect(s[0].meta.sessionId).toBe('als-clean');
  });

  it('a malformed single-line `{` blob yields no records (dropped as a bad NDJSON line)', () => {
    // A `{`-led blob that fails single-document parse is retried as NDJSON; a single
    // malformed line is then silently dropped, so the result is empty (not a throw).
    // Multi-line NDJSON still recovers its good lines (see the NDJSON test).
    expect(parseAgentLens('{ not: valid }')).toEqual([]);
  });
});

describe('parseAgentLens — token accounting', () => {
  it('prefers the pre-computed stats.total_tokens', () => {
    expect(parseAgentLens(exp(completed))[0].meta.tokenUsage).toBe(10);
  });

  it('falls back to total_tokens_in + total_tokens_out when total is absent', () => {
    const s = parseAgentLens(
      exp({ ...completed, stats: { total_tokens_in: 7, total_tokens_out: 8 } }),
    );
    expect(s[0].meta.tokenUsage).toBe(15);
  });

  it('falls back to summing per-event tokens when stats has none', () => {
    const s = parseAgentLens(
      exp({
        session: completed.session,
        events: [
          { event_type: 'llm_call', timestamp: '2026-01-01T00:00:01Z', tokens_in: 2, tokens_out: 3 },
          { event_type: 'llm_call', timestamp: '2026-01-01T00:00:01Z', tokens_in: 1, tokens_out: 1 },
        ],
      }),
    );
    expect(s[0].meta.tokenUsage).toBe(7);
    // msgTokenMax is the largest single-event in+out (2+3 = 5).
    expect(s[0].meta.msgTokenMax).toBe(5);
  });
});

describe('parseAgentLens — runtime', () => {
  it('prefers the pre-computed stats.session_duration_ms', () => {
    const s = parseAgentLens(exp({ ...completed, stats: { session_duration_ms: 12500, total_tokens: 1 } }));
    expect(s[0].meta.runtimeMs).toBe(12500);
  });

  it('derives runtime from ended_at - started_at when stats has no duration', () => {
    // completed spans 00:00:00 → 00:00:05 = 5000ms.
    expect(parseAgentLens(exp(completed))[0].meta.runtimeMs).toBe(5000);
  });

  it('floors runtime from event timestamp + duration_ms when there is no end', () => {
    const s = parseAgentLens(
      exp({
        session: { session_id: 'fl', status: 'active', started_at: '2026-01-01T00:00:00Z' },
        events: [
          {
            event_type: 'tool_call',
            timestamp: '2026-01-01T00:00:03Z',
            duration_ms: 2000,
            tool_call: { tool_name: 'grep', tool_input: { q: 'x' } },
          },
        ],
      }),
    );
    // last activity = event start (3000ms) + its duration (2000ms) = 5000ms.
    expect(s[0].meta.runtimeMs).toBe(5000);
  });
});

describe('parseAgentLens — verdict flags', () => {
  it('marks a completed, ended session clean', () => {
    const m = parseAgentLens(exp(completed))[0].meta;
    expect(m.endedCleanly).toBe(true);
    expect(m.abortedAny).toBe(false);
    expect(m.trajTimedOut).toBe(false);
  });

  it('marks a still-active never-ended session as timed-out / abandoned', () => {
    const m = parseAgentLens(
      exp({ session: { session_id: 'to', status: 'active', started_at: '2026-01-01T00:00:00Z' } }),
    )[0].meta;
    expect(m.trajTimedOut).toBe(true);
    expect(m.abortedAny).toBe(true);
    expect(m.endedCleanly).toBe(false);
  });

  it('detects errors via stats.error_count (not just error events)', () => {
    const m = parseAgentLens(exp({ ...completed, stats: { error_count: 2, total_tokens: 5 } }))[0].meta;
    expect(m.errorEvents).toBe(2);
    expect(m.trajError).toBe(true);
    expect(m.endedCleanly).toBe(false);
    expect(m.abortedAny).toBe(true);
    // an errored (not merely never-ended) session is NOT classed as a timeout.
    expect(m.trajTimedOut).toBe(false);
  });

  it('detects errors via an error event when stats omits the count', () => {
    const m = parseAgentLens(
      exp({
        session: { session_id: 'ee', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:02Z' },
        events: [{ event_type: 'error', timestamp: '2026-01-01T00:00:01Z', output_data: 'boom' }],
      }),
    )[0].meta;
    expect(m.errorEvents).toBe(1);
    expect(m.trajError).toBe(true);
  });
});

describe('parseAgentLens — labels, text & tool signatures', () => {
  it('derives the label from the first event input prompt field', () => {
    const m = parseAgentLens(
      exp({
        session: { session_id: 'lb', agent_name: 'bot', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:01Z' },
        events: [
          {
            event_type: 'tool_call',
            timestamp: '2026-01-01T00:00:00Z',
            input_data: { prompt: 'do the thing' },
            tool_call: { tool_name: 't', reasoning: 'because' },
          },
        ],
      }),
    )[0].meta;
    expect(m.label).toBe('do the thing');
    // reasoning is carried into the assistant text alongside the tool name.
    expect(m.allAssistantText).toBe('t\nreasoning: because');
    expect(m.toolCallSignatures).toEqual(['t()']);
  });

  it('falls back to "<agent> session" when no event carries input', () => {
    const m = parseAgentLens(
      exp({ session: { session_id: 'lb2', agent_name: 'bot', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:01Z' }, events: [] }),
    )[0].meta;
    expect(m.label).toBe('bot session');
  });

  it('records a tool-call signature with its input', () => {
    const m = parseAgentLens(
      exp({
        session: { session_id: 'ts', status: 'completed', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:01Z' },
        events: [{ event_type: 'tool_call', timestamp: '2026-01-01T00:00:00Z', tool_call: { tool_name: 'grep', tool_input: { q: 'x' } } }],
      }),
    )[0].meta;
    expect(m.toolCallSignatures).toEqual(['grep({"q":"x"})']);
  });
});

describe('triageAgentLens — convenience wrapper', () => {
  it('parses and triages in one call, flagging a never-ended active session', () => {
    const report = triageAgentLens(
      exp({
        session: { session_id: 'fl', status: 'active', started_at: '2026-01-01T00:00:00Z' },
        events: [{ event_type: 'tool_call', timestamp: '2026-01-01T00:00:03Z', duration_ms: 2000, tool_call: { tool_name: 'grep', tool_input: { q: 'x' } } }],
      }),
      { staleOnly: false },
    );
    expect(report.scanned).toBe(1);
    expect(report.flagged).toBe(1);
  });

  it('does not flag a clean completed session', () => {
    const report = triageAgentLens(exp(completed), { staleOnly: false });
    expect(report.scanned).toBe(1);
    expect(report.flagged).toBe(0);
  });
});
