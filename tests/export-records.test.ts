/**
 * Tests for the shared `parseExportRecords` helper — the "split an export blob
 * into candidate records" envelope dispatcher that the AgentLens trace-export
 * adapter uses before it looks at a single record.
 *
 * This logic previously lived as an inline dispatch inside `parseAgentLens`
 * (trim → bail on empty → branch on `trimmed[0]` for JSON-array / single-object /
 * NDJSON, filtering every candidate through one shape predicate). It now has one
 * home (`./export-records.js`) and this suite pins its contract directly instead
 * of only exercising it transitively through `parseAgentLens`'s round-trip.
 *
 * The properties that matter for the extraction to be safe (the AgentLens inline
 * dispatch applied its `pushOne` predicate UNIFORMLY to every candidate — each
 * array element, the single object, and each successfully-parsed NDJSON line —
 * and preserved document/line order):
 *   1. Empty / whitespace-only input → `[]` (never throws, never parses).
 *   2. A `[`-led blob is parsed as an array; each element is filtered by `accept`,
 *      order preserved; a non-array `[`… payload contributes nothing.
 *   3. A `{`-led blob is parsed as a single object and filtered by `accept`.
 *   4. Anything else (first char is neither `[` nor `{`) is NDJSON: split on
 *      `/\r?\n/`, each line trimmed, blank lines skipped, malformed lines silently
 *      dropped, the rest filtered by `accept`. A `{`-led multi-line blob is ALSO
 *      recovered as NDJSON when it fails to parse as one JSON document (real export
 *      records begin with `{`, so object-per-line NDJSON must round-trip).
 *   5. `accept` is applied to EVERY candidate in ALL branches (uniformity is the
 *      exact property that let AgentLens delegate here); it also narrows the type.
 *   6. A malformed array surfaces the native `JSON.parse` error; a `{`-led blob that
 *      fails single-document parse is retried as NDJSON, so a malformed single line
 *      is dropped (→ `[]`) rather than throwing — only NDJSON's per-line failures are
 *      swallowed, and a `{`-led blob now shares that path on fallback.
 *
 * Note on the envelope choice: it is decided by `trimmed[0]`, with a `{`-led blob
 * that fails single-document parse retried as object-per-line NDJSON — the same
 * fallback the OTLP and LangSmith adapters carry inline. This keeps NDJSON of
 * exports (every line begins with `{`) working instead of throwing on line two.
 */

import { describe, expect, it } from 'vitest';

import { parseExportRecords } from '../src/adapters/export-records.js';

/** A minimal record shape + guard mirroring the adapters' `'x' in o` predicates. */
interface Rec {
  id: number;
}
const isRec = (o: unknown): o is Rec =>
  !!o && typeof o === 'object' && 'id' in o;

describe('parseExportRecords — empty / whitespace input', () => {
  it('returns [] for an empty string (never parses)', () => {
    expect(parseExportRecords('', isRec)).toEqual([]);
  });

  it('returns [] for whitespace / newlines only', () => {
    expect(parseExportRecords('   \n\t \r\n  ', isRec)).toEqual([]);
  });
});

