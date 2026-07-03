/**
 * Agent Provider — backend HTTP transport.
 *
 * The four LLM backend calls that {@link AgentProvider} (the agentic-loop provider
 * in `./agent.ts`) dispatches to, extracted as pure module functions so the engine
 * file stays focused on the loop, tool dispatch, and timeline capture, and so this
 * transport layer is unit-testable on its own (no class, no `this`).
 *
 * Three of the four backends — Azure OpenAI, Groq, OpenRouter — speak the identical
 * OpenAI chat-completions wire protocol; they funnel through {@link callOpenAICompatible},
 * which owns body assembly, tool mapping, timeout handling, and error labelling in ONE
 * place so the backends cannot drift apart. Gemini has its own request/response mapping
 * ({@link callGemini}) but returns the same {@link ChatCompletionResponse} shape, so the
 * engine loop never needs to know which backend answered.
 *
 * Each function takes the resolved tool list explicitly (rather than reading provider
 * state) so it is a pure function of its inputs. This file performs IO (network `fetch`)
 * but holds no provider/loop state. See ./agent.ts and ./agent-types.ts.
 *
 * @module
 */

import type { ProviderOptions } from '../core/types.js';
import type {
  ToolDefinition,
  AzureOpenAIBackendConfig,
  GeminiBackendConfig,
  GroqBackendConfig,
  OpenRouterBackendConfig,
  ChatMessage,
  ChatCompletionResponse,
  OpenAICompatibleSpec,
} from './agent-types.js';

/**
 * Call an OpenAI-compatible chat completions endpoint.
 *
 * Azure OpenAI, Groq, and OpenRouter all speak the same wire protocol — the
 * only differences are the URL, the auth header, and (for Groq/OpenRouter) a
 * `model` field in the body. This shared transport keeps body assembly, tool
 * mapping, timeout handling, and error reporting in ONE place so the three
 * backends cannot drift apart.
 */
export async function callOpenAICompatible(
  messages: ChatMessage[],
  spec: OpenAICompatibleSpec,
  llm: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  tools: ToolDefinition[] | undefined,
  options?: ProviderOptions,
): Promise<ChatCompletionResponse> {
  // Build tool definitions for the API (identical OpenAI `function` shape).
  const apiTools = tools && tools.length > 0
    ? tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined;

  const body: Record<string, unknown> = {
    messages,
    temperature: options?.temperature ?? llm.temperature ?? 0,
  };

  // Azure carries the model in the URL (deployment); Groq/OpenRouter in the body.
  if (spec.model !== undefined) body.model = spec.model;
  if (apiTools) body.tools = apiTools;
  if (options?.maxTokens ?? llm.maxTokens) body.max_tokens = options?.maxTokens ?? llm.maxTokens;

  const timeoutMs = llm.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(spec.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...spec.authHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`${spec.label} API error ${response.status}: ${errorText}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call Azure OpenAI chat completions API.
 */
export async function callAzureOpenAI(
  messages: ChatMessage[],
  llm: AzureOpenAIBackendConfig,
  tools: ToolDefinition[] | undefined,
  options?: ProviderOptions,
): Promise<ChatCompletionResponse> {
  const apiVersion = llm.apiVersion ?? '2024-08-01-preview';
  const url = `${llm.endpoint.replace(/\/$/, '')}/openai/deployments/${llm.deployment}/chat/completions?api-version=${apiVersion}`;

  return callOpenAICompatible(
    messages,
    { url, authHeaders: { 'api-key': llm.apiKey }, label: 'Azure OpenAI' },
    llm,
    tools,
    options,
  );
}

/**
 * Call Groq API (OpenAI-compatible).
 */
export async function callGroq(
  messages: ChatMessage[],
  llm: GroqBackendConfig,
  tools: ToolDefinition[] | undefined,
  options?: ProviderOptions,
): Promise<ChatCompletionResponse> {
  return callOpenAICompatible(
    messages,
    {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      authHeaders: { 'Authorization': `Bearer ${llm.apiKey}` },
      model: llm.model ?? 'llama-3.3-70b-versatile',
      label: 'Groq',
    },
    llm,
    tools,
    options,
  );
}

/**
 * Call OpenRouter API (OpenAI-compatible).
 */
export async function callOpenRouter(
  messages: ChatMessage[],
  llm: OpenRouterBackendConfig,
  tools: ToolDefinition[] | undefined,
  options?: ProviderOptions,
): Promise<ChatCompletionResponse> {
  return callOpenAICompatible(
    messages,
    {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authHeaders: { 'Authorization': `Bearer ${llm.apiKey}` },
      model: llm.model ?? 'anthropic/claude-sonnet-4',
      label: 'OpenRouter',
    },
    llm,
    tools,
    options,
  );
}

/**
 * Call Google Gemini generateContent API with OpenAI-compatible response mapping.
 */
export async function callGemini(
  messages: ChatMessage[],
  llm: GeminiBackendConfig,
  tools: ToolDefinition[] | undefined,
  options?: ProviderOptions,
): Promise<ChatCompletionResponse> {
  const model = llm.model ?? 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${llm.apiKey}`;

  // Convert OpenAI-style messages to Gemini format
  const systemInstruction = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  // Build Gemini tool declarations
  const toolDeclarations = tools && tools.length > 0
    ? [{
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }]
    : undefined;

  // Map messages to Gemini contents format
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const msg of nonSystemMessages) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content ?? '' }] });
    } else if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
    } else if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'tool_response',
            response: { result: msg.content },
          },
        }],
      });
    }
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: options?.temperature ?? llm.temperature ?? 0,
      maxOutputTokens: options?.maxTokens ?? llm.maxTokens ?? 8192,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
  }
  if (toolDeclarations) body.tools = toolDeclarations;

  const timeoutMs = llm.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }> };
        finishReason: string;
      }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };

    // Map Gemini response to OpenAI-compatible format
    const candidate = data.candidates[0];
    if (!candidate) {
      throw new Error('Gemini response contained no candidates');
    }
    const parts = candidate.content.parts;

    const textParts = parts.filter(p => p.text).map(p => p.text).join('');
    const functionCalls = parts.filter(
      (p): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        p.functionCall !== undefined,
    );

    const toolCalls = functionCalls.length > 0
      ? functionCalls.map((p, i) => ({
          id: `call_gemini_${Date.now()}_${i}`,
          type: 'function' as const,
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args),
          },
        }))
      : undefined;

    return {
      choices: [{
        message: {
          content: textParts || null,
          tool_calls: toolCalls,
        },
        finish_reason: functionCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: data.usageMetadata
        ? {
            prompt_tokens: data.usageMetadata.promptTokenCount,
            completion_tokens: data.usageMetadata.candidatesTokenCount,
            total_tokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}
