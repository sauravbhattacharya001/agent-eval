import { describe, it, expect } from 'vitest';

import {
  TIMEOUT_RE,
  toMs,
  runTokens,
  extractLabel,
  eventType,
  type LangSmithRun,
} from '../src/adapters/langsmith-fields.js';

/**
 * Direct unit tests for the LangSmith per-run field helpers
 * (`src/adapters/langsmith-fields.ts`) — the pure, single-run primitives split
 * out of `langsmith.ts`. These lock in the field-level semantics (timestamp
 * coercion, token fallbacks, label extraction, run_type→event mapping, timeout
 * matching) independently of trace grouping, so a future refactor of either half
 * can't silently drift the other.
 */

function run(over: Partial<LangSmithRun> = {}): LangSmithRun {
  return { id: 'r1', ...over };
}

describe('langsmith-fields: TIMEOUT_RE', () => {
  it('matches explicit timeout/deadline phrasings (case-insensitive)', () => {
    for (const s of [
      'Request timed out',
      'TIMEOUT after 60s',
      'deadline exceeded',
      'ETIMEDOUT',
      'read timed out',
      'operation time-out',
    ]) {
      expect(TIMEOUT_RE.test(s)).toBe(true);
    }
  });

  it('does not match generic failures', () => {
    for (const s of ['rate limit exceeded', 'invalid api key', 'connection refused']) {
      expect(TIMEOUT_RE.test(s)).toBe(false);
    }
  });
});

describe('langsmith-fields: toMs', () => {
  it('returns NaN for null/undefined', () => {
    expect(toMs(null)).toBeNaN();
    expect(toMs(undefined)).toBeNaN();
  });

  it('treats sub-1e12 numbers as epoch seconds and larger as ms', () => {
    expect(toMs(1_000)).toBe(1_000_000); // seconds → ms
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000); // already ms
  });

  it('parses ISO strings and NaNs unparseable ones', () => {
    expect(toMs('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(toMs('not a date')).toBeNaN();
  });
});

describe('langsmith-fields: runTokens', () => {
  it('prefers a numeric total_tokens', () => {
    expect(runTokens(run({ total_tokens: 42, prompt_tokens: 5 }))).toBe(42);
  });

  it('sums prompt + completion when total is absent', () => {
    expect(runTokens(run({ prompt_tokens: 10, completion_tokens: 7 }))).toBe(17);
  });

  it('falls back to outputs.llm_output.token_usage', () => {
    expect(runTokens(run({ outputs: { llm_output: { token_usage: { total_tokens: 9 } } } }))).toBe(9);
    expect(
      runTokens(run({ outputs: { llm_output: { token_usage: { prompt_tokens: 4, completion_tokens: 3 } } } })),
    ).toBe(7);
  });

  it('falls back to extra.metadata.total_tokens, else 0', () => {
    expect(runTokens(run({ extra: { metadata: { total_tokens: 12 } } }))).toBe(12);
    expect(runTokens(run())).toBe(0);
  });
});

describe('langsmith-fields: extractLabel', () => {
  it('uses a raw string input', () => {
    expect(extractLabel(run({ inputs: 'summarize this' }))).toBe('summarize this');
  });

  it('probes common object keys in order', () => {
    // 'input' is probed before 'question', so it wins when both are present.
    expect(extractLabel(run({ inputs: { input: 'the input', question: 'why?' } }))).toBe('the input');
    expect(extractLabel(run({ inputs: { question: 'why?' } }))).toBe('why?');
    expect(extractLabel(run({ inputs: { prompt: 'do the thing' } }))).toBe('do the thing');
  });

  it('reads the last message content when messages[] present', () => {
    expect(
      extractLabel(run({ inputs: { messages: [{ content: 'first' }, { content: 'last one' }] } })),
    ).toBe('last one');
  });

  it('returns a placeholder when there is no usable input', () => {
    expect(extractLabel(run({ inputs: undefined }))).toBe('(no task line)');
  });
});

describe('langsmith-fields: eventType', () => {
  it('maps tool/retriever to tool_call and llm/chain to output', () => {
    expect(eventType(run({ run_type: 'tool' }))).toBe('tool_call');
    expect(eventType(run({ run_type: 'retriever' }))).toBe('tool_call');
    expect(eventType(run({ run_type: 'llm' }))).toBe('output');
    expect(eventType(run({ run_type: 'chain' }))).toBe('output');
  });

  it('passes through an unknown run_type and defaults to output when absent', () => {
    expect(eventType(run({ run_type: 'agent' }))).toBe('agent');
    expect(eventType(run())).toBe('output');
  });
});
