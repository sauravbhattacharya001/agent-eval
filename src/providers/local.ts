/**
 * Local provider — returns pre-defined outputs for testing without API calls.
 */

import type { EvalProvider, ProviderOptions } from '../core/types.js';

export interface LocalProviderConfig {
  /** Map of prompt → output. Can use exact match or pattern match. */
  outputs: Map<string, string> | Record<string, string>;
  /** Default output if no match found. */
  defaultOutput?: string;
  /** Use substring matching instead of exact match. */
  substringMatch?: boolean;
}

/**
 * A provider that returns pre-defined outputs — no API calls needed.
 * Perfect for testing, CI, and offline development.
 */
export class LocalProvider implements EvalProvider {
  readonly name = 'local';
  private outputs: Map<string, string>;
  private defaultOutput: string | undefined;
  private substringMatch: boolean;

  constructor(config: LocalProviderConfig) {
    this.outputs =
      config.outputs instanceof Map
        ? config.outputs
        : new Map(Object.entries(config.outputs));
    this.defaultOutput = config.defaultOutput;
    this.substringMatch = config.substringMatch ?? false;
  }

  async generate(prompt: string, _options?: ProviderOptions): Promise<string> {
    // Try exact match first
    const exact = this.outputs.get(prompt);
    if (exact !== undefined) {
      return exact;
    }

    // Try substring match if enabled
    if (this.substringMatch) {
      for (const [key, value] of this.outputs) {
        if (prompt.includes(key) || key.includes(prompt)) {
          return value;
        }
      }
    }

    // Fall back to default
    if (this.defaultOutput !== undefined) {
      return this.defaultOutput;
    }

    throw new Error(
      `LocalProvider: no output defined for prompt "${prompt.slice(0, 100)}". ` +
        'Add it to the outputs map or set a defaultOutput.',
    );
  }
}
