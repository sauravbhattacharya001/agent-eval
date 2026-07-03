import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  callOpenAICompatible,
  callAzureOpenAI,
  callGroq,
  callOpenRouter,
  callGemini,
} from '../src/providers/agent-backends.js';
import type { ChatMessage, ToolDefinition } from '../src/providers/agent-types.js';

// These tests exercise the backend transport functions DIRECTLY — no AgentProvider
// instance, no loop. Extracting them from the provider class made each a pure
// function of its inputs (messages, config, tools, options), so the wire shape and
// the Gemini request/response mapping can be pinned at the unit boundary instead of
// only through the full agentic loop.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock fetch that records the outgoing request and returns a stub OpenAI completion. */
function captureOpenAIFetch(): { calls: CapturedRequest[] } {
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

function mockFetchError(status: number, body: string) {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

const userMsg: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const lookupTool: ToolDefinition = {
  name: 'lookup',
  description: 'Look something up',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  execute: async () => 'done',
};

// ─── OPENAI-COMPATIBLE TRANSPORT (shared by Azure / Groq / OpenRouter) ────────────

describe('callOpenAICompatible', () => {
  it('sends the spec URL, merges auth headers over Content-Type, and returns the completion', async () => {
    const cap = captureOpenAIFetch();
    const res = await callOpenAICompatible(
      userMsg,
      { url: 'https://example.test/chat', authHeaders: { 'Authorization': 'Bearer k' }, label: 'Example' },
      {},
      undefined,
    );

    const req = cap.calls[0]!;
    expect(req.url).toBe('https://example.test/chat');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(req.headers['Authorization']).toBe('Bearer k');
    expect(res.choices[0]!.message.content).toBe('ok');
  });

  it('omits the model field when the spec has none (Azure carries it in the URL)', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(
      userMsg,
      { url: 'https://x.test', authHeaders: {}, label: 'X' },
      {},
      undefined,
    );
    expect(cap.calls[0]!.body).not.toHaveProperty('model');
  });

  it('includes the model field when the spec sets one (Groq/OpenRouter)', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(
      userMsg,
      { url: 'https://x.test', authHeaders: {}, model: 'some-model', label: 'X' },
      {},
      undefined,
    );
    expect(cap.calls[0]!.body.model).toBe('some-model');
  });

  it('omits tools entirely when the tool list is undefined or empty', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'X' }, {}, undefined);
    expect(cap.calls[0]!.body).not.toHaveProperty('tools');

    const cap2 = captureOpenAIFetch();
    await callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'X' }, {}, []);
    expect(cap2.calls[0]!.body).not.toHaveProperty('tools');
  });

  it('maps a populated tool list into the OpenAI function shape', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'X' }, {}, [lookupTool]);
    const tools = cap.calls[0]!.body.tools as Array<{ type: string; function: { name: string; description: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.function.name).toBe('lookup');
    expect(tools[0]!.function.description).toBe('Look something up');
  });

  it('defaults temperature to 0 and only sets max_tokens when provided', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'X' }, {}, undefined);
    expect(cap.calls[0]!.body.temperature).toBe(0);
    expect(cap.calls[0]!.body).not.toHaveProperty('max_tokens');
  });

  it('prefers request options over the backend config for temperature and max_tokens', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(
      userMsg,
      { url: 'https://x.test', authHeaders: {}, label: 'X' },
      { temperature: 0.2, maxTokens: 111 },
      undefined,
      { temperature: 0.9, maxTokens: 512 },
    );
    expect(cap.calls[0]!.body.temperature).toBe(0.9);
    expect(cap.calls[0]!.body.max_tokens).toBe(512);
  });

  it('falls back to the backend config max_tokens when options omit it', async () => {
    const cap = captureOpenAIFetch();
    await callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'X' }, { maxTokens: 77 }, undefined);
    expect(cap.calls[0]!.body.max_tokens).toBe(77);
  });

  it('throws with the spec label and status on a non-ok response', async () => {
    mockFetchError(503, 'unavailable');
    await expect(
      callOpenAICompatible(userMsg, { url: 'https://x.test', authHeaders: {}, label: 'MyBackend' }, {}, undefined),
    ).rejects.toThrow('MyBackend API error 503: unavailable');
  });
});

// ─── PER-BACKEND WIRE SHAPE ───────────────────────────────────────────────────────

