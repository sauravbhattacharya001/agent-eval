/**
 * Agent Provider — Full agentic loop evaluation with tool calls, multi-turn,
 * and run timeline capture.
 *
 * Unlike AzureOpenAIProvider (single-shot), this provider:
 * 1. Runs a ReAct-style agentic loop (prompt → think → act → observe → repeat)
 * 2. Captures the full timeline of events (tool calls, responses, durations)
 * 3. Produces a RunTimeline that unlocks staleness, loop, and timeout assertions
 *
 * Architecture:
 * ```
 * AgentProvider
 *   ├── LLM backend (Azure OpenAI, etc.)
 *   ├── Tool registry (functions the agent can call)
 *   ├── Run harness (loop control, max iterations, timeout)
 *   └── Timeline capture (events for Tier 1/2 assertions)
 * ```
 *
 * @module
 */

import type { EvalProvider, ProviderOptions } from '../core/types.js';
import type { RunEvent, RunTimeline } from '../checks/staleness.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────────

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

/** LLM backend configuration. */
export interface LLMBackendConfig {
  /** Provider type. */
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

/** Chat message for multi-turn conversation. */
interface ChatMessage {
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
interface ChatCompletionResponse {
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

// ─── AGENT PROVIDER ─────────────────────────────────────────────────────────────

/**
 * Agent provider — runs a full agentic loop and captures everything.
 *
 * @example
 * ```ts
 * const provider = new AgentProvider({
 *   llm: {
 *     type: 'azure-openai',
 *     endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
 *     apiKey: process.env.AZURE_OPENAI_API_KEY!,
 *     deployment: 'gpt-4o',
 *   },
 *   tools: [
 *     {
 *       name: 'read_file',
 *       description: 'Read a file from disk',
 *       parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
 *       execute: async (args) => fs.readFileSync(args.path as string, 'utf-8'),
 *     },
 *   ],
 *   maxIterations: 5,
 * });
 *
 * // The run result includes timeline for staleness/loop checks
 * const runResult = await provider.run('Refactor the auth module');
 * const timeline = runResult.timeline; // Use with toNotBeStale(), toNotBeStalled()
 * ```
 */
export class AgentProvider implements EvalProvider {
  readonly name: string;
  private config: AgentProviderConfig;
  private toolMap: Map<string, ToolDefinition>;

  /** Last run result — accessible after generate() for timeline inspection. */
  lastRun: AgentRunResult | null = null;

  constructor(config: AgentProviderConfig) {
    this.name = `agent/${config.llm.deployment}`;
    this.config = {
      maxIterations: 10,
      maxDurationMs: 120000,
      includeToolResults: false,
      ...config,
    };
    this.toolMap = new Map((config.tools ?? []).map(t => [t.name, t]));
  }

  /**
   * Run the agent and return final output text.
   * Implements EvalProvider interface — assertions only see the final output.
   * For full timeline access, use `provider.lastRun` or `provider.run()`.
   */
  async generate(prompt: string, options?: ProviderOptions): Promise<string> {
    const result = await this.run(prompt, options);
    return result.output;
  }

  /**
   * Run the full agentic loop and return the complete result with timeline.
   *
   * This is the method you want for rich evaluation — gives you:
   * - Full conversation history (all turns)
   * - Tool call captures (what was called, args, results, timing)
   * - RunTimeline for staleness/loop/timeout assertions
   * - Token usage for cost estimation
   */
  async run(prompt: string, options?: ProviderOptions): Promise<AgentRunResult> {
    const startTime = Date.now();
    const maxIterations = this.config.maxIterations!;
    const maxDurationMs = this.config.maxDurationMs!;

    const messages: ChatMessage[] = [];
    const turns: AgentTurn[] = [];
    const events: RunEvent[] = [];
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let stopReason: AgentRunResult['stopReason'] = 'complete';
    let error: string | undefined;

    // System prompt
    const systemPrompt = options?.systemPrompt ?? this.config.systemPrompt;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // User prompt
    messages.push({ role: 'user', content: prompt });

    // Emit start event
    events.push({
      type: 'start',
      timestamp: new Date(startTime).toISOString(),
      content: prompt,
    });

    // Agentic loop
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Check timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > maxDurationMs) {
        stopReason = 'timeout';
        events.push({
          type: 'error',
          timestamp: new Date().toISOString(),
          content: `Timeout after ${elapsed}ms`,
        });
        break;
      }

