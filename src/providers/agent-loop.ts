/**
 * Agent Provider — tool-dispatch helper.
 *
 * The per-turn tool-execution step of the agentic loop in {@link AgentProvider}
 * (`./agent.ts`): given the tool calls the model asked for, run each one against
 * the registered tool implementations and produce the three parallel outputs the
 * loop needs — the captured calls (for the turn/timeline), the timeline events,
 * and the `tool` role messages to append to the conversation.
 *
 * It is split out as a leaf so the engine file (`agent.ts`) stays focused on loop
 * control (iteration, timeout, stop-reason) and so this dispatch step is unit
 * testable without constructing a provider or hitting a backend. It holds **no**
 * network IO: the only side effect is calling the caller-supplied tool
 * `execute()` functions. See ./agent.ts.
 *
 * @module
 */

import type { RunEvent } from '../checks/staleness.js';
import type { CapturedToolCall, ChatMessage, ToolDefinition } from './agent-types.js';

/** A single tool call as requested by the model. */
export type RequestedToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** Result of executing one turn's worth of tool calls. */
export interface ToolDispatchResult {
  /** Captured calls (name, parsed args, result, timing) for the turn/timeline. */
  capturedCalls: CapturedToolCall[];
  /** Timeline events emitted (a `tool_call` + `tool_result` pair per call). */
  events: RunEvent[];
  /** `tool` role messages to append to the conversation, one per call. */
  toolMessages: ChatMessage[];
}

/**
 * Execute every tool call the model requested in a single turn.
 *
 * Behavior (preserved verbatim from the original inline loop):
 * - An unknown tool name yields `Error: Unknown tool "<name>"` as its result
 *   (no throw — the agent sees the error string and can recover next turn).
 * - A tool whose `execute()` throws, or whose arguments fail to `JSON.parse`,
 *   yields `Error: <message>` as its result.
 * - `arguments` on the captured call are parsed from the raw string, defaulting
 *   to `{}` when the model sent an empty arguments payload.
 * - Each call contributes exactly one `tool_call` event, one `tool_result`
 *   event (result truncated to 500 chars), one captured call, and one `tool`
 *   message (keyed by `tool_call_id`).
 *
 * @param requestedCalls the `tool_calls` array from the model's message
 * @param toolMap registered tools, keyed by name
 * @returns captured calls, timeline events, and conversation `tool` messages
 */
export async function executeToolCalls(
  requestedCalls: RequestedToolCall[],
  toolMap: Map<string, ToolDefinition>,
): Promise<ToolDispatchResult> {
  const capturedCalls: CapturedToolCall[] = [];
  const events: RunEvent[] = [];
  const toolMessages: ChatMessage[] = [];

  for (const tc of requestedCalls) {
    const toolStart = Date.now();
    const toolDef = toolMap.get(tc.function.name);

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

    capturedCalls.push({
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

    toolMessages.push({
      role: 'tool',
      content: toolResult,
      tool_call_id: tc.id,
    });
  }

  return { capturedCalls, events, toolMessages };
}
