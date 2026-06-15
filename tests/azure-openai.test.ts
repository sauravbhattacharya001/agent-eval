import { describe, it, expect, vi, afterEach } from 'vitest';
import { AzureOpenAIProvider } from '../src/providers/azure-openai.js';

// ─── MOCK FETCH ─────────────────────────────────────────────────────────────────
//
// AzureOpenAIProvider.generate() is a thin wrapper over the Azure OpenAI chat
// completions HTTP endpoint. These tests pin its observable transport behaviour:
// URL construction, headers, request body shaping, success parsing, and the
// failure modes (non-OK status, empty/null content, abort/timeout wiring).
//
// We record every fetch call so the request URL/headers/body are assertable.

const originalFetch = globalThis.fetch;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** Mock a sequence of successful chat-completion responses, recording each request. */
function mockFetchOk(
  responses: Array<{
    content: string | null | undefined;
    finishReason?: string;
    tokens?: { prompt: number; completion: number };
  }>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let callIndex = 0;
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const resp = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { content: resp.content },
            finish_reason: resp.finishReason ?? 'stop',
          },
        ],
        usage: resp.tokens
          ? {
              prompt_tokens: resp.tokens.prompt,
              completion_tokens: resp.tokens.completion,
              total_tokens: resp.tokens.prompt + resp.tokens.completion,
            }
          : undefined,
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

/** Mock a non-OK HTTP response. */
function mockFetchError(status: number, body: string | (() => never)): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: false,
      status,
      text: async () => {
        if (typeof body === 'function') return body();
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

/** Mock a response with a completely empty choices array. */
function mockFetchEmptyChoices(): void {
  globalThis.fetch = vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    }) as unknown as Response,
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const baseConfig = {
  endpoint: 'https://my-resource.openai.azure.com',
  apiKey: 'secret-key',
  deployment: 'gpt-4o',
};

// ─── CONSTRUCTION ─────────────────────────────────────────────────────────────

describe('AzureOpenAIProvider — construction', () => {
  it('derives provider name from the deployment', () => {
    const provider = new AzureOpenAIProvider(baseConfig);
    expect(provider.name).toBe('azure-openai/gpt-4o');
  });

  it('reflects a different deployment in the name', () => {
    const provider = new AzureOpenAIProvider({ ...baseConfig, deployment: 'gpt-35-turbo' });
    expect(provider.name).toBe('azure-openai/gpt-35-turbo');
  });
});

// ─── URL CONSTRUCTION ───────────────────────────────────────────────────────────

describe('AzureOpenAIProvider — URL construction', () => {
  it('builds the deployment chat-completions URL with the default api-version', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview',
    );
  });

  it('strips a trailing slash from the endpoint so the URL has no double slash', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({
      ...baseConfig,
      endpoint: 'https://my-resource.openai.azure.com/',
    });

    await provider.generate('hi');

    expect(calls[0]!.url).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview',
    );
    expect(calls[0]!.url).not.toContain('azure.com//openai');
  });

  it('honours a custom api-version', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, apiVersion: '2025-01-01-preview' });

    await provider.generate('hi');

    expect(calls[0]!.url).toContain('api-version=2025-01-01-preview');
  });
});

// ─── REQUEST SHAPE (method / headers) ───────────────────────────────────────────

