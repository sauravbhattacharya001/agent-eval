import { describe, it, expect } from 'vitest';

import { parseLangSmith, triageLangSmith } from '../src/adapters/langsmith.js';
import type { LangSmithRun } from '../src/adapters/langsmith.js';

/**
 * Direct tests for the LangSmith run-export adapter
 * (`src/adapters/langsmith.ts`) — a Tier-1 deterministic parser that maps a
 * LangSmith/LangChain run tree into agent-eval's neutral `BuiltSession` shape.
 *
 * The adapter is a public barrel export (`parseLangSmith` / `triageLangSmith`)
 * and had no direct coverage: these pins lock in its format detection (array /
 * `{ runs: [...] }` / single-object / NDJSON), trace grouping, leaf-token
 * accounting, and the clean-vs-abandoned-vs-timeout-vs-error determination that
 * fleet triage depends on. Every expected value was validated against the
 * compiled adapter before being asserted here.
 */

/** Build a minimal LangSmith run record with sensible defaults. */
function run(over: Partial<LangSmithRun> & { id: string }): LangSmithRun {
  return {
    trace_id: over.trace_id ?? over.id,
    parent_run_id: null,
    run_type: 'chain',
    start_time: '2026-07-01T00:00:00Z',
    end_time: '2026-07-01T00:00:01Z',
    status: 'success',
    ...over,
  };
}

