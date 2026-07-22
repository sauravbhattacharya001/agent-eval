/**
 * Direct unit tests for the shared path-assertion scaffold
 * (`src/checks/paths-assertion-shell.ts`).
 *
 * The scaffold is exercised indirectly by every count-invalid factory in
 * paths.test.ts, but these tests pin its behaviour directly so the seam is
 * documented and a future refactor can't silently change the wording,
 * pass/fail arithmetic, or the empty-pass early-out.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRefAssertionResult,
  emptyPass,
} from '../src/checks/paths-assertion-shell.js';
import type { ReferenceVerifyResult } from '../src/checks/paths-types.js';

function ref(value: string, exists: boolean, error?: string): ReferenceVerifyResult {
  return {
    reference: { value, type: 'url', line: 1, raw: value },
    exists,
    error,
  } as ReferenceVerifyResult;
}

describe('buildRefAssertionResult', () => {
  it('passes when invalid count is within maxInvalid', () => {
    const r = buildRefAssertionResult({
      name: 'has valid URLs',
      start: performance.now(),
      results: [ref('https://a', true), ref('https://b', true)],
      maxInvalid: 0,
      noun: 'URLs',
      invalidNoun: 'URL(s)',
      countNoun: 'URLs',
      evidenceLine: x => `  ✗ ${x.reference.value}`,
    });
    expect(r.status).toBe('pass');
    expect(r.message).toBe('All 2 URLs verified');
    expect(r.evidence).toBeUndefined();
    expect(r.expected).toBe('≤0 invalid URLs');
    expect(r.actual).toBe('0 invalid of 2 total');
    expect(typeof r.durationMs).toBe('number');
  });

  it('fails and lists evidence when invalid exceeds maxInvalid', () => {
    const r = buildRefAssertionResult({
      name: 'has valid URLs',
      start: performance.now(),
      results: [ref('https://ok', true), ref('https://bad', false, 'boom')],
      maxInvalid: 0,
      noun: 'URLs',
      invalidNoun: 'URL(s)',
      countNoun: 'URLs',
      evidenceLine: x => `  ✗ ${x.reference.value} — ${x.error ?? 'unreachable'}`,
    });
    expect(r.status).toBe('fail');
    expect(r.message).toBe('1 invalid URL(s) found');
    expect(r.evidence).toBe('  ✗ https://bad — boom');
    expect(r.actual).toBe('1 invalid of 2 total');
  });

  it('honours a nonzero maxInvalid tolerance', () => {
    const r = buildRefAssertionResult({
      name: 'has valid references',
      start: performance.now(),
      results: [ref('a', false), ref('b', true)],
      maxInvalid: 1,
      noun: 'references',
      invalidNoun: 'reference(s)',
      countNoun: 'references',
      evidenceLine: x => `  ✗ ${x.reference.value}`,
    });
    expect(r.status).toBe('pass');
    expect(r.expected).toBe('≤1 invalid references');
  });

  it('appends the optional summary suffix to both pass and fail messages', () => {
    const start = performance.now();
    const pass = buildRefAssertionResult({
      name: 'has valid references',
      start,
      results: [ref('a', true)],
      maxInvalid: 0,
      noun: 'references',
      summary: 'URLs: 1, Paths: 0',
      invalidNoun: 'reference(s)',
      countNoun: 'references',
      evidenceLine: x => `  ✗ ${x.reference.value}`,
    });
    expect(pass.message).toBe('All 1 references verified (URLs: 1, Paths: 0)');

    const fail = buildRefAssertionResult({
      name: 'has valid references',
      start,
      results: [ref('a', false)],
      maxInvalid: 0,
      noun: 'references',
      summary: 'URLs: 1, Paths: 0',
      invalidNoun: 'reference(s)',
      countNoun: 'references',
      evidenceLine: x => `  ✗ ${x.reference.value}`,
    });
    expect(fail.message).toBe('1 invalid reference(s) found (URLs: 1, Paths: 0)');
  });
});

describe('emptyPass', () => {
  it('returns a pass with the "no references found" message', () => {
    const r = emptyPass('has valid URLs', 'URLs', performance.now());
    expect(r.status).toBe('pass');
    expect(r.name).toBe('has valid URLs');
    expect(r.message).toBe('No URLs found in output');
    expect(typeof r.durationMs).toBe('number');
  });
});