describe('AzureOpenAIProvider — request headers and method', () => {
  it('POSTs with JSON content-type and the api-key header (not a bearer token)', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['api-key']).toBe('secret-key');
    // Azure authenticates with `api-key`, never an Authorization bearer header.
    expect(headers['Authorization']).toBeUndefined();
  });

  it('passes an AbortSignal so the request can time out', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── REQUEST BODY (messages / params) ───────────────────────────────────────────

describe('AzureOpenAIProvider — request body', () => {
  function bodyOf(call: RecordedCall): {
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number | undefined;
  } {
    return JSON.parse(call.init.body as string);
  }

  it('sends a single user message when no system prompt is configured', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('summarize this');

    const body = bodyOf(calls[0]!);
    expect(body.messages).toEqual([{ role: 'user', content: 'summarize this' }]);
  });

  it('prepends the configured system prompt before the user message', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, systemPrompt: 'You are terse.' });

    await provider.generate('hello');

    const body = bodyOf(calls[0]!);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('lets a per-call system prompt override the configured default', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, systemPrompt: 'default system' });

    await provider.generate('hello', { systemPrompt: 'override system' });

    const body = bodyOf(calls[0]!);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'override system' });
    expect(body.messages).toHaveLength(2);
  });

  it('defaults temperature to 0 for deterministic evals', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    expect(bodyOf(calls[0]!).temperature).toBe(0);
  });

  it('uses the configured temperature when provided', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, temperature: 0.7 });

    await provider.generate('hi');

    expect(bodyOf(calls[0]!).temperature).toBe(0.7);
  });

  it('lets a per-call temperature override the configured default', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, temperature: 0.5 });

    await provider.generate('hi', { temperature: 0.2 });

    expect(bodyOf(calls[0]!).temperature).toBe(0.2);
  });

  it('omits max_tokens when neither config nor call provides one', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    expect(bodyOf(calls[0]!).max_tokens).toBeUndefined();
  });

  it('uses the configured max_tokens', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, maxTokens: 256 });

    await provider.generate('hi');

    expect(bodyOf(calls[0]!).max_tokens).toBe(256);
  });

  it('lets a per-call maxTokens override the configured default', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider({ ...baseConfig, maxTokens: 256 });

    await provider.generate('hi', { maxTokens: 1024 });

    expect(bodyOf(calls[0]!).max_tokens).toBe(1024);
  });

  it('routes the model through the deployment URL, not the request body', async () => {
    // Azure selects the model via the deployment path segment; a `model` option
    // must not leak into the JSON body (unlike vanilla OpenAI).
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi', { model: 'gpt-4o-mini' });

    const raw = calls[0]!.init.body as string;
    expect(raw).not.toContain('gpt-4o-mini');
    expect(JSON.parse(raw)).not.toHaveProperty('model');
  });
});

// ─── SUCCESS PARSING ────────────────────────────────────────────────────────────

describe('AzureOpenAIProvider — success parsing', () => {
  it('returns the assistant message content', async () => {
    mockFetchOk([{ content: 'Hello, world!' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('say hi')).resolves.toBe('Hello, world!');
  });

  it('returns an empty string as a valid (non-null) completion', async () => {
    mockFetchOk([{ content: '' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('say nothing')).resolves.toBe('');
  });

  it('issues exactly one request per generate call', async () => {
    const calls = mockFetchOk([{ content: 'ok' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await provider.generate('hi');

    expect(calls).toHaveLength(1);
  });
});

// ─── FAILURE MODES ──────────────────────────────────────────────────────────────

describe('AzureOpenAIProvider — failure modes', () => {
  it('throws with status and body on a non-OK response', async () => {
    mockFetchError(429, 'rate limited');
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow('Azure OpenAI API error 429: rate limited');
  });

  it('surfaces the upstream status code in the error', async () => {
    mockFetchError(500, 'internal error');
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow(/500/);
  });

  it('falls back to "unknown" when the error body cannot be read', async () => {
    mockFetchError(503, () => {
      throw new Error('stream broke');
    });
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow('Azure OpenAI API error 503: unknown');
  });

  it('throws on null content, reporting the finish reason', async () => {
    mockFetchOk([{ content: null, finishReason: 'content_filter' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow(
      'Azure OpenAI returned empty content. Finish reason: content_filter',
    );
  });

  it('throws on undefined content (missing message field)', async () => {
    mockFetchOk([{ content: undefined, finishReason: 'length' }]);
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow('Azure OpenAI returned empty content');
  });

  it('throws when the choices array is empty', async () => {
    mockFetchEmptyChoices();
    const provider = new AzureOpenAIProvider(baseConfig);

    await expect(provider.generate('hi')).rejects.toThrow('Azure OpenAI returned empty content');
  });

  it('aborts the request once the timeout elapses', async () => {
    // Never resolves on its own; only the AbortController should end it.
    globalThis.fetch = vi.fn(
      (_url: unknown, init: unknown) =>
        new Promise((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal }).signal;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;

    const provider = new AzureOpenAIProvider({ ...baseConfig, timeoutMs: 5 });

    await expect(provider.generate('hi')).rejects.toThrow('aborted');
  });
});