      // Call LLM
      const turnStart = Date.now();
      let response: ChatCompletionResponse;

      try {
        response = await this.callLLM(messages, options);
      } catch (err) {
        stopReason = 'error';
        error = err instanceof Error ? err.message : String(err);
        events.push({
          type: 'error',
          timestamp: new Date().toISOString(),
          content: error,
        });
        break;
      }

      const choice = response.choices[0]!;
      const usage = response.usage;

      if (usage) {
        totalPromptTokens += usage.prompt_tokens;
        totalCompletionTokens += usage.completion_tokens;
      }

      // Emit output event
      events.push({
        type: 'output',
        timestamp: new Date().toISOString(),
        content: choice.message.content ?? undefined,
      });

      // Process tool calls if any
      const toolCalls: CapturedToolCall[] = [];

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        // Add assistant message with tool calls to conversation
        messages.push({
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        });

        // Execute each tool call
        for (const tc of choice.message.tool_calls) {
          const toolStart = Date.now();
          const toolDef = this.toolMap.get(tc.function.name);

          events.push({
            type: 'tool_call',
            timestamp: new Date().toISOString(),
            content: `${tc.function.name}(${tc.function.arguments})`,
          });

          let toolResult: string;
          if (!toolDef) {
            toolResult = `Error: Unknown tool "${tc.function.name}"`;
          } else {
            try {
              const args = JSON.parse(tc.function.arguments);
              toolResult = await toolDef.execute(args);
            } catch (err) {
              toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          const toolDuration = Date.now() - toolStart;

          toolCalls.push({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
            result: toolResult,
            durationMs: toolDuration,
            timestamp: new Date(toolStart).toISOString(),
          });

          events.push({
            type: 'tool_result',
            timestamp: new Date().toISOString(),
            content: `${tc.function.name}: ${toolResult.slice(0, 500)}`,
          });

          // Add tool result to conversation
          messages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
        }
      } else {
        // No tool calls — add assistant message and we're done
        messages.push({ role: 'assistant', content: choice.message.content ?? '' });
      }

      const turnDuration = Date.now() - turnStart;

      turns.push({
        index: iteration,
        content: choice.message.content ?? '',
        toolCalls,
        tokens: usage ? { prompt: usage.prompt_tokens, completion: usage.completion_tokens } : undefined,
        durationMs: turnDuration,
        finishReason: choice.finish_reason,
      });

      // If no tool calls, the agent is done
      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        stopReason = 'complete';
        break;
      }

      // If we hit max iterations on next loop
      if (iteration === maxIterations - 1) {
        stopReason = 'max_iterations';
      }

      // Emit heartbeat between iterations
      events.push({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
      });
    }

    // Emit end event
    const endTime = Date.now();
    events.push({
      type: 'end',
      timestamp: new Date(endTime).toISOString(),
      content: stopReason,
    });

    // Build timeline
    const timeline: RunTimeline = {
      events,
      startedAt: new Date(startTime).toISOString(),
      endedAt: new Date(endTime).toISOString(),
    };

    // Assemble final output
    const output = this.assembleOutput(turns);

    const result: AgentRunResult = {
      output,
      turns,
      timeline,
      totalTokens: {
        prompt: totalPromptTokens,
        completion: totalCompletionTokens,
        total: totalPromptTokens + totalCompletionTokens,
      },
      durationMs: endTime - startTime,
      completed: stopReason === 'complete',
      stopReason,
      error,
    };

