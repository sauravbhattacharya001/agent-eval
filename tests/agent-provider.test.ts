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

    it('stops with a timeout stopReason when maxDurationMs is exceeded', async () => {
      // A negative budget guarantees the very first iteration's elapsed-time
      // guard (`elapsed > maxDurationMs`) trips before any LLM call. The fetch
      // mock is armed but must never be consulted — the loop must break on the
      // wall-clock guard, not on a model response.
      mockFetch([{ content: 'should never be read', finish_reason: 'stop' }]);
      const provider = new AgentProvider({ ...baseConfig, maxDurationMs: -1 });

      const result = await provider.run('Long task');

      expect(result.stopReason).toBe('timeout');
      expect(result.completed).toBe(false);
      // No turn was ever taken (we broke before the first LLM call)...
      expect(result.turns).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      // ...and the timeout is surfaced as an error event on the timeline,
      // sequenced between start and end, so staleness/timeout checks can see it.
      const types = (result.timeline.events ?? []).map((e) => e.type);
      expect(types[0]).toBe('start');
      expect(types[types.length - 1]).toBe('end');
      const errorEvent = (result.timeline.events ?? []).find((e) => e.type === 'error');
      expect(errorEvent?.content).toMatch(/^Timeout after \d+ms$/);
      // The end event still records the final stop reason as its content.
      expect((result.timeline.events ?? []).at(-1)?.content).toBe('timeout');
    });

    it('stops with an error when the LLM response contains no choices', async () => {
      // A syntactically-valid 200 response with an empty `choices` array is a
      // real failure mode (some gateways return this on a filtered/blocked
      // prompt). The loop must treat it as an error, not crash on `choices[0]`.
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }),
      })) as unknown as typeof fetch;
      const provider = new AgentProvider(baseConfig);

      const result = await provider.run('Blocked prompt');

      expect(result.stopReason).toBe('error');
      expect(result.error).toBe('LLM response contained no choices');
      expect(result.completed).toBe(false);
      expect(result.turns).toHaveLength(0);
      const errorEvent = (result.timeline.events ?? []).find((e) => e.type === 'error');
      expect(errorEvent?.content).toBe('LLM response contained no choices');
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

    it('recovers the original task prompt from the run timeline', async () => {
      mockFetch([{ content: 'Done' }]);
      const provider = new AgentProvider(baseConfig);
      const result = await provider.run('refactor the auth module');

      const ctx = agentContext(result);
      // Tier 2/3 assertions read context.prompt as the task; it must be the
      // real prompt (carried on the timeline start event), not an empty string.
      expect(ctx.prompt).toBe('refactor the auth module');
    });

    it('falls back to an empty prompt when the timeline has no start event', () => {
      // agentContext recovers the task prompt from the run's `start` event. If a
      // caller hands it a run whose timeline carries no start event (e.g. a
      // synthesized/partial result), it must degrade to '' rather than throw —
      // the downstream Tier 2/3 checks then simply have no task to compare to.
      const run = {
        output: 'x',
        turns: [],
        timeline: { events: [{ type: 'end' as const, timestamp: new Date().toISOString(), content: 'complete' }] },
        totalTokens: { prompt: 0, completion: 0, total: 0 },
        durationMs: 0,
        completed: true,
        stopReason: 'complete' as const,
      };

      const ctx = agentContext(run);
      expect(ctx.prompt).toBe('');
      expect(ctx.metadata.timeline).toBe(run.timeline);
    });
  });
});

// ─── BACKEND WIRE CONTRACT ──────────────────────────────────────────────────────
// The OpenAI-compatible backends (Azure, Groq, OpenRouter) share one transport
// helper. These tests pin each backend's URL / auth header / model field / error
// label so that shared helper can never silently change a backend's wire shape.

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock fetch that captures the outgoing request and returns a stub completion. */
function captureFetch(): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    const opts = init as { headers?: Record<string, string>; body?: string };
    calls.push({
      url: String(url),
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : {},
    });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