describe('parseLangSmith — input format detection', () => {
  it('returns [] for empty or whitespace-only text', () => {
    expect(parseLangSmith('')).toEqual([]);
    expect(parseLangSmith('   \n  \t ')).toEqual([]);
  });

  it('parses a top-level JSON array of runs', () => {
    const sessions = parseLangSmith(JSON.stringify([run({ id: 'r1', trace_id: 't1' })]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('t1');
  });

  it('parses a { runs: [...] } wrapper object', () => {
    const text = JSON.stringify({ runs: [run({ id: 'r1', trace_id: 'tw' })] });
    const sessions = parseLangSmith(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('tw');
  });

  it('parses a single bare run object (has id, no runs array)', () => {
    const text = JSON.stringify(run({ id: 'solo', trace_id: 'S', inputs: 'do a thing' }));
    const sessions = parseLangSmith(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('S');
    expect(sessions[0]?.meta.label).toBe('do a thing');
  });

  it('falls back to run values when an object has neither runs[] nor id', () => {
    // A map keyed by run id, values are runs (a "last resort" shape).
    const text = JSON.stringify({
      a: run({ id: 'a', trace_id: 'A' }),
      b: run({ id: 'b', trace_id: 'B' }),
    });
    const sessions = parseLangSmith(text);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.meta.sessionId).sort()).toEqual(['A', 'B']);
  });

  it('throws on a malformed top-level array (a real error, not silent-empty)', () => {
    expect(() => parseLangSmith('[ not json')).toThrow();
  });
});

describe('parseLangSmith — NDJSON (newline-delimited runs)', () => {
  it('parses object-per-line NDJSON even though each line starts with {', () => {
    // Regression: object-per-line NDJSON begins with `{`, so a naive single-object
    // parse of the whole blob throws on line 2. The adapter must fall back to
    // line-by-line parsing (this is the exact format `langsmith trace export` emits).
    const ndjson = [
      JSON.stringify(run({ id: 'x', trace_id: 'N', run_type: 'chain', inputs: 'q' })),
      JSON.stringify(run({ id: 'y', trace_id: 'N', parent_run_id: 'x', run_type: 'llm', total_tokens: 5 })),
    ].join('\n');
    const sessions = parseLangSmith(ndjson);
    expect(sessions).toHaveLength(1);
    // The two lines share a trace → one session; the leaf llm run's tokens are summed.
    expect(sessions[0]?.meta.tokenUsage).toBe(5);
  });

  it('skips a malformed NDJSON line instead of aborting the whole parse', () => {
    const ndjson = [
      JSON.stringify(run({ id: 'x', trace_id: 'N', run_type: 'chain', inputs: 'q' })),
      '{ this is : not valid json',
      JSON.stringify(run({ id: 'y', trace_id: 'N', parent_run_id: 'x', run_type: 'llm', total_tokens: 7 })),
    ].join('\n');
    const sessions = parseLangSmith(ndjson);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.tokenUsage).toBe(7);
  });

  it('handles a single NDJSON line (one object) as one session', () => {
    const one = JSON.stringify(run({ id: 'z', trace_id: 'Z', inputs: 'z' }));
    expect(parseLangSmith(one)).toHaveLength(1);
  });
});

describe('parseLangSmith — trace grouping', () => {
  it('groups all runs sharing a trace_id into ONE session', () => {
    const text = JSON.stringify([
      run({ id: 'root', trace_id: 'tg', run_type: 'chain', inputs: 'q' }),
      run({ id: 'c1', trace_id: 'tg', parent_run_id: 'root', run_type: 'llm', total_tokens: 30 }),
      run({ id: 'c2', trace_id: 'tg', parent_run_id: 'root', run_type: 'tool', name: 'search', inputs: { q: 'x' } }),
    ]);
    const sessions = parseLangSmith(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('tg');
  });

  it('produces one session per distinct trace', () => {
    const text = JSON.stringify([
      run({ id: 'a', trace_id: 'A', inputs: 'a' }),
      run({ id: 'b', trace_id: 'B', inputs: 'b' }),
    ]);
    expect(parseLangSmith(text)).toHaveLength(2);
  });

  it('falls back to the run id as the trace key when trace_id is absent', () => {
    const text = JSON.stringify([
      { ...run({ id: 'lonely' }), trace_id: undefined },
    ]);
    const sessions = parseLangSmith(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('lonely');
  });

  it('records tool-call signatures for tool/retriever runs', () => {
    const text = JSON.stringify([
      run({ id: 'root', trace_id: 'tg', run_type: 'chain', inputs: 'q' }),
      run({ id: 'c2', trace_id: 'tg', parent_run_id: 'root', run_type: 'tool', name: 'search', inputs: { q: 'x' } }),
    ]);
    const meta = parseLangSmith(text)[0]?.meta;
    expect(meta?.toolCallSignatures).toEqual(['search({"q":"x"})']);
  });
});

describe('parseLangSmith — token accounting', () => {
  it('sums leaf llm-run tokens rather than double-counting the chain rollup', () => {
    // A chain root reports a rollup of 100; its two llm leaves report 30 + 40.
    // Naively summing every run would double-count → the adapter prefers leaves.
    const text = JSON.stringify([
      run({ id: 'root', trace_id: 't', run_type: 'chain', total_tokens: 100, inputs: 'q' }),
      run({ id: 'l1', trace_id: 't', parent_run_id: 'root', run_type: 'llm', total_tokens: 30 }),
      run({ id: 'l2', trace_id: 't', parent_run_id: 'root', run_type: 'llm', total_tokens: 40 }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.tokenUsage).toBe(70);
  });

  it('falls back to the root rollup when no llm leaf reports usage', () => {
    const text = JSON.stringify([run({ id: 'root', trace_id: 't', run_type: 'chain', total_tokens: 100, inputs: 'q' })]);
    expect(parseLangSmith(text)[0]?.meta.tokenUsage).toBe(100);
  });

  it('reads token usage from prompt_tokens + completion_tokens', () => {
    const text = JSON.stringify([
      run({ id: 'l', trace_id: 't', run_type: 'llm', prompt_tokens: 12, completion_tokens: 8, total_tokens: undefined }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.tokenUsage).toBe(20);
  });

  it('reads token usage from the outputs.llm_output.token_usage fallback', () => {
    const text = JSON.stringify([
      run({
        id: 'l', trace_id: 't', run_type: 'llm', total_tokens: undefined,
        outputs: { llm_output: { token_usage: { prompt_tokens: 7, completion_tokens: 3 } } },
      }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.tokenUsage).toBe(10);
  });
});

describe('parseLangSmith — outcome classification', () => {
  it('marks a clean, fully-finished trace as endedCleanly with no abort signal', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', run_type: 'chain', status: 'success', inputs: 'q', total_tokens: 100 }),
    ]);
    const meta = parseLangSmith(text)[0]?.meta;
    expect(meta?.endedCleanly).toBe(true);
    expect(meta?.abortedAny).toBe(false);
    expect(meta?.trajError).toBe(false);
    expect(meta?.trajTimedOut).toBe(false);
    expect(meta?.trajFinalStatus).toBe('success');
    expect(meta?.source).toBe('trajectory');
    expect(meta?.hadTrajectory).toBe(true);
  });

  it('treats a run missing its end_time as abandoned (not cleanly ended)', () => {
    const text = JSON.stringify([
      { ...run({ id: 'r', trace_id: 't', inputs: 'q' }), end_time: null },
    ]);
    const meta = parseLangSmith(text)[0]?.meta;
    expect(meta?.endedCleanly).toBe(false);
    expect(meta?.trajAborted).toBe(true);
    expect(meta?.abortedAny).toBe(true);
    expect(meta?.trajTimedOut).toBe(false);
  });

  it('infers a timeout when an error string uses timeout/deadline language', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', run_type: 'llm', error: 'Read timed out after 60s' }),
    ]);
    const meta = parseLangSmith(text)[0]?.meta;
    expect(meta?.trajTimedOut).toBe(true);
    expect(meta?.trajError).toBe(true);
    expect(meta?.errorEvents).toBe(1);
    expect(meta?.abortedAny).toBe(true);
  });

  it('flags a generic error WITHOUT marking it a timeout', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', run_type: 'llm', error: 'KeyError: foo' }),
    ]);
    const meta = parseLangSmith(text)[0]?.meta;
    expect(meta?.trajError).toBe(true);
    expect(meta?.trajTimedOut).toBe(false);
    expect(meta?.endedCleanly).toBe(false);
  });
});

