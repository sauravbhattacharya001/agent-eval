/**
 * Format Validator — Tier 1 Deterministic Check
 *
 * Pure parse-based validation with zero AI dependencies:
 * - JSON: parse validity + optional JSON Schema validation
 * - Markdown: structural validation (headings, required sections, code blocks)
 * - Generic format assertions usable in eval specs
 *
 * This file is the **public barrel** for format checking. The implementation
 * lives in seams alongside it and is re-exported here so the public surface
 * stays a single `./format.js` import path:
 * - ./format-types.js      - the type vocabulary (JSON Schema + markdown model)
 * - ./format-analysis.js   - the deterministic engine (validateJsonSchema /
 *                            parseMarkdownStructure / validateMarkdownStructure)
 * - ./format-assertions.js - the Jest/Vitest-style assertion factories that wrap
 *                            the engine (toMatchJsonSchema, toBeFormat, ...)
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

// --- TYPE RE-EXPORTS -----------------------------------------------------------
// The format type vocabulary lives in ./format-types.js; re-export it here so
// consumers keep a single `./format.js` import path.
export type {
  JsonSchema,
  JsonSchemaType,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
  SchemaValidationError,
  SchemaValidationResult,
} from './format-types.js';

// --- ENGINE RE-EXPORTS ---------------------------------------------------------
// The deterministic engine (JSON Schema validation + markdown parsing) lives
// alongside; re-export the public functions so the barrel is the single surface.
export {
  parseMarkdownStructure,
  validateJsonSchema,
  validateMarkdownStructure,
} from './format-analysis.js';

// --- ASSERTION FACTORY RE-EXPORTS ---------------------------------------------
// The Jest/Vitest-style assertion factories live in ./format-assertions.js;
// re-export them so the barrel remains the single public surface.
export {
  toBeFormat,
  toBeValidJsonStrict,
  toHaveCodeBlocks,
  toHaveMarkdownStructure,
  toHaveSections,
  toMatchJsonSchema,
} from './format-assertions.js';
