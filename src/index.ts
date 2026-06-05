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

// CLI utilities (for programmatic use)
export { parseCliArgs } from './cli/args.js';
export type { ParsedArgs } from './cli/args.js';
export { discoverSpecs } from './cli/discover.js';

// Checks (Tier 1 — Deterministic)
export {
  // Format validation
  toMatchJsonSchema,
  toBeValidJsonStrict,
  toHaveMarkdownStructure,
  toHaveSections,
  toHaveCodeBlocks,
  toBeFormat,
  validateJsonSchema,
  validateMarkdownStructure,
  parseMarkdownStructure,
  // Path/URL verification
  toHaveValidUrls,
  toHaveValidPaths,
  toHaveValidGitHubRefs,
  toHaveValidReferences,
  toReferenceUrls,
  toHaveWellFormedUrls,
  toReferencePaths,
  extractReferences,
  verifyUrl,
  verifyFilePath,
  verifyGitHubRepo,
  verifyGitHubIssue,
  verifyReferences,
} from './checks/index.js';
export type {
  JsonSchema,
  JsonSchemaType,
  SchemaValidationError,
  SchemaValidationResult,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
  ExtractedReference,
  UrlVerifyOptions,
  FilePathVerifyOptions,
  ReferenceVerifyResult,
  PathVerifyOptions,
  BatchVerifyOptions,
} from './checks/index.js';

// Helpers
export { defineEval } from './define.js';