describe('callAzureOpenAI', () => {
  it('builds the deployment URL (trailing slash stripped), sends api-key, and omits body model', async () => {
    const cap = captureOpenAIFetch();
    await callAzureOpenAI(
      userMsg,
      { type: 'azure-openai', endpoint: 'https://test.openai.azure.com/', apiKey: 'azure-secret', deployment: 'gpt-4o', apiVersion: '2024-08-01-preview' },
      undefined,
    );
    const req = cap.calls[0]!;
    expect(req.url).toBe('https://test.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview');
    expect(req.headers['api-key']).toBe('azure-secret');
    expect(req.headers['Authorization']).toBeUndefined();
    expect(req.body).not.toHaveProperty('model');
  });

  it('defaults the api-version when not supplied', async () => {
    const cap = captureOpenAIFetch();
    await callAzureOpenAI(
      userMsg,
      { type: 'azure-openai', endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' },
      undefined,
    );
    expect(cap.calls[0]!.url).toContain('api-version=2024-08-01-preview');
  });

  it('labels errors as "Azure OpenAI"', async () => {
    mockFetchError(401, 'bad key');
    await expect(
      callAzureOpenAI(userMsg, { type: 'azure-openai', endpoint: 'https://x.openai.azure.com', apiKey: 'k', deployment: 'd' }, undefined),
    ).rejects.toThrow('Azure OpenAI API error 401');
  });
});

describe('callGroq', () => {
  it('targets the Groq URL, sends a Bearer token, and defaults the model', async () => {
    const cap = captureOpenAIFetch();
    await callGroq(userMsg, { type: 'groq', apiKey: 'groq-secret' }, undefined);
    const req = cap.calls[0]!;
    expect(req.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(req.headers['Authorization']).toBe('Bearer groq-secret');
    expect(req.body.model).toBe('llama-3.3-70b-versatile');
  });

  it('honors an explicit model override', async () => {
    const cap = captureOpenAIFetch();
    await callGroq(userMsg, { type: 'groq', apiKey: 'k', model: 'mixtral-8x7b' }, undefined);
    expect(cap.calls[0]!.body.model).toBe('mixtral-8x7b');
  });

  it('labels errors as "Groq"', async () => {
    mockFetchError(500, 'boom');
    await expect(callGroq(userMsg, { type: 'groq', apiKey: 'k' }, undefined)).rejects.toThrow('Groq API error 500');
  });
});

describe('callOpenRouter', () => {
  it('targets the OpenRouter URL, sends a Bearer token, and defaults the model', async () => {
    const cap = captureOpenAIFetch();
    await callOpenRouter(userMsg, { type: 'openrouter', apiKey: 'or-secret' }, undefined);
    const req = cap.calls[0]!;
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(req.headers['Authorization']).toBe('Bearer or-secret');
    expect(req.body.model).toBe('anthropic/claude-sonnet-4');
  });

  it('honors an explicit model override', async () => {
    const cap = captureOpenAIFetch();
    await callOpenRouter(userMsg, { type: 'openrouter', apiKey: 'k', model: 'meta-llama/llama-3-70b' }, undefined);
    expect(cap.calls[0]!.body.model).toBe('meta-llama/llama-3-70b');
  });

  it('labels errors as "OpenRouter"', async () => {
    mockFetchError(429, 'slow down');
    await expect(callOpenRouter(userMsg, { type: 'openrouter', apiKey: 'k' }, undefined)).rejects.toThrow('OpenRouter API error 429');
  });
});

// ─── GEMINI REQUEST/RESPONSE MAPPING ──────────────────────────────────────────────
// Gemini does not speak the OpenAI wire protocol; callGemini owns a request mapping
// (messages -> contents, system-instruction extraction, tool declarations) and a
// response mapping (candidates -> OpenAI-shaped choices/usage). These seams are hard
// to reach through the loop, so they are pinned directly here.

interface CapturedGemini {
  url: string;
  body: {
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
    tools?: Array<{ functionDeclarations: Array<{ name: string }> }>;
    generationConfig: { temperature: number; maxOutputTokens: number };
  };
}

/** Mock fetch returning a Gemini-shaped response and capturing the request. */
function captureGeminiFetch(response: unknown): { calls: CapturedGemini[] } {
  const calls: CapturedGemini[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    const opts = init as { body?: string };
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : {} });
    return { ok: true, json: async () => response } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

const geminiTextResponse = {
  candidates: [{ content: { parts: [{ text: 'hello from gemini' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
};

describe('callGemini request mapping', () => {
  it('builds the generateContent URL with the model and api key', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'g-key' }, undefined);
    expect(cap.calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=g-key',
    );
  });

  it('honors an explicit model override in the URL', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'k', model: 'gemini-1.5-pro' }, undefined);
    expect(cap.calls[0]!.url).toContain('/models/gemini-1.5-pro:generateContent');
  });

  it('lifts a system message into systemInstruction and keeps user turns in contents', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'question?' },
    ];
    await callGemini(messages, { type: 'gemini', apiKey: 'k' }, undefined);
    const body = cap.calls[0]!.body;
    expect(body.systemInstruction!.parts[0]!.text).toBe('You are terse.');
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0]!.role).toBe('user');
    expect(body.contents[0]!.parts[0]!.text).toBe('question?');
  });

  it('maps an assistant tool_call into a model functionCall part', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{"x":1}' } }],
      },
      { role: 'tool', content: 'tool said ok', tool_call_id: 'c1' },
    ];
    await callGemini(messages, { type: 'gemini', apiKey: 'k' }, undefined);
    const contents = cap.calls[0]!.body.contents;
    const modelTurn = contents.find(c => c.role === 'model')!;
    expect(modelTurn.parts[0]).toEqual({ functionCall: { name: 'run', args: { x: 1 } } });
    // The tool result is mapped to a user turn carrying a functionResponse.
    const toolTurn = contents[contents.length - 1]!;
    expect(toolTurn.role).toBe('user');
    expect((toolTurn.parts[0] as { functionResponse: { response: { result: string } } }).functionResponse.response.result)
      .toBe('tool said ok');
  });

  it('emits functionDeclarations for a populated tool list and omits tools otherwise', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, [lookupTool]);
    const decls = cap.calls[0]!.body.tools![0]!.functionDeclarations;
    expect(decls).toHaveLength(1);
    expect(decls[0]!.name).toBe('lookup');

    const cap2 = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined);
    expect(cap2.calls[0]!.body).not.toHaveProperty('tools');
  });

  it('applies temperature/maxOutputTokens overrides with the Gemini default token cap', async () => {
    const cap = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined);
    expect(cap.calls[0]!.body.generationConfig.temperature).toBe(0);
    expect(cap.calls[0]!.body.generationConfig.maxOutputTokens).toBe(8192);

    const cap2 = captureGeminiFetch(geminiTextResponse);
    await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined, { temperature: 0.5, maxTokens: 256 });
    expect(cap2.calls[0]!.body.generationConfig.temperature).toBe(0.5);
    expect(cap2.calls[0]!.body.generationConfig.maxOutputTokens).toBe(256);
  });
});

