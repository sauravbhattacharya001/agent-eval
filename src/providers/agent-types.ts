/**
 * Agent Provider — type vocabulary.
 *
 * The shared type surface for {@link AgentProvider} (the agentic-loop provider in
 * `./agent.ts`): the tool/turn/run-result shapes, the per-backend LLM configs and
 * their union, and the internal OpenAI-compatible wire types. It is split out as a
 * leaf so the engine file (`agent.ts`) stays focused on the loop, tool dispatch,
 * and the four backend HTTP calls, and so this vocabulary is importable without
 * pulling in the engine.
 *
 * The engine (`agent.ts`) re-exports every public type below so consumers keep one
 * import path at `./providers/agent.js`. This file holds **only** types — no logic,
 * no constants, no IO. See ./agent.ts.
 *
 * @module
 */

import type { RunTimeline } from '../checks/staleness.js';

/** Tool definition for the agent. */
export interface ToolDefinition {
  /** Tool name (function name). */
  name: string;
  /** Description shown to the model. */
  description: string;
  /** JSON schema for parameters. */
  parameters: Record<string, unknown>;
  /** The actual implementation. */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** A single tool call in the run. */
export interface CapturedToolCall {
  /** Tool name. */
  name: string;
  /** Arguments passed. */
  arguments: Record<string, unknown>;
  /** Result returned. */
  result: string;
  /** Duration of tool execution in ms. */
  durationMs: number;
  /** Timestamp when tool was called. */
  timestamp: string;
}

/** A single turn in the conversation. */
export interface AgentTurn {
  /** Turn number (0-indexed). */
  index: number;
  /** The model's response text (reasoning/content). */
  content: string;
  /** Tool calls made in this turn (if any). */
  toolCalls: CapturedToolCall[];
  /** Tokens used in this turn. */
  tokens?: { prompt: number; completion: number };
  /** Duration of this turn (LLM call + tool execution). */
  durationMs: number;
  /** Finish reason from the model. */
  finishReason: string;
}

/** Complete result of an agentic run. */
export interface AgentRunResult {
  /** Final assembled output. */
  output: string;
  /** All turns in the conversation. */
  turns: AgentTurn[];
  /** Flat timeline of run events (for staleness checks). */
  timeline: RunTimeline;
  /** Total token usage across all turns. */
  totalTokens: { prompt: number; completion: number; total: number };
  /** Total duration of the run. */
  durationMs: number;
  /** Whether the run completed normally (vs timeout/max iterations). */
  completed: boolean;
  /** Reason for stopping. */
  stopReason: 'complete' | 'max_iterations' | 'timeout' | 'error';
  /** Error message if stopped due to error. */
  error?: string;
}

/** Configuration for the agent provider. */
export interface AgentProviderConfig {
  /** LLM backend configuration. */
  llm: LLMBackendConfig;
  /** Tools available to the agent. */
  tools?: ToolDefinition[];
  /** System prompt for the agent. */
  systemPrompt?: string;
  /** Maximum iterations (turns) before stopping. Default: 10 */
  maxIterations?: number;
  /** Maximum total duration in ms. Default: 120000 (2 min) */
  maxDurationMs?: number;
  /** Whether to include tool results in final output. Default: false */
  includeToolResults?: boolean;
}

/** LLM backend configuration — Azure OpenAI. */
export interface AzureOpenAIBackendConfig {
  type: 'azure-openai';
  /** Azure OpenAI endpoint. */
  endpoint: string;
  /** API key. */
  apiKey: string;
  /** Deployment name. */
  deployment: string;
  /** API version. Default: 2024-08-01-preview */
  apiVersion?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
  /** Max tokens per turn. */
  maxTokens?: number;
  /** Request timeout per LLM call in ms. Default: 60000 */
  timeoutMs?: number;
}

/** LLM backend configuration — Google Gemini. */
export interface GeminiBackendConfig {
  type: 'gemini';
  /** Gemini API key. */
  apiKey: string;
  /** Model name. Default: gemini-2.0-flash */
  model?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
  /** Max tokens per turn. */
  maxTokens?: number;
  /** Request timeout per LLM call in ms. Default: 60000 */
  timeoutMs?: number;
}

/** LLM backend configuration — Groq (OpenAI-compatible). */
export interface GroqBackendConfig {
  type: 'groq';
  /** Groq API key. */
  apiKey: string;
  /** Model name. Default: llama-3.3-70b-versatile */
  model?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
  /** Max tokens per turn. */
  maxTokens?: number;
  /** Request timeout per LLM call in ms. Default: 60000 */
  timeoutMs?: number;
}

/** LLM backend configuration — OpenRouter (OpenAI-compatible). */
export interface OpenRouterBackendConfig {
  type: 'openrouter';
  /** OpenRouter API key. */
  apiKey: string;
  /** Model name. Default: anthropic/claude-sonnet-4 */
  model?: string;
  /** Temperature. Default: 0 */
  temperature?: number;
  /** Max tokens per turn. */
  maxTokens?: number;
  /** Request timeout per LLM call in ms. Default: 60000 */
  timeoutMs?: number;
}

/** Union of all supported LLM backend configs. */
export type LLMBackendConfig = AzureOpenAIBackendConfig | GeminiBackendConfig | GroqBackendConfig | OpenRouterBackendConfig;

/** Chat message for multi-turn conversation. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Azure OpenAI chat completion response. */
export interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Per-backend differences for an OpenAI-compatible chat completions call.
 * Everything else (body assembly, tool mapping, timeout, error handling) is shared.
 */
export interface OpenAICompatibleSpec {
  /** Fully-resolved request URL. */
  url: string;
  /** Auth headers merged on top of `Content-Type: application/json`. */
  authHeaders: Record<string, string>;
  /** Model name to put in the body; omit for Azure (model lives in the URL). */
  model?: string;
  /** Human-readable backend label used in error messages. */
  label: string;
}
