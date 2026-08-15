/**
 * Tests for the Timeline Bridge (`src/monitoring/timeline-bridge.ts`).
 *
 * `transcriptToTimeline` is the deterministic Tier-1 glue that turns a parsed
 * {@link Transcript} into the {@link RunTimeline} shape consumed by the
 * staleness / timeout / abandonment detectors (via `scorer-checks.ts`). It is a
 * PUBLIC export (`src/index.ts`) and sits on the historical scoring hot path,
 * yet had no direct test — its only prior mention in the suite was a comment in
 * `scorer.test.ts`. Its behaviour is full of load-bearing subtleties that a
 * results-only test through the scorer cannot see:
 *
 *   - the recovered-error rule (hadErrors=true but outcome=pass ⇒ NO synthetic
 *     `error` event, else healthy runs false-flag as stale — the exact fix the
 *     `scorer.test.ts` comment references);
 *   - even distribution of synthetic `output` events across the real run window
 *     (exclusive of endpoints) vs. the synthetic 1-second cadence fallback when
 *     the transcript carries no parseable wall-clock;
 *   - the synthetic `end` event emitted for a finished-but-untimed run so
 *     `no_end` is not falsely flagged;
 *   - conditional inclusion of `output` / `timeoutMs` / `endedAt`;
 *   - 280-char truncation of action + error content.
 *
 * Fixtures are built through the real `parseTranscript` parser (not hand-rolled
 * Transcript literals) so the test stays honest if the Transcript shape evolves,
 * and pin `defaultTimezone: '+00:00'` so start/end ms math is exact and
 * host-clock-independent.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import type { RunEvent } from '../src/checks/staleness.js';
import { transcriptToTimeline } from '../src/monitoring/timeline-bridge.js';
import { parseTranscript } from '../src/monitoring/transcript-reader.js';
import type { Transcript } from '../src/monitoring/types.js';

// ─── FIXTURES ───────────────────────────────────────────────────────────────────

/** UTC so `startedAtMs`/`endedAtMs` are exact regardless of the host timezone. */
const UTC = { defaultTimezone: '+00:00' as const };

/** A healthy run that DID document recovered errors (`## Errors & Retries`). */
const PASS_WITH_RECOVERED_ERRORS = `# Builder Run - 2026-06-05 10:00 PT
## Task
Ship one improvement.
## Actions Taken
1. Cloned the repo
2. Refactored the module
3. Ran the tests
## Key Outputs
- commit abc1234 pushed
- tests green
## Outcome
pass
## Errors & Retries
- Hit a transient 403 on first push; retried and it went through
## Duration
30 minutes
`;

/** A run that ended in failure with a live error. */
const FAILING_RUN = `# Tempcheck Run - 2026-06-07 13:00 PT
## Task
Check temperature.
## Actions Taken
1. Tried to read the sensor
2. Sensor timed out
## Key Outputs
No reading obtained.
## Outcome
fail
## Errors & Retries
- Sensor read timed out after 3 attempts
## Duration
4 minutes
`;

/** A finished run with NO parseable `## Duration` (so endedAtMs is NaN). */
const FINISHED_NO_DURATION = `# Gardener Run - 2026-06-08 09:00 PT
## Task
Pick repos.
## Actions Taken
1. Picked repo A
2. Picked repo B
## Key Outputs
Two repos considered.
## Outcome
pass
## Errors & Retries
No errors
`;

/** An in-progress / unknown-outcome run. */
const UNKNOWN_OUTCOME = `# Eval Run - 2026-06-09 12:00 PT
## Task
Do a thing.
## Actions Taken
1. Started the thing
## Key Outputs
Working on it.
## Outcome
IN-PROGRESS
## Duration
2 minutes
`;

// ─── helpers ─────────────────────────────────────────────────────────────────────

function parse(text: string, filename: string): Transcript {
  return parseTranscript(text, { filename, ...UTC });
}

function typesOf(events: RunEvent[]): string[] {
  return events.map((e) => e.type);
}

