/**
 * Unit tests for the fluent tool-definition builder (`defineTool` / `ToolBuilder`).
 *
 * `defineTool`/`ToolBuilder` is a leaf module (`providers/agent-tools.ts`) extracted
 * from `providers/agent.ts` and re-exported from `agent.js`, so the public import
 * path `./providers/agent.js` is unchanged. The behavioural suite in
 * `agent-provider.test.ts` reaches this builder only in passing (to construct tools
 * for the agentic loop) and pins just two happy-path cases. These tests pin the
 * builder's own contract directly — the JSON-schema shape it emits, the defaults,
 * the fluent-identity of each chaining method, and builder isolation — so the leaf
 * module can be refactored with confidence.
 *
 * Imported from `agent-tools.js` (its OWN module) to also pin the seam: the builder
 * must be importable from the leaf it lives in, not only transitively via `agent.js`.
 */
import { describe, it, expect } from 'vitest';
import { defineTool, ToolBuilder } from '../src/providers/agent-tools.js';

type Params = {
  type: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
};

describe('defineTool / ToolBuilder', () => {
  it('defineTool returns a ToolBuilder instance', () => {
    expect(defineTool('x')).toBeInstanceOf(ToolBuilder);
  });

  it('emits a JSON-schema "object" params shape', () => {
    const tool = defineTool('noop').execute(async () => 'ok');
    const params = tool.parameters as Params;
    expect(params.type).toBe('object');
    expect(params.properties).toEqual({});
    expect(params.required).toEqual([]);
  });

  it('defaults description to empty string when describe() is not called', () => {
    const tool = defineTool('bare').execute(async () => 'ok');
    expect(tool.name).toBe('bare');
    expect(tool.description).toBe('');
  });

  it('stores each param type + description under properties', () => {
    const tool = defineTool('lookup')
      .param('q', 'string', 'the query', true)
      .param('limit', 'number', 'max results', false)
      .execute(async () => 'ok');
    const params = tool.parameters as Params;
    expect(params.properties.q).toEqual({ type: 'string', description: 'the query' });
    expect(params.properties.limit).toEqual({ type: 'number', description: 'max results' });
  });

  it('param() defaults required to false when the flag is omitted', () => {
    const tool = defineTool('opt')
      .param('a', 'string', 'a (required)', true)
      .param('b', 'string', 'b (implicitly optional)')
      .execute(async () => 'ok');
    const params = tool.parameters as Params;
    expect(params.required).toEqual(['a']);
    expect(params.properties.b).toEqual({ type: 'string', description: 'b (implicitly optional)' });
  });

  it('records required params in declaration order', () => {
    const tool = defineTool('multi')
      .param('first', 'string', 'first', true)
      .param('skip', 'string', 'skip', false)
      .param('second', 'string', 'second', true)
      .execute(async () => 'ok');
    expect((tool.parameters as Params).required).toEqual(['first', 'second']);
  });

  it('describe() and param() are fluent (return the same builder)', () => {
    const b = new ToolBuilder('chain');
    expect(b.describe('d')).toBe(b);
    expect(b.param('p', 'string', 'p')).toBe(b);
  });

  it('last describe() wins when called more than once', () => {
    const tool = defineTool('rename')
      .describe('first')
      .describe('final')
      .execute(async () => 'ok');
    expect(tool.description).toBe('final');
  });

  it('execute() attaches the runnable function returning its result', async () => {
    const tool = defineTool('echo')
      .param('text', 'string', 'text', true)
      .execute(async (args) => `got:${args.text as string}`);
    await expect(tool.execute({ text: 'hi' })).resolves.toBe('got:hi');
  });

  it('builds independent params objects per builder (no shared mutable state)', () => {
    const a = defineTool('a').param('x', 'string', 'x', true).execute(async () => 'a');
    const b = defineTool('b').param('y', 'number', 'y', false).execute(async () => 'b');
    const pa = a.parameters as Params;
    const pb = b.parameters as Params;
    expect(Object.keys(pa.properties)).toEqual(['x']);
    expect(Object.keys(pb.properties)).toEqual(['y']);
    expect(pa.required).toEqual(['x']);
    expect(pb.required).toEqual([]);
    expect(pa.properties).not.toBe(pb.properties);
  });
});
