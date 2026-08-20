import { describe, it, expect } from 'vitest';
import {
  validateJsonSchema,
  validateMarkdownStructure,
  parseMarkdownStructure,
  toMatchJsonSchema,
  toBeValidJsonStrict,
  toHaveMarkdownStructure,
  toHaveSections,
  toHaveCodeBlocks,
  toBeFormat,
} from '../src/checks/format.js';
import type { JsonSchema } from '../src/checks/format.js';

// ─── validateJsonSchema ─────────────────────────────────────────────────────────

describe('validateJsonSchema', () => {
  it('validates primitive types', () => {
    expect(validateJsonSchema('hello', { type: 'string' }).valid).toBe(true);
    expect(validateJsonSchema(42, { type: 'number' }).valid).toBe(true);
    expect(validateJsonSchema(42, { type: 'integer' }).valid).toBe(true);
    expect(validateJsonSchema(true, { type: 'boolean' }).valid).toBe(true);
    expect(validateJsonSchema(null, { type: 'null' }).valid).toBe(true);
    expect(validateJsonSchema([], { type: 'array' }).valid).toBe(true);
    expect(validateJsonSchema({}, { type: 'object' }).valid).toBe(true);
  });

  it('rejects mismatched types', () => {
    const result = validateJsonSchema('hello', { type: 'number' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Expected type number');
  });

  it('supports union types', () => {
    const schema: JsonSchema = { type: ['string', 'null'] };
    expect(validateJsonSchema('hello', schema).valid).toBe(true);
    expect(validateJsonSchema(null, schema).valid).toBe(true);
    expect(validateJsonSchema(42, schema).valid).toBe(false);
  });

  it('validates string length constraints', () => {
    const schema: JsonSchema = { type: 'string', minLength: 3, maxLength: 10 };
    expect(validateJsonSchema('hello', schema).valid).toBe(true);
    expect(validateJsonSchema('hi', schema).valid).toBe(false);
    expect(validateJsonSchema('hello world!', schema).valid).toBe(false);
  });

  it('validates string pattern', () => {
    const schema: JsonSchema = { type: 'string', pattern: '^[A-Z][a-z]+$' };
    expect(validateJsonSchema('Hello', schema).valid).toBe(true);
    expect(validateJsonSchema('hello', schema).valid).toBe(false);
  });

  it('validates number range', () => {
    const schema: JsonSchema = { type: 'number', minimum: 0, maximum: 100 };
    expect(validateJsonSchema(50, schema).valid).toBe(true);
    expect(validateJsonSchema(-1, schema).valid).toBe(false);
    expect(validateJsonSchema(101, schema).valid).toBe(false);
  });

  it('validates integer type strictly', () => {
    const schema: JsonSchema = { type: 'integer' };
    expect(validateJsonSchema(42, schema).valid).toBe(true);
    expect(validateJsonSchema(3.14, schema).valid).toBe(false);
  });

  it('validates enum values', () => {
    const schema: JsonSchema = { enum: ['red', 'green', 'blue'] };
    expect(validateJsonSchema('red', schema).valid).toBe(true);
    expect(validateJsonSchema('yellow', schema).valid).toBe(false);
  });

  it('validates array items', () => {
    const schema: JsonSchema = { type: 'array', items: { type: 'string' } };
    expect(validateJsonSchema(['a', 'b'], schema).valid).toBe(true);
    expect(validateJsonSchema(['a', 42], schema).valid).toBe(false);
  });

  it('validates array length constraints', () => {
    const schema: JsonSchema = { type: 'array', minItems: 2, maxItems: 4 };
    expect(validateJsonSchema([1, 2, 3], schema).valid).toBe(true);
    expect(validateJsonSchema([1], schema).valid).toBe(false);
    expect(validateJsonSchema([1, 2, 3, 4, 5], schema).valid).toBe(false);
  });

  it('validates object required properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name', 'age'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
    };
    expect(validateJsonSchema({ name: 'Alice', age: 30 }, schema).valid).toBe(true);
    const result = validateJsonSchema({ name: 'Alice' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Required property "age" is missing');
  });

  it('validates nested object properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string' },
            zip: { type: 'string', pattern: '^\\d{5}$' },
          },
        },
      },
    };
    expect(validateJsonSchema({ address: { city: 'NYC', zip: '10001' } }, schema).valid).toBe(true);
    expect(validateJsonSchema({ address: { city: 'NYC', zip: 'abc' } }, schema).valid).toBe(false);
  });

  it('rejects additional properties when not allowed', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    expect(validateJsonSchema({ name: 'Alice' }, schema).valid).toBe(true);
    const result = validateJsonSchema({ name: 'Alice', extra: true }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Additional property "extra"');
  });

  it('validates additionalProperties with schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: { type: 'number' },
    };
    expect(validateJsonSchema({ name: 'Alice', score: 99 }, schema).valid).toBe(true);
    expect(validateJsonSchema({ name: 'Alice', score: 'high' }, schema).valid).toBe(false);
  });

  // additionalProperties is only enforced when `properties` is also present
  // (the `&& schema.properties` guard on both arms). Without `properties`,
  // extra keys go unvalidated - pin that documented subset limitation.
  it('ignores additionalProperties:false when no properties are declared', () => {
    const schema: JsonSchema = { type: 'object', additionalProperties: false };
    // No `properties` key -> the false-arm guard is skipped, extras allowed.
    expect(validateJsonSchema({ anything: 1, more: 2 }, schema).valid).toBe(true);
  });

  it('ignores additionalProperties schema when no properties are declared', () => {
    const schema: JsonSchema = { type: 'object', additionalProperties: { type: 'number' } };
    // No `properties` key -> the object-arm guard is skipped; a non-number
    // extra key is NOT validated against the additionalProperties schema.
    expect(validateJsonSchema({ extra: 'not-a-number' }, schema).valid).toBe(true);
  });

  it('reports paths correctly for nested errors', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
        },
      },
    };
    const result = validateJsonSchema({ items: [{ id: 1 }, { id: 'two' }] }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('$.items[1].id');
  });

  it('passes empty schema (no constraints)', () => {
    expect(validateJsonSchema('anything', {}).valid).toBe(true);
    expect(validateJsonSchema(42, {}).valid).toBe(true);
    expect(validateJsonSchema(null, {}).valid).toBe(true);
  });
});

