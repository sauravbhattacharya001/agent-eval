/**
 * Tests for the claude-code-action execution-file adapter — Phase 4 CI Integration.
 *
 * The adapter is pure parsing of the on-disk `claude-execution-output.json`
 * (a `Turn[]` JSON array, as written by claude-code-action's
 * `base-action/src/execution-file.ts` and read in `run.ts`'s cleanup phase).
 * These tests pin:
 *   1. parseCcaExecutionLog — total parsing (valid array, malformed JSON, non-array).
 *   2. extractCcaRun — output selection (result turn vs. assistant text vs. none),
 *      run-detail extraction (cost/duration/error), and the synthesised timeline
 *      (start/output/tool/end events; missing-end on abandoned runs).
 *   3. extractCcaRunFromFile → evaluateCiRun — the full seam: a real execution
 *      log becomes a gated ActionEvaluation, a clean on-topic run passes, and an
 *      abandoned no-result run trips staleness.
 */

import { describe, expect, it } from 'vitest';

import {
  parseCcaExecutionLog,
  extractCcaRun,
  extractCcaRunFromFile,
  type CcaTurn,
} from '../src/action/cca-execution.js';
import { evaluateCiRun } from '../src/action/ci-run.js';
import { toActionOutputs } from '../src/action/adapter.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

const REVIEW_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation in
limiter.ts for correctness, verify the Redis cache key expiry is set, and flag
any race conditions in the concurrent request handling.`;

// A realistic, well-formed execution log: a system init turn, an assistant turn
// that calls a tool, a user turn carrying the tool_result, a final assistant
// turn with the visible review prose, and the closing `result` turn that the
// action keys cost/duration off.
const GOOD_LOG: CcaTurn[] = [
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: "Let me read the limiter implementation." },
        { type: 'tool_use', name: 'Read', id: 'tu_1', input: { file_path: 'src/limiter.ts' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'export function refill() { /* ... */ }' },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `## Review

### Token bucket
The token bucket refill logic in \`limiter.ts\` line 42 is correct — it computes
the refill from elapsed time and clamps to capacity.

### Redis expiry
I confirmed the Redis cache key sets an expiry. Consider \`SET ... EX\` atomically
to avoid a crash window between SET and EXPIRE that leaves a key without a TTL.

### Race condition
There is a race in the concurrent request path in \`auth/login.ts\` line 88 — two
requests can both read the bucket before either writes it back. Suggest a Lua
script or WATCH/MULTI to make the read-modify-write atomic.`,
        },
      ],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result:
      'Reviewed the rate limiting PR: token bucket in limiter.ts is correct, ' +
      'flagged a missing-TTL window on the Redis key, and a race condition in ' +
      'auth/login.ts line 88 around the concurrent read-modify-write.',
    total_cost_usd: 0.0123,
    duration_ms: 45000,
    duration_api_ms: 31000,
    num_turns: 4,
  },
];

// ─── parseCcaExecutionLog ────────────────────────────────────────────────────

describe('parseCcaExecutionLog', () => {
  it('parses a well-formed JSON array of turns', () => {
    const log = parseCcaExecutionLog(JSON.stringify(GOOD_LOG));
    expect(log).toHaveLength(GOOD_LOG.length);
    expect(log[log.length - 1].type).toBe('result');
  });

  it('returns [] for malformed JSON (never throws)', () => {
    expect(parseCcaExecutionLog('{not json')).toEqual([]);
    expect(parseCcaExecutionLog('')).toEqual([]);
  });

  it('returns [] for valid JSON that is not an array', () => {
    expect(parseCcaExecutionLog('{"type":"result"}')).toEqual([]);
    expect(parseCcaExecutionLog('42')).toEqual([]);
    expect(parseCcaExecutionLog('null')).toEqual([]);
  });

  it('drops non-object array elements', () => {
    const log = parseCcaExecutionLog('[1, "x", null, {"type":"result"}]');
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('result');
  });
});

