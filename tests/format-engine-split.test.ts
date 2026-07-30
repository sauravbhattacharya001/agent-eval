import { describe, it, expect } from 'vitest';

// The Tier-1 format engine was split out of `format-analysis.ts` into two
// individually-testable modules. These tests pin the seam: each split module is
// directly importable, and the historical `format-analysis.js` barrel (plus the
// public `format.js` barrel) still re-export the same function references.
import { validateJsonSchema as jsonSchemaDirect } from '../src/checks/format-json-schema.js';
import {
  parseMarkdownStructure as parseMdDirect,
  validateMarkdownStructure as validateMdDirect,
} from '../src/checks/format-markdown.js';
import {
  validateJsonSchema as jsonSchemaBarrel,
  parseMarkdownStructure as parseMdBarrel,
  validateMarkdownStructure as validateMdBarrel,
} from '../src/checks/format-analysis.js';
import {
  validateJsonSchema as jsonSchemaPublic,
  parseMarkdownStructure as parseMdPublic,
  validateMarkdownStructure as validateMdPublic,
} from '../src/checks/format.js';
import type { JsonSchema } from '../src/checks/format.js';

describe('format engine split — module seam', () => {
  it('re-exports the SAME function reference from every import path', () => {
    expect(jsonSchemaBarrel).toBe(jsonSchemaDirect);
    expect(jsonSchemaPublic).toBe(jsonSchemaDirect);
    expect(parseMdBarrel).toBe(parseMdDirect);
    expect(parseMdPublic).toBe(parseMdDirect);
    expect(validateMdBarrel).toBe(validateMdDirect);
    expect(validateMdPublic).toBe(validateMdDirect);
  });

  it('json-schema engine validates directly with no barrel', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    };
    expect(jsonSchemaDirect({ name: 'ok' }, schema).valid).toBe(true);
    const bad = jsonSchemaDirect({}, schema);
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.message).toContain('Required property "name" is missing');
  });

  it('markdown engine parses and validates directly with no barrel', () => {
    const md = '# Title\n\n```ts\nconst x = 1;\n```\n';
    const parsed = parseMdDirect(md);
    expect(parsed.headings).toHaveLength(1);
    expect(parsed.codeBlocks[0]?.language).toBe('ts');

    const result = validateMdDirect(md, { requiredSections: ['Title'], requiredCodeLanguages: ['ts'] });
    expect(result.valid).toBe(true);

    const missing = validateMdDirect(md, { requiredSections: ['Nonexistent'] });
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]).toContain('Missing required section');
  });
});