// ─── parseMarkdownStructure ──────────────────────────────────────────────────────

describe('parseMarkdownStructure', () => {
  it('extracts ATX headings', () => {
    const md = '# Title\n\nSome text\n\n## Section A\n\n### Subsection\n';
    const { headings } = parseMarkdownStructure(md);
    expect(headings).toHaveLength(3);
    expect(headings[0]).toEqual({ level: 1, text: 'Title', line: 1 });
    expect(headings[1]).toEqual({ level: 2, text: 'Section A', line: 5 });
    expect(headings[2]).toEqual({ level: 3, text: 'Subsection', line: 7 });
  });

  it('extracts fenced code blocks with language', () => {
    const md = '# Example\n\n```typescript\nconst x = 1;\n```\n\n```python\nprint("hi")\n```\n';
    const { codeBlocks } = parseMarkdownStructure(md);
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0].language).toBe('typescript');
    expect(codeBlocks[0].content).toBe('const x = 1;');
    expect(codeBlocks[1].language).toBe('python');
    expect(codeBlocks[1].content).toBe('print("hi")');
  });

  it('handles code blocks without language', () => {
    const md = '```\nplain code\n```\n';
    const { codeBlocks } = parseMarkdownStructure(md);
    expect(codeBlocks[0].language).toBe('');
    expect(codeBlocks[0].content).toBe('plain code');
  });

  it('handles unclosed code blocks', () => {
    const md = '```python\ndef foo():\n  pass\n';
    const { codeBlocks } = parseMarkdownStructure(md);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].content).toContain('def foo()');
  });

  it('does not parse headings inside code blocks', () => {
    const md = '# Real\n\n```\n# Not a heading\n```\n\n## Also real\n';
    const { headings } = parseMarkdownStructure(md);
    expect(headings).toHaveLength(2);
    expect(headings[0].text).toBe('Real');
    expect(headings[1].text).toBe('Also real');
  });

  it('handles trailing # in headings', () => {
    const md = '## Section ##\n';
    const { headings } = parseMarkdownStructure(md);
    expect(headings[0].text).toBe('Section');
  });

  it('returns correct line count', () => {
    const md = 'line1\nline2\nline3\n';
    const { lineCount } = parseMarkdownStructure(md);
    expect(lineCount).toBe(4); // trailing newline creates empty line
  });

  it('handles tilde code fences', () => {
    const md = '~~~bash\necho hello\n~~~\n';
    const { codeBlocks } = parseMarkdownStructure(md);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].language).toBe('bash');
  });
});

// ─── validateMarkdownStructure ───────────────────────────────────────────────────

