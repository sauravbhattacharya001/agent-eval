/**
 * agent-eval — A lightweight TypeScript framework for testing and evaluating AI agent outputs.
 *
 * @packageDocumentation
 */

// Core
export {
  runSuite,
  runSuites,
  resolveProvider,
} from './core/runner.js';
export type { RunnerOptions } from './core/runner.js';

// Types
export type {
  Assertion,
  AssertionResult,
  AssertionStatus,
  EvalContext,
  EvalProvider,
  EvalSpec,
  EvalSuiteDefinition,
  ProviderOptions,
  Reporter,
  SpecResult,
  SuiteResult,
} from './core/types.js';

// Assertions
export {
  toContain,
  toMatch,
  toEqual,
  notToContain,
  notToMatch,
  toHaveMinLength,
  toHaveMaxLength,
  toBeValidJson,
  toStartWith,
  toEndWith,
  custom,
} from './core/assertions.js';

// Reporters
export { TerminalReporter, JsonReporter } from './core/reporter.js';

// Providers
export { LocalProvider } from './providers/local.js';
export type { LocalProviderConfig } from './providers/local.js';

// Helpers
export { defineEval } from './define.js';
