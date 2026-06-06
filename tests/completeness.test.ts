/**
 * Tests for the Completeness Checker — Tier 1 Deterministic Check
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeContent,
  checkCompleteness,
  toBeNonEmpty,
  toMeetLengthRange,
  toBeSubstantive,
  toBeComplete,
  toPassCompletenessCheck,
} from '../src/checks/completeness.js';

// ─── analyzeContent ─────────────────────────────────────────────────────────────

describe('analyzeContent', () => {
  it('returns zero metrics for empty string', () => {
    const m = analyzeContent('');
    expect(m.charCount).toBe(0);
    expect(m.wordCount).toBe(0);
    expect(m.lineCount).toBe(1); // empty string split produces ['']
    expect(m.sentenceCount).toBe(0);
    expect(m.paragraphCount).toBe(0);
    expect(m.uniqueWordRatio).toBe(0);
    expect(m.isStub).toBe(true);
  });

  it('counts words correctly', () => {
    const m = analyzeContent('hello world foo bar baz');
    expect(m.wordCount).toBe(5);
  });

  it('counts lines correctly', () => {
    const m = analyzeContent('line1\nline2\nline3\n\nline5');
    expect(m.lineCount).toBe(5);
    expect(m.nonEmptyLineCount).toBe(4);
  });

  it('counts sentences heuristically', () => {
    const m = analyzeContent('This is a sentence. Here is another! And a question?');
    expect(m.sentenceCount).toBe(3);
  });

  it('handles abbreviations in sentence counting', () => {
    const m = analyzeContent('Dr. Smith went to Washington D.C. and met Mr. Jones.');
    // Abbreviation handling reduces false splits; exact count depends on heuristic
    // D.C. may still split, so accept 1 or 2
    expect(m.sentenceCount).toBeGreaterThanOrEqual(1);
    expect(m.sentenceCount).toBeLessThanOrEqual(2);
  });

  it('counts paragraphs', () => {
    const m = analyzeContent('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    expect(m.paragraphCount).toBe(3);
  });

  it('calculates unique word ratio', () => {
    // All unique
    const m1 = analyzeContent('one two three four five');
    expect(m1.uniqueWordRatio).toBe(1.0);

    // Half repeated
    const m2 = analyzeContent('hello hello world world');
    expect(m2.uniqueWordRatio).toBe(0.5);
  });

  it('detects truncation markers', () => {
    expect(analyzeContent('Some text [truncated]').isTruncated).toBe(true);
    expect(analyzeContent('Some text...').isTruncated).toBe(true);
    expect(analyzeContent('Some text [...]').isTruncated).toBe(true);
    expect(analyzeContent('This is a complete sentence.').isTruncated).toBe(false);
  });

  it('detects stub responses', () => {
    expect(analyzeContent('TODO').isStub).toBe(true);
    expect(analyzeContent('[placeholder]').isStub).toBe(true);
    expect(analyzeContent('Lorem ipsum dolor sit amet').isStub).toBe(true);
    expect(analyzeContent("I cannot help with that request").isStub).toBe(true);
    expect(analyzeContent("I'm sorry, I'm unable to assist").isStub).toBe(true);
    expect(analyzeContent('This is a detailed and helpful response about the topic.').isStub).toBe(false);
  });

  it('does not flag short valid answers as stubs', () => {
    expect(analyzeContent('yes').isStub).toBe(false);
    expect(analyzeContent('no').isStub).toBe(false);
    expect(analyzeContent('42').isStub).toBe(false);
    expect(analyzeContent('true').isStub).toBe(false);
  });

  it('calculates average words per sentence', () => {
    const m = analyzeContent('Short. Also short. Very short too.');
    expect(m.avgWordsPerSentence).toBeCloseTo(2, 0);
  });
});

// ─── checkCompleteness ──────────────────────────────────────────────────────────

describe('checkCompleteness', () => {
  it('reports empty output as incomplete', () => {
    const result = checkCompleteness('');
    expect(result.complete).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.category).toBe('empty');
  });

  it('reports whitespace-only as incomplete', () => {
    const result = checkCompleteness('   \n  \n   ');
    expect(result.complete).toBe(false);
  });

  it('passes for normal substantive output', () => {
    const result = checkCompleteness(
      'This is a well-written response that addresses the question thoroughly. ' +
      'It provides specific examples and clear explanations. ' +
      'The answer covers multiple aspects of the topic.'
    );
    expect(result.complete).toBe(true);
    expect(result.violations.filter(v => v.severity === 'error')).toHaveLength(0);
  });

  describe('length range checks', () => {
    it('fails when below minWords', () => {
      const result = checkCompleteness('short text', { length: { minWords: 50 } });
      expect(result.complete).toBe(false);
      expect(result.violations.some(v => v.message.includes('Word count'))).toBe(true);
    });

    it('fails when above maxWords', () => {
      const text = Array(200).fill('word').join(' ');
      const result = checkCompleteness(text, { length: { maxWords: 100 } });
      expect(result.complete).toBe(false);
      expect(result.violations.some(v => v.message.includes('exceeds maximum'))).toBe(true);
    });

    it('fails when below minChars', () => {
      const result = checkCompleteness('hi', { length: { minChars: 100 } });
      expect(result.complete).toBe(false);
    });

    it('passes when within range', () => {
      const text = 'This is a response with exactly the right number of words and characters for the specified range.';
      const result = checkCompleteness(text, { length: { minWords: 5, maxWords: 100, minChars: 10, maxChars: 500 } });
      expect(result.violations.filter(v => v.category === 'length')).toHaveLength(0);
    });

    it('checks minLines and maxLines', () => {
      const text = 'Line 1\nLine 2\nLine 3';
      expect(checkCompleteness(text, { length: { minLines: 5 } }).violations.some(v => v.message.includes('Line count'))).toBe(true);
      expect(checkCompleteness(text, { length: { maxLines: 2 } }).violations.some(v => v.message.includes('Line count'))).toBe(true);
      expect(checkCompleteness(text, { length: { minLines: 2, maxLines: 5 } }).violations.filter(v => v.category === 'length')).toHaveLength(0);
    });

    it('checks minSentences and maxSentences', () => {
      const text = 'One sentence. Two sentences. Three sentences.';
      expect(checkCompleteness(text, { length: { minSentences: 5 } }).violations.some(v => v.message.includes('Sentence count'))).toBe(true);
      expect(checkCompleteness(text, { length: { maxSentences: 2 } }).violations.some(v => v.message.includes('Sentence count'))).toBe(true);
    });

    it('checks minParagraphs and maxParagraphs', () => {
      const text = 'Para one.\n\nPara two.\n\nPara three.';
      expect(checkCompleteness(text, { length: { minParagraphs: 5 } }).violations.some(v => v.message.includes('Paragraph count'))).toBe(true);
      expect(checkCompleteness(text, { length: { maxParagraphs: 2 } }).violations.some(v => v.message.includes('Paragraph count'))).toBe(true);
    });
  });

  describe('substance checks', () => {
    it('flags low unique word ratio', () => {
      const repetitive = Array(50).fill('same word repeated').join(' ');
      const result = checkCompleteness(repetitive, { substance: { minUniqueWordRatio: 0.3 } });
      expect(result.violations.some(v => v.message.includes('Unique word ratio'))).toBe(true);
    });

    it('flags consecutive duplicate lines', () => {
      const looping = 'Normal text\n' + 'Repeated line\n'.repeat(5) + 'End text';
      const result = checkCompleteness(looping, { substance: { maxConsecutiveDuplicateLines: 3 } });
      expect(result.violations.some(v => v.message.includes('consecutive duplicate'))).toBe(true);
    });

    it('flags high filler phrase density', () => {
      const fillery = 'As an AI, I hope this helps you. Feel free to ask if you need more. Let me know if you need anything else. Is there anything else I can help with?';
      const result = checkCompleteness(fillery);
      expect(result.violations.some(v => v.message.includes('filler phrase'))).toBe(true);
    });

    it('passes for diverse, substantive content', () => {
      const good = 'The TypeScript compiler performs structural type checking by comparing the shapes of objects. When you define an interface, the compiler ensures that any object assigned to a variable of that type contains all required properties with the correct types. This enables powerful patterns like duck typing while maintaining type safety.';
      const result = checkCompleteness(good);
      expect(result.violations.filter(v => v.category === 'substance')).toHaveLength(0);
    });

    it('respects custom filler phrases', () => {
      const text = 'This is the way. This is the way. Everything happens for a reason.';
      const result = checkCompleteness(text, {
        substance: { fillerPhrases: ['this is the way', 'everything happens', 'just saying'] },
      });
      // Only 2 filler phrases found, threshold is 3
      expect(result.violations.filter(v => v.message.includes('filler phrase'))).toHaveLength(0);
    });
  });

  describe('structural completeness', () => {
    it('detects unbalanced brackets', () => {
      const text = 'function foo() { return bar(; }';
      const result = checkCompleteness(text, { structure: { checkBalancedBrackets: true } });
      expect(result.violations.some(v => v.message.includes('Unbalanced brackets'))).toBe(true);
    });

    it('passes for balanced brackets', () => {
      const text = 'function foo() { return bar(); }';
      const result = checkCompleteness(text, { structure: { checkBalancedBrackets: true } });
      expect(result.violations.filter(v => v.message.includes('Unbalanced'))).toHaveLength(0);
    });

    it('ignores brackets inside string literals', () => {
      const text = 'const msg = "Hello {world}"; console.log(msg);';
      const result = checkCompleteness(text, { structure: { checkBalancedBrackets: true } });
      expect(result.violations.filter(v => v.message.includes('Unbalanced'))).toHaveLength(0);
    });

    it('detects truncation', () => {
      const text = 'This response was going to explain more but [truncated]';
      const result = checkCompleteness(text, { structure: { checkTruncation: true } });
      expect(result.violations.some(v => v.category === 'truncation')).toBe(true);
    });

    it('validates required patterns', () => {
      const text = 'This response talks about TypeScript but not testing.';
      const result = checkCompleteness(text, {
        structure: { requiredPatterns: [/TypeScript/i, /testing/i, /deployment/i] },
      });
      expect(result.violations.some(v => v.message.includes('required content pattern'))).toBe(true);
    });

    it('validates forbidden patterns', () => {
      const text = 'INTERNAL: This contains sensitive data that should not be exposed.';
      const result = checkCompleteness(text, {
        structure: { forbiddenPatterns: [/INTERNAL:/] },
      });
      expect(result.violations.some(v => v.message.includes('forbidden content pattern'))).toBe(true);
    });
  });
});

// ─── Assertion: toBeNonEmpty ────────────────────────────────────────────────────

describe('toBeNonEmpty', () => {
  const assertion = toBeNonEmpty();

  it('passes for substantive output', () => {
    const result = assertion.evaluate('This is a detailed response about the topic at hand.');
    expect(result.status).toBe('pass');
  });

  it('fails for empty output', () => {
    const result = assertion.evaluate('');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('empty');
  });

  it('fails for whitespace-only output', () => {
    const result = assertion.evaluate('   \n  \t  \n  ');
    expect(result.status).toBe('fail');
  });

  it('fails for TODO stub', () => {
    const result = assertion.evaluate('TODO');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('stub');
  });

  it('fails for placeholder text', () => {
    const result = assertion.evaluate('[placeholder]');
    expect(result.status).toBe('fail');
  });

  it('fails for lorem ipsum', () => {
    const result = assertion.evaluate('Lorem ipsum dolor sit amet');
    expect(result.status).toBe('fail');
  });

  it('fails for AI refusal stubs', () => {
    const result = assertion.evaluate("I cannot assist with that request.");
    expect(result.status).toBe('fail');
  });

  it('passes for short valid answers', () => {
    expect(toBeNonEmpty().evaluate('yes').status).toBe('pass');
    expect(toBeNonEmpty().evaluate('42').status).toBe('pass');
  });

  it('detects custom stub patterns', () => {
    const custom = toBeNonEmpty({ stubPatterns: [/^DRAFT:/] });
    expect(custom.evaluate('DRAFT: not ready yet').status).toBe('fail');
    expect(custom.evaluate('Final: ready for review').status).toBe('pass');
  });
});

// ─── Assertion: toMeetLengthRange ───────────────────────────────────────────────

describe('toMeetLengthRange', () => {
  it('passes when all constraints met', () => {
    const text = 'This is a response with enough words. It has multiple sentences. The content is adequate for the specified range requirements.';
    const assertion = toMeetLengthRange({ minWords: 10, maxWords: 50, minSentences: 2 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
  });

  it('fails when below minWords', () => {
    const assertion = toMeetLengthRange({ minWords: 100 });
    const result = assertion.evaluate('Too short.');
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Word count');
  });

  it('fails when above maxWords', () => {
    const text = Array(200).fill('word').join(' ') + '.';
    const assertion = toMeetLengthRange({ maxWords: 50 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('exceeds maximum');
  });

  it('reports actual metrics in pass message', () => {
    const text = 'Hello world. Nice day.';
    const assertion = toMeetLengthRange({ minWords: 2, maxWords: 10 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('w');
  });

  it('includes assertion name with constraint summary', () => {
    const assertion = toMeetLengthRange({ minWords: 10, maxWords: 500 });
    expect(assertion.name).toContain('≥10w');
    expect(assertion.name).toContain('≤500w');
  });
});

// ─── Assertion: toBeSubstantive ─────────────────────────────────────────────────

describe('toBeSubstantive', () => {
  it('passes for diverse content', () => {
    const text = 'The framework provides multiple assertion types including string matching, JSON validation, format checking, and structural completeness verification. Each assertion returns detailed evidence when a check fails.';
    const assertion = toBeSubstantive();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
  });

  it('fails for highly repetitive content', () => {
    const text = Array(30).fill('word word word word').join(' ');
    const assertion = toBeSubstantive({ minUniqueWordRatio: 0.3 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Unique word ratio');
  });

  it('fails for looping output (consecutive duplicates)', () => {
    const text = 'Start\n' + 'Repeated line goes here\n'.repeat(6) + 'End of output.';
    const assertion = toBeSubstantive({ maxConsecutiveDuplicateLines: 3 });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('consecutive duplicate');
  });

  it('reports metrics in pass message', () => {
    const text = 'Diverse vocabulary demonstrates good content quality in this evaluation framework. Testing various word patterns ensures proper detection.';
    const assertion = toBeSubstantive();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Unique ratio');
  });
});

// ─── Assertion: toBeComplete ────────────────────────────────────────────────────

describe('toBeComplete', () => {
  it('passes for well-formed output', () => {
    const text = 'This is a complete response that ends properly.';
    const assertion = toBeComplete();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
  });

  it('fails when truncation markers are present', () => {
    const text = 'The response was explaining something important but [truncated]';
    const assertion = toBeComplete();
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('truncat');
  });

  it('fails when required patterns are missing', () => {
    const text = 'A response about general programming.';
    const assertion = toBeComplete({ requiredPatterns: [/conclusion/i, /summary/i] });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('required content pattern');
  });

  it('fails when forbidden patterns are found', () => {
    const text = 'DEBUG: internal state dump follows. The actual response is here.';
    const assertion = toBeComplete({ forbiddenPatterns: [/DEBUG:/] });
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
  });

  it('reports unbalanced brackets as warning', () => {
    const text = 'The code { return value; without closing brace because reasons are complex enough for fifty words needed here to trigger the incomplete ending check but we just test brackets.';
    const assertion = toBeComplete({ checkBalancedBrackets: true, checkIncompleteEnding: false });
    const result = assertion.evaluate(text);
    expect(result.message).toContain('Unbalanced brackets');
  });

  it('can disable specific checks', () => {
    const text = 'Truncated output that ends with [...]';
    const assertion = toBeComplete({ checkTruncation: false });
    const result = assertion.evaluate(text);
    // Should not fail for truncation when disabled
    expect(result.status).toBe('pass');
  });
});

// ─── Assertion: toPassCompletenessCheck ─────────────────────────────────────────

describe('toPassCompletenessCheck', () => {
  it('passes for well-formed, substantive output within range', () => {
    const text = [
      'The TypeScript compiler performs structural type checking by comparing the shapes of objects.',
      'When you define an interface, the compiler ensures that any object assigned to a variable of that type contains all required properties with the correct types.',
      'This enables powerful patterns like duck typing while maintaining type safety.',
      '',
      'Key features include:',
      '- Structural compatibility checking',
      '- Generic type inference',
      '- Conditional types for advanced patterns',
      '- Template literal types for string manipulation.',
    ].join('\n');

    const assertion = toPassCompletenessCheck({
      length: { minWords: 20, maxWords: 200 },
      substance: { minUniqueWordRatio: 0.3 },
    });

    const result = assertion.evaluate(text);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('Complete');
  });

  it('fails for empty output', () => {
    const assertion = toPassCompletenessCheck();
    const result = assertion.evaluate('');
    expect(result.status).toBe('fail');
  });

  it('fails for stub output', () => {
    const assertion = toPassCompletenessCheck();
    const result = assertion.evaluate('TODO: implement this');
    expect(result.status).toBe('fail');
  });

  it('provides detailed evidence on failure', () => {
    const assertion = toPassCompletenessCheck({ length: { minWords: 100 } });
    const result = assertion.evaluate('Too short.');
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('Metrics');
    expect(result.evidence).toContain('w,');
  });

  it('combines multiple check categories', () => {
    const assertion = toPassCompletenessCheck({
      length: { minWords: 5, maxWords: 1000 },
      substance: { minUniqueWordRatio: 0.9 },
      structure: { checkTruncation: true },
    });

    // Repetitive + truncated
    const text = Array(20).fill('repeated word').join(' ') + '...';
    const result = assertion.evaluate(text);
    expect(result.status).toBe('fail');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles single-character output', () => {
    const m = analyzeContent('x');
    expect(m.charCount).toBe(1);
    expect(m.wordCount).toBe(1);
    expect(m.isStub).toBe(true); // too short
  });

  it('handles output with only code', () => {
    const code = 'function add(a: number, b: number): number {\n  return a + b;\n}';
    const m = analyzeContent(code);
    expect(m.wordCount).toBeGreaterThan(0);
    expect(m.isStub).toBe(false);
  });

  it('handles output with unicode', () => {
    const text = 'La réponse est très détaillée et couvre tous les aspects importants du sujet.';
    const m = analyzeContent(text);
    expect(m.wordCount).toBeGreaterThan(5);
    expect(m.isStub).toBe(false);
  });

  it('handles output with only numbers', () => {
    const text = '42\n3.14\n2.718\n1.618';
    const m = analyzeContent(text);
    expect(m.lineCount).toBe(4);
  });

  it('handles very long single line', () => {
    const text = 'word '.repeat(1000).trim();
    const m = analyzeContent(text);
    expect(m.wordCount).toBe(1000);
    expect(m.lineCount).toBe(1);
  });

  it('bracket check handles nested structures', () => {
    const text = '{ "data": [{ "nested": { "deep": [1, 2, 3] } }] }';
    const result = checkCompleteness(text, { structure: { checkBalancedBrackets: true } });
    expect(result.violations.filter(v => v.message.includes('Unbalanced'))).toHaveLength(0);
  });

  it('bracket check handles code with mixed bracket types', () => {
    const text = 'arr.map((x) => ({ value: x, items: [1, 2] }));';
    const result = checkCompleteness(text, { structure: { checkBalancedBrackets: true } });
    expect(result.violations.filter(v => v.message.includes('Unbalanced'))).toHaveLength(0);
  });
});
