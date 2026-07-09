import { describe, it, expect } from 'vitest';

import { parseOtlp, triageOtlp } from '../src/adapters/otlp.js';
import type { OtlpTrace } from '../src/adapters/otlp.js';

/**
 * Direct tests for the OpenTelemetry (OTLP) trace adapter
 * (`src/adapters/otlp.ts`) — a Tier-1 deterministic parser that maps OTLP GenAI
 * spans into agent-eval's neutral `BuiltSession` shape. This is the
 * standard-format adapter: any OTel-native LLM tracer (Arize Phoenix, Traceloop /
 * OpenLLMetry, the raw OTel GenAI SDK) emits these spans, so one adapter covers
 * the whole ecosystem.
 *
 * `parseOtlp` / `triageOtlp` are public barrel exports and previously had no
 * automated coverage (only a manual `dist`-based smoke script). These pins lock
 * in: the OTLP typed-KV value decoding, session grouping by
 * `gen_ai.conversation.id` (fallback `traceId`), leaf-token accounting from the
 * GenAI usage conventions, nanosecond→ms timing, the `finish_reasons` cap →
 * timeout heuristic, error detection (status code or exception event), the
 * missing-end → abandoned determination, tool-call signatures, and the input
 * envelope handling (single payload / array / NDJSON) that fleet triage depends on.
 *
 * Every expected value was validated against the compiled adapter before being
 * asserted here.
 */

/** 1 millisecond expressed in nanoseconds (OTLP timestamps are nanosecond strings). */
const MS = 1e6;

/** Encode a value into an OTLP `AnyValue`. */
function anyValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { intValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((v) => anyValue(v)) } };
  return {};
}

interface SpanSpec {
  conv?: string;
  traceId?: string;
  spanId?: string;
  name?: string;
  startMs?: number;
  endMs?: number;
  inTok?: number;
  outTok?: number;
  promptTok?: number;
  completionTok?: number;
  finish?: string[];
  op?: string;
  model?: string;
  toolName?: string;
  toolArgs?: unknown;
  /** Set `status.code = STATUS_CODE_ERROR`. */
  error?: boolean;
  /** Attach an `exception` event `[type, message]`. */
  exception?: [string, string];
}

/** Build one OTLP span from a compact spec. */
function span(spec: SpanSpec): Record<string, unknown> {
  const attributes: Array<Record<string, unknown>> = [];
  const add = (key: string, value: unknown) => {
    if (value !== undefined) attributes.push({ key, value: anyValue(value) });
  };
  add('gen_ai.conversation.id', spec.conv);
  add('gen_ai.usage.input_tokens', spec.inTok);
  add('gen_ai.usage.output_tokens', spec.outTok);
  add('gen_ai.usage.prompt_tokens', spec.promptTok);
  add('gen_ai.usage.completion_tokens', spec.completionTok);
  if (spec.finish) add('gen_ai.response.finish_reasons', spec.finish);
  add('gen_ai.operation.name', spec.op);
  add('gen_ai.request.model', spec.model);
  add('gen_ai.tool.name', spec.toolName);
  add('gen_ai.tool.call.arguments', spec.toolArgs);

  const s: Record<string, unknown> = {
    traceId: spec.traceId,
    spanId: spec.spanId ?? 's',
    name: spec.name ?? 'span',
    attributes,
  };
  if (spec.startMs !== undefined) s.startTimeUnixNano = String(spec.startMs * MS);
  if (spec.endMs !== undefined) s.endTimeUnixNano = String(spec.endMs * MS);
  if (spec.error) s.status = { code: 'STATUS_CODE_ERROR' };
  if (spec.exception) {
    s.events = [
      {
        name: 'exception',
        attributes: [
          { key: 'exception.type', value: anyValue(spec.exception[0]) },
          { key: 'exception.message', value: anyValue(spec.exception[1]) },
        ],
      },
    ];
  }
  return s;
}

/** Wrap spans in a single OTLP/HTTP trace payload. */
function payload(...spans: Array<Record<string, unknown>>): string {
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
}

