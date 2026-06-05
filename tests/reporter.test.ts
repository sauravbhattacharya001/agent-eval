import { describe, it, expect } from 'vitest';
import { TerminalReporter, JsonReporter } from '../src/core/reporter.js';
import type { SuiteResult } from '../src/core/types.js';

const mockResults: SuiteResult[] = [
  {
    name: 'Test Suite',
    durationMs: 150,
    passed: 2,
    failed: 1,
    skipped: 0,
    errors: 0,
    specs: [
      {
        name: 'passing spec',
        status: 'pass',
        durationMs: 5,
        assertions: [{ status: 'pass', name: 'contains "hello"', durationMs: 1 }],
      },
      {
        name: 'another pass',
        status: 'pass',
        durationMs: 3,
        assertions: [{ status: 'pass', name: 'matches /\\d+/', durationMs: 1 }],
      },
      {
        name: 'failing spec',
        status: 'fail',
        durationMs: 10,
        assertions: [
          {
            status: 'fail',
            name: 'contains "expected"',
            message: 'Output does not contain "expected"',
            expected: 'expected',
            actual: 'actual output here',
            durationMs: 2,
          },
        ],
      },
    ],
  },
];

describe('TerminalReporter', () => {
  it('formats results with pass/fail counts', () => {
    const reporter = new TerminalReporter();
    const output = reporter.format(mockResults);
    expect(output).toContain('Test Suite');
    expect(output).toContain('✓ passing spec');
    expect(output).toContain('✗ failing spec');
    expect(output).toContain('2 passed');
    expect(output).toContain('1 failed');
  });

  it('includes failure evidence in output', () => {
    const reporter = new TerminalReporter();
    const output = reporter.format(mockResults);
    expect(output).toContain('Output does not contain "expected"');
    expect(output).toContain('expected: expected');
    expect(output).toContain('actual output here');
  });
});

describe('JsonReporter', () => {
  it('formats results as valid JSON', () => {
    const reporter = new JsonReporter();
    const output = reporter.format(mockResults);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Test Suite');
    expect(parsed[0].passed).toBe(2);
    expect(parsed[0].failed).toBe(1);
  });
});
