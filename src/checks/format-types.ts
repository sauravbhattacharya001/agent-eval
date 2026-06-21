/**
 * Format Validator — Type Vocabulary
 *
 * The types shared by the format-validation engine (`./format-analysis.js`)
 * and the public barrel (`./format.js`): JSON Schema definitions and the
 * markdown-structure model. Kept dependency-free so both the engine and the
 * assertion factories can import them without pulling in any runtime code.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

// ─── JSON SCHEMA TYPES ─────────────────────────────────────────────────────────

/** Supported JSON Schema types for validation. */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

/** A simplified JSON Schema definition for validation. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: unknown[];
  /** Allow additional properties not in `properties`. Default: true. */
  additionalProperties?: boolean | JsonSchema;
  /** Human-readable description for error messages. */
  description?: string;
}

/** A single schema validation error. */
export interface SchemaValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

/** Result of JSON schema validation. */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

// ─── MARKDOWN STRUCTURE TYPES ───────────────────────────────────────────────────

/** A parsed markdown heading. */
export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

/** Options for markdown structure validation. */
export interface MarkdownStructureOptions {
  /** Required heading texts (case-insensitive by default). */
  requiredSections?: string[];
  /** Minimum heading count. */
  minHeadings?: number;
  /** Maximum heading level allowed (1-6). */
  maxHeadingLevel?: number;
  /** Whether to require headings be in hierarchical order. */
  requireHierarchy?: boolean;
  /** Minimum number of code blocks required. */
  minCodeBlocks?: number;
  /** Required code block languages. */
  requiredCodeLanguages?: string[];
  /** Whether to be case-sensitive when matching section names. */
  caseSensitive?: boolean;
  /** Minimum total line count. */
  minLines?: number;
  /** Maximum total line count. */
  maxLines?: number;
}

/** Result of markdown structure validation. */
export interface MarkdownValidationResult {
  valid: boolean;
  headings: MarkdownHeading[];
  codeBlocks: ParsedCodeBlock[];
  errors: string[];
  lineCount: number;
}

/** A parsed code block from markdown. */
export interface ParsedCodeBlock {
  language: string;
  content: string;
  startLine: number;
  endLine: number;
}