    this.lastRun = result;
    return result;
  }

  /**
   * Call the LLM backend.
   */
  private async callLLM(messages: ChatMessage[], options?: ProviderOptions): Promise<ChatCompletionResponse> {
    const llm = this.config.llm;
    const apiVersion = llm.apiVersion ?? '2024-08-01-preview';
    const url = `${llm.endpoint.replace(/\/$/, '')}/openai/deployments/${llm.deployment}/chat/completions?api-version=${apiVersion}`;

    // Build tool definitions for the API
    const tools = this.config.tools && this.config.tools.length > 0
      ? this.config.tools.map(t => ({
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

    if (tools) body.tools = tools;
    if (options?.maxTokens ?? llm.maxTokens) body.max_tokens = options?.maxTokens ?? llm.maxTokens;

    const timeoutMs = llm.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': llm.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorText}`);
      }

      return (await response.json()) as ChatCompletionResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Assemble final output from all turns.
   */
  private assembleOutput(turns: AgentTurn[]): string {
    if (turns.length === 0) return '';

    if (this.config.includeToolResults) {
      // Include tool call results in the output (useful for debugging)
      return turns.map(t => {
        const parts = [t.content];
        for (const tc of t.toolCalls) {
          parts.push(`[${tc.name}]: ${tc.result}`);
        }
        return parts.filter(Boolean).join('\n');
      }).join('\n\n---\n\n');
    }

    // Default: return only the last assistant message (the final answer)
    const lastTurn = turns[turns.length - 1]!;
    return lastTurn.content;
  }
}

// ─── HELPERS: EVALUATION WITH TIMELINE ──────────────────────────────────────────

/**
 * Helper to create an EvalContext that includes the agent run timeline.
 *
 * Use this to pass timeline data to staleness/loop assertions:
 *
 * @example
 * ```ts
 * const provider = new AgentProvider({ ... });
 * const result = await provider.run('refactor the auth module');
 *
 * // Create context with timeline for staleness checks
 * const context = agentContext(result);
 * await toNotBeStale().evaluate(result.output, context);
 * await toNotBeStalled().evaluate(result.output, context);
 * ```
 */
export function agentContext(run: AgentRunResult): {
  prompt: string;
  metadata: { timeline: RunTimeline; turns: AgentTurn[]; tokens: AgentRunResult['totalTokens'] };
} {
  const firstUserMessage = run.turns.length > 0 ? '' : '';
  return {
    prompt: firstUserMessage,
    metadata: {
      timeline: run.timeline,
      turns: run.turns,
      tokens: run.totalTokens,
    },
  };
}

// ─── TOOL BUILDERS ──────────────────────────────────────────────────────────────

/**
 * Fluent tool definition builder.
 *
 * @example
 * ```ts
 * const readFile = defineTool('read_file')
 *   .describe('Read a file from disk')
 *   .param('path', 'string', 'File path to read', true)
 *   .execute(async (args) => fs.readFileSync(args.path as string, 'utf-8'));
 * ```
 */
export function defineTool(name: string): ToolBuilder {
  return new ToolBuilder(name);
}

export class ToolBuilder {
  private _name: string;
  private _description = '';
  private _params: Record<string, unknown> = { type: 'object', properties: {}, required: [] };

  constructor(name: string) {
    this._name = name;
  }

  describe(description: string): this {
    this._description = description;
    return this;
  }

  param(name: string, type: string, description: string, required = false): this {
    const props = (this._params as { properties: Record<string, unknown>; required: string[] });
    props.properties[name] = { type, description };
    if (required) props.required.push(name);
    return this;
  }

  execute(fn: (args: Record<string, unknown>) => Promise<string>): ToolDefinition {
    return {
      name: this._name,
      description: this._description,
      parameters: this._params,
      execute: fn,
    };
  }
}
