/**
 * Format Validator — Deterministic Engine (barrel)
 *
 * Pure parse-based validation with zero AI dependencies: a JSON Schema
 * validator (subset) and a markdown-structure parser/validator. No filesystem
 * or network access — input strings in, results out.
 *
 * The engine is split across two individually-testable modules:
 * - `./format-json-schema.js` — {@link validateJsonSchema}
 * - `./format-markdown.js` — {@link parseMarkdownStructure}, {@link validateMarkdownStructure}
 *
 * This file preserves the historical `./format-analysis.js` import surface by
 * re-exporting both. Re-exported through the public barrel (`./format.js`); the
 * type vocabulary lives in `./format-types.js`.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

export { validateJsonSchema } from './format-json-schema.js';
export { parseMarkdownStructure, validateMarkdownStructure } from './format-markdown.js';
