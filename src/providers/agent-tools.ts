/**
 * Agent tool builders — the fluent {@link defineTool}/{@link ToolBuilder} API for
 * declaring the functions an {@link AgentProvider} can call.
 *
 * This is a leaf module: it depends only on the {@link ToolDefinition} shape and
 * carries no loop, transport, or timeline logic. It was extracted from
 * `providers/agent.ts` so that file stays focused on the agentic loop and tool
 * dispatch. The builders are re-exported from `./agent.js`, so the public import
 * path at `./providers/agent.js` is unchanged.
 *
 * @module
 */

import type { ToolDefinition } from './agent-types.js';

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
