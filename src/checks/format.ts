/**
 * Format Validator — Tier 1 Deterministic Check
 *
 * Pure parse-based validation with zero AI dependencies:
 * - JSON: parse validity + optional JSON Schema validation
 * - Markdown: structural validation (headings, required sections, code blocks)
 * - Generic format assertions usable in eval specs
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';

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

// ─── JSON SCHEMA VALIDATION ─────────────────────────────────────────────────────

/**
 * Validate a value against a JSON Schema (subset).
 *
 * Supports type, properties, required, items, min/max, pattern, enum,
 * and additionalProperties. Does not support $ref, allOf, anyOf, oneOf.
 */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = ''): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  validateNode(value, schema, path || '$', errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: SchemaValidationError[]): void {
  // Type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(value);
    if (!types.some((t) => typeMatches(actualType, t))) {
      errors.push({
        path,
        message: `Expected type ${types.join(' | ')}, got ${actualType}`,
        expected: types.join(' | '),
        actual: actualType,
      });
      return; // Skip further validation if type is wrong
    }
  }

  // Enum check
  if (schema.enum !== undefined) {
    const matches = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value));
    if (!matches) {
      errors.push({
        path,
        message: `Value must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
        expected: schema.enum.map((e) => JSON.stringify(e)).join(' | '),
        actual: JSON.stringify(value),
      });
    }
  }

  // String-specific
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `String length ${value.length} is below minimum ${schema.minLength}`,
        expected: `>= ${schema.minLength}`,
        actual: `${value.length}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `String length ${value.length} exceeds maximum ${schema.maxLength}`,
        expected: `<= ${schema.maxLength}`,
        actual: `${value.length}`,
      });
    }
    if (schema.pattern !== undefined) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push({
          path,
          message: `String does not match pattern /${schema.pattern}/`,
          expected: schema.pattern,
          actual: value.slice(0, 100),
        });
      }
    }
  }

  // Number-specific
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        path,
        message: `Value ${value} is below minimum ${schema.minimum}`,
        expected: `>= ${schema.minimum}`,
        actual: `${value}`,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        path,
        message: `Value ${value} exceeds maximum ${schema.maximum}`,
        expected: `<= ${schema.maximum}`,
        actual: `${value}`,
      });
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      errors.push({
        path,
        message: `Expected integer, got float`,
        expected: 'integer',
        actual: `${value}`,
      });
    }
  }

  // Array-specific
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path,
        message: `Array length ${value.length} is below minimum ${schema.minItems}`,
        expected: `>= ${schema.minItems} items`,
        actual: `${value.length} items`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `Array length ${value.length} exceeds maximum ${schema.maxItems}`,
        expected: `<= ${schema.maxItems} items`,
        actual: `${value.length} items`,
      });
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        validateNode(value[i], schema.items, `${path}[${i}]`, errors);
      }
    }
  }

  // Object-specific
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    // Required properties
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({
            path: `${path}.${key}`,
            message: `Required property "${key}" is missing`,
            expected: `property "${key}"`,
            actual: 'undefined',
          });
        }
      }
    }

    // Property schemas
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validateNode(obj[key], propSchema, `${path}.${key}`, errors);
        }
      }
    }

    // Additional properties
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({
            path: `${path}.${key}`,
            message: `Additional property "${key}" is not allowed`,
            expected: 'no additional properties',
            actual: key,
          });
        }
      }
    } else if (typeof schema.additionalProperties === 'object' && schema.properties) {
      const defined = new Set(Object.keys(schema.properties));
      for (const [key, val] of Object.entries(obj)) {
        if (!defined.has(key)) {
          validateNode(val, schema.additionalProperties, `${path}.${key}`, errors);
        }
      }
    }
  }
}

function getJsonType(value: unknown): JsonSchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value as JsonSchemaType;
}

/** Check if a value's type matches a schema type (number matches integer). */
function typeMatches(actualType: JsonSchemaType, schemaType: JsonSchemaType): boolean {
  if (actualType === schemaType) return true;
  // 'number' in schema accepts both integer and float
  if (schemaType === 'number' && actualType === 'integer') return true;
  return false;
}

// ─── MARKDOWN PARSING ────────────────────────────────────────────────────────────

