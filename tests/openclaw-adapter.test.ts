/**
 * Tests for the OpenClaw session adapter.
 *
 * These run against three SYNTHETIC session fixtures
 * (`tests/fixtures/synthetic-sessions/`) that reproduce the structural shapes
 * the adapter must handle. They are hand-authored stand-ins — the original
 * validation used real captured fleet sessions, but those transcripts contain
 * PII / DLP canaries and are intentionally not published (see .gitignore).
 *
 *   - burner  — a 19.3M-token idle-timeout ABANDON (worst-case runaway).
 *   - abandon — a 489K-token idle-timeout abandon that produced nothing.
 *   - clean   — a run that completed CLEANLY (the known negative; a behavioral
 *      gate must NOT flag it).
 *
 * The contract under test: the adapter builds a `RunTimeline` whose end-state and
 * token signals make `analyzeStaleness` reach the correct verdict for each.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSession,
  buildAllSessions,
  listSessions,
  type BuiltSession,
} from '../src/adapters/openclaw.js';
import { analyzeStaleness } from '../src/checks/staleness.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synthetic-sessions');

const ID_BURNER = 'burner-0000-0000-0000-000000000001'; // 19.3M tok, idle-timeout abandon
const ID_ABANDON = 'abandon-000-0000-0000-000000000002'; // 489K tok, idle-timeout abandon
const ID_CLEAN = 'clean-0000-0000-0000-000000000003'; // clean stop (known negative)

function build(id: string): BuiltSession {
  const built = buildSession(id, FIXTURES);
  expect(built, `expected to build session ${id}`).not.toBeNull();
  return built as BuiltSession;
}

describe('openclaw adapter — listSessions', () => {
  it('enumerates the three logical fixture sessions (companions collapsed)', () => {
    const ids = listSessions(FIXTURES)
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual([ID_BURNER, ID_ABANDON, ID_CLEAN].sort());
  });

  it('buildAllSessions returns one BuiltSession per logical id', () => {
    const all = buildAllSessions(FIXTURES);
    expect(all).toHaveLength(3);
    for (const s of all) {
      expect(s.timeline.startedAt).toBeTruthy();
      expect(Array.isArray(s.timeline.events)).toBe(true);
    }
  });
});

describe('openclaw adapter — timeline shape', () => {
  it('produces a RunTimeline with ordered events and a startedAt', () => {
    const { timeline } = build(ID_BURNER);
    expect(timeline.startedAt).toBeTruthy();
    expect(timeline.events!.length).toBeGreaterThan(0);
  });

  it('captures token usage from the trajectory companion', () => {
    expect(build(ID_BURNER).meta.tokenUsage).toBeGreaterThan(15_000_000);
    expect(build(ID_ABANDON).meta.tokenUsage).toBeGreaterThan(400_000);
  });
});

describe('openclaw adapter — staleness verdict on the fixtures', () => {
  it('flags the 19.3M-token burner as stale/abandoned with no clean end', () => {
    const { timeline, meta } = build(ID_BURNER);
    expect(meta.abortedAny).toBe(true);
    expect(meta.endedCleanly).toBe(false);
    // No clean 'end' event should be emitted for an abandoned run.
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(false);
    expect(timeline.endedAt).toBeUndefined();

    const result = analyzeStaleness(timeline);
    expect(result.isStale).toBe(true);
    expect(result.issues.some((i) => i.kind === 'no_end' || i.kind === 'abandoned' || i.kind === 'timeout')).toBe(true);
  });

  it('flags the 489K-token abandon as stale', () => {
    const { timeline, meta } = build(ID_ABANDON);
    expect(meta.abortedAny).toBe(true);
    expect(meta.endedCleanly).toBe(false);
    expect(analyzeStaleness(timeline).isStale).toBe(true);
  });

  it('does NOT flag the clean run (known negative)', () => {
    const { meta } = build(ID_CLEAN);
    expect(meta.endedCleanly).toBe(true);
    expect(meta.abortedAny).toBe(false);
    expect(meta.trajError).toBe(false);
  });
});
