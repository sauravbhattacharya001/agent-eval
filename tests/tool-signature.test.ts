/**
 * Tests for the shared tool-call signature helper - `toolSig` - the deterministic
 * `name(inputDigest)` string that every trace-export adapter (OpenClaw, OTLP,
 * LangSmith, AgentLens) pushes into `SessionMeta.toolCallSignatures`.
 *
 * That array feeds the tool-loop half of the loop-without-progress check
 * (`action/triage.ts` `loopSignal`, thrash mode #3): the same call fired N times
 * is a thrash even when no prose repeats. Until now `toolSig` was only exercised
 * transitively through each adapter's `parse*` round-trip; this suite pins its
 * contract directly so a drift in the helper can't silently weaken thrash
 * detection across all four adapters at once.
 *
 * The behaviours that matter most for that downstream check:
 *   1. ARGUMENT CANONICALIZATION - object keys are sorted before stringify, so
 *      the SAME call with args in a different key order produces the SAME
 *      signature (it must collide, or a genuine retry loop would be missed).
 *   2. THE `name()` vs `name(digest)` DISTINCTION - missing/empty args yield a
 *      bare `name()` with no digest, which `loopSignal` deliberately treats as
 *      weak evidence (streak-only), whereas real args yield `name(digest)` that
 *      counts by share-of-calls. The empty-digest boundary therefore has meaning.
 *   3. NEVER THROWS - a value that can't be JSON-encoded (circular ref, BigInt)
 *      degrades to an empty digest instead of blowing up the adapter mid-parse.
 */

import { describe, expect, it } from 'vitest';

import { toolSig } from '../src/adapters/tool-signature.js';

describe('toolSig - name handling', () => {
  it('formats a plain name with an object digest as name(digest)', () => {
    expect(toolSig('read', { path: 'a.ts' })).toBe('read({"path":"a.ts"})');
  });

  it('trims surrounding whitespace from the name', () => {
    expect(toolSig('  read  ', undefined)).toBe('read()');
  });

  it('falls back to "tool" when the name is an empty/whitespace string', () => {
    expect(toolSig('', { a: 1 })).toBe('tool({"a":1})');
    expect(toolSig('   ', { a: 1 })).toBe('tool({"a":1})');
  });

  it('falls back to "tool" when the name is not a string', () => {
    expect(toolSig(undefined, null)).toBe('tool()');
    expect(toolSig(null, null)).toBe('tool()');
    expect(toolSig(42 as unknown, null)).toBe('tool()');
    expect(toolSig({ not: 'a name' } as unknown, null)).toBe('tool()');
  });
});

describe('toolSig - empty digest (the name() boundary)', () => {
  // These all collapse to a bare `name()` - the shape loopSignal treats as weak
  // evidence (streak-only, never share-of-calls). Pin each nullish/empty input.
  it('emits a bare name() for undefined args', () => {
    expect(toolSig('edit', undefined)).toBe('edit()');
  });

  it('emits a bare name() for null args', () => {
    expect(toolSig('edit', null)).toBe('edit()');
  });

  it('emits a bare name() for an empty-string args value', () => {
    expect(toolSig('edit', '')).toBe('edit()');
  });

  it('does NOT collapse other falsy args (0, false) to a bare name', () => {
    // Only undefined/null/'' are treated as "no args"; 0 and false are real.
    expect(toolSig('edit', 0)).toBe('edit(0)');
    expect(toolSig('edit', false)).toBe('edit(false)');
  });
});

describe('toolSig - argument canonicalization (the collision contract)', () => {
  it('produces the SAME signature for the same object with keys in a different order', () => {
    const a = toolSig('edit', { path: 'x.ts', text: 'hi' });
    const b = toolSig('edit', { text: 'hi', path: 'x.ts' });
    expect(a).toBe(b);
  });

  it('produces DIFFERENT signatures for genuinely different argument values', () => {
    const a = toolSig('edit', { path: 'a.ts' });
    const b = toolSig('edit', { path: 'b.ts' });
    expect(a).not.toBe(b);
  });

  it('sorts keys deterministically regardless of insertion order', () => {
    // Build the same logical args two ways; both must serialize key-sorted.
    const first: Record<string, unknown> = {};
    first.b = 2;
    first.a = 1;
    const second: Record<string, unknown> = {};
    second.a = 1;
    second.b = 2;
    expect(toolSig('t', first)).toBe('t({"a":1,"b":2})');
    expect(toolSig('t', second)).toBe('t({"a":1,"b":2})');
  });

  it('serializes a non-object arg with plain JSON (no key sort applies)', () => {
    expect(toolSig('run', 'ls -la')).toBe('run("ls -la")');
    expect(toolSig('run', 123)).toBe('run(123)');
  });
});

describe('toolSig - whitespace collapse', () => {
  it('collapses runs of real whitespace in the digest to a single space', () => {
    // The \s+ -> ' ' collapse runs over the JSON-ENCODED string, so literal
    // space runs collapse but the `\n`/`\t` ESCAPE SEQUENCES that
    // JSON.stringify emits (backslash + letter, not whitespace bytes) survive.
    const sig = toolSig('run', { cmd: 'a\n\t  b   c' });
    expect(sig).toBe('run({"cmd":"a\\n\\t b c"})');
    // No run of 2+ literal space characters remains.
    expect(sig).not.toMatch(/ {2,}/);
    // ...and no raw newline/tab byte is present (they became `\n`/`\t` text).
    expect(sig).not.toMatch(/[\n\t]/);
  });
});

describe('toolSig - hard truncation at 200 chars', () => {
  it('truncates a very long digest to 200 characters', () => {
    const big = 'x'.repeat(1000);
    const sig = toolSig('read', { path: big });
    // digest is sliced to 200; the wrapper adds `read(` + `)` around it.
    const digest = sig.slice('read('.length, -1);
    expect(digest.length).toBe(200);
    expect(sig.startsWith('read(')).toBe(true);
    expect(sig.endsWith(')')).toBe(true);
  });

  it('does not truncate a short digest', () => {
    const sig = toolSig('read', { path: 'short.ts' });
    expect(sig).toBe('read({"path":"short.ts"})');
  });
});

describe('toolSig - never throws (degrades to empty digest)', () => {
  it('returns name() when the args contain a circular reference', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // JSON.stringify throws on a cycle; toolSig must swallow it -> empty digest.
    expect(() => toolSig('loop', circular)).not.toThrow();
    expect(toolSig('loop', circular)).toBe('loop()');
  });

  it('returns name() when the args contain a BigInt (not JSON-serializable)', () => {
    const withBigInt = { n: BigInt(10) };
    expect(() => toolSig('big', withBigInt)).not.toThrow();
    expect(toolSig('big', withBigInt)).toBe('big()');
  });
});