/**
 * Parse markdown content and extract structure (headings, code blocks).
 */
export function parseMarkdownStructure(content: string): { headings: MarkdownHeading[]; codeBlocks: ParsedCodeBlock[]; lineCount: number } {
  const lines = content.split('\n');
  const headings: MarkdownHeading[] = [];
  const codeBlocks: ParsedCodeBlock[] = [];

  let inCodeBlock = false;
  let currentBlockLang = '';
  let currentBlockContent: string[] = [];
  let currentBlockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNum = i + 1;

    // Code block detection (fenced)
    const fenceMatch = line.match(/^(`{3,}|~{3,})(\S*)/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        currentBlockLang = fenceMatch[2] ?? '';
        currentBlockContent = [];
        currentBlockStart = lineNum;
      } else {
        codeBlocks.push({
          language: currentBlockLang,
          content: currentBlockContent.join('\n'),
          startLine: currentBlockStart,
          endLine: lineNum,
        });
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      currentBlockContent.push(line);
      continue;
    }

    // ATX heading detection
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      const levelStr = headingMatch[1] as string;
      const textStr = headingMatch[2] as string;
      headings.push({
        level: levelStr.length,
        text: textStr.trim(),
        line: lineNum,
      });
    }
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    codeBlocks.push({
      language: currentBlockLang,
      content: currentBlockContent.join('\n'),
      startLine: currentBlockStart,
      endLine: lines.length,
    });
  }

  return { headings, codeBlocks, lineCount: lines.length };
}

/**
 * Validate markdown structure against requirements.
 */
export function validateMarkdownStructure(content: string, options: MarkdownStructureOptions = {}): MarkdownValidationResult {
  const { headings, codeBlocks, lineCount } = parseMarkdownStructure(content);
  const errors: string[] = [];

  // Line count
  if (options.minLines !== undefined && lineCount < options.minLines) {
    errors.push(`Document has ${lineCount} lines, minimum required: ${options.minLines}`);
  }
  if (options.maxLines !== undefined && lineCount > options.maxLines) {
    errors.push(`Document has ${lineCount} lines, maximum allowed: ${options.maxLines}`);
  }

  // Heading count
  if (options.minHeadings !== undefined && headings.length < options.minHeadings) {
    errors.push(`Found ${headings.length} headings, minimum required: ${options.minHeadings}`);
  }

  // Max heading level
  if (options.maxHeadingLevel !== undefined) {
    const maxLevel = options.maxHeadingLevel;
    const deepHeadings = headings.filter((h) => h.level > maxLevel);
    if (deepHeadings.length > 0) {
      errors.push(
        `Found headings deeper than level ${options.maxHeadingLevel}: ${deepHeadings.map((h) => `"${h.text}" (h${h.level}, line ${h.line})`).join(', ')}`,
      );
    }
  }

  // Required sections
  if (options.requiredSections) {
    const headingTexts = headings.map((h) => (options.caseSensitive ? h.text : h.text.toLowerCase()));
    for (const section of options.requiredSections) {
      const needle = options.caseSensitive ? section : section.toLowerCase();
      if (!headingTexts.includes(needle)) {
        errors.push(`Missing required section: "${section}"`);
      }
    }
  }

  // Heading hierarchy
  if (options.requireHierarchy && headings.length > 0) {
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1] as MarkdownHeading;
      const curr = headings[i] as MarkdownHeading;
      // A heading can be same level, go deeper by 1, or go back to any higher level
      if (curr.level > prev.level + 1) {
        errors.push(
          `Heading hierarchy violated: "${curr.text}" (h${curr.level}, line ${curr.line}) skips from h${prev.level} to h${curr.level}`,
        );
      }
    }
  }

  // Code blocks
  if (options.minCodeBlocks !== undefined && codeBlocks.length < options.minCodeBlocks) {
    errors.push(`Found ${codeBlocks.length} code blocks, minimum required: ${options.minCodeBlocks}`);
  }

  // Required code languages
  if (options.requiredCodeLanguages) {
    const foundLangs = new Set(codeBlocks.map((b) => b.language.toLowerCase()));
    for (const lang of options.requiredCodeLanguages) {
      if (!foundLangs.has(lang.toLowerCase())) {
        errors.push(`Missing code block with language: "${lang}"`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    headings,
    codeBlocks,
    errors,
    lineCount,
  };
}

// ─── ASSERTION FACTORIES ────────────────────────────────────────────────────────

/**
 * Assert output is valid JSON that conforms to a schema.
 *
 * @tier 1 — Deterministic
 */
export function toMatchJsonSchema(schema: JsonSchema): Assertion {
  return {
    name: 'matches JSON schema',
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      // First, parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          name: 'matches JSON schema',
          message: `Output is not valid JSON: ${message}`,
          actual: output.slice(0, 200),
          durationMs: performance.now() - start,
        };
      }

      // Then validate schema
      const result = validateJsonSchema(parsed, schema);
      if (result.valid) {
        return {
          status: 'pass',
          name: 'matches JSON schema',
          durationMs: performance.now() - start,
        };
      }

      const errorSummary = result.errors
        .slice(0, 5)
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n');
      return {
        status: 'fail',
        name: 'matches JSON schema',
        message: `JSON schema validation failed:\n${errorSummary}${result.errors.length > 5 ? `\n  ... and ${result.errors.length - 5} more errors` : ''}`,
        evidence: JSON.stringify(result.errors, null, 2),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output is valid JSON (optionally extracting from markdown code blocks).
 *
 * @tier 1 — Deterministic
 */
export function toBeValidJsonStrict(options?: { allowWrappedInCodeBlock?: boolean }): Assertion {
  return {
    name: 'valid JSON (strict)',
    evaluate(output: string): AssertionResult {
      const start = performance.now();

      let jsonStr = output.trim();

      // Optionally extract from markdown code block
      if (options?.allowWrappedInCodeBlock) {
        const codeBlockMatch = jsonStr.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
        if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
          jsonStr = codeBlockMatch[1] as string;
        }
      }

      try {
        JSON.parse(jsonStr);
        return {
          status: 'pass',
          name: 'valid JSON (strict)',
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          name: 'valid JSON (strict)',
          message: `Output is not valid JSON: ${message}`,
          actual: jsonStr.slice(0, 200),
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert output has valid markdown structure with specific requirements.
 *
 * @tier 1 — Deterministic
 */
export function toHaveMarkdownStructure(options: MarkdownStructureOptions): Assertion {
  return {
    name: 'valid markdown structure',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const result = validateMarkdownStructure(output, options);

      if (result.valid) {
        return {
          status: 'pass',
          name: 'valid markdown structure',
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: 'valid markdown structure',
        message: `Markdown structure validation failed:\n${result.errors.map((e) => `  • ${e}`).join('\n')}`,
        evidence: JSON.stringify({ headings: result.headings, codeBlockCount: result.codeBlocks.length, lineCount: result.lineCount }, null, 2),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output contains specific required sections (headings).
 *
 * @tier 1 — Deterministic
 */
export function toHaveSections(sections: string[], options?: { caseSensitive?: boolean }): Assertion {
  const caseSensitive = options?.caseSensitive ?? false;
  return {
    name: `has sections: ${sections.join(', ')}`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const { headings } = parseMarkdownStructure(output);
      const headingTexts = headings.map((h) => (caseSensitive ? h.text : h.text.toLowerCase()));

      const missing: string[] = [];
      for (const section of sections) {
        const needle = caseSensitive ? section : section.toLowerCase();
        if (!headingTexts.includes(needle)) {
          missing.push(section);
        }
      }

      if (missing.length === 0) {
        return {
          status: 'pass',
          name: `has sections: ${sections.join(', ')}`,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name: `has sections: ${sections.join(', ')}`,
        message: `Missing required sections: ${missing.map((s) => `"${s}"`).join(', ')}`,
        expected: sections.join(', '),
        actual: headingTexts.join(', ') || '(no headings found)',
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output contains at least N code blocks (optionally with specific languages).
 *
 * @tier 1 — Deterministic
 */
export function toHaveCodeBlocks(options: { min?: number; max?: number; languages?: string[] }): Assertion {
  const name = `has code blocks${options.min ? ` (min: ${options.min})` : ''}${options.languages ? ` [${options.languages.join(', ')}]` : ''}`;
  return {
    name,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const { codeBlocks } = parseMarkdownStructure(output);

      const errors: string[] = [];

      if (options.min !== undefined && codeBlocks.length < options.min) {
        errors.push(`Found ${codeBlocks.length} code blocks, need at least ${options.min}`);
      }
      if (options.max !== undefined && codeBlocks.length > options.max) {
        errors.push(`Found ${codeBlocks.length} code blocks, maximum is ${options.max}`);
      }
      if (options.languages) {
        const foundLangs = new Set(codeBlocks.map((b) => b.language.toLowerCase()));
        const missingLangs = options.languages.filter((l) => !foundLangs.has(l.toLowerCase()));
        if (missingLangs.length > 0) {
          errors.push(`Missing code block languages: ${missingLangs.join(', ')}`);
        }
      }

      if (errors.length === 0) {
        return {
          status: 'pass',
          name,
          durationMs: performance.now() - start,
        };
      }

      return {
        status: 'fail',
        name,
        message: errors.join('; '),
        evidence: `Found: ${codeBlocks.map((b) => b.language || '(no lang)').join(', ') || 'none'}`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output matches one of the expected formats.
 *
 * @tier 1 — Deterministic
 */
export function toBeFormat(format: 'json' | 'markdown' | 'yaml' | 'xml' | 'csv'): Assertion {
  return {
    name: `is ${format} format`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const trimmed = output.trim();

      switch (format) {
        case 'json': {
          try {
            JSON.parse(trimmed);
            return { status: 'pass', name: `is ${format} format`, durationMs: performance.now() - start };
          } catch {
            return {
              status: 'fail',
              name: `is ${format} format`,
              message: 'Output is not valid JSON',
              actual: trimmed.slice(0, 100),
              durationMs: performance.now() - start,
            };
          }
        }
        case 'markdown': {
          // Markdown: must have at least one heading or structural element
          const hasHeading = /^#{1,6}\s+/m.test(trimmed);
          const hasListOrBlock = /^[-*+]\s|^\d+\.\s|^```|^>/m.test(trimmed);
          const isMarkdown = hasHeading || hasListOrBlock;
          return {
            status: isMarkdown ? 'pass' : 'fail',
            name: `is ${format} format`,
            message: isMarkdown ? undefined : 'Output does not appear to be markdown (no headings, lists, code blocks, or blockquotes found)',
            durationMs: performance.now() - start,
          };
        }
        case 'yaml': {
          // YAML: starts with --- or has key: value structure
          const yamlLike = trimmed.startsWith('---') || /^[\w-]+:\s/m.test(trimmed);
          return {
            status: yamlLike ? 'pass' : 'fail',
            name: `is ${format} format`,
            message: yamlLike ? undefined : 'Output does not appear to be YAML (no key:value pairs or --- delimiter found)',
            durationMs: performance.now() - start,
          };
        }
        case 'xml': {
          const xmlLike = trimmed.startsWith('<?xml') || (trimmed.startsWith('<') && trimmed.endsWith('>'));
          return {
            status: xmlLike ? 'pass' : 'fail',
            name: `is ${format} format`,
            message: xmlLike ? undefined : 'Output does not appear to be XML (no XML declaration or root element found)',
            durationMs: performance.now() - start,
          };
        }
        case 'csv': {
          const lines = trimmed.split('\n');
          if (lines.length < 2) {
            return {
              status: 'fail',
              name: `is ${format} format`,
              message: 'CSV requires at least a header row and one data row',
              durationMs: performance.now() - start,
            };
          }
          // Check delimiter consistency
          const headerLine = lines[0] as string;
          const delimiter = headerLine.includes('\t') ? '\t' : ',';
          const headerCols = headerLine.split(delimiter).length;
          const consistent = lines.slice(1).every((l) => l.trim() === '' || l.split(delimiter).length === headerCols);
          return {
            status: consistent ? 'pass' : 'fail',
            name: `is ${format} format`,
            message: consistent ? undefined : `CSV column count inconsistent (header has ${headerCols} columns)`,
            durationMs: performance.now() - start,
          };
        }
      }
    },
  };
}
