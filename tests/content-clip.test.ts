/**
 * Tests for the shared content-truncation helpers — the `clip` function and the
 * two truncation limits that every trace-export adapter (OpenClaw, OTLP,
 * LangSmith, AgentLens) uses to bound event `content` and derived session labels.
 *
 * This logic previously lived as a byte-identical private copy inside all four
 * adapters; it now has one home (`./content-clip.js`) and this suite pins its
 * contract directly instead of only exercising it transitively through each
 * adapter's `parse*` round-trip.
 *
 * The two behaviours that matter most for the extraction to be safe:
 *   1. `null`/`undefined` collapse to `''` BEFORE any `JSON.stringify` runs — so a
 *      missing value never throws (`JSON.stringify(undefined)` is itself
 *      `undefined`, which would blow up on `.length`).
 *   2. For a value that is already a string, `clip` is a pure length-bound and
 *      does NOT re-encode it — i.e. it matches the old `String(value)` variant the
 *      OpenClaw adapter used, which is why swapping that adapter onto this shared
 *      helper is behaviour-preserving (OpenClaw only ever clips strings).
 */

import { describe, expect, it } from 'vitest';

import { clip, CONTENT_TRUNCATION, LABEL_TRUNCATION } from '../src/adapters/content-clip.js';

describe('content-clip constants', () => {
  it('exposes the event-content and label truncation limits', () => {
    expect(CONTENT_TRUNCATION).toBe(500);
    expect(LABEL_TRUNCATION).toBe(120);
  });

  it('uses a shorter limit for labels than for event content', () => {
    expect(LABEL_TRUNCATION).toBeLessThan(CONTENT_TRUNCATION);
  });
});

describe('clip — nullish handling', () => {
  it('collapses null to an empty string', () => {
    expect(clip(null)).toBe('');
  });

  it('collapses undefined to an empty string (never reaches JSON.stringify)', () => {
    // JSON.stringify(undefined) === undefined, so without the guard this would
    // throw on `.length`. The guard must run first.
    expect(clip(undefined)).toBe('');
  });

  it('does not throw when a nullish value is passed with a custom max', () => {
    expect(() => clip(null, 10)).not.toThrow();
    expect(clip(undefined, 1)).toBe('');
  });
});

describe('clip — strings pass through unchanged (parity with String())', () => {
  it('returns a short string as-is, without quoting or re-encoding', () => {
    expect(clip('hello world')).toBe('hello world');
  });

  it('does NOT JSON-quote a string (distinguishes it from the object path)', () => {
    // A string is used verbatim; only non-strings are JSON.stringify'd. This is
    // the exact property that lets the OpenClaw adapter (which only clips strings)
    // move onto this helper with no behaviour change.
    expect(clip('a "quoted" value')).toBe('a "quoted" value');
    expect(clip('a "quoted" value')).not.toContain('\\"');
  });

  it('leaves the empty string as the empty string', () => {
    expect(clip('')).toBe('');
  });

  it('preserves an already-trimmed multi-word label verbatim', () => {
    const label = 'Refactor the adapter truncation helpers';
    expect(clip(label, LABEL_TRUNCATION)).toBe(label);
  });
});

describe('clip — non-string values are JSON-encoded', () => {
  it('stringifies a plain object', () => {
    expect(clip({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
  });

  it('stringifies an array', () => {
    expect(clip([1, 2, 3])).toBe('[1,2,3]');
  });

  it('stringifies a number', () => {
    expect(clip(42)).toBe('42');
  });

  it('stringifies a boolean', () => {
    expect(clip(true)).toBe('true');
    expect(clip(false)).toBe('false');
  });

  it('stringifies a nested structure', () => {
    expect(clip({ tool: 'read', args: { path: '/tmp/x' } })).toBe(
      '{"tool":"read","args":{"path":"/tmp/x"}}',
    );
  });
});

describe('clip — truncation boundary', () => {
  it('does not truncate a string exactly at the limit (no ellipsis)', () => {
    const s = 'x'.repeat(CONTENT_TRUNCATION);
    const out = clip(s);
    expect(out).toBe(s);
    expect(out).not.toContain('…');
    expect(out.length).toBe(CONTENT_TRUNCATION);
  });

  it('truncates a string one over the limit and appends the ellipsis', () => {
    const s = 'x'.repeat(CONTENT_TRUNCATION + 1);
    const out = clip(s);
    expect(out.endsWith('…')).toBe(true);
    // kept `max` chars of content + the single ellipsis character
    expect(out.length).toBe(CONTENT_TRUNCATION + 1);
    expect(out.slice(0, CONTENT_TRUNCATION)).toBe('x'.repeat(CONTENT_TRUNCATION));
  });

  it('honours a custom max below the default', () => {
    expect(clip('abcdef', 3)).toBe('abc…');
    expect(clip('abc', 3)).toBe('abc'); // exactly at max → untouched
    expect(clip('ab', 3)).toBe('ab'); // under max → untouched
  });

  it('applies the label limit to an over-long derived label', () => {
    const long = 'word '.repeat(60).trim(); // > 120 chars
    const out = clip(long, LABEL_TRUNCATION);
    expect(out.length).toBe(LABEL_TRUNCATION + 1); // 120 kept + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('can truncate a JSON-encoded object once encoded length exceeds max', () => {
    const big = { note: 'y'.repeat(50) };
    const out = clip(big, 20);
    expect(out.length).toBe(21); // 20 chars + ellipsis
    expect(out.startsWith('{"note":"y')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});
