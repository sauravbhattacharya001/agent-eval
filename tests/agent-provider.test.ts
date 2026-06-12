import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentProvider, defineTool, agentContext } from '../src/providers/agent.js';

// ─── MOCK FETCH ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(responses: Array<{
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  finish_reason?: string;
  tokens?: { prompt: number; completion: number };
}>) {
  let callIndex = 0;
  globalThis.fetch = vi.fn(async () => {
    const resp = responses[callIndex]!;
    callIndex++;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: resp.content,
            tool_calls: resp.tool_calls,
          },
          finish_reason: resp.finish_reason ?? 'stop',
        }],
        usage: resp.tokens
          ? { prompt_tokens: resp.tokens.prompt, completion_tokens: resp.tokens.completion, total_tokens: resp.tokens.prompt + resp.tokens.completion }
          : { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function mockFetchError(status: number, body: string) {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => { /* fresh state */ });
afterEach(() => { globalThis.fetch = originalFetch; });

// ─── BASIC PROVIDER ─────────────────────────────────────────────────────────────

describe('AgentProvider', () => {
  const baseConfig = {
    llm: {
      type: 'azure-openai' as const,
      endpoint: 'https://test.openai.azure.com',
      apiKey: 'test-key',
      deployment: 'gpt-4o',
    },
  };

  describe('single-turn (no tools)', () => {
    it('returns model response as output', async () => {
      mockFetch([{ content: 'Hello, world!', finish_reason: 'stop' }]);
      const provider = new AgentProvider(baseConfig);

      const output = await provider.generate('Say hello');
      expect(output).toBe('Hello, world!');
    });

    it('captures timeline events', async () => {
      mockFetch([{ content: 'Done', finish_reason: 'stop' }]);
      const provider = new AgentProvider(baseConfig);

      const result = await provider.run('Test');
      expect(result.timeline.events!.length).toBeGreaterThanOrEqual(3); // start, output, end
      expect(result.timeline.events![0]!.type).toBe('start');
      expect(result.timeline.events![result.timeline.events!.length - 1]!.type).toBe('end');
    });

    it('records token usage', async () => {
      mockFetch([{ content: 'Hi', tokens: { prompt: 10, completion: 5 } }]);
      const provider = new AgentProvider(baseConfig);

      const result = await provider.run('Hi');
      expect(result.totalTokens.prompt).toBe(10);
      expect(result.totalTokens.completion).toBe(5);
      expect(result.totalTokens.total).toBe(15);
    });

    it('marks run as completed', async () => {
      mockFetch([{ content: 'Done' }]);
      const provider = new AgentProvider(baseConfig);

      const result = await provider.run('Task');
      expect(result.completed).toBe(true);
      expect(result.stopReason).toBe('complete');
    });

    it('stores lastRun for timeline access', async () => {
      mockFetch([{ content: 'Result' }]);
      const provider = new AgentProvider(baseConfig);

      expect(provider.lastRun).toBeNull();
      await provider.generate('Test');
      expect(provider.lastRun).not.toBeNull();
      expect(provider.lastRun!.output).toBe('Result');
    });
  });

  describe('multi-turn with tools', () => {
    it('executes tool calls and continues', async () => {
      const readFile = defineTool('read_file')
        .describe('Read a file')
        .param('path', 'string', 'File path', true)
        .execute(async (args) => `content of ${args.path}`);

      mockFetch([
        // Turn 1: model calls read_file
        {
          content: 'Let me read that file.',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path": "test.ts"}' },
          }],
          finish_reason: 'tool_calls',
        },
        // Turn 2: model gives final answer
        {
          content: 'The file contains: content of test.ts',
          finish_reason: 'stop',
        },
      ]);

      const provider = new AgentProvider({ ...baseConfig, tools: [readFile] });
      const result = await provider.run('Read test.ts');

      expect(result.turns).toHaveLength(2);
      expect(result.turns[0]!.toolCalls).toHaveLength(1);
      expect(result.turns[0]!.toolCalls[0]!.name).toBe('read_file');
      expect(result.turns[0]!.toolCalls[0]!.result).toBe('content of test.ts');
      expect(result.output).toBe('The file contains: content of test.ts');
    });

    it('captures tool_call and tool_result events in timeline', async () => {
      const tool = defineTool('ping')
        .describe('Ping')
        .execute(async () => 'pong');

      mockFetch([
        {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
          finish_reason: 'tool_calls',
        },
        { content: 'Got pong', finish_reason: 'stop' },
      ]);

      const provider = new AgentProvider({ ...baseConfig, tools: [tool] });
      const result = await provider.run('Ping');

      const types = result.timeline.events!.map(e => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
    });

    it('handles tool execution errors gracefully', async () => {
      const failTool = defineTool('fail')
        .describe('Always fails')
        .execute(async () => { throw new Error('Tool exploded'); });

      mockFetch([
        {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fail', arguments: '{}' } }],
          finish_reason: 'tool_calls',
        },
        { content: 'Tool failed, sorry', finish_reason: 'stop' },
      ]);

      const provider = new AgentProvider({ ...baseConfig, tools: [failTool] });
      const result = await provider.run('Do it');

      expect(result.turns[0]!.toolCalls[0]!.result).toContain('Error: Tool exploded');
      expect(result.completed).toBe(true);
    });

    it('handles unknown tool gracefully', async () => {
      mockFetch([
        {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'nonexistent', arguments: '{}' } }],
          finish_reason: 'tool_calls',
        },
        { content: 'Ah, that tool does not exist', finish_reason: 'stop' },
      ]);

      const provider = new AgentProvider(baseConfig);
      const result = await provider.run('Use nonexistent');

      expect(result.turns[0]!.toolCalls[0]!.result).toContain('Unknown tool');
    });
  });

  describe('limits and stop conditions', () => {
    it('stops at maxIterations', async () => {
      // Model always calls tools — would loop forever
      const tool = defineTool('loop')
        .describe('Loop')
        .execute(async () => 'again');

      const infiniteResponses = Array(20).fill({
        content: 'calling again',
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'loop', arguments: '{}' } }],
        finish_reason: 'tool_calls',
      });

      mockFetch(infiniteResponses);

      const provider = new AgentProvider({ ...baseConfig, tools: [tool], maxIterations: 3 });
      const result = await provider.run('Loop forever');

      expect(result.turns).toHaveLength(3);
      expect(result.stopReason).toBe('max_iterations');
      expect(result.completed).toBe(false);
    });

    it('stops on API error', async () => {
      mockFetchError(429, 'Rate limited');
      const provider = new AgentProvider(baseConfig);

      const result = await provider.run('Trigger error');
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('429');
      expect(result.completed).toBe(false);
    });
  });

  describe('output assembly', () => {
    it('returns last turn content by default', async () => {
      mockFetch([
        {
          content: 'Thinking...',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
          finish_reason: 'tool_calls',
        },
        { content: 'Final answer', finish_reason: 'stop' },
      ]);

      const tool = defineTool('x').describe('x').execute(async () => 'ok');
      const provider = new AgentProvider({ ...baseConfig, tools: [tool] });

      const output = await provider.generate('Test');
      expect(output).toBe('Final answer');
    });

    it('includes tool results when configured', async () => {
      mockFetch([
        {
          content: 'Reading...',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
          finish_reason: 'tool_calls',
        },
        { content: 'Done', finish_reason: 'stop' },
      ]);

      const tool = defineTool('x').describe('x').execute(async () => 'tool output');
      const provider = new AgentProvider({ ...baseConfig, tools: [tool], includeToolResults: true });

      const output = await provider.generate('Test');
      expect(output).toContain('tool output');
      expect(output).toContain('Done');
    });
  });

  describe('agentContext helper', () => {
    it('extracts timeline from run result', async () => {
      mockFetch([{ content: 'Done' }]);
      const provider = new AgentProvider(baseConfig);
      const result = await provider.run('Test');

      const ctx = agentContext(result);
      expect(ctx.metadata.timeline).toBe(result.timeline);
      expect(ctx.metadata.turns).toBe(result.turns);
      expect(ctx.metadata.tokens).toBe(result.totalTokens);
    });
  });
});

// ─── TOOL BUILDER ───────────────────────────────────────────────────────────────

describe('defineTool', () => {
  it('builds a complete tool definition', () => {
    const tool = defineTool('search')
      .describe('Search the web')
      .param('query', 'string', 'Search query', true)
      .param('limit', 'number', 'Max results', false)
      .execute(async (args) => `Results for: ${args.query}`);

    expect(tool.name).toBe('search');
    expect(tool.description).toBe('Search the web');
    expect((tool.parameters as { required: string[] }).required).toContain('query');
    expect((tool.parameters as { required: string[] }).required).not.toContain('limit');
  });

  it('execute function works', async () => {
    const tool = defineTool('echo')
      .describe('Echo')
      .param('text', 'string', 'Text', true)
      .execute(async (args) => args.text as string);

    const result = await tool.execute({ text: 'hello' });
    expect(result).toBe('hello');
  });
});
