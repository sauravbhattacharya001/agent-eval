/**
 * Format Validator — Deterministic Engine
 *
 * Pure parse-based validation with zero AI dependencies: a JSON Schema
 * validator (subset) and a markdown-structure parser/validator. No
 * filesystem or network access — input strings in, results out.
 *
 * Re-exported through the public barrel (`./format.js`); the type vocabulary
 * lives in `./format-types.js`.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type {
  JsonSchema,
  JsonSchemaType,
  MarkdownHeading,
  MarkdownStructureOptions,
  MarkdownValidationResult,
  ParsedCodeBlock,
  SchemaValidationError,
  SchemaValidationResult,
} from './format-types.js';

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