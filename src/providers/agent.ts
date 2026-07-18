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

// The type vocabulary (tool/turn/run-result shapes, the per-backend LLM configs
// and their union, and the internal OpenAI-compatible wire types) lives in a leaf
// module so this file stays focused on the loop, tool dispatch, and timeline
// capture. The public types are re-exported below so the surface at
// `./providers/agent.js` is unchanged; the wire types (ChatMessage,
// ChatCompletionResponse) are imported for internal use only and deliberately
// NOT re-exported. See ./agent-types.ts.
import type {
  ToolDefinition,
  CapturedToolCall,
  AgentTurn,
  AgentRunResult,
  AgentProviderConfig,
  ChatMessage,
  ChatCompletionResponse,
} from './agent-types.js';

// The four backend HTTP calls live in a sibling transport module so this file
// carries no `fetch`/wire-mapping code. They are pure functions of their inputs
// (the resolved tool list is passed explicitly), which keeps them unit-testable
// without a provider instance. See ./agent-backends.ts.
import {
  callAzureOpenAI,
  callGroq,
  callOpenRouter,
  callGemini,
} from './agent-backends.js';

export type {
  ToolDefinition,
  CapturedToolCall,
  AgentTurn,
  AgentRunResult,
  AgentProviderConfig,
  AzureOpenAIBackendConfig,
  GeminiBackendConfig,
  GroqBackendConfig,
  OpenRouterBackendConfig,
  LLMBackendConfig,
} from './agent-types.js';

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
  private config: AgentProviderConfig &
    Required<Pick<AgentProviderConfig, 'maxIterations' | 'maxDurationMs' | 'includeToolResults'>>;
  private toolMap: Map<string, ToolDefinition>;

  /** Last run result — accessible after generate() for timeline inspection. */
  lastRun: AgentRunResult | null = null;

  constructor(config: AgentProviderConfig) {
    const llmName = config.llm.type === 'azure-openai'
      ? config.llm.deployment
      : config.llm.type === 'groq'
      ? (config.llm.model ?? 'llama-3.3-70b-versatile')
      : config.llm.type === 'openrouter'
      ? (config.llm.model ?? 'anthropic/claude-sonnet-4')
      : (config.llm.model ?? 'gemini-2.0-flash');
    this.name = `agent/${llmName}`;
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
    const maxIterations = this.config.maxIterations;
    const maxDurationMs = this.config.maxDurationMs;

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

      const choice = response.choices[0];
      if (!choice) {
        stopReason = 'error';
        error = 'LLM response contained no choices';
        events.push({
          type: 'error',
          timestamp: new Date().toISOString(),
          content: error,
        });
        break;
      }
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
   *
   * Dispatches to the matching backend transport in `./agent-backends.ts`,
   * passing the resolved tool list explicitly so those functions stay pure and
   * independently testable. Every backend returns the same
   * {@link ChatCompletionResponse} shape, so the loop above never needs to know
   * which backend answered.
   */
  private async callLLM(messages: ChatMessage[], options?: ProviderOptions): Promise<ChatCompletionResponse> {
    const llm = this.config.llm;
    const tools = this.config.tools;

    if (llm.type === 'gemini') {
      return callGemini(messages, llm, tools, options);
    }

    if (llm.type === 'groq') {
      return callGroq(messages, llm, tools, options);
    }

    if (llm.type === 'openrouter') {
      return callOpenRouter(messages, llm, tools, options);
    }

    return callAzureOpenAI(messages, llm, tools, options);
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
    const lastTurn = turns[turns.length - 1];
    return lastTurn ? lastTurn.content : '';
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

// The fluent tool-definition builder (`defineTool` / `ToolBuilder`) lives in a
// leaf module so this file stays focused on the agentic loop, tool dispatch, and
// timeline capture. They are re-exported here so the public surface at
// `./providers/agent.js` is unchanged. See ./agent-tools.ts.
export { defineTool, ToolBuilder } from './agent-tools.js';
