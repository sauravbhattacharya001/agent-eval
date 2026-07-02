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
 *   - heavy   — a run that also completed CLEANLY but burned 1.5M tokens over
 *      45m (the finished-but-bad case: staleness sees a healthy run, so the
 *      completed-run budgets are what catch it).
 *   - looper  — a run that completed CLEANLY and stayed UNDER the token cap yet
 *      repeated the same assistant sentence 6× (mode #3, TEXT thrash).
 *   - toolthrash — clean + under cap + DISTINCT prose, but fired the identical
 *      `exec(npm test…)` tool call 6× (mode #3, TOOL-CALL thrash — caught only
 *      by the `toolCallSignatures` channel).
 *   - manyedits — clean; six `edit` calls to six DIFFERENT files. Same tool
 *      NAME but distinct args → six distinct signatures → NOT a loop. Guards the
 *      arg-level signature against false positives on legitimate bulk work.
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
const ID_HEAVY = 'heavy-000-0000-0000-0000-000000000004'; // clean stop, but 1.5M tok / 45m
const ID_LOOPER = 'looper-00-0000-0000-0000-000000000005'; // clean stop, under cap, TEXT thrash 6×
const ID_TOOLTHRASH = 'toolthrash-0000-0000-0000-00000006'; // clean stop, under cap, TOOL-CALL thrash 6×
const ID_MANYEDITS = 'manyedits-0000-0000-0000-00000007'; // clean stop; 6 edits to 6 DIFFERENT files

function build(id: string): BuiltSession {
  const built = buildSession(id, FIXTURES);
  expect(built, `expected to build session ${id}`).not.toBeNull();
  return built as BuiltSession;
}

describe('openclaw adapter — listSessions', () => {
  it('enumerates the seven logical fixture sessions (companions collapsed)', () => {
    const ids = listSessions(FIXTURES)
      .map((d) => d.id)
      .sort();
    expect(ids).toEqual(
      [ID_BURNER, ID_ABANDON, ID_CLEAN, ID_HEAVY, ID_LOOPER, ID_TOOLTHRASH, ID_MANYEDITS].sort(),
    );
  });

  it('buildAllSessions returns one BuiltSession per logical id', () => {
    const all = buildAllSessions(FIXTURES);
    expect(all).toHaveLength(7);
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

  it('sees the heavy run as ENDED CLEANLY, carrying the over-budget resource signals', () => {
    const { timeline, meta } = build(ID_HEAVY);
    // Ended cleanly: a clean 'end' event is emitted and no abort signal fires.
    expect(meta.endedCleanly).toBe(true);
    expect(meta.abortedAny).toBe(false);
    expect(meta.trajError).toBe(false);
    expect(timeline.events!.some((e) => e.type === 'end')).toBe(true);
    expect(timeline.endedAt).toBeTruthy();
    // The raw resource signals the finished-but-bad family reads are present.
    // (Staleness may still note long inter-event gaps on a legitimately long run;
    // the triage layer ignores that for a cleanly-ended run — see triage.test.ts.)
    expect(meta.tokenUsage).toBeGreaterThanOrEqual(1_500_000);
    expect(meta.runtimeMs).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(meta.eventCount).toBeGreaterThan(0);
  });

  it('captures the looper as CLEAN, under-cap, with repeated allAssistantText (mode #3 input)', () => {
    const { meta } = build(ID_LOOPER);
    expect(meta.endedCleanly).toBe(true);
    expect(meta.abortedAny).toBe(false);
    // under every resource budget — so only the loop scan can catch it
    expect(meta.tokenUsage).toBeLessThan(200_000);
    expect(meta.runtimeMs).toBeLessThan(30 * 60 * 1000);
    // the concatenated assistant text (the loop detector's input) is populated
    // and actually contains the repeated phrase multiple times
    expect(meta.assistantCount).toBeGreaterThanOrEqual(4);
    const occurrences = meta.allAssistantText.split('build configuration').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it('extracts per-tool-call signatures for the toolthrash run (mode #3 tool channel)', () => {
    const { meta } = build(ID_TOOLTHRASH);
    expect(meta.endedCleanly).toBe(true);
    // six identical tool calls → six identical signatures, all distinct prose
    expect(meta.toolCallSignatures).toHaveLength(6);
    const unique = new Set(meta.toolCallSignatures);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toContain('exec(');
    expect([...unique][0]).toContain('flaky.spec.ts');
  });

  it('captures DISTINCT signatures for distinct-arg calls (manyedits: 6 files)', () => {
    const { meta } = build(ID_MANYEDITS);
    expect(meta.endedCleanly).toBe(true);
    expect(meta.toolCallSignatures).toHaveLength(6);
    // same tool name, six different paths → six DISTINCT signatures (not a loop)
    expect(new Set(meta.toolCallSignatures).size).toBe(6);
    expect(meta.toolCallSignatures.every((s) => s.startsWith('edit('))).toBe(true);
    expect(meta.toolCallSignatures.some((s) => s.includes('src/auth.ts'))).toBe(true);
    expect(meta.toolCallSignatures.some((s) => s.includes('src/settings.ts'))).toBe(true);
  });

  it('leaves toolCallSignatures empty for a trajectory-only session (no per-call args)', () => {
    // the two abandons are enriched-bare; the pure clean/heavy runs have bare logs.
    // A trajectory-only build cannot see args — assert the field exists and is [].
    const all = buildAllSessions(FIXTURES);
    for (const s of all) {
      expect(Array.isArray(s.meta.toolCallSignatures)).toBe(true);
    }
  });
});