// ─── extractCcaRun: output selection ─────────────────────────────────────────

describe('extractCcaRun — output selection', () => {
  it('prefers the final result-turn text as the output', () => {
    const x = extractCcaRun(GOOD_LOG, { prompt: REVIEW_PROMPT });
    expect(x.outputSource).toBe('result');
    expect(x.output).toContain('auth/login.ts line 88');
    expect(x.resultText).toBe(x.output);
    expect(x.prompt).toBe(REVIEW_PROMPT);
  });

  it('falls back to concatenated assistant text when there is no result turn', () => {
    const noResult = GOOD_LOG.filter((t) => t.type !== 'result');
    const x = extractCcaRun(noResult, { prompt: REVIEW_PROMPT });
    expect(x.outputSource).toBe('assistant-text');
    // The visible review prose is preserved …
    expect(x.output).toContain('Token bucket');
    expect(x.output).toContain('Race condition');
    // … and the result text is absent.
    expect(x.resultText).toBeUndefined();
  });

  it('reports "none" with empty output when there is no text anywhere', () => {
    const x = extractCcaRun([{ type: 'system', subtype: 'init' }]);
    expect(x.outputSource).toBe('none');
    expect(x.output).toBe('');
    expect(x.prompt).toBe('');
  });

  it('collects assistant text separately from the result text', () => {
    const x = extractCcaRun(GOOD_LOG);
    expect(x.assistantText).toContain('Let me read the limiter implementation.');
    expect(x.assistantText).toContain('## Review');
    // Assistant text never folds in tool_result content.
    expect(x.assistantText).not.toContain('export function refill');
  });
});

// ─── extractCcaRun: run details ──────────────────────────────────────────────

describe('extractCcaRun — result details', () => {
  it('extracts cost / duration / turns from the result turn', () => {
    const x = extractCcaRun(GOOD_LOG);
    expect(x.details.subtype).toBe('success');
    expect(x.details.isError).toBe(false);
    expect(x.details.totalCostUsd).toBeCloseTo(0.0123);
    expect(x.details.durationMs).toBe(45000);
    expect(x.details.durationApiMs).toBe(31000);
    expect(x.details.numTurns).toBe(4);
  });

  it('flags is_error and error_* subtypes as errored runs', () => {
    const errLog: CcaTurn[] = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial work' }] } },
      { type: 'result', subtype: 'error_max_turns', is_error: true },
    ];
    const x = extractCcaRun(errLog);
    expect(x.details.isError).toBe(true);
    expect(x.details.subtype).toBe('error_max_turns');
  });

  it('leaves details empty (non-error) when there is no result turn', () => {
    const noResult = GOOD_LOG.filter((t) => t.type !== 'result');
    const x = extractCcaRun(noResult);
    expect(x.details.isError).toBe(false);
    expect(x.details.totalCostUsd).toBeUndefined();
    expect(x.details.durationMs).toBeUndefined();
  });
});

// ─── extractCcaRun: synthesised timeline ─────────────────────────────────────