function eventsOfType(events: RunEvent[], type: string): RunEvent[] {
  return events.filter((e) => e.type === type);
}

/** Parse the ISO/number timestamp on an event back to Unix ms for ordering asserts. */
function ms(event: RunEvent): number {
  return typeof event.timestamp === 'number'
    ? event.timestamp
    : new Date(event.timestamp).getTime();
}

// ─── start event ─────────────────────────────────────────────────────────────────

describe('transcriptToTimeline - start event', () => {
  it('emits a start event anchored at startedAtMs with the transcript title', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const timeline = transcriptToTimeline(t);

    const starts = eventsOfType(timeline.events ?? [], 'start');
    expect(starts).toHaveLength(1);
    expect(ms(starts[0]!)).toBe(t.identity.startedAtMs);
    expect(starts[0]!.content).toBe(t.title);
  });

  it('falls back to "<worker> run" content when the transcript has no title', () => {
    // A body with no `# ...` heading ⇒ empty title, worker inferred from filename.
    const t = parse('## Task\nx\n## Outcome\npass\n## Duration\n2 minutes\n', 'sentinel/2026-06-08-1815.md');
    const timeline = transcriptToTimeline(t);
    const starts = eventsOfType(timeline.events ?? [], 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.content).toBe(`${t.identity.worker} run`);
  });
});

// ─── action expansion (Tier-1 synthetic output events) ───────────────────────────

describe('transcriptToTimeline - action expansion', () => {
  it('emits one output event per action item, in order, by default', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    expect(t.actionItems.length).toBe(3);

    const timeline = transcriptToTimeline(t);
    const outputs = eventsOfType(timeline.events ?? [], 'output');
    expect(outputs).toHaveLength(3);
    expect(outputs.map((e) => e.content)).toEqual([
      'Cloned the repo',
      'Refactored the module',
      'Ran the tests',
    ]);
  });

  it('distributes action events strictly inside the real (start,end) window', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const start = t.identity.startedAtMs;
    const end = t.endedAtMs; // start + 30min
    const span = end - start;

    const outputs = eventsOfType(transcriptToTimeline(t).events ?? [], 'output');
    const stamps = outputs.map(ms);

    // Exclusive of endpoints and strictly increasing → evenly spaced at 1/4,2/4,3/4.
    expect(stamps.every((x) => x > start && x < end)).toBe(true);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(stamps).toEqual([
      start + Math.round(span * (1 / 4)),
      start + Math.round(span * (2 / 4)),
      start + Math.round(span * (3 / 4)),
    ]);
  });

  it('suppresses per-action events when expandActions is false (minimal timeline)', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const timeline = transcriptToTimeline(t, { expandActions: false });
    expect(eventsOfType(timeline.events ?? [], 'output')).toHaveLength(0);
    // start + end survive; only the synthetic action fan-out is removed.
    expect(typesOf(timeline.events ?? [])).toEqual(['start', 'end']);
  });

  it('truncates long action content to 280 chars with an ellipsis', () => {
    const longStep = 'x'.repeat(400);
    const t = parse(
      `# Builder Run - 2026-06-05 10:00 PT\n## Actions Taken\n1. ${longStep}\n## Outcome\npass\n## Duration\n10 minutes\n`,
      'builder/2026-06-05-1000.md',
    );
    const outputs = eventsOfType(transcriptToTimeline(t).events ?? [], 'output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.content).toHaveLength(280);
    expect(outputs[0]!.content!.endsWith('…')).toBe(true);
  });
});

// ─── recovered-error suppression (the load-bearing rule) ─────────────────────────

