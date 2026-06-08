/**
 * LLM-based Judge Backend — calls an OpenAI-compatible API for Tier 3 evaluation.
 *
 * Works with any OpenAI-compatible endpoint (Groq, OpenRouter, OpenAI, Azure).
 * Sends the rubric as a structured prompt, parses the JSON response.
 *
 * @module
 */

import type {
  JudgeBackend,
  JudgeContext,
  RawJudgeResponse,
  Rubric,
} from '../checks/judge.js';
import { buildJudgePrompt, parseJudgeResponse } from '../checks/judge.js';

/** Configuration for the LLM judge backend. */
export interface LLMJudgeConfig {
  /** Provider type. */
  type: 'groq' | 'openrouter' | 'openai';
  /** API key. */
  apiKey: string;
  /** Model to use as judge. */
  model?: string;
  /** Temperature. Default: 0 (deterministic judging). */
  temperature?: number;
  /** Max tokens for judge response. Default: 4096 */
  maxTokens?: number;
  /** Request timeout in ms. Default: 60000 */
  timeoutMs?: number;
  /** Max retries on parse failure. Default: 2 */
  maxRetries?: number;
}

const ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const DEFAULT_MODELS: Record<string, string> = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'anthropic/claude-sonnet-4',
  openai: 'gpt-4o',
};

/**
 * LLM-based judge backend.
 *
 * Sends the rubric prompt to an LLM, parses the structured JSON response.
 * Retries on parse failures with feedback to the model.
 */
export class LLMJudgeBackend implements JudgeBackend {
  readonly name: string;
  private config: LLMJudgeConfig;
  private url: string;
  private model: string;

  constructor(config: LLMJudgeConfig) {
    this.config = config;
    this.url = ENDPOINTS[config.type] ?? ENDPOINTS.openai!;
    this.model = config.model ?? DEFAULT_MODELS[config.type] ?? 'llama-3.3-70b-versatile';
    this.name = `llm-judge/${this.model}`;
  }

  async evaluate(
    output: string,
    rubric: Rubric,
    context: JudgeContext,
  ): Promise<RawJudgeResponse> {
    const prompt = buildJudgePrompt(output, rubric, context);
    const maxRetries = this.config.maxRetries ?? 2;

    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const messages: Array<{ role: string; content: string }> = [
        {
          role: 'system',
          content: 'You are a meticulous evaluation judge. You score AI agent outputs against structured rubrics. Always respond with valid JSON only.',
        },
        { role: 'user', content: prompt },
      ];

      // On retries, add feedback about what went wrong
      if (attempt > 0 && lastError) {
        messages.push({
          role: 'user',
          content: `Your previous response could not be parsed: ${lastError}\n\nPlease respond with ONLY valid JSON in the exact format specified.`,
        });
      }

      const responseText = await this.callLLM(messages);
      const parsed = parseJudgeResponse(responseText, rubric);

      if ('message' in parsed && 'rawResponse' in parsed) {
        // Parse error
        lastError = parsed.message;
        if (attempt < maxRetries) continue;
        throw new Error(`Judge response parsing failed after ${maxRetries + 1} attempts: ${parsed.message}`);
      }

      return parsed;
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Judge evaluation failed');
  }

  private async callLLM(messages: Array<{ role: string; content: string }>): Promise<string> {
    const timeoutMs = this.config.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.config.temperature ?? 0,
          max_tokens: this.config.maxTokens ?? 4096,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Judge LLM API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string | null } }>;
      };

      return data.choices[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timeout);
    }
  }
}
