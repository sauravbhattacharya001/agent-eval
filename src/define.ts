/**
 * Helper to define an eval suite with type safety.
 */

import type { EvalSuiteDefinition } from './core/types.js';

/**
 * Define an eval suite. Provides type safety and IDE autocomplete.
 *
 * @example
 * ```ts
 * import { defineEval } from 'agent-eval';
 *
 * export default defineEval({
 *   name: 'My Agent Tests',
 *   provider: new AzureOpenAIProvider({ deployment: 'gpt-4o' }),
 *   specs: [...]
 * });
 * ```
 */
export function defineEval(suite: EvalSuiteDefinition): EvalSuiteDefinition {
  return suite;
}