describe('transcriptToTimeline - recovered vs. live errors', () => {
  it('does NOT emit an error event when hadErrors but the run reported pass', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    // Precondition: the fixture really did document recovered errors.
    expect(t.hadErrors).toBe(true);
    expect(t.outcome).toBe('pass');

    const timeline = transcriptToTimeline(t);
    expect(eventsOfType(timeline.events ?? [], 'error')).toHaveLength(0);
  });

  it('emits an error event (just before end) for a run that actually failed', () => {
    const t = parse(FAILING_RUN, 'tempcheck/2026-06-07-1300.md');
    expect(t.hadErrors).toBe(true);
    expect(t.outcome).toBe('fail');

    const events = transcriptToTimeline(t).events ?? [];
    const errors = eventsOfType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.content).toContain('Sensor read timed out');

    // The error is sequenced strictly before the end event (endMs - 1).
    const end = eventsOfType(events, 'end')[0]!;
    expect(ms(errors[0]!)).toBe(ms(end) - 1);
  });

  it('honors emitErrorEvent=false even for a live failure', () => {
    const t = parse(FAILING_RUN, 'tempcheck/2026-06-07-1300.md');
    const timeline = transcriptToTimeline(t, { emitErrorEvent: false });
    expect(eventsOfType(timeline.events ?? [], 'error')).toHaveLength(0);
  });

  it('positions the synthetic error at the tail when the run has NO parseable wall-clock', () => {
    // No `# ...` heading and a time-less filename ⇒ startedAtMs AND endedAtMs are
    // both NaN, so neither the real-window nor the finite-start fallback applies.
    // This is the ONLY path that exercises the anchor-based error timestamp
    // (`anchorMs + (actionItems.length + 1) * 1000 - 1`), and the branch that
    // suppresses the end event when startMs is not finite.
    const t = parse(
      '## Task\nx\n## Actions Taken\n1. tried step one\n2. tried step two\n## Outcome\nfail\n## Errors & Retries\nSensor read timed out badly here\n',
      'sentinel/notes.md',
    );
    expect(Number.isNaN(t.identity.startedAtMs)).toBe(true);
    expect(Number.isNaN(t.endedAtMs)).toBe(true);
    expect(t.hadErrors).toBe(true);
    expect(t.outcome).toBe('fail');
    expect(t.actionItems.length).toBe(2);

    const events = transcriptToTimeline(t).events ?? [];
    // Two synthetic 1s-cadence outputs (1000, 2000), then the error at the tail.
    // No start event (startMs NaN) and no end event (finite-start guard fails).
    expect(typesOf(events)).toEqual(['output', 'output', 'error']);
    const errors = eventsOfType(events, 'error');
    expect(errors).toHaveLength(1);
    // anchorMs(0) + (2 + 1) * 1000 - 1 = 2999, strictly after both outputs.
    expect(ms(errors[0]!)).toBe(2999);
    expect(ms(errors[0]!)).toBe(Math.max(...events.map(ms)));
    expect(errors[0]!.content).toContain('Sensor read timed out');
  });

  it('truncates long error content to 280 chars with an ellipsis', () => {
    // Multi-word (>=2 tokens) so `hadErrors` registers, and long enough to clip.
    const longErr = 'sensor read failed retrying '.repeat(20).trim();
    expect(longErr.length).toBeGreaterThan(280);
    const t = parse(
      `# Tempcheck Run - 2026-06-07 13:00 PT\n## Actions Taken\n1. tried\n## Outcome\nfail\n## Errors & Retries\n${longErr}\n## Duration\n4 minutes\n`,
      'tempcheck/2026-06-07-1300.md',
    );
    expect(t.hadErrors).toBe(true);
    const errors = eventsOfType(transcriptToTimeline(t).events ?? [], 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.content).toHaveLength(280);
    expect(errors[0]!.content!.endsWith('…')).toBe(true);
  });
});

// ─── end event ───────────────────────────────────────────────────────────────────

