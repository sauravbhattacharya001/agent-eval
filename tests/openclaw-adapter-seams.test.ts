/**
 * Unit tests for the OpenClaw session adapter's parsing SEAMS.
 *
 * The companion `openclaw-adapter.test.ts` covers the end-to-end staleness
 * verdicts against three on-disk synthetic fixtures (bare+trajectory). This
 * file pins the seams those fixtures don't exercise, building tiny session dirs
 * on the fly so no published fixture is needed:
 *
 *   - `buildSession` returning null (nothing parseable / missing id)
 *   - trajectory-ONLY sessions (no bare log): clean success vs idle-timeout
 *   - checkpoint collapse + largest-snapshot election in `listSessions`
 *   - bare content flattening (toolCall / toolResult / string content)
 *   - malformed JSONL lines being skipped, not fatal
 *   - clean-stop end event + trajectory token enrichment
 *
 * These are behaviour-preserving regression pins for the read-only Tier-1
 * adapter (frozen §F surface): all assertions describe current behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildSession,
  buildAllSessions,
  listSessions,
  type BuiltSession,
} from '../src/adapters/openclaw.js';

// ─── FIXTURE BUILDERS (in-tmpdir, no committed files) ───────────────────────────

let root: string;

/** Write `.jsonl` from an array of record objects (one JSON per line). */
function writeJsonl(dir: string, name: string, recs: unknown[]): void {
  writeFileSync(path.join(dir, name), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'oc-adapter-seams-'));
  mkdirSync(root, { recursive: true });

  // (1) bare clean run: user line + assistant toolCall + toolResult + clean stop
  writeJsonl(root, 'sess-bare-clean.jsonl', [
    { type: 'session', cwd: '/work/proj', timestamp: '2026-02-01T00:00:00Z' },
    {
      type: 'message',
      timestamp: '2026-02-01T00:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Fix the parser bug' }] },
    },
    {
      type: 'message',
      timestamp: '2026-02-01T00:00:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing now' },
          { type: 'toolCall', name: 'edit', arguments: { path: 'a.ts' } },
        ],
        usage: { totalTokens: 1000 },
        stopReason: 'toolUse',
      },
    },
    {
      type: 'message',
      timestamp: '2026-02-01T00:00:06Z',
      message: { role: 'toolResult', content: [{ type: 'toolResult' }] },
    },
    {
      type: 'message',
      timestamp: '2026-02-01T00:00:10Z',
      message: { role: 'assistant', content: 'All done.', usage: { totalTokens: 1500 }, stopReason: 'stop' },
    },
  ]);

  // (2) trajectory-ONLY, clean success
  writeJsonl(root, 'sess-traj-ok.trajectory.jsonl', [
    { type: 'session.started', ts: '2026-02-02T00:00:00Z', data: {} },
    { type: 'model.completed', ts: '2026-02-02T00:00:05Z', data: { usage: { total: 9000 }, assistantTexts: ['hi', 'done'] } },
    { type: 'session.ended', ts: '2026-02-02T00:01:00Z', data: { finalStatus: 'success' } },
  ]);

  // (3) trajectory-ONLY, idle-timeout abandon (no clean end)
  writeJsonl(root, 'sess-traj-idle.trajectory.jsonl', [
    { type: 'session.started', ts: '2026-02-03T00:00:00Z', data: {} },
    { type: 'model.completed', ts: '2026-02-03T00:30:00Z', data: { usage: { total: 500000 }, idleTimedOut: true, finalStatus: 'error' } },
  ]);

  // (4) checkpoint-only base (no plain file): two snapshots, larger is elected
  writeJsonl(root, 'ckpt-base.checkpoint.small.jsonl', [
    { type: 'session', timestamp: '2026-02-04T00:00:00Z' },
    { type: 'message', timestamp: '2026-02-04T00:00:01Z', message: { role: 'user', content: 'small' } },
  ]);
  writeJsonl(root, 'ckpt-base.checkpoint.large.jsonl', [
    { type: 'session', cwd: '/c', timestamp: '2026-02-04T00:00:00Z' },
    { type: 'message', timestamp: '2026-02-04T00:00:01Z', message: { role: 'user', content: 'large-rep-task' } },
    { type: 'message', timestamp: '2026-02-04T00:00:09Z', message: { role: 'assistant', content: 'ok', usage: { totalTokens: 7 }, stopReason: 'stop' } },
  ]);

  // (5) bare with malformed lines interleaved — must skip, not crash
  writeFileSync(
    path.join(root, 'sess-malformed.jsonl'),
    [
      JSON.stringify({ type: 'session', timestamp: '2026-02-05T00:00:00Z' }),
      '{ this is not json',
      JSON.stringify({ type: 'message', timestamp: '2026-02-05T00:00:01Z', message: { role: 'user', content: 'task' } }),
      '',
      JSON.stringify({ type: 'message', timestamp: '2026-02-05T00:00:02Z', message: { role: 'assistant', content: 'done', stopReason: 'stop' } }),
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function build(id: string, override?: string): BuiltSession {
  const b = buildSession(id, root, override);
  expect(b, `expected build for ${id}`).not.toBeNull();
  return b as BuiltSession;
}

// ─── buildSession: nothing parseable ────────────────────────────────────────────

describe('openclaw adapter — buildSession null paths', () => {
  it('returns null when neither bare nor trajectory exists', () => {
    expect(buildSession('does-not-exist', root)).toBeNull();
  });

  it('returns null for an empty bare file', () => {
    writeFileSync(path.join(root, 'empty.jsonl'), '');
    expect(buildSession('empty', root)).toBeNull();
  });
});

// ─── bare content flattening + clean stop ───────────────────────────────────────

describe('openclaw adapter — bare flattening', () => {
  it('captures cwd, label, token usage, and emits a clean end', () => {
    const { timeline, meta } = build('sess-bare-clean');
    expect(meta.cwd).toBe('/work/proj');
    expect(meta.label).toBe('Fix the parser bug');
    expect(meta.cleanStop).toBe(true);
    expect(meta.endedCleanly).toBe(true);
    expect(meta.tokenUsage).toBe(1500); // max per-message total
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(true);
    expect(timeline.endedAt).toBeTruthy();
  });

  it('renders toolCall and toolResult blocks into event content', () => {
    const { timeline } = build('sess-bare-clean');
    const hasToolCall = timeline.events!.some((e) => e.type === 'tool_call');
    const toolResult = timeline.events!.some((e) => e.type === 'tool_result');
    expect(hasToolCall).toBe(true);
    expect(toolResult).toBe(true);
  });

  it('skips malformed JSONL lines without throwing', () => {
    const { meta } = build('sess-malformed');
    expect(meta.label).toBe('task');
    expect(meta.cleanStop).toBe(true);
  });
});

// ─── trajectory-only build ──────────────────────────────────────────────────────

describe('openclaw adapter — trajectory-only sessions', () => {
  it('builds a clean trajectory session with end event + token total', () => {
    const { timeline, meta } = build('sess-traj-ok');
    expect(meta.source).toBe('trajectory');
    expect(meta.endedCleanly).toBe(true);
    expect(meta.trajTokenTotal).toBe(9000);
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(true);
    expect(meta.allAssistantText).toContain('done');
  });

  it('marks an idle-timeout trajectory as aborted with no clean end', () => {
    const { timeline, meta } = build('sess-traj-idle');
    expect(meta.abortedAny).toBe(true);
    expect(meta.endedCleanly).toBe(false);
    expect(meta.trajError).toBe(true);
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(false);
    expect(timeline.endedAt).toBeUndefined();
    expect(timeline.timeoutMs).toBeGreaterThan(0); // budget set below observed runtime
  });
});

// ─── checkpoint collapse ────────────────────────────────────────────────────────

describe('openclaw adapter — checkpoint collapse', () => {
  it('collapses checkpoints to one base id and elects the largest snapshot', () => {
    const descs = listSessions(root);
    const base = descs.find((d) => d.id === 'ckpt-base');
    expect(base, 'expected ckpt-base in listing').toBeTruthy();
    expect(base!.bareOverride).toContain('large');
  });

  it('builds the elected representative via bareOverride', () => {
    const base = listSessions(root).find((d) => d.id === 'ckpt-base')!;
    const built = build('ckpt-base', base.bareOverride);
    expect(built.meta.label).toBe('large-rep-task');
  });

  it('buildAllSessions skips nothing parseable and includes the checkpoint base', () => {
    const ids = buildAllSessions(root).map((s) => s.meta.sessionId);
    expect(ids).toContain('ckpt-base');
    expect(ids).toContain('sess-traj-ok');
  });
});
