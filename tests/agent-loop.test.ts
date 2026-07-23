import { describe, it, expect } from 'vitest';
import { executeToolCalls, type RequestedToolCall } from '../src/providers/agent-loop.js';
import type { ToolDefinition } from '../src/providers/agent-types.js';

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, execute };
}

function call(name: string, args: string, id = `call_${name}`): RequestedToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

describe('executeToolCalls', () => {
  it('runs a registered tool and captures name, parsed args, and result', async () => {
    const map = new Map([[ 'echo', tool('echo', async (a) => `got ${JSON.stringify(a)}`) ]]);
    const res = await executeToolCalls([call('echo', '{"x":1}')], map);

    expect(res.capturedCalls).toHaveLength(1);
    expect(res.capturedCalls[0]).toMatchObject({
      name: 'echo',
      arguments: { x: 1 },
      result: 'got {"x":1}',
    });
    expect(typeof res.capturedCalls[0].durationMs).toBe('number');
    expect(res.capturedCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits a tool_call + tool_result event pair per call, truncated to 500 chars', async () => {
    const big = 'z'.repeat(1000);
    const map = new Map([[ 'big', tool('big', async () => big) ]]);
    const res = await executeToolCalls([call('big', '{}')], map);

    expect(res.events.map(e => e.type)).toEqual(['tool_call', 'tool_result']);
    expect(res.events[0].content).toBe('big({})');
    // tool_result content is "big: " + first 500 chars of result
    expect(res.events[1].content).toBe(`big: ${'z'.repeat(500)}`);
  });

  it('appends one tool message per call keyed by tool_call_id', async () => {
    const map = new Map([[ 'echo', tool('echo', async () => 'ok') ]]);
    const res = await executeToolCalls([call('echo', '{}', 'call_42')], map);

    expect(res.toolMessages).toEqual([
      { role: 'tool', content: 'ok', tool_call_id: 'call_42' },
    ]);
  });

  it('reports an unknown tool as an error result without throwing', async () => {
    const res = await executeToolCalls([call('missing', '{}')], new Map());
    expect(res.capturedCalls[0].result).toBe('Error: Unknown tool "missing"');
    expect(res.toolMessages[0].content).toBe('Error: Unknown tool "missing"');
  });

  it('captures a thrown tool error as an error result string', async () => {
    const map = new Map([[ 'boom', tool('boom', async () => { throw new Error('kaboom'); }) ]]);
    const res = await executeToolCalls([call('boom', '{}')], map);
    expect(res.capturedCalls[0].result).toBe('Error: kaboom');
  });

  it('defaults empty arguments to {} on the captured call', async () => {
    const map = new Map([[ 'noargs', tool('noargs', async () => 'done') ]]);
    const res = await executeToolCalls([call('noargs', '')], map);
    expect(res.capturedCalls[0].arguments).toEqual({});
  });

  it('preserves order across multiple calls', async () => {
    const map = new Map([
      ['a', tool('a', async () => 'ra')],
      ['b', tool('b', async () => 'rb')],
    ]);
    const res = await executeToolCalls([call('a', '{}', 'i1'), call('b', '{}', 'i2')], map);
    expect(res.capturedCalls.map(c => c.name)).toEqual(['a', 'b']);
    expect(res.toolMessages.map(m => m.tool_call_id)).toEqual(['i1', 'i2']);
    expect(res.events.map(e => e.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
  });

  it('returns empty results for an empty call list', async () => {
    const res = await executeToolCalls([], new Map());
    expect(res.capturedCalls).toEqual([]);
    expect(res.events).toEqual([]);
    expect(res.toolMessages).toEqual([]);
  });
});
