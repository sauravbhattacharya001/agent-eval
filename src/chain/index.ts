/**
 * Chain module — Multi-step prompt sequence evaluation.
 *
 * @module chain
 */

// Types
export type {
  ChainContext,
  PromptBuilder,
  OutputTransformer,
  GateFunction,
  BranchTarget,
  ChainStep,
  ChainDefinition,
  ChainStepStatus,
  ChainStepResult,
  ChainResult,
} from './types.js';

// Runner
export { runChain } from './runner.js';
export type { ChainRunnerOptions } from './runner.js';

// Builder
export { StepBuilder, step, ChainBuilder, chainBuilder, defineChain } from './builder.js';

// Context utilities
export {
  previousOutput,
  namedOutput,
  namedOutputOr,
  outputAt,
  allOutputs,
  template,
  followUp,
  refine,
  validate,
  summarizeChain,
  setMeta,
  getMeta,
  incrementMeta,
  extractJson,
  extractSection,
  extractList,
} from './context.js';
