/**
 * Azure OpenAI Provider — calls Azure OpenAI chat completions API.
 *
 * Basic provider for single-shot evaluation: sends prompt, gets response.
 * For agentic (multi-turn, tool-use) evaluation, use AgentProvider.
 *
 * @module
 */

import type { EvalProvider, ProviderOptions } from '../core/types.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

export interface AzureOpenAIConfig {
  /** Azure OpenAI endpoint (e.g., https://my-resource.openai.azure.com) */
  endpoint: string;
  /** Azure OpenAI API key. */
  apiKey: string;
  /** Deployment name (e.g., gpt-4o). */
  deployment: string;
  /** API version. Default: 2024-08-01-preview */
  apiVersion?: string;
  /** Default system prompt for all calls. */
  systemPrompt?: string;
  /** Default temperature. Default: 0 (deterministic for evals). */
  temperature?: number;
  /** Default max tokens. */
  maxTokens?: number;
  /** Request timeout in ms. Default: 60000 */
  timeoutMs?: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── PROVIDER ───────────────────────────────────────────────────────────────────

/**
 * Azure OpenAI provider for single-shot evaluation.
 *
 * @example
 * ```ts
 * const provider = new AzureOpenAIProvider({
 *   endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
 *   apiKey: process.env.AZURE_OPENAI_API_KEY!,
 *   deployment: 'gpt-4o',
 * });
 *
 * const suite = defineEval({
 *   provider,
 *   specs: [{ prompt: 'Write hello world', assertions: [...] }],
 * });
 * ```
 */
export class AzureOpenAIProvider implements EvalProvider {
  readonly name: string;
  private config: Required<Pick<AzureOpenAIConfig, 'endpoint' | 'apiKey' | 'deployment' | 'apiVersion' | 'temperature' | 'timeoutMs'>> & Pick<AzureOpenAIConfig, 'systemPrompt' | 'maxTokens'>;

  constructor(config: AzureOpenAIConfig) {
    this.name = `azure-openai/${config.deployment}`;
    this.config = {
      endpoint: config.endpoint.replace(/\/$/, ''),
      apiKey: config.apiKey,
      deployment: config.deployment,
      apiVersion: config.apiVersion ?? '2024-08-01-preview',
      systemPrompt: config.systemPrompt,
      temperature: config.temperature ?? 0,
      maxTokens: config.maxTokens,
      timeoutMs: config.timeoutMs ?? 60000,
    };
  }

  async generate(prompt: string, options?: ProviderOptions): Promise<string> {
    const messages: ChatMessage[] = [];

    const systemPrompt = options?.systemPrompt ?? this.config.systemPrompt;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    const url = `${this.config.endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${this.config.apiVersion}`;

    const body = {
      messages,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.config.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;

      const content = data.choices[0]?.message?.content;
      if (content === null || content === undefined) {
        throw new Error(`Azure OpenAI returned empty content. Finish reason: ${data.choices[0]?.finish_reason}`);
      }

      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}
