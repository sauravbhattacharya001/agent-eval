/**
 * Direct unit tests for the OpenClaw session-assembly seam
 * (`src/adapters/openclaw-build.ts`): the two source-specific builders
 * `buildFromBare` and `buildFromTrajectory`.
 *
 * The public `openclaw.ts` adapter is exercised end-to-end by
 * `openclaw-adapter*.test.ts`; those go through `buildSession` and mostly assert
 * the downstream staleness verdict. This file targets the builders DIRECTLY so
 * the branch logic internal to the extraction — timeout-budget synthesis, the
 * bare↔trajectory enrichment override, custom error events, label election, and
 * clean-stop `end`/`endedAt` emission — is pinned independently of the higher
 * layers.
 *
 * All fixtures are tiny JSONL files built on the fly (read-only, dependency-free
 * Tier-1 surface): no published fixture is needed. Every assertion describes
 * current behaviour — these are behaviour-preserving regression pins for the
 * frozen F adapter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildFromBare, buildFromTrajectory } from '../src/adapters/openclaw-build.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocbuild-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: unknown[]): string {
  const f = path.join(dir, name);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return f;
}

describe('buildFromBare: empty / unparseable input', () => {
  it('returns null when the bare log has no parseable records', () => {
    const f = path.join(dir, 'empty.jsonl');
    writeFileSync(f, '\n  \nnot-json\n', 'utf8');
    expect(buildFromBare(f, 'empty', null)).toBeNull();
  });
});

describe('buildFromBare: clean stop', () => {
  it('elects a task label, emits a clean end event + endedAt, and reports the last assistant text as output', () => {
    const bare = writeJsonl('clean.jsonl', [
      { type: 'session', timestamp: '2026-01-01T00:00:00Z', cwd: '/work' },
      { type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'Do the thing' } },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:02Z',
        message: { role: 'assistant', content: 'first', usage: { totalTokens: 40 } },
      },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'assistant', content: 'final answer', stopReason: 'stop', usage: { totalTokens: 90 } },
      },
    ]);
    const s = buildFromBare(bare, 'clean', null)!;
    expect(s).not.toBeNull();
    expect(s.meta.label).toBe('Do the thing');
    expect(s.meta.cwd).toBe('/work');
    expect(s.meta.source).toBe('bare');
    expect(s.meta.cleanStop).toBe(true);
    expect(s.meta.endedCleanly).toBe(true);
    expect(s.meta.tokenUsage).toBe(90);
    expect(s.timeline.output).toBe('final answer');
    expect(s.timeline.endedAt).toBe('2026-01-01T00:00:03Z');
    expect(s.timeline.events.some((e) => e.type === 'end')).toBe(true);
    // No timeout budget on a clean run.
    expect(s.timeline.timeoutMs).toBeUndefined();
  });

  it('skips bracketed lines when electing the label, falling back to the first real line', () => {
    const bare = writeJsonl('label.jsonl', [
      { type: 'message', timestamp: 1, message: { role: 'user', content: '[system preamble]\nActual task here' } },
    ]);
    const s = buildFromBare(bare, 'label', null)!;
    expect(s.meta.label).toBe('Actual task here');
  });

  it('falls back to the "(no task line)" placeholder when no user text is present', () => {
    const bare = writeJsonl('nolabel.jsonl', [
      { type: 'message', timestamp: 1, message: { role: 'assistant', content: 'hi' } },
    ]);
    const s = buildFromBare(bare, 'nolabel', null)!;
    expect(s.meta.label).toBe('(no task line)');
  });
});

describe('buildFromBare: custom error / idle-timeout events', () => {
  it('records a custom error event and synthesises an error-severity timeout budget below runtime', () => {
    const bare = writeJsonl('timeout.jsonl', [
      { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'run it' } },
      {
        type: 'custom',
        timestamp: '2026-01-01T00:10:00Z',
        customType: 'prompt-error',
        data: { message: 'idle timeout reached' },
      },
    ]);
    const s = buildFromBare(bare, 'timeout', null)!;
    expect(s.meta.errorEvents).toBe(1);
    expect(s.meta.idleTimeoutErr).toBe(true);
    expect(s.meta.endedCleanly).toBe(false);
    expect(s.timeline.events.some((e) => e.type === 'error')).toBe(true);
    // 10 minutes of runtime → budget is set strictly below it (runtimeMs - 1).
    expect(s.timeline.timeoutMs).toBe(600_000 - 1);
    expect(s.timeline.endedAt).toBeUndefined();
  });
});

describe('buildFromBare: tool-call signatures and aborted stop reason', () => {
  it('collects tool-call signatures from assistant content and flags aborted runs', () => {
    const bare = writeJsonl('tools.jsonl', [
      { type: 'message', timestamp: 1, message: { role: 'user', content: 'go' } },
      {
        type: 'message',
        timestamp: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: { path: '/a' } }],
          stopReason: 'aborted',
        },
      },
    ]);
    const s = buildFromBare(bare, 'tools', null)!;
    expect(s.meta.sawAborted).toBe(true);
    expect(s.meta.abortedAny).toBe(true);
    expect(s.meta.endedCleanly).toBe(false);
    expect(s.meta.toolCallSignatures.length).toBe(1);
    expect(s.timeline.events.some((e) => e.type === 'tool_call')).toBe(true);
  });
});

describe('buildFromBare: trajectory enrichment override', () => {
  it('prefers trajectory assistant texts + token totals over the bare log when a companion trajectory exists', () => {
    const bare = writeJsonl('enrich.jsonl', [
      { type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'task' } },
      {
        type: 'message',
        timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: 'bare text', usage: { totalTokens: 10 } },
      },
    ]);
    const traj = writeJsonl('enrich.trajectory.jsonl', [
      { type: 'session.started', ts: '2026-01-01T00:00:00Z', data: {} },
      {
        type: 'model.completed',
        ts: '2026-01-01T00:00:02Z',
        data: { usage: { total: 500 }, finalStatus: 'success', assistantTexts: ['trajectory answer'] },
      },
      { type: 'session.ended', ts: '2026-01-01T00:00:03Z', data: {} },
    ]);
    const s = buildFromBare(bare, 'enrich', traj)!;
    expect(s.meta.hadTrajectory).toBe(true);
    // Trajectory texts win for the output; token usage is the max of both.
    expect(s.timeline.output).toBe('trajectory answer');
    expect(s.meta.tokenUsage).toBe(500);
    expect(s.meta.trajTokenTotal).toBe(500);
    expect(s.meta.msgTokenMax).toBe(10);
  });
});

describe('buildFromTrajectory: trajectory-only sessions', () => {
  it('returns null for an empty / missing trajectory', () => {
    const empty = path.join(dir, 'none.trajectory.jsonl');
    writeFileSync(empty, '\n', 'utf8');
    expect(buildFromTrajectory(empty, 'none')).toBeNull();
    expect(buildFromTrajectory(path.join(dir, 'gone.trajectory.jsonl'), 'gone')).toBeNull();
  });

  it('keeps the end event + endedAt on a clean success and carries no timeout budget', () => {
    const traj = writeJsonl('tclean.trajectory.jsonl', [
      { type: 'session.started', ts: '2026-01-01T00:00:00Z', data: {} },
      {
        type: 'model.completed',
        ts: '2026-01-01T00:00:01Z',
        data: { usage: { total: 120 }, finalStatus: 'success', assistantTexts: ['done'] },
      },
      { type: 'session.ended', ts: '2026-01-01T00:00:02Z', data: {} },
    ]);
    const s = buildFromTrajectory(traj, 'tclean')!;
    expect(s.meta.source).toBe('trajectory');
    expect(s.meta.endedCleanly).toBe(true);
    expect(s.meta.cleanStop).toBe(true);
    expect(s.meta.toolCallSignatures).toEqual([]);
    expect(s.timeline.output).toBe('done');
    expect(s.timeline.endedAt).toBe('2026-01-01T00:00:02Z');
    expect(s.timeline.events.some((e) => e.type === 'end')).toBe(true);
    expect(s.timeline.timeoutMs).toBeUndefined();
  });

  it('strips the end event and synthesises a timeout budget on an idle-timed-out run', () => {
    const traj = writeJsonl('tidle.trajectory.jsonl', [
      { type: 'session.started', ts: '2026-01-01T00:00:00Z', data: {} },
      {
        type: 'model.completed',
        ts: '2026-01-01T00:05:00Z',
        data: { usage: { total: 999 }, idleTimedOut: true, finalStatus: 'error', assistantTexts: ['stuck'] },
      },
      { type: 'session.ended', ts: '2026-01-01T00:05:00Z', data: { aborted: true } },
    ]);
    const s = buildFromTrajectory(traj, 'tidle')!;
    expect(s.meta.endedCleanly).toBe(false);
    expect(s.meta.abortedAny).toBe(true);
    expect(s.meta.idleTimeoutErr).toBe(true);
    // 'end' is stripped so the downstream no_end signal can fire.
    expect(s.timeline.events.some((e) => e.type === 'end')).toBe(false);
    expect(s.timeline.endedAt).toBeUndefined();
    // 5 minutes runtime → budget strictly below it.
    expect(s.timeline.timeoutMs).toBe(300_000 - 1);
  });
});