describe('extractCcaRun — timeline synthesis', () => {
  it('emits a start event, output/tool events, and an end event for a complete run', () => {
    const x = extractCcaRun(GOOD_LOG, { syntheticStartMs: 1_000_000, syntheticStepMs: 1000 });
    const types = x.timeline.events?.map((e) => e.type) ?? [];
    expect(types[0]).toBe('start');
    expect(types).toContain('output');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    // A result turn closes the timeline with an `end` event AND endedAt.
    expect(types[types.length - 1]).toBe('end');
    expect(x.timeline.endedAt).toBeDefined();
  });

  it('leaves endedAt unset when the run never reached a result turn (abandoned)', () => {
    const noResult = GOOD_LOG.filter((t) => t.type !== 'result');
    const x = extractCcaRun(noResult);
    expect(x.timeline.endedAt).toBeUndefined();
    expect(x.timeline.events?.some((e) => e.type === 'end')).toBe(false);
  });

  it('uses turn-supplied timestamps when present', () => {
    const stamped: CcaTurn[] = [
      { type: 'assistant', timestamp: '2026-06-11T00:00:01.000Z', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', timestamp: '2026-06-11T00:00:09.000Z', subtype: 'success', result: 'done' },
    ];
    const x = extractCcaRun(stamped, { syntheticStartMs: 5_000_000 });
    const out = x.timeline.events?.find((e) => e.type === 'output');
    const end = x.timeline.events?.find((e) => e.type === 'end');
    expect(out?.timestamp).toBe('2026-06-11T00:00:01.000Z');
    expect(end?.timestamp).toBe('2026-06-11T00:00:09.000Z');
  });

  it('mirrors the chosen output onto timeline.output', () => {
    const x = extractCcaRun(GOOD_LOG);
    expect(x.timeline.output).toBe(x.output);
  });
});

// ─── extractCcaRunFromFile → evaluateCiRun (the full seam) ───────────────────

describe('extractCcaRunFromFile → evaluateCiRun', () => {
  const FIXED_NOW = new Date('2026-06-11T00:00:00.000Z');

  it('a clean on-topic run with a result turn passes the gate', () => {
    const x = extractCcaRunFromFile(JSON.stringify(GOOD_LOG), { prompt: REVIEW_PROMPT });
    const { evaluation, checks } = evaluateCiRun({
      prompt: x.prompt,
      output: x.output,
      timeline: x.timeline,
      worker: 'claude-review',
      now: FIXED_NOW,
    });
    expect(evaluation.passed).toBe(true);
    // All four checks present and none failing.
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
    // The evaluation is the standard ActionEvaluation shape (drops into emit /
    // toActionOutputs unchanged).
    expect(evaluation.verdicts.map((v) => v.worker)).toContain('claude-review');
    const outputs = toActionOutputs(evaluation);
    expect(outputs.eval_passed).toBe('true');
  });

  it('an empty/no-output run fails (completeness)', () => {
    const emptyLog: CcaTurn[] = [
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: '' },
    ];
    const x = extractCcaRunFromFile(JSON.stringify(emptyLog), { prompt: REVIEW_PROMPT });
    expect(x.output).toBe('');
    const { evaluation } = evaluateCiRun({
      prompt: x.prompt,
      output: x.output,
      timeline: x.timeline,
      now: FIXED_NOW,
    });
    expect(evaluation.passed).toBe(false);
  });

  it('an on-topic but no-op acknowledgement trips staleness even with a result turn', () => {
    const noopLog: CcaTurn[] = [
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result:
          'I reviewed the rate limiting pull request for the authentication login ' +
          'endpoint, including the token bucket and the Redis cache expiry, and the ' +
          'concurrent request handling. Overall this looks reasonable to me. Nice work.',
        total_cost_usd: 0.004,
        duration_ms: 8000,
      },
    ];
    const x = extractCcaRunFromFile(JSON.stringify(noopLog), { prompt: REVIEW_PROMPT });
    expect(x.outputSource).toBe('result');
    const { evaluation, staleness } = evaluateCiRun({
      prompt: x.prompt,
      output: x.output,
      timeline: x.timeline,
      now: FIXED_NOW,
    });
    // On-topic enough to clear coverage/relevance, but no actionable artifacts.
    expect(staleness.artifacts.count).toBeLessThan(2);
    expect(evaluation.passed).toBe(false);
  });

  it('a malformed execution file yields empty output and a failing (no substance) gate', () => {
    const x = extractCcaRunFromFile('totally not json', { prompt: REVIEW_PROMPT });
    expect(x.output).toBe('');
    expect(x.outputSource).toBe('none');
    const { evaluation } = evaluateCiRun({
      prompt: x.prompt,
      output: x.output,
      timeline: x.timeline,
      now: FIXED_NOW,
    });
    expect(evaluation.passed).toBe(false);
  });
});
