import { describe, it, expect } from 'vitest';
import { runSuite, runSuites } from '../src/core/runner.js';
import { toContain, toMatch, notToContain } from '../src/core/assertions.js';
import { LocalProvider } from '../src/providers/local.js';
import type { EvalSuiteDefinition } from '../src/core/types.js';

const provider = new LocalProvider({
  outputs: {
    'Write a function that reverses a string': `function reverseString(input: string): string {
  return input.split('').reverse().join('');
}`,
    'What is 2+2?': 'The answer is 4.',
    'Tell me about cats': 'Cats are wonderful pets that have been domesticated for thousands of years.',
  },
  defaultOutput: 'I am a helpful assistant.',
});

describe('runner', () => {
  it('runs a suite with passing specs', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'Basic Test',
      provider,
      specs: [
        {
          name: 'contains function keyword',
          prompt: 'Write a function that reverses a string',
          assertions: [toContain('function'), toContain('reverse')],
        },
        {
          name: 'answers correctly',
          prompt: 'What is 2+2?',
          assertions: [toContain('4')],
        },
      ],
    };

    const result = await runSuite(suite);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.name).toBe('Basic Test');
  });

  it('reports failures with evidence', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'Failing Test',
      provider,
      specs: [
        {
          name: 'expects wrong content',
          prompt: 'What is 2+2?',
          assertions: [toContain('5'), notToContain('4')],
        },
      ],
    };

    const result = await runSuite(suite);
    expect(result.failed).toBe(1);
    expect(result.specs[0]!.status).toBe('fail');
    expect(result.specs[0]!.assertions[0]!.status).toBe('fail');
    expect(result.specs[0]!.assertions[1]!.status).toBe('fail');
  });

  it('skips specs marked as skip', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'Skip Test',
      provider,
      specs: [
        {
          name: 'this is skipped',
          prompt: 'anything',
          assertions: [toContain('test')],
          skip: true,
        },
        {
          name: 'this runs',
          prompt: 'What is 2+2?',
          assertions: [toContain('4')],
        },
      ],
    };

    const result = await runSuite(suite);
    expect(result.skipped).toBe(1);
    expect(result.passed).toBe(1);
  });

  it('respects filter option', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'Filter Test',
      provider,
      specs: [
        {
          name: 'math test',
          prompt: 'What is 2+2?',
          assertions: [toContain('4')],
        },
        {
          name: 'string test',
          prompt: 'Write a function that reverses a string',
          assertions: [toContain('function')],
        },
      ],
    };

    const result = await runSuite(suite, { filter: /math/ });
    expect(result.passed).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('bails on first failure when bail=true', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'Bail Test',
      provider,
      specs: [
        {
          name: 'failing spec',
          prompt: 'What is 2+2?',
          assertions: [toContain('wrong')],
        },
        {
          name: 'would pass',
          prompt: 'What is 2+2?',
          assertions: [toContain('4')],
        },
      ],
    };

    const result = await runSuite(suite, { bail: true });
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.passed).toBe(0);
  });

  it('handles missing provider with clear error', async () => {
    const suite: EvalSuiteDefinition = {
      name: 'No Provider',
      specs: [
        {
          name: 'will error',
          prompt: 'test',
          assertions: [toContain('test')],
        },
      ],
    };

    const result = await runSuite(suite);
    expect(result.errors).toBe(1);
    expect(result.specs[0]!.error).toContain('No provider configured');
  });

  it('calls setup and teardown', async () => {
    let setupCalled = false;
    let teardownCalled = false;

    const suite: EvalSuiteDefinition = {
      name: 'Lifecycle Test',
      provider,
      specs: [
        {
          name: 'basic',
          prompt: 'What is 2+2?',
          assertions: [toContain('4')],
        },
      ],
      setup: () => {
        setupCalled = true;
      },
      teardown: () => {
        teardownCalled = true;
      },
    };

    await runSuite(suite);
    expect(setupCalled).toBe(true);
    expect(teardownCalled).toBe(true);
  });

  it('runs multiple suites with runSuites', async () => {
    const suites: EvalSuiteDefinition[] = [
      {
        name: 'Suite A',
        provider,
        specs: [
          {
            name: 'test a',
            prompt: 'What is 2+2?',
            assertions: [toContain('4')],
          },
        ],
      },
      {
        name: 'Suite B',
        provider,
        specs: [
          {
            name: 'test b',
            prompt: 'Tell me about cats',
            assertions: [toContain('Cats'), toMatch(/domesticated/)],
          },
        ],
      },
    ];

    const results = await runSuites(suites);
    expect(results).toHaveLength(2);
    expect(results[0]!.passed).toBe(1);
    expect(results[1]!.passed).toBe(1);
  });
});