describe('parseOtlp — input envelope detection', () => {
  it('returns [] for empty or whitespace-only text', () => {
    expect(parseOtlp('')).toEqual([]);
    expect(parseOtlp('   \n \t ')).toEqual([]);
  });

  it('parses a single { resourceSpans: [...] } payload', () => {
    const text = payload(span({ conv: 'c1', traceId: 'T', inTok: 100, outTok: 50, startMs: 1000, endMs: 3000 }));
    const sessions = parseOtlp(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('c1');
  });

  it('parses a top-level JSON array of payloads', () => {
    const p1 = JSON.parse(payload(span({ conv: 'a', traceId: 'A', inTok: 1, startMs: 1, endMs: 2 }))) as OtlpTrace;
    const p2 = JSON.parse(payload(span({ conv: 'b', traceId: 'B', inTok: 2, startMs: 1, endMs: 2 }))) as OtlpTrace;
    expect(parseOtlp(JSON.stringify([p1, p2]))).toHaveLength(2);
  });

  it('accepts the legacy instrumentationLibrarySpans key (OTel <=0.x)', () => {
    const text = JSON.stringify({
      resourceSpans: [{ instrumentationLibrarySpans: [{ spans: [span({ conv: 'ils', traceId: 'T', inTok: 4, startMs: 1, endMs: 2 })] }] }],
    });
    const sessions = parseOtlp(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('ils');
  });

  it('throws on a malformed top-level array (a real error, not silent-empty)', () => {
    expect(() => parseOtlp('[ not json')).toThrow();
  });
});

describe('parseOtlp — NDJSON (payload per line)', () => {
  // Regression: a real OTLP payload begins with `{`, so payload-per-line NDJSON also
  // begins with `{`. A naive single-object parse of the whole blob throws on line 2.
  // The adapter must fall back to line-by-line parsing (mirroring the LangSmith adapter),
  // otherwise the documented "NDJSON with one payload per line" input never works.
  it('parses payload-per-line NDJSON even though each line starts with {', () => {
    const p1 = payload(span({ conv: 'n1', traceId: 'A', inTok: 1, startMs: 1, endMs: 2 }));
    const p2 = payload(span({ conv: 'n2', traceId: 'B', inTok: 2, startMs: 1, endMs: 2 }));
    const sessions = parseOtlp(`${p1}\n${p2}`);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.meta.sessionId).sort()).toEqual(['n1', 'n2']);
  });

  it('skips a malformed NDJSON line instead of aborting the whole parse', () => {
    const p1 = payload(span({ conv: 'n1', traceId: 'A', inTok: 1, startMs: 1, endMs: 2 }));
    const p2 = payload(span({ conv: 'n2', traceId: 'B', inTok: 2, startMs: 1, endMs: 2 }));
    const sessions = parseOtlp(`${p1}\n{ this is : not valid json\n${p2}`);
    expect(sessions).toHaveLength(2);
  });

  it('still parses a single payload that has leading whitespace', () => {
    const text = `  \n${payload(span({ conv: 'ws', traceId: 'T', inTok: 1, startMs: 1, endMs: 2 }))}`;
    expect(parseOtlp(text)).toHaveLength(1);
  });
});

