import { describe, it, expect, vi, afterEach } from 'vitest';
import { LLMJudgeBackend } from '../src/judges/llm-judge.js';
import type { LLMJudgeConfig } from '../src/judges/llm-judge.js';
import type { Rubric, JudgeContext, RawJudgeResponse } from '../src/checks/judge.js';

// ─── FIXTURES ─────────────────────────────────────────────────────────────────

const RUBRIC: Rubric = {
  name: 'Test Rubric',
  description: 'Evaluate clarity of an answer.',
  criteria: [
    {
      id: 'clarity',
      description: 'Is the answer clear?',
      weight: 1,
      levels: [
        { score: 1, label: 'poor', description: 'Confusing.' },
        { score: 5, label: 'great', description: 'Crystal clear.' },
      ],
    },
  ],
};

const CONTEXT: JudgeContext = {
  task: 'Explain recursion.',
  chainOfThought: true,
};

/** A well-formed JSON judge response body the parser accepts. */
function validJudgeJson(): string {
  return JSON.stringify({
    scores: [
      {
        criterionId: 'clarity',
        score: 5,
        reasoning: 'Very clear explanation.',
        evidence: ['base case stated'],
        confidence: 0.9,
      },
    ],
    summary: 'Strong answer.',
    suggestions: ['Add an example.'],
  });
}

// ─── FETCH MOCK ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/**
 * Mock fetch with a queue of successful chat-completion responses. Each entry is
 * the assistant message `content` returned for that call. Records every request
 * so tests can assert on URL/headers/body.
 */
function mockFetchSequence(contents: Array<string | null>): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(url), init, body });
    const content = contents[i] ?? contents[contents.length - 1] ?? null;
    i++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

/** Mock fetch that returns a non-OK HTTP error. */
function mockFetchError(status: number, body: string): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── CONSTRUCTOR / CONFIG ───────────────────────────────────────────────────

describe('LLMJudgeBackend — construction', () => {
  it('derives name from the default model for the provider type', () => {
    expect(new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).name).toBe('llm-judge/llama-3.3-70b-versatile');
    expect(new LLMJudgeBackend({ type: 'openai', apiKey: 'k' }).name).toBe('llm-judge/gpt-4o');
    // openrouter has its own non-empty default model under the llm-judge/<model> shape.
    const openrouterName = new LLMJudgeBackend({ type: 'openrouter', apiKey: 'k' }).name;
    expect(openrouterName).toMatch(/^llm-judge\/.+/);
    expect(openrouterName).not.toBe('llm-judge/');
  });

  it('honors an explicit model override in the name', () => {
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', model: 'mixtral-8x7b' });
    expect(judge.name).toBe('llm-judge/mixtral-8x7b');
  });

  it('routes each provider type to the correct endpoint', async () => {
    const cases: Array<{ type: LLMJudgeConfig['type']; host: string }> = [
      { type: 'groq', host: 'https://api.groq.com/openai/v1/chat/completions' },
      { type: 'openrouter', host: 'https://openrouter.ai/api/v1/chat/completions' },
      { type: 'openai', host: 'https://api.openai.com/v1/chat/completions' },
    ];
    for (const { type, host } of cases) {
      const { calls } = mockFetchSequence([validJudgeJson()]);
      const judge = new LLMJudgeBackend({ type, apiKey: 'k' });
      await judge.evaluate('output', RUBRIC, CONTEXT);
      expect(calls[0]!.url).toBe(host);
    }
  });

  it('falls back to the openai endpoint and default model for an unknown type', async () => {
    // Cast through unknown: exercises the `?? ENDPOINTS.openai` / default-model fallbacks.
    const judge = new LLMJudgeBackend({ type: 'mystery' as unknown as 'openai', apiKey: 'k' });
    expect(judge.name).toBe('llm-judge/llama-3.3-70b-versatile');
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await judge.evaluate('output', RUBRIC, CONTEXT);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});

// ─── REQUEST SHAPE ────────────────────────────────────────────────────────────

describe('LLMJudgeBackend — request shape', () => {
  const baseConfig: LLMJudgeConfig = { type: 'openai', apiKey: 'secret-key' };

  it('sends a Bearer auth header and JSON content type', async () => {
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await new LLMJudgeBackend(baseConfig).evaluate('out', RUBRIC, CONTEXT);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('includes the resolved model and a system + user message in the body', async () => {
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await new LLMJudgeBackend({ ...baseConfig, model: 'gpt-4o-mini' }).evaluate('out', RUBRIC, CONTEXT);
    const body = calls[0]!.body;
    expect(body.model).toBe('gpt-4o-mini');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('evaluation judge');
    expect(messages[1]!.role).toBe('user');
    // The user prompt is the built judge prompt, which references the criterion.
    expect(messages[1]!.content).toContain('clarity');
  });

  it('defaults temperature to 0 and max_tokens to 4096', async () => {
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await new LLMJudgeBackend(baseConfig).evaluate('out', RUBRIC, CONTEXT);
    expect(calls[0]!.body.temperature).toBe(0);
    expect(calls[0]!.body.max_tokens).toBe(4096);
  });

  it('honors temperature and maxTokens overrides', async () => {
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await new LLMJudgeBackend({ ...baseConfig, temperature: 0.7, maxTokens: 1024 }).evaluate('out', RUBRIC, CONTEXT);
    expect(calls[0]!.body.temperature).toBe(0.7);
    expect(calls[0]!.body.max_tokens).toBe(1024);
  });
});

// ─── SUCCESS PARSING ──────────────────────────────────────────────────────────

describe('LLMJudgeBackend — successful evaluation', () => {
  it('parses a well-formed JSON response into a RawJudgeResponse', async () => {
    mockFetchSequence([validJudgeJson()]);
    const result = await new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).evaluate('out', RUBRIC, CONTEXT);
    const ok = result as RawJudgeResponse;
    expect(ok.scores).toHaveLength(1);
    expect(ok.scores[0]!.criterionId).toBe('clarity');
    expect(ok.scores[0]!.score).toBe(5);
    expect(ok.scores[0]!.confidence).toBeCloseTo(0.9);
    expect(ok.summary).toBe('Strong answer.');
    expect(ok.suggestions).toEqual(['Add an example.']);
  });

  it('parses JSON wrapped in a markdown code fence', async () => {
    const fenced = '```json\n' + validJudgeJson() + '\n```';
    mockFetchSequence([fenced]);
    const result = await new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).evaluate('out', RUBRIC, CONTEXT);
    expect((result as RawJudgeResponse).scores[0]!.criterionId).toBe('clarity');
  });

  it('issues exactly one request when the first response parses', async () => {
    const { calls } = mockFetchSequence([validJudgeJson()]);
    await new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).evaluate('out', RUBRIC, CONTEXT);
    expect(calls).toHaveLength(1);
  });
});