describe('validateMarkdownStructure', () => {
  it('passes with no constraints', () => {
    const result = validateMarkdownStructure('# Hello\n\nWorld');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates required sections (case-insensitive)', () => {
    const md = '# Introduction\n\n## Methods\n\n## Results\n';
    const result = validateMarkdownStructure(md, {
      requiredSections: ['Introduction', 'Methods', 'Conclusion'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Conclusion');
  });

  it('validates required sections (case-sensitive)', () => {
    const md = '# introduction\n';
    const result = validateMarkdownStructure(md, {
      requiredSections: ['Introduction'],
      caseSensitive: true,
    });
    expect(result.valid).toBe(false);
  });

  it('validates minimum heading count', () => {
    const md = '# Only One\n\nSome text.\n';
    const result = validateMarkdownStructure(md, { minHeadings: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('1 headings');
  });

  it('validates max heading level', () => {
    const md = '# Title\n\n#### Too Deep\n';
    const result = validateMarkdownStructure(md, { maxHeadingLevel: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Too Deep');
  });

  it('validates heading hierarchy', () => {
    const md = '# Title\n\n### Skipped Level 2\n';
    const result = validateMarkdownStructure(md, { requireHierarchy: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('hierarchy violated');
  });

  it('allows going back to higher level without violation', () => {
    const md = '# Title\n\n## Section\n\n### Sub\n\n## Another Section\n';
    const result = validateMarkdownStructure(md, { requireHierarchy: true });
    expect(result.valid).toBe(true);
  });

  it('validates minimum code blocks', () => {
    const md = '# Guide\n\nNo code here.\n';
    const result = validateMarkdownStructure(md, { minCodeBlocks: 1 });
    expect(result.valid).toBe(false);
  });

  it('validates required code languages', () => {
    const md = '# Guide\n\n```python\nprint()\n```\n';
    const result = validateMarkdownStructure(md, {
      requiredCodeLanguages: ['python', 'bash'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('bash');
  });

  it('validates line count constraints', () => {
    const md = '# Short\n';
    const result = validateMarkdownStructure(md, { minLines: 10 });
    expect(result.valid).toBe(false);
  });

  it('passes complex valid document', () => {
    const md = [
      '# API Reference',
      '',
      '## Installation',
      '',
      '```bash',
      'npm install agent-eval',
      '```',
      '',
      '## Usage',
      '',
      '```typescript',
      "import { defineEval } from 'agent-eval';",
      '```',
      '',
      '## API',
      '',
      'Details here.',
      '',
    ].join('\n');

    const result = validateMarkdownStructure(md, {
      requiredSections: ['Installation', 'Usage', 'API'],
      minHeadings: 3,
      minCodeBlocks: 2,
      requireHierarchy: true,
    });
    expect(result.valid).toBe(true);
  });
});

// ─── Assertion: toMatchJsonSchema ────────────────────────────────────────────────

describe('toMatchJsonSchema assertion', () => {
  it('passes valid JSON matching schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['status', 'data'],
      properties: {
        status: { type: 'string', enum: ['ok', 'error'] },
        data: { type: 'array', items: { type: 'number' } },
      },
    };
    const assertion = toMatchJsonSchema(schema);
    const result = assertion.evaluate(JSON.stringify({ status: 'ok', data: [1, 2, 3] }));
    expect(result.status).toBe('pass');
  });

  it('fails on invalid JSON', () => {
    const assertion = toMatchJsonSchema({ type: 'object' });
    const result = assertion.evaluate('not json at all');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not valid JSON');
  });

  it('fails on schema mismatch', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const assertion = toMatchJsonSchema(schema);
    const result = assertion.evaluate(JSON.stringify({ age: 30 }));
    expect(result.status).toBe('fail');
    expect(result.message).toContain('name');
  });
});

// ─── Assertion: toBeValidJsonStrict ──────────────────────────────────────────────

describe('toBeValidJsonStrict assertion', () => {
  it('passes valid JSON', () => {
    const assertion = toBeValidJsonStrict();
    const result = assertion.evaluate('{"key": "value"}');
    expect(result.status).toBe('pass');
  });

  it('fails invalid JSON', () => {
    const assertion = toBeValidJsonStrict();
    const result = assertion.evaluate('{key: value}');
    expect(result.status).toBe('fail');
  });

  it('extracts JSON from code block when enabled', () => {
    const assertion = toBeValidJsonStrict({ allowWrappedInCodeBlock: true });
    const input = '```json\n{"key": "value"}\n```';
    const result = assertion.evaluate(input);
    expect(result.status).toBe('pass');
  });

  it('does not extract code block by default', () => {
    const assertion = toBeValidJsonStrict();
    const input = '```json\n{"key": "value"}\n```';
    const result = assertion.evaluate(input);
    expect(result.status).toBe('fail');
  });
});

// ─── Assertion: toHaveMarkdownStructure ──────────────────────────────────────────

describe('toHaveMarkdownStructure assertion', () => {
  it('passes valid markdown meeting requirements', () => {
    const assertion = toHaveMarkdownStructure({ requiredSections: ['Summary'], minHeadings: 1 });
    const result = assertion.evaluate('# Summary\n\nThis is the summary.\n');
    expect(result.status).toBe('pass');
  });

  it('fails when requirements not met', () => {
    const assertion = toHaveMarkdownStructure({ requiredSections: ['Summary', 'Details'] });
    const result = assertion.evaluate('# Summary\n\nContent\n');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Details');
  });
});

// ─── Assertion: toHaveSections ───────────────────────────────────────────────────

describe('toHaveSections assertion', () => {
  it('passes when all sections present', () => {
    const assertion = toHaveSections(['Overview', 'Installation', 'Usage']);
    const md = '# Overview\n\n## Installation\n\n## Usage\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('pass');
  });

  it('fails when sections missing', () => {
    const assertion = toHaveSections(['Overview', 'API']);
    const md = '# Overview\n\n## Examples\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('API');
  });

  it('is case-insensitive by default', () => {
    const assertion = toHaveSections(['overview']);
    const md = '# Overview\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('pass');
  });

  it('respects case-sensitive option', () => {
    const assertion = toHaveSections(['overview'], { caseSensitive: true });
    const md = '# Overview\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('fail');
  });
});

// ─── Assertion: toHaveCodeBlocks ─────────────────────────────────────────────────

describe('toHaveCodeBlocks assertion', () => {
  it('passes with enough code blocks', () => {
    const assertion = toHaveCodeBlocks({ min: 2 });
    const md = '```js\ncode1\n```\n\n```python\ncode2\n```\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('pass');
  });

  it('fails with too few code blocks', () => {
    const assertion = toHaveCodeBlocks({ min: 3 });
    const md = '```js\ncode\n```\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('fail');
  });

  it('validates required languages', () => {
    const assertion = toHaveCodeBlocks({ languages: ['typescript', 'bash'] });
    const md = '```typescript\ncode\n```\n\n```python\ncode\n```\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('bash');
  });

  it('validates max code blocks', () => {
    const assertion = toHaveCodeBlocks({ max: 1 });
    const md = '```js\ncode1\n```\n\n```js\ncode2\n```\n';
    const result = assertion.evaluate(md);
    expect(result.status).toBe('fail');
  });
});

// ─── Assertion: toBeFormat ────────────────────────────────────────────────────────

describe('toBeFormat assertion', () => {
  describe('json', () => {
    it('passes valid JSON', () => {
      const result = toBeFormat('json').evaluate('{"a":1}');
      expect(result.status).toBe('pass');
    });
    it('fails invalid JSON', () => {
      const result = toBeFormat('json').evaluate('not json');
      expect(result.status).toBe('fail');
    });
  });

  describe('markdown', () => {
    it('passes content with headings', () => {
      const result = toBeFormat('markdown').evaluate('# Hello\n\nWorld');
      expect(result.status).toBe('pass');
    });
    it('passes content with lists', () => {
      const result = toBeFormat('markdown').evaluate('- item 1\n- item 2');
      expect(result.status).toBe('pass');
    });
    it('fails plain text without structure', () => {
      const result = toBeFormat('markdown').evaluate('Just some plain text without any formatting.');
      expect(result.status).toBe('fail');
    });
  });

  describe('yaml', () => {
    it('passes YAML with key:value', () => {
      const result = toBeFormat('yaml').evaluate('name: test\nversion: 1.0\n');
      expect(result.status).toBe('pass');
    });
    it('passes YAML with front matter delimiter', () => {
      const result = toBeFormat('yaml').evaluate('---\ntitle: Doc\n---\n');
      expect(result.status).toBe('pass');
    });
    it('fails non-YAML', () => {
      const result = toBeFormat('yaml').evaluate('Just text here');
      expect(result.status).toBe('fail');
    });
  });

  describe('xml', () => {
    it('passes XML declaration', () => {
      const result = toBeFormat('xml').evaluate('<?xml version="1.0"?><root></root>');
      expect(result.status).toBe('pass');
    });
    it('passes bare root element', () => {
      const result = toBeFormat('xml').evaluate('<root>\n  <child/>\n</root>');
      expect(result.status).toBe('pass');
    });
    it('fails non-XML', () => {
      const result = toBeFormat('xml').evaluate('Not XML content');
      expect(result.status).toBe('fail');
    });
  });

  describe('csv', () => {
    it('passes valid CSV', () => {
      const result = toBeFormat('csv').evaluate('name,age,city\nAlice,30,NYC\nBob,25,LA');
      expect(result.status).toBe('pass');
    });
    it('fails single-line input', () => {
      const result = toBeFormat('csv').evaluate('just,a,header');
      expect(result.status).toBe('fail');
    });
    it('fails inconsistent columns', () => {
      const result = toBeFormat('csv').evaluate('a,b,c\n1,2\n3,4,5');
      expect(result.status).toBe('fail');
    });
    it('supports tab-delimited', () => {
      const result = toBeFormat('csv').evaluate('name\tage\nAlice\t30');
      expect(result.status).toBe('pass');
    });
  });
});