describe('parseExportRecords — JSON array envelope', () => {
  it('parses an array and keeps accepted elements in document order', () => {
    const out = parseExportRecords('[{"id":1},{"id":2},{"id":3}]', isRec);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('drops elements the predicate rejects, keeping the rest in order', () => {
    // 42 (scalar) and {} (no id) are rejected; 1 and 2 survive, order preserved.
    const out = parseExportRecords('[{"id":1},42,{"nope":true},{"id":2}]', isRec);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns [] for a `[`-led payload that is not actually an array', () => {
    // Only real arrays are iterated; a `[`-led empty array parses but contributes
    // nothing (mirrors the inline `if (Array.isArray(arr))` guard).
    expect(parseExportRecords('[]', isRec)).toEqual([]);
  });

  it('throws on a malformed `[`-led blob (native JSON.parse error, not swallowed)', () => {
    // Only NDJSON swallows parse errors; a broken array surfaces them, unchanged.
    expect(() => parseExportRecords('[{"id":1', isRec)).toThrow();
  });
});

describe('parseExportRecords — single JSON object envelope', () => {
  it('parses a lone object and keeps it when accepted', () => {
    const out = parseExportRecords('{"id":7}', isRec);
    expect(out.map((r) => r.id)).toEqual([7]);
  });

  it('applies the predicate to the single object too (rejects a non-record)', () => {
    // The `{`-led branch is NOT unconditional here: an object failing the guard is
    // dropped, exactly as AgentLens's `pushOne(JSON.parse(trimmed))` did.
    expect(parseExportRecords('{"nope":true}', isRec)).toEqual([]);
  });

  it('a malformed single-line `{` blob yields [] (retried as NDJSON, bad line dropped)', () => {
    // A `{`-led blob that fails single-document parse falls back to NDJSON; a lone
    // malformed line is then silently dropped, so the result is empty (not a throw).
    // Only a malformed `[`-led array still surfaces the native error.
    expect(parseExportRecords('{"id":', isRec)).toEqual([]);
  });
});

describe('parseExportRecords — NDJSON envelope', () => {
  // NDJSON is reached both when the blob does NOT start with `{`/`[` AND as a
  // fallback for a `{`-led multi-line blob that fails single-document parse. The
  // scalar-per-line cases below exercise the primary (non-object-led) path; the
  // object-per-line fallback is pinned in its own test.
  const isNum = (o: unknown): o is number => typeof o === 'number';

  it('parses one value per line, keeping accepted ones in line order', () => {
    expect(parseExportRecords('1\n2\n3', isNum)).toEqual([1, 2, 3]);
  });

  it('skips blank lines and trims surrounding whitespace on each line', () => {
    expect(parseExportRecords('  1  \n\n\t2\n   \n3\n', isNum)).toEqual([1, 2, 3]);
  });

  it('silently drops malformed lines but keeps the valid ones', () => {
    expect(parseExportRecords('1\nthis is not json\n2\n{oops\n3', isNum)).toEqual([1, 2, 3]);
  });

  it('splits on both \\n and \\r\\n line endings', () => {
    expect(parseExportRecords('1\r\n2\n3\r\n', isNum)).toEqual([1, 2, 3]);
  });

  it('applies the predicate to NDJSON values too (drops parsed non-matches)', () => {
    // A well-formed line that fails the guard (a string, a bool) is filtered out.
    expect(parseExportRecords('1\n"two"\ntrue\n2', isNum)).toEqual([1, 2]);
  });

  it('recovers a `{`-led multi-line blob as object-per-line NDJSON', () => {
    // Regression: every export record begins with `{`, so a `{`-led blob is tried as
    // one document first, then — on parse failure — retried as NDJSON instead of
    // throwing on the second line. This is the fix that keeps NDJSON of exports working.
    const out = parseExportRecords('{"id":1}\n{"id":2}', isRec);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('parseExportRecords — the predicate is uniform + type-narrowing', () => {
  it('narrows unknown → T so callers get typed records with no cast', () => {
    const out = parseExportRecords('[{"id":1},{"id":2}]', isRec);
    // If the return type were not narrowed, `.id` would not type-check; the sum
    // exercises the narrowed shape at runtime too.
    const total = out.reduce((s, r) => s + r.id, 0);
    expect(total).toBe(3);
  });

  it('honours the same predicate across the array and single envelopes', () => {
    // The exact uniformity property that let AgentLens delegate: the identical guard
    // governs every shape it reaches. A record missing `id` is dropped in both.
    const arr = parseExportRecords('[{"id":1},{"x":0}]', isRec);
    const one = parseExportRecords('{"x":0}', isRec);
    expect(arr.map((r) => r.id)).toEqual([1]);
    expect(one).toEqual([]);
  });
});

describe('parseExportRecords — parity with the AgentLens envelope it replaced', () => {
  // AgentLens accepts an export object carrying a `session` and/or `events` block.
  interface Exp {
    session?: unknown;
    events?: unknown;
  }
  const isExport = (o: unknown): o is Exp =>
    !!o && typeof o === 'object' && ('session' in o || 'events' in o);

  it('array of exports → one record per export (the real-schema fixture shape)', () => {
    const blob = JSON.stringify([
      { session: { session_id: 'a' }, events: [] },
      { session: { session_id: 'b' }, events: [] },
      { events: [{ event_type: 'llm_call' }] }, // events-only is still a record
    ]);
    expect(parseExportRecords(blob, isExport)).toHaveLength(3);
  });

  it('a single export object is accepted', () => {
    expect(parseExportRecords('{"session":{"session_id":"solo"}}', isExport)).toHaveLength(1);
  });

  it('an object with neither session nor events is rejected (shape guard)', () => {
    expect(parseExportRecords('{"stats":{"total_tokens":10}}', isExport)).toEqual([]);
  });
});