describe('transcriptToTimeline - end event', () => {
  it('emits an end event at endedAtMs carrying the outcome as content', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const ends = eventsOfType(transcriptToTimeline(t).events ?? [], 'end');
    expect(ends).toHaveLength(1);
    expect(ms(ends[0]!)).toBe(t.endedAtMs);
    expect(ends[0]!.content).toBe('pass');
  });

  it('synthesizes an end event for a finished run with no parseable duration', () => {
    const t = parse(FINISHED_NO_DURATION, 'gardener/2026-06-08-0900.md');
    // No duration ⇒ endedAtMs is NaN, but the run clearly finished (pass).
    expect(Number.isNaN(t.endedAtMs)).toBe(true);
    expect(t.outcome).toBe('pass');

    const events = transcriptToTimeline(t).events ?? [];
    const ends = eventsOfType(events, 'end');
    // A synthetic end must exist so downstream 'no_end' is not falsely flagged...
    expect(ends).toHaveLength(1);
    expect(ends[0]!.content).toBe('pass');
    // ...and it is sequenced last (after the action fan-out), ordering only.
    expect(ms(ends[0]!)).toBe(Math.max(...events.map(ms)));
  });

  it('emits NO end event when the outcome is unknown', () => {
    const t = parse(UNKNOWN_OUTCOME, 'eval/2026-06-09-1200.md');
    expect(t.outcome).toBe('unknown');
    expect(eventsOfType(transcriptToTimeline(t).events ?? [], 'end')).toHaveLength(0);
  });
});

// ─── synthetic cadence fallback (no parseable wall-clock at all) ──────────────────

describe('transcriptToTimeline - no parseable wall-clock', () => {
  it('still fans out action events on a synthetic 1s cadence so the run is not mistaken for empty', () => {
    // A filename with no time ⇒ startedAtMs and endedAtMs are both NaN.
    const t = parse(FINISHED_NO_DURATION, 'gardener/notes.md');
    expect(Number.isNaN(t.identity.startedAtMs)).toBe(true);
    expect(Number.isNaN(t.endedAtMs)).toBe(true);

    const events = transcriptToTimeline(t).events ?? [];
    // No start/end anchor is possible, but the two actions must still show up.
    const outputs = eventsOfType(events, 'output');
    expect(outputs).toHaveLength(2);
    // anchor 0 + (i+1)*1000 ⇒ 1000ms, 2000ms, strictly ordered.
    expect(outputs.map(ms)).toEqual([1000, 2000]);
    expect(typesOf(events)).toEqual(['output', 'output']);
  });
});

// ─── timeline field passthrough (output / timeoutMs / endedAt) ────────────────────

describe('transcriptToTimeline - timeline fields', () => {
  it('carries Key Outputs into timeline.output for content-based abandonment checks', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const timeline = transcriptToTimeline(t);
    expect(timeline.output).toBe(t.keyOutputs);
    expect(timeline.output).toContain('commit abc1234 pushed');
  });

  it('omits timeline.output when the transcript has no Key Outputs section', () => {
    const t = parse(
      '# Builder Run - 2026-06-05 10:00 PT\n## Task\nx\n## Outcome\npass\n## Duration\n2 minutes\n',
      'builder/2026-06-05-1000.md',
    );
    expect(t.keyOutputs).toBe('');
    expect('output' in transcriptToTimeline(t)).toBe(false);
  });

  it('sets timeline.timeoutMs only when the option is provided', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    expect('timeoutMs' in transcriptToTimeline(t)).toBe(false);
    expect(transcriptToTimeline(t, { timeoutMs: 90_000 }).timeoutMs).toBe(90_000);
  });

  it('propagates startedAt/endedAt from the transcript identity + parsed end', () => {
    const t = parse(PASS_WITH_RECOVERED_ERRORS, 'builder/2026-06-05-1000.md');
    const timeline = transcriptToTimeline(t);
    expect(timeline.startedAt).toBe(t.identity.startedAt);
    expect(timeline.endedAt).toBe(t.endedAt);
  });

  it('omits endedAt when the run has no parseable end', () => {
    const t = parse(FINISHED_NO_DURATION, 'gardener/2026-06-08-0900.md');
    expect(t.endedAt).toBeUndefined();
    expect('endedAt' in transcriptToTimeline(t)).toBe(false);
  });
});