describe('parseLangSmith — runtime + label', () => {
  it('computes runtimeMs from start_time → latest end_time (ISO strings)', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', start_time: '2026-07-01T00:00:00Z', end_time: '2026-07-01T00:00:05Z', inputs: 'q' }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.runtimeMs).toBe(5000);
  });

  it('coerces epoch-seconds timestamps into milliseconds', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', start_time: 1751328000, end_time: 1751328005, inputs: 'q' }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.runtimeMs).toBe(5000);
  });

  it('derives the session label from a messages-array input', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', inputs: { messages: [{ content: 'hello world' }] } }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.label).toBe('hello world');
  });

  it('falls back to a placeholder label when no user line is present', () => {
    const text = JSON.stringify([
      run({ id: 'r', trace_id: 't', inputs: undefined }),
    ]);
    expect(parseLangSmith(text)[0]?.meta.label).toBe('(no task line)');
  });
});

describe('triageLangSmith — convenience wrapper', () => {
  it('parses and triages in one call, scanning each session', () => {
    const clean = JSON.stringify([run({ id: 'r', trace_id: 't', status: 'success', inputs: 'q', total_tokens: 100 })]);
    const report = triageLangSmith(clean);
    expect(report.scanned).toBe(1);
    expect(report.byKind).toBeTypeOf('object');
    expect(Array.isArray(report.rows)).toBe(true);
  });

  it('scans an abandoned run (missing end_time) as a session', () => {
    const noEnd = JSON.stringify([{ ...run({ id: 'r', trace_id: 't', inputs: 'q' }), end_time: null }]);
    expect(triageLangSmith(noEnd).scanned).toBe(1);
  });

  it('returns an empty report for empty input', () => {
    const report = triageLangSmith('');
    expect(report.scanned).toBe(0);
    expect(report.flagged).toBe(0);
    expect(report.rows).toEqual([]);
  });
});
