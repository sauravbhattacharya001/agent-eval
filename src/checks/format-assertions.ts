/**
 * Format Assertion Factories — Tier 1 Deterministic Check
 *
 * Jest/Vitest-style assertion factories that wrap the deterministic format
 * engine (`./format-analysis.js`) into `Assertion` objects usable in eval specs.
 * These are pure and have zero AI dependencies.
 *
 * This module holds the assertion factories only; the type vocabulary lives in
 * `./format-types.js` and the engine in `./format-analysis.js`. The public
 * barrel `./format.js` re-exports everything so consumers keep a single import
 * path.
 *
 * @tier 1 — Deterministic (no AI needed, 100% reliable)
 * @module
 */

import type { Assertion, AssertionResult } from '../core/types.js';
import type { JsonSchema, MarkdownStructureOptions } from './format-types.js';
import {
  parseMarkdownStructure,
  validateJsonSchema,
  validateMarkdownStructure,
} from './format-analysis.js';

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
