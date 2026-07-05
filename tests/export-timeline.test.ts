/**
 * Tests for the shared `buildExportTimeline` helper - the "finalize a session
 * RunTimeline" assembly that every trace-export adapter (OTLP, LangSmith,
 * AgentLens) uses to shape its computed start/end/finished/events/output into the
 * neutral {@link RunTimeline} triage consumes.
 *
 * This object literal previously lived as a byte-identical inline block inside all
 * three adapters, differing ONLY in the `startedAt` fallback expression and which
 * locals fed the values; it now has one home (`./export-timeline.js`) and this
 * suite pins its contract directly instead of only exercising it transitively
 * through each adapter's `parse*` round-trip.
 *
 * The properties that matter for the extraction to be safe (each adapter's inline
 * literal was
 *   `{ startedAt: finite(startMs) ? startMs : fallback,
 *      ...(missing || !finite(endMs) ? {} : { endedAt: endMs }),
 *      events, output: assistantTexts.join('\n').slice(0, 4000) }`):
 *   1. `startedAt` is the finite start ms, else the caller's fallback verbatim.
 *   2. `endedAt` is attached IFF `finished && Number.isFinite(endMs)` - an
 *      unfinished run (or a non-finite end) OMITS the key entirely (so staleness
 *      checks see "no end"), never sets it to NaN.
 *   3. `events` pass through by reference, unchanged.
 *   4. `output` is the segments joined with '\n' and hard-capped at 4000 chars.
 *   5. Key order is `startedAt, endedAt?, events, output` so the produced object
 *      is indistinguishable from the old inline literals.
 */

import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../src/checks/staleness.js';
import {
  buildExportTimeline,
  TIMELINE_OUTPUT_CAP,
} from '../src/adapters/export-timeline.js';

const evs: RunEvent[] = [
  { timestamp: 100, type: 'start', content: 's' },
  { timestamp: 200, type: 'output', content: 'hi' },
];

describe('buildExportTimeline — startedAt', () => {
  it('uses the finite start ms when it is finite', () => {
    const t = buildExportTimeline({
      startMs: 1234,
      startFallback: 'raw-iso',
      endMs: 5678,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect(t.startedAt).toBe(1234);
  });

  it('falls back to the caller value verbatim when start is NaN', () => {
    const t = buildExportTimeline({
      startMs: NaN,
      startFallback: '2026-07-05T12:00:00Z',
      endMs: NaN,
      finished: false,
      events: [],
      assistantTexts: [],
    });
    expect(t.startedAt).toBe('2026-07-05T12:00:00Z');
  });

  it('supports a numeric 0 fallback (OTLP style)', () => {
    const t = buildExportTimeline({
      startMs: NaN,
      startFallback: 0,
      endMs: NaN,
      finished: false,
      events: [],
      assistantTexts: [],
    });
    expect(t.startedAt).toBe(0);
  });

  it('prefers the finite start even when a fallback is also supplied', () => {
    const t = buildExportTimeline({
      startMs: 42,
      startFallback: 'ignored',
      endMs: 99,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect(t.startedAt).toBe(42);
  });
});

describe('buildExportTimeline — endedAt attachment (finished && finite)', () => {
  it('attaches endedAt when finished AND end is finite', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 900,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect(t.endedAt).toBe(900);
    expect('endedAt' in t).toBe(true);
  });

  it('OMITS endedAt entirely when NOT finished (even if end is finite)', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 900, // finite, but the run did not cleanly finish
      finished: false,
      events: [],
      assistantTexts: [],
    });
    expect('endedAt' in t).toBe(false);
    expect(t.endedAt).toBeUndefined();
  });

  it('OMITS endedAt when finished but end is NaN (no key, not NaN value)', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: NaN,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect('endedAt' in t).toBe(false);
    expect(t.endedAt).toBeUndefined();
  });

  it('OMITS endedAt when end is +Infinity (not finite)', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: Infinity,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect('endedAt' in t).toBe(false);
  });
});

describe('buildExportTimeline — events pass through', () => {
  it('carries the events array by reference, unchanged', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 200,
      finished: true,
      events: evs,
      assistantTexts: [],
    });
    expect(t.events).toBe(evs);
    expect(t.events).toHaveLength(2);
  });
});

describe('buildExportTimeline — output preview', () => {
  it('joins the assistant segments with newlines', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 200,
      finished: true,
      events: [],
      assistantTexts: ['line one', 'line two', 'line three'],
    });
    expect(t.output).toBe('line one\nline two\nline three');
  });

  it('produces an empty string for no segments', () => {
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 200,
      finished: true,
      events: [],
      assistantTexts: [],
    });
    expect(t.output).toBe('');
  });

  it('hard-caps the joined output at TIMELINE_OUTPUT_CAP (4000) chars', () => {
    expect(TIMELINE_OUTPUT_CAP).toBe(4000);
    const big = 'x'.repeat(10_000);
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 200,
      finished: true,
      events: [],
      assistantTexts: [big],
    });
    expect(t.output).toHaveLength(4000);
    expect(t.output).toBe('x'.repeat(4000));
  });

  it('caps ACROSS the joined segments, not per-segment', () => {
    // three 1500-char segments + 2 newlines = 4502 chars pre-cap → capped to 4000
    const seg = 'y'.repeat(1500);
    const t = buildExportTimeline({
      startMs: 100,
      startFallback: 0,
      endMs: 200,
      finished: true,
      events: [],
      assistantTexts: [seg, seg, seg],
    });
    expect(t.output).toHaveLength(4000);
  });
});

describe('buildExportTimeline — byte-equivalence with the old inline literal', () => {
  // Reproduce the exact literal each adapter used and assert deep equality, so a
  // future divergence in the helper is caught structurally (keys + order + values).
  const oldInline = (
    startMs: number,
    startFallback: string | number,
    endMs: number,
    missing: boolean,
    events: RunEvent[],
    assistantTexts: string[],
  ) => ({
    startedAt: Number.isFinite(startMs) ? startMs : startFallback,
    ...(missing || !Number.isFinite(endMs) ? {} : { endedAt: endMs }),
    events,
    output: assistantTexts.join('\n').slice(0, 4000),
  });

  const cases: Array<[string, number, string | number, number, boolean]> = [
    ['finished finite', 100, 0, 900, false],
    ['unfinished finite end', 100, 0, 900, true],
    ['finished NaN end', 100, 0, NaN, false],
    ['NaN start with iso fallback', NaN, 'iso', NaN, true],
    ['numeric fallback', NaN, 7, 500, false],
  ];

  for (const [name, startMs, fallback, endMs, missing] of cases) {
    it(`matches inline literal: ${name}`, () => {
      const texts = ['a', 'b'];
      const viaHelper = buildExportTimeline({
        startMs,
        startFallback: fallback,
        endMs,
        finished: !missing,
        events: evs,
        assistantTexts: texts,
      });
      const viaInline = oldInline(startMs, fallback, endMs, missing, evs, texts);
      expect(viaHelper).toEqual(viaInline);
      expect(Object.keys(viaHelper)).toEqual(Object.keys(viaInline));
    });
  }
});