// ─── RETRY LOOP ────────────────────────────────────────────────────────────────

describe('LLMJudgeBackend — retry on parse failure', () => {
  it('retries after an unparseable response and succeeds', async () => {
    const { calls } = mockFetchSequence(['not json at all', validJudgeJson()]);
    const result = await new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).evaluate('out', RUBRIC, CONTEXT);
    expect((result as RawJudgeResponse).scores[0]!.criterionId).toBe('clarity');
    expect(calls).toHaveLength(2);
  });

  it('feeds the parse error back to the model on retry', async () => {
    const { calls } = mockFetchSequence(['garbage', validJudgeJson()]);
    await new LLMJudgeBackend({ type: 'groq', apiKey: 'k' }).evaluate('out', RUBRIC, CONTEXT);
    const retryMessages = calls[1]!.body.messages as Array<{ role: string; content: string }>;
    const feedback = retryMessages[retryMessages.length - 1]!;
    expect(feedback.role).toBe('user');
    expect(feedback.content).toContain('could not be parsed');
  });

  it('throws after exhausting maxRetries with a descriptive message', async () => {
    mockFetchSequence(['nope', 'still nope', 'nope again', 'nope final']);
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', maxRetries: 2 });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow(
      /parsing failed after 3 attempts/,
    );
  });

  it('makes exactly maxRetries + 1 attempts before giving up', async () => {
    const { calls } = mockFetchSequence(['x', 'x', 'x', 'x']);
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', maxRetries: 2 });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  it('with maxRetries: 0 makes a single attempt then throws', async () => {
    const { calls } = mockFetchSequence(['not json']);
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', maxRetries: 0 });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow(
      /parsing failed after 1 attempts/,
    );
    expect(calls).toHaveLength(1);
  });
});

// ─── HTTP / TRANSPORT ERRORS ────────────────────────────────────────────────

describe('LLMJudgeBackend — transport errors', () => {
  it('throws on a non-OK HTTP response, surfacing status and body', async () => {
    mockFetchError(429, 'rate limited');
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k' });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow(
      /Judge LLM API error 429: rate limited/,
    );
  });

  it('treats an empty-content response as a parse failure (retried then thrown)', async () => {
    const { calls } = mockFetchSequence([null, null]);
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', maxRetries: 1 });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow(/parsing failed/);
    expect(calls).toHaveLength(2);
  });

  it('falls back to "unknown" when the error body cannot be read', async () => {
    // Exercises the `response.text().catch(() => 'unknown')` branch: a non-OK
    // response whose body read itself rejects must still surface a clean message
    // (status + "unknown") rather than leaking the text() rejection.
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('stream closed');
      },
    })) as unknown as typeof fetch;
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k' });
    await expect(judge.evaluate('out', RUBRIC, CONTEXT)).rejects.toThrow(
      /Judge LLM API error 500: unknown/,
    );
  });
});

// ─── TIMEOUT / ABORT ─────────────────────────────────────────────────────────

describe('LLMJudgeBackend — request timeout', () => {
  it('aborts the request via AbortSignal after timeoutMs and surfaces the abort', async () => {
    vi.useFakeTimers();
    try {
      // fetch that rejects when the abort signal fires, mirroring the real
      // fetch/AbortController contract, so we can assert the timeout path wires
      // the signal through and clears its timer.
      globalThis.fetch = vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof fetch;

      const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', timeoutMs: 1000 });
      const p = judge.evaluate('out', RUBRIC, CONTEXT);
      // Attach a rejection handler before advancing timers so the rejection is
      // observed (avoids an unhandled-rejection warning under fake timers).
      const assertion = expect(p).rejects.toThrow(/aborted/i);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not abort when the response resolves before timeoutMs', async () => {
    // A fast success must clear the abort timer and return normally; regression
    // guard that the finally-clearTimeout keeps a stray abort from firing.
    mockFetchSequence([validJudgeJson()]);
    const judge = new LLMJudgeBackend({ type: 'groq', apiKey: 'k', timeoutMs: 60000 });
    const result = await judge.evaluate('out', RUBRIC, CONTEXT);
    expect((result as RawJudgeResponse).scores[0]!.criterionId).toBe('clarity');
  });
});
