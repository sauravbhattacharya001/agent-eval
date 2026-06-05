/**
 * Built-in checks — Tier 1, 2, and 3 evaluation modules.
 *
 * @packageDocumentation
 */

export {
  // Format validation assertions
  toMatchJsonSchema,
  toBeValidJsonStrict,
  toHaveMarkdownStructure,
  toHaveSections,
  toHaveCodeBlocks,
  toBeFormat,
  // Utilities
  validateJsonSchema,
  validateMarkdownStructure,
  parseMarkdownStructure,
} from './format.js';

export type {
  JsonSchema,
  JsonSchemaType,
  SchemaValidationError,
  SchemaValidationResult,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
} from './format.js';
