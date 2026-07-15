/**
 * Unit tests for the OpenClaw adapter's low-level `.jsonl` parsing seam
 * (`src/adapters/openclaw-parse.ts`): line-safe reads, content flattening,
 * tool-call signatures, elapsed-time math, and the trajectory companion parse.
 *
 * These cover the pure helpers directly (the higher-level session-assembly and
 * public-API layers are exercised by openclaw-adapter*.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  contentToText,
  toolCallSignaturesOf,
  safeParseLines,
  elapsedMs,
  parseTrajectory,
} from '../src/adapters/openclaw-parse.js';

describe('openclaw-parse: contentToText', () => {
  it('returns a plain string unchanged', () => {
    expect(contentToText('hello')).toBe('hello');
  });

  it('returns empty string for non-string, non-array input', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(42)).toBe('');
    expect(contentToText({ text: 'x' })).toBe('');
  });

  it('flattens text blocks and renders toolCall / toolResult markers', () => {
    const out = contentToText([
      { text: 'line one' },
      { type: 'toolCall', name: 'read', arguments: { path: '/a' } },
      { type: 'toolResult' },
      null,
      'not-a-block-object',
    ]);
    expect(out).toContain('line one');
    expect(out).toContain('[toolCall read {"path":"/a"}]');
    expect(out).toContain('[toolResult]');
  });

  it('truncates very long toolCall arguments to 160 chars of JSON', () => {
    const big = { blob: 'x'.repeat(500) };
    const out = contentToText([{ type: 'toolCall', name: 'w', arguments: big }]);
    const inner = out.slice(out.indexOf('w ') + 2, out.length - 1);
    expect(inner.length).toBeLessThanOrEqual(160);
  });
});

describe('openclaw-parse: toolCallSignaturesOf', () => {
  it('returns [] for non-array content', () => {
    expect(toolCallSignaturesOf('nope')).toEqual([]);
  });

  it('emits one stable signature per toolCall block only', () => {
    const sigs = toolCallSignaturesOf([
      { type: 'toolCall', name: 'read', arguments: { path: '/a' } },
      { text: 'chatter' },
      { type: 'toolResult' },
      { type: 'toolCall', name: 'write', arguments: { path: '/b' } },
    ]);
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).toContain('read');
    expect(sigs[1]).toContain('write');
  });
});

describe('openclaw-parse: elapsedMs', () => {
  it('returns NaN when either bound is missing', () => {
    expect(elapsedMs(null, '2026-01-01T00:00:00Z')).toBeNaN();
    expect(elapsedMs('2026-01-01T00:00:00Z', null)).toBeNaN();
    expect(elapsedMs(undefined, undefined)).toBeNaN();
  });

  it('computes the millisecond delta between ISO timestamps', () => {
    expect(elapsedMs('2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z')).toBe(5000);
  });
});

describe('openclaw-parse: safeParseLines + parseTrajectory (disk)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ocparse-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('safeParseLines skips blank + malformed lines, returns [] for a missing file', () => {
    const f = path.join(dir, 'mixed.jsonl');
    writeFileSync(f, '{"a":1}\n\n  \nnot-json\n{"b":2}\n', 'utf8');
    const recs = safeParseLines(f);
    expect(recs).toEqual([{ a: 1 }, { b: 2 }]);
    expect(safeParseLines(path.join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('parseTrajectory returns null for an empty / missing file', () => {
    const empty = path.join(dir, 'empty.trajectory.jsonl');
    writeFileSync(empty, '\n  \n', 'utf8');
    expect(parseTrajectory(empty)).toBeNull();
    expect(parseTrajectory(path.join(dir, 'gone.trajectory.jsonl'))).toBeNull();
  });

  it('parseTrajectory extracts usage, abort flags, finalStatus, texts, and the event spine', () => {
    const f = path.join(dir, 'run.trajectory.jsonl');
    const lines = [
      { type: 'session.started', ts: '2026-01-01T00:00:00Z', data: {} },
      { type: 'model.completed', ts: '2026-01-01T00:00:01Z', data: { usage: { total: 100 } } },
      {
        type: 'model.completed',
        ts: '2026-01-01T00:00:02Z',
        data: { usage: { total: 250 }, idleTimedOut: true, finalStatus: 'error', assistantTexts: ['final answer'] },
      },
      { type: 'trace.artifacts', ts: '2026-01-01T00:00:03Z', data: {} },
      { type: 'session.ended', ts: '2026-01-01T00:00:04Z', data: { aborted: true } },
      { type: 'unmapped.event', ts: '2026-01-01T00:00:05Z', data: {} },
    ];
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    const t = parseTrajectory(f)!;
    expect(t).not.toBeNull();
    expect(t.maxTotal).toBe(250);
    expect(t.idleTimedOut).toBe(true);
    expect(t.aborted).toBe(true);
    expect(t.finalStatus).toBe('error');
    expect(t.assistantTexts).toEqual(['final answer']);
    expect(t.firstTs).toBe('2026-01-01T00:00:00Z');
    expect(t.lastTs).toBe('2026-01-01T00:00:05Z');
    expect(t.recCount).toBe(6);
    // event spine maps only known types; unmapped.event is dropped
    const types = t.events.map((e) => e.type);
    expect(types).toEqual(['start', 'output', 'output', 'tool_result', 'end']);
  });
});
