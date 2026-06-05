/**
 * Built-in assertion library for agent-eval.
 *
 * Provides common assertions for evaluating agent outputs:
 * - String matching (contains, matches regex, equals)
 * - Length constraints
 * - JSON validity
 * - Negation wrappers
 */

import type { Assertion, AssertionResult, EvalContext } from './types.js';

/**
 * Assert output contains a substring.
 */
export function toContain(substring: string): Assertion {
  return {
    name: `contains "${substring}"`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output.includes(substring);
      return {
        status: pass ? 'pass' : 'fail',
        name: `contains "${substring}"`,
        message: pass ? undefined : `Output does not contain "${substring}"`,
        expected: substring,
        actual: pass ? undefined : output.slice(0, 200),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output matches a regex pattern.
 */
export function toMatch(pattern: RegExp): Assertion {
  return {
    name: `matches ${pattern}`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = pattern.test(output);
      return {
        status: pass ? 'pass' : 'fail',
        name: `matches ${pattern}`,
        message: pass ? undefined : `Output does not match pattern ${pattern}`,
        expected: pattern.toString(),
        actual: pass ? undefined : output.slice(0, 200),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output does NOT contain a substring.
 */
export function notToContain(substring: string): Assertion {
  return {
    name: `does not contain "${substring}"`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = !output.includes(substring);
      return {
        status: pass ? 'pass' : 'fail',
        name: `does not contain "${substring}"`,
        message: pass ? undefined : `Output unexpectedly contains "${substring}"`,
        expected: `not "${substring}"`,
        actual: pass ? undefined : substring,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output does NOT match a regex.
 */
export function notToMatch(pattern: RegExp): Assertion {
  return {
    name: `does not match ${pattern}`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = !pattern.test(output);
      return {
        status: pass ? 'pass' : 'fail',
        name: `does not match ${pattern}`,
        message: pass ? undefined : `Output unexpectedly matches pattern ${pattern}`,
        expected: `not ${pattern}`,
        actual: pass ? undefined : output.slice(0, 200),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output equals an exact string.
 */
export function toEqual(expected: string): Assertion {
  return {
    name: `equals expected`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output === expected;
      return {
        status: pass ? 'pass' : 'fail',
        name: `equals expected`,
        message: pass ? undefined : `Output does not equal expected value`,
        expected: expected.slice(0, 200),
        actual: pass ? undefined : output.slice(0, 200),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output has a minimum length.
 */
export function toHaveMinLength(minLength: number): Assertion {
  return {
    name: `min length ${minLength}`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output.length >= minLength;
      return {
        status: pass ? 'pass' : 'fail',
        name: `min length ${minLength}`,
        message: pass ? undefined : `Output length ${output.length} is below minimum ${minLength}`,
        expected: `>= ${minLength} chars`,
        actual: `${output.length} chars`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output has a maximum length.
 */
export function toHaveMaxLength(maxLength: number): Assertion {
  return {
    name: `max length ${maxLength}`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output.length <= maxLength;
      return {
        status: pass ? 'pass' : 'fail',
        name: `max length ${maxLength}`,
        message: pass ? undefined : `Output length ${output.length} exceeds maximum ${maxLength}`,
        expected: `<= ${maxLength} chars`,
        actual: `${output.length} chars`,
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output is valid JSON.
 */
export function toBeValidJson(): Assertion {
  return {
    name: 'valid JSON',
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      try {
        JSON.parse(output);
        return {
          status: 'pass',
          name: 'valid JSON',
          durationMs: performance.now() - start,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'fail',
          name: 'valid JSON',
          message: `Output is not valid JSON: ${message}`,
          actual: output.slice(0, 200),
          durationMs: performance.now() - start,
        };
      }
    },
  };
}

/**
 * Assert output starts with a prefix.
 */
export function toStartWith(prefix: string): Assertion {
  return {
    name: `starts with "${prefix}"`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output.startsWith(prefix);
      return {
        status: pass ? 'pass' : 'fail',
        name: `starts with "${prefix}"`,
        message: pass ? undefined : `Output does not start with "${prefix}"`,
        expected: prefix,
        actual: pass ? undefined : output.slice(0, prefix.length + 20),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Assert output ends with a suffix.
 */
export function toEndWith(suffix: string): Assertion {
  return {
    name: `ends with "${suffix}"`,
    evaluate(output: string): AssertionResult {
      const start = performance.now();
      const pass = output.endsWith(suffix);
      return {
        status: pass ? 'pass' : 'fail',
        name: `ends with "${suffix}"`,
        message: pass ? undefined : `Output does not end with "${suffix}"`,
        expected: suffix,
        actual: pass ? undefined : output.slice(-suffix.length - 20),
        durationMs: performance.now() - start,
      };
    },
  };
}

/**
 * Custom assertion from a function.
 */
export function custom(
  name: string,
  fn: (output: string, context?: EvalContext) => boolean | { pass: boolean; message?: string },
): Assertion {
  return {
    name,
    evaluate(output: string, context?: EvalContext): AssertionResult {
      const start = performance.now();
      const result = fn(output, context);
      if (typeof result === 'boolean') {
        return {
          status: result ? 'pass' : 'fail',
          name,
          message: result ? undefined : `Custom assertion "${name}" failed`,
          durationMs: performance.now() - start,
        };
      }
      return {
        status: result.pass ? 'pass' : 'fail',
        name,
        message: result.pass ? undefined : result.message ?? `Custom assertion "${name}" failed`,
        durationMs: performance.now() - start,
      };
    },
  };
}