describe('backend wire contract', () => {
  describe('azure-openai', () => {
    it('targets the deployment URL, sends api-key, and omits model from the body', async () => {
      const cap = captureFetch();
      const provider = new AgentProvider({
        llm: {
          type: 'azure-openai',
          endpoint: 'https://test.openai.azure.com/', // trailing slash should be stripped
          apiKey: 'azure-secret',
          deployment: 'gpt-4o',
          apiVersion: '2024-08-01-preview',
        },
      });

      await provider.generate('hi');

      const req = cap.calls[0]!;
      expect(req.url).toBe(
        'https://test.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview',
      );
      expect(req.headers['api-key']).toBe('azure-secret');
      expect(req.headers['Authorization']).toBeUndefined();
      // Azure carries the model in the URL (deployment), never in the body.
      expect(req.body.model).toBeUndefined();
      expect(req.body.temperature).toBe(0);
    });

    it('labels API errors as "Azure OpenAI"', async () => {
      mockFetchError(401, 'bad key');
      const provider = new AgentProvider({
        llm: { type: 'azure-openai', endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' },
      });
      const result = await provider.run('x');
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('Azure OpenAI API error 401');
    });
  });

  describe('groq', () => {
    it('targets the Groq URL, sends a Bearer token, and defaults the model', async () => {
      const cap = captureFetch();
      const provider = new AgentProvider({ llm: { type: 'groq', apiKey: 'groq-secret' } });

      await provider.generate('hi');

      const req = cap.calls[0]!;
      expect(req.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect(req.headers['Authorization']).toBe('Bearer groq-secret');
      expect(req.headers['api-key']).toBeUndefined();
      expect(req.body.model).toBe('llama-3.3-70b-versatile');
    });

    it('honors an explicit model override', async () => {
      const cap = captureFetch();
      const provider = new AgentProvider({ llm: { type: 'groq', apiKey: 'k', model: 'mixtral-8x7b' } });
      await provider.generate('hi');
      expect(cap.calls[0]!.body.model).toBe('mixtral-8x7b');
    });

    it('labels API errors as "Groq"', async () => {
      mockFetchError(500, 'boom');
      const provider = new AgentProvider({ llm: { type: 'groq', apiKey: 'k' } });
      const result = await provider.run('x');
      expect(result.error).toContain('Groq API error 500');
    });
  });

  describe('openrouter', () => {
    it('targets the OpenRouter URL, sends a Bearer token, and defaults the model', async () => {
      const cap = captureFetch();
      const provider = new AgentProvider({ llm: { type: 'openrouter', apiKey: 'or-secret' } });

      await provider.generate('hi');

      const req = cap.calls[0]!;
      expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(req.headers['Authorization']).toBe('Bearer or-secret');
      expect(req.body.model).toBe('anthropic/claude-sonnet-4');
    });

    it('labels API errors as "OpenRouter"', async () => {
      mockFetchError(429, 'slow down');
      const provider = new AgentProvider({ llm: { type: 'openrouter', apiKey: 'k' } });
      const result = await provider.run('x');
      expect(result.error).toContain('OpenRouter API error 429');
    });
  });

  describe('shared body assembly', () => {
    it('maps tools into the OpenAI function shape for every OpenAI-compatible backend', async () => {
      const tool = defineTool('lookup')
        .describe('Look something up')
        .param('q', 'string', 'query', true)
        .execute(async () => 'done');

      for (const llm of [
        { type: 'azure-openai' as const, endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' },
        { type: 'groq' as const, apiKey: 'k' },
        { type: 'openrouter' as const, apiKey: 'k' },
      ]) {
        const cap = captureFetch();
        const provider = new AgentProvider({ llm, tools: [tool] });
        await provider.generate('hi');

        const tools = cap.calls[0]!.body.tools as Array<{ type: string; function: { name: string } }>;
        expect(tools).toHaveLength(1);
        expect(tools[0]!.type).toBe('function');
        expect(tools[0]!.function.name).toBe('lookup');
      }
    });

    it('forwards max_tokens and temperature overrides to the body', async () => {
      const cap = captureFetch();
      const provider = new AgentProvider({ llm: { type: 'groq', apiKey: 'k' } });
      await provider.generate('hi', { temperature: 0.7, maxTokens: 256 });
      expect(cap.calls[0]!.body.temperature).toBe(0.7);
      expect(cap.calls[0]!.body.max_tokens).toBe(256);
    });
  });
});

// ─── TOOL BUILDER ───────────────────────────────────────────────────────────────────────────

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