describe('callGemini response mapping', () => {
  it('maps text parts and usageMetadata to an OpenAI-shaped completion', async () => {
    captureGeminiFetch(geminiTextResponse);
    const res = await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined);
    expect(res.choices[0]!.message.content).toBe('hello from gemini');
    expect(res.choices[0]!.finish_reason).toBe('stop');
    expect(res.choices[0]!.message.tool_calls).toBeUndefined();
    expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('maps functionCall parts to OpenAI tool_calls with tool_calls finish reason', async () => {
    captureGeminiFetch({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'search', args: { q: 'weather' } } }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    });
    const res = await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined);
    expect(res.choices[0]!.finish_reason).toBe('tool_calls');
    const calls = res.choices[0]!.message.tool_calls!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('search');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ q: 'weather' });
    // content is null when the model returned only a function call
    expect(res.choices[0]!.message.content).toBeNull();
  });

  it('returns undefined usage when Gemini omits usageMetadata', async () => {
    captureGeminiFetch({
      candidates: [{ content: { parts: [{ text: 'no usage' }] }, finishReason: 'STOP' }],
    });
    const res = await callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined);
    expect(res.usage).toBeUndefined();
    expect(res.choices[0]!.message.content).toBe('no usage');
  });

  it('throws when Gemini returns no candidates', async () => {
    captureGeminiFetch({ candidates: [] });
    await expect(callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined))
      .rejects.toThrow('Gemini response contained no candidates');
  });

  it('labels a non-ok Gemini response with its status', async () => {
    mockFetchError(400, 'bad request');
    await expect(callGemini(userMsg, { type: 'gemini', apiKey: 'k' }, undefined))
      .rejects.toThrow('Gemini API error 400: bad request');
  });
});
