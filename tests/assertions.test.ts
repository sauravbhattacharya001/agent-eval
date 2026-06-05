import { describe, it, expect } from 'vitest';
import {
  toContain,
  toMatch,
  toEqual,
  notToContain,
  notToMatch,
  toHaveMinLength,
  toHaveMaxLength,
  toBeValidJson,
  toStartWith,
  toEndWith,
  custom,
} from '../src/core/assertions.js';

describe('assertions', () => {
  describe('toContain', () => {
    it('passes when output contains substring', () => {
      const assertion = toContain('hello');
      const result = assertion.evaluate('hello world');
      expect(result.status).toBe('pass');
    });

    it('fails when output does not contain substring', () => {
      const assertion = toContain('goodbye');
      const result = assertion.evaluate('hello world');
      expect(result.status).toBe('fail');
      expect(result.message).toContain('goodbye');
    });
  });

  describe('toMatch', () => {
    it('passes when output matches regex', () => {
      const assertion = toMatch(/\d{3}-\d{4}/);
      const result = assertion.evaluate('Call 555-1234');
      expect(result.status).toBe('pass');
    });

    it('fails when output does not match regex', () => {
      const assertion = toMatch(/\d{3}-\d{4}/);
      const result = assertion.evaluate('No phone here');
      expect(result.status).toBe('fail');
    });
  });

  describe('toEqual', () => {
    it('passes on exact match', () => {
      const assertion = toEqual('exact');
      const result = assertion.evaluate('exact');
      expect(result.status).toBe('pass');
    });

    it('fails on mismatch', () => {
      const assertion = toEqual('exact');
      const result = assertion.evaluate('not exact');
      expect(result.status).toBe('fail');
    });
  });

  describe('notToContain', () => {
    it('passes when substring is absent', () => {
      const assertion = notToContain('error');
      const result = assertion.evaluate('all good');
      expect(result.status).toBe('pass');
    });

    it('fails when substring is present', () => {
      const assertion = notToContain('error');
      const result = assertion.evaluate('an error occurred');
      expect(result.status).toBe('fail');
    });
  });

  describe('notToMatch', () => {
    it('passes when pattern does not match', () => {
      const assertion = notToMatch(/ERROR/i);
      const result = assertion.evaluate('all good');
      expect(result.status).toBe('pass');
    });

    it('fails when pattern matches', () => {
      const assertion = notToMatch(/ERROR/i);
      const result = assertion.evaluate('Error found');
      expect(result.status).toBe('fail');
    });
  });

  describe('toHaveMinLength', () => {
    it('passes when output meets minimum', () => {
      const assertion = toHaveMinLength(5);
      const result = assertion.evaluate('hello world');
      expect(result.status).toBe('pass');
    });

    it('fails when output is too short', () => {
      const assertion = toHaveMinLength(100);
      const result = assertion.evaluate('short');
      expect(result.status).toBe('fail');
      expect(result.message).toContain('5');
      expect(result.message).toContain('100');
    });
  });

  describe('toHaveMaxLength', () => {
    it('passes when output is within limit', () => {
      const assertion = toHaveMaxLength(100);
      const result = assertion.evaluate('short');
      expect(result.status).toBe('pass');
    });

    it('fails when output exceeds limit', () => {
      const assertion = toHaveMaxLength(3);
      const result = assertion.evaluate('too long');
      expect(result.status).toBe('fail');
    });
  });

  describe('toBeValidJson', () => {
    it('passes for valid JSON', () => {
      const assertion = toBeValidJson();
      const result = assertion.evaluate('{"key": "value", "num": 42}');
      expect(result.status).toBe('pass');
    });

    it('fails for invalid JSON', () => {
      const assertion = toBeValidJson();
      const result = assertion.evaluate('not json at all');
      expect(result.status).toBe('fail');
      expect(result.message).toContain('not valid JSON');
    });
  });

  describe('toStartWith', () => {
    it('passes when output starts with prefix', () => {
      const assertion = toStartWith('Hello');
      const result = assertion.evaluate('Hello, world!');
      expect(result.status).toBe('pass');
    });

    it('fails when output does not start with prefix', () => {
      const assertion = toStartWith('Bye');
      const result = assertion.evaluate('Hello, world!');
      expect(result.status).toBe('fail');
    });
  });

  describe('toEndWith', () => {
    it('passes when output ends with suffix', () => {
      const assertion = toEndWith('world!');
      const result = assertion.evaluate('Hello, world!');
      expect(result.status).toBe('pass');
    });

    it('fails when output does not end with suffix', () => {
      const assertion = toEndWith('goodbye');
      const result = assertion.evaluate('Hello, world!');
      expect(result.status).toBe('fail');
    });
  });

  describe('custom', () => {
    it('passes when function returns true', () => {
      const assertion = custom('is uppercase', (output) => output === output.toUpperCase());
      const result = assertion.evaluate('HELLO');
      expect(result.status).toBe('pass');
    });

    it('fails when function returns false', () => {
      const assertion = custom('is uppercase', (output) => output === output.toUpperCase());
      const result = assertion.evaluate('hello');
      expect(result.status).toBe('fail');
    });

    it('supports object return with custom message', () => {
      const assertion = custom('word count', (output) => {
        const count = output.split(/\s+/).length;
        return { pass: count >= 5, message: `Expected >= 5 words, got ${count}` };
      });
      const result = assertion.evaluate('two words');
      expect(result.status).toBe('fail');
      expect(result.message).toContain('got 2');
    });
  });
});