describe('parseOtlp — session grouping', () => {
  it('groups spans sharing a gen_ai.conversation.id into ONE session', () => {
    const text = payload(
      span({ conv: 'g', traceId: 'A', inTok: 10, startMs: 1000, endMs: 2000 }),
      span({ conv: 'g', traceId: 'B', outTok: 5, startMs: 2000, endMs: 4000 }),
    );
    const sessions = parseOtlp(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.meta.sessionId).toBe('g');
    // Session token usage sums across both spans; runtime spans first-start → last-end.
    expect(sessions[0]?.meta.tokenUsage).toBe(15);
    expect(sessions[0]?.meta.runtimeMs).toBe(3000);
  });

  it('falls back to traceId when no conversation id is present', () => {
    const text = payload(span({ traceId: 'TR', inTok: 1, outTok: 1, startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.sessionId).toBe('TR');
  });

  it('produces one session per distinct conversation', () => {
    const text = payload(
      span({ conv: 'A', traceId: 'A', inTok: 1, startMs: 1, endMs: 2 }),
      span({ conv: 'B', traceId: 'B', inTok: 1, startMs: 1, endMs: 2 }),
    );
    expect(parseOtlp(text)).toHaveLength(2);
  });
});

describe('parseOtlp — token accounting (GenAI usage conventions)', () => {
  it('sums input_tokens + output_tokens across spans', () => {
    const text = payload(
      span({ conv: 'm', traceId: 'T', inTok: 10, outTok: 5, startMs: 1, endMs: 2 }),
      span({ conv: 'm', traceId: 'T', inTok: 1, outTok: 1, startMs: 2, endMs: 3 }),
    );
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.tokenUsage).toBe(17);
    // msgTokenMax is the largest single-span token count (15), not the total.
    expect(meta?.msgTokenMax).toBe(15);
  });

  it('reads the legacy prompt_tokens / completion_tokens keys', () => {
    const text = payload(span({ conv: 'leg', traceId: 'T', promptTok: 7, completionTok: 3, startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.tokenUsage).toBe(10);
  });
});

describe('parseOtlp — outcome classification', () => {
  it('marks a clean, fully-finished span as endedCleanly', () => {
    const text = payload(span({ conv: 'c', traceId: 'T', inTok: 100, outTok: 50, op: 'chat', model: 'gpt-4', startMs: 1000, endMs: 3000 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.endedCleanly).toBe(true);
    expect(meta?.trajError).toBe(false);
    expect(meta?.trajTimedOut).toBe(false);
    expect(meta?.trajAborted).toBe(false);
    expect(meta?.abortedAny).toBe(false);
    expect(meta?.trajFinalStatus).toBe('success');
    expect(meta?.source).toBe('trajectory');
    expect(meta?.hadTrajectory).toBe(true);
  });

  it('infers a timeout when a finish_reason hits the token cap (length / max_tokens)', () => {
    const text = payload(span({ conv: 'cap', traceId: 'T', inTok: 5, outTok: 5, finish: ['length'], startMs: 1, endMs: 2 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.trajTimedOut).toBe(true);
    // A capped-but-otherwise-complete span still ended (no error, no missing end).
    expect(meta?.endedCleanly).toBe(true);
  });

  it('flags a span whose status.code is STATUS_CODE_ERROR', () => {
    const text = payload(span({ conv: 'e', traceId: 'T', error: true, startMs: 1, endMs: 2 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.trajError).toBe(true);
    expect(meta?.errorEvents).toBe(1);
    expect(meta?.endedCleanly).toBe(false);
    expect(meta?.abortedAny).toBe(true);
    expect(meta?.trajFinalStatus).toBe('error');
  });

  it('flags a span carrying an exception event and surfaces its message', () => {
    const text = payload(span({ conv: 'x', traceId: 'T', exception: ['ValueError', 'boom'], startMs: 1, endMs: 2 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.errorEvents).toBe(1);
    expect(meta?.trajError).toBe(true);
    expect(meta?.allAssistantText).toContain('ValueError: boom');
  });

  it('treats a span missing its end time as abandoned (not cleanly ended)', () => {
    const text = payload(span({ conv: 'a', traceId: 'T', inTok: 3, startMs: 1000 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.trajAborted).toBe(true);
    expect(meta?.endedCleanly).toBe(false);
    expect(meta?.abortedAny).toBe(true);
  });
});

describe('parseOtlp — tool-call signatures', () => {
  it('records a signature for execute_tool spans using the semantic tool name + args', () => {
    const text = payload(span({ conv: 'tl', traceId: 'T', name: 'raw-span-name', op: 'execute_tool', toolName: 'search', toolArgs: '{"q":"hi"}', startMs: 1, endMs: 2 }));
    // The tool name comes from gen_ai.tool.name (not the raw span name); args are appended.
    expect(parseOtlp(text)[0]?.meta.toolCallSignatures).toEqual(['search("{\\"q\\":\\"hi\\"}")']);
  });

  it('falls back to the tool name alone when no arguments were recorded', () => {
    const text = payload(span({ conv: 'tl', traceId: 'T', op: 'execute_tool', toolName: 'search', startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.toolCallSignatures).toEqual(['search()']);
  });

  it('falls back to the span name when the tool span has no gen_ai.tool.name', () => {
    const text = payload(span({ conv: 'tl', traceId: 'T', name: 'raw-span-name', op: 'execute_tool', startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.toolCallSignatures).toEqual(['raw-span-name()']);
  });

  it('does not record a tool signature for a non-tool span', () => {
    const text = payload(span({ conv: 's', traceId: 'T', op: 'chat', model: 'gpt-4', startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.toolCallSignatures).toEqual([]);
  });
});

describe('parseOtlp — label + timeline', () => {
  it('labels the session "<model> session" when a chat span carries a model', () => {
    const text = payload(span({ conv: 'lbl', traceId: 'T', name: 'my-span', op: 'chat', model: 'claude-3', startMs: 1, endMs: 2 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.label).toBe('claude-3 session');
    // The model is also annotated into the assistant text.
    expect(meta?.allAssistantText).toContain('my-span (claude-3)');
  });

  it('falls back to the first span name for the label when no chat model is present', () => {
    const text = payload(span({ conv: 'lbl2', traceId: 'T', name: 'my-span', startMs: 1, endMs: 2 }));
    expect(parseOtlp(text)[0]?.meta.label).toBe('my-span');
  });

  it('emits a start → output → end event timeline for a single clean span', () => {
    const text = payload(span({ conv: 'tl', traceId: 'T', op: 'chat', model: 'gpt-4', startMs: 1, endMs: 2 }));
    const meta = parseOtlp(text)[0]?.meta;
    expect(meta?.eventCount).toBe(3);
    expect(meta?.lastType).toBe('end');
  });
});

describe('triageOtlp — convenience wrapper', () => {
  it('parses and triages in one call, scanning each session', () => {
    const text = payload(span({ conv: 't', traceId: 'T', inTok: 1_000_000, outTok: 250_000, finish: ['length'], startMs: 1, endMs: 2 }));
    const report = triageOtlp(text, { dollarsPerMillionTokens: 9, costlyTokenThreshold: 100_000 });
    expect(report.scanned).toBe(1);
    expect(report.byKind).toBeTypeOf('object');
    expect(Array.isArray(report.rows)).toBe(true);
    // The 1.25M-token span is flagged and priced.
    expect(report.flagged).toBe(1);
    expect(report.rows[0]?.tokenUsage).toBe(1_250_000);
    expect(report.rows[0]?.projectedCostUsd).toBeGreaterThan(0);
  });

  it('returns an empty report for empty input', () => {
    const report = triageOtlp('');
    expect(report.scanned).toBe(0);
    expect(report.flagged).toBe(0);
    expect(report.rows).toEqual([]);
  });
});
