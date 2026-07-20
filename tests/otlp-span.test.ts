import { describe, it, expect } from 'vitest';

import {
  attrMap,
  decodeValue,
  asNumber,
  nanoToMs,
  normSpan,
  CAP_FINISH,
  type OtlpSpan,
} from '../src/adapters/otlp-span.js';

/**
 * Direct tests for the OTLP span-decoding leaf (`src/adapters/otlp-span.ts`),
 * the pure IO-free bottom layer extracted from the OTLP adapter. These pin the
 * value-decoding + span-normalisation seam independently of session assembly:
 * typed-KV `AnyValue` decoding (each variant + the array recursion + the
 * numeric-string `intValue` coercion), `attrMap` flattening, `asNumber`
 * guarding, nanosecond→ms conversion (incl. the NaN paths), and the full
 * `normSpan` mapping (token accounting from both current + legacy GenAI usage
 * keys, finish-reason normalisation, error detection via status code / exception
 * event, tool name + argument spelling fallbacks, conversation id fallback).
 *
 * Every expected value was validated against the compiled leaf before assertion.
 */

describe('otlp-span: decodeValue', () => {
  it('decodes each AnyValue variant', () => {
    expect(decodeValue({ stringValue: 'hi' })).toBe('hi');
    expect(decodeValue({ intValue: 7 })).toBe(7);
    expect(decodeValue({ intValue: '42' })).toBe(42);
    expect(decodeValue({ doubleValue: 1.5 })).toBe(1.5);
    expect(decodeValue({ boolValue: true })).toBe(true);
    expect(decodeValue({ arrayValue: { values: [{ stringValue: 'a' }, { intValue: '2' }] } })).toEqual([
      'a',
      2,
    ]);
  });

  it('returns undefined for empty / unknown values', () => {
    expect(decodeValue(undefined)).toBeUndefined();
    expect(decodeValue({})).toBeUndefined();
    expect(decodeValue({ arrayValue: {} })).toBeUndefined();
  });
});

describe('otlp-span: attrMap', () => {
  it('flattens a typed-KV list into a decoded map', () => {
    const m = attrMap([
      { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } },
    ]);
    expect(m.get('gen_ai.request.model')).toBe('gpt-4o');
    expect(m.get('gen_ai.usage.input_tokens')).toBe(10);
  });

  it('returns an empty map for undefined and skips keyless entries', () => {
    expect(attrMap(undefined).size).toBe(0);
    // @ts-expect-error deliberately malformed entry
    const m = attrMap([{ value: { stringValue: 'x' } }, { key: 'ok', value: { stringValue: 'y' } }]);
    expect(m.size).toBe(1);
    expect(m.get('ok')).toBe('y');
  });
});

describe('otlp-span: asNumber / nanoToMs', () => {
  it('asNumber only passes finite numbers', () => {
    expect(asNumber(5)).toBe(5);
    expect(asNumber('5')).toBe(0);
    expect(asNumber(NaN)).toBe(0);
    expect(asNumber(Infinity)).toBe(0);
    expect(asNumber(undefined)).toBe(0);
  });

  it('nanoToMs converts nanosecond strings and guards non-numeric input', () => {
    expect(nanoToMs('1000000')).toBe(1); // 1e6 ns = 1 ms
    expect(nanoToMs('1500000')).toBe(1); // floors
    expect(Number.isNaN(nanoToMs(undefined))).toBe(true);
    expect(Number.isNaN(nanoToMs('nope'))).toBe(true);
  });
});

describe('otlp-span: normSpan', () => {
  it('maps a clean chat span with current usage keys', () => {
    const span: OtlpSpan = {
      name: 'chat gpt-4o',
      traceId: 't1',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '3000000',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } },
        { key: 'gen_ai.usage.input_tokens', value: { intValue: '10' } },
        { key: 'gen_ai.usage.output_tokens', value: { intValue: '5' } },
        { key: 'gen_ai.conversation.id', value: { stringValue: 'conv-1' } },
        { key: 'gen_ai.response.finish_reasons', value: { arrayValue: { values: [{ stringValue: 'stop' }] } } },
      ],
    };
    const n = normSpan(span);
    expect(n.op).toBe('chat');
    expect(n.model).toBe('gpt-4o');
    expect(n.tokens).toBe(15);
    expect(n.startMs).toBe(1);
    expect(n.endMs).toBe(3);
    expect(n.conversationId).toBe('conv-1');
    expect(n.finishReasons).toEqual(['stop']);
    expect(n.isError).toBe(false);
    expect(n.exceptionMsg).toBe('');
  });

  it('falls back to legacy prompt/completion token keys', () => {
    const n = normSpan({
      name: 'legacy',
      attributes: [
        { key: 'gen_ai.usage.prompt_tokens', value: { intValue: '3' } },
        { key: 'gen_ai.usage.completion_tokens', value: { intValue: '4' } },
      ],
    });
    expect(n.tokens).toBe(7);
  });

  it('normalises a scalar finish_reason into an array', () => {
    const n = normSpan({
      name: 's',
      attributes: [{ key: 'gen_ai.response.finish_reasons', value: { stringValue: 'length' } }],
    });
    expect(n.finishReasons).toEqual(['length']);
    expect(n.finishReasons.some((r) => CAP_FINISH.has(r))).toBe(true);
  });

  it('detects error via status code and via exception event', () => {
    const byStatus = normSpan({ name: 'e', status: { code: 'STATUS_CODE_ERROR' } });
    expect(byStatus.isError).toBe(true);
    const byCode2 = normSpan({ name: 'e', status: { code: 2 } });
    expect(byCode2.isError).toBe(true);

    const byEvent = normSpan({
      name: 'e',
      events: [
        {
          name: 'exception',
          attributes: [
            { key: 'exception.type', value: { stringValue: 'ValueError' } },
            { key: 'exception.message', value: { stringValue: 'boom' } },
          ],
        },
      ],
    });
    expect(byEvent.exceptionMsg).toBe('ValueError: boom');
  });

  it('picks tool name + arguments from the first recorded vendor spelling', () => {
    const n = normSpan({
      name: 'execute_tool read',
      attributes: [
        { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
        { key: 'code.function.name', value: { stringValue: 'read_file' } },
        { key: 'tool.arguments', value: { stringValue: '{"path":"x"}' } },
      ],
    });
    expect(n.toolName).toBe('read_file');
    expect(n.toolArgs).toBe('{"path":"x"}');
  });

  it('falls back conversation id to session.id and applies span-name default', () => {
    const n = normSpan({ attributes: [{ key: 'session.id', value: { stringValue: 'sess-9' } }] });
    expect(n.conversationId).toBe('sess-9');
    expect(n.name).toBe('(span)');
    expect(Number.isNaN(n.startMs)).toBe(true);
  });
});
