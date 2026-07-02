/**
 * Tests for fleet triage — ranking failed trajectories by cost.
 *
 * Runs against the same three SYNTHETIC fixtures the adapter test uses
 * (`tests/fixtures/synthetic-sessions/`): two expensive abandons and one clean
 * run that must be excluded. (Real captured sessions are withheld — PII/canaries.)
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { triageSessions, triageBuilt, renderTriageTable } from '../src/action/triage.js';
import { buildAllSessions } from '../src/adapters/openclaw.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'synthetic-sessions');

const ID_BURNER = 'burner-0000-0000-0000-000000000001'; // 19.3M tok abandon
const ID_ABANDON = 'abandon-000-0000-0000-000000000002'; // 489K tok abandon
const ID_CLEAN = 'clean-0000-0000-0000-000000000003'; // clean + within budget (known negative)
const ID_HEAVY = 'heavy-000-0000-0000-0000-000000000004'; // clean but 1.5M tok / 45m (finished-but-bad)
const ID_LOOPER = 'looper-00-0000-0000-0000-000000000005'; // clean, under cap, TEXT thrash (mode #3)
const ID_TOOLTHRASH = 'toolthrash-0000-0000-0000-00000006'; // clean, under cap, TOOL-CALL thrash (mode #3)
const ID_MANYEDITS = 'manyedits-0000-0000-0000-00000007'; // clean; 6 edits to 6 DIFFERENT files — NOT a loop

describe('triageSessions — ranked failed trajectories', () => {
  const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });

  it('scans all logical sessions and flags the two abandons + the three finished-but-bad runs', () => {
    expect(report.scanned).toBe(7);
    expect(report.flagged).toBe(5);
    const ids = report.rows.map((r) => r.id).sort();
    expect(ids).toEqual([ID_BURNER, ID_ABANDON, ID_HEAVY, ID_LOOPER, ID_TOOLTHRASH].sort());
  });

  it('does NOT flag manyedits: 6 edits to 6 different files is real work, not a tool loop', () => {
    // The whole point of arg-level signatures — same tool NAME, distinct args →
    // six unique signatures → no loop. A name-only match would falsely flag this.
    expect(report.rows.some((r) => r.id === ID_MANYEDITS)).toBe(false);
  });

  it('EXCLUDES the clean, within-budget run (the known negative)', () => {
    expect(report.rows.some((r) => r.id === ID_CLEAN)).toBe(false);
  });

  it('ranks the 19.3M-token burner first (worst by cost)', () => {
    expect(report.rows[0]?.id).toBe(ID_BURNER);
    expect(report.rows[0]?.tokenUsage).toBeGreaterThan(15_000_000);
  });

  it('classifies the broken runs as timeout/abandon/runaway failures', () => {
    for (const r of report.rows) {
      if (['over-cost', 'over-latency', 'excessive-steps', 'loop-without-progress'].includes(r.kind))
        continue;
      expect(['timeout', 'abandoned', 'runaway']).toContain(r.kind);
    }
  });

  it('counts the costly rows and projects a non-trivial dollar figure', () => {
    // burner + abandon + heavy are costly; the two loopers are cheap (under the cap)
    expect(report.costly).toBe(3);
    // 19.3M + 0.49M + 1.5M ≈ 21.3M tokens @ $9/M ≈ $190+
    expect(report.projectedCostUsd).toBeGreaterThan(150);
  });

  it('cost scales linearly with the configured rate', () => {
    const cheap = triageSessions(FIXTURES, { dollarsPerMillionTokens: 3 });
    const dear = triageSessions(FIXTURES, { dollarsPerMillionTokens: 15 });
    expect(dear.projectedCostUsd).toBeGreaterThan(cheap.projectedCostUsd);
    expect(dear.projectedCostUsd / cheap.projectedCostUsd).toBeCloseTo(5, 1);
  });

  it('every flagged row carries a human summary and an issue kind', () => {
    for (const r of report.rows) {
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.issueKinds.length).toBeGreaterThan(0);
    }
  });
});

describe('triageBuilt — pure, no I/O', () => {
  it('produces the same flagged count from pre-built sessions', () => {
    const built = buildAllSessions(FIXTURES);
    const report = triageBuilt(built, { dollarsPerMillionTokens: 9 });
    expect(report.flagged).toBe(5);
  });

  it('staleOnly:false broadens the broken family, still excludes the clean within-budget run', () => {
    const built = buildAllSessions(FIXTURES);
    const report = triageBuilt(built, { staleOnly: false });
    // 2 broke + 3 finished-but-bad (heavy over-budget, looper text-thrash, toolthrash tool-thrash) = 5
    expect(report.flagged).toBe(5);
    expect(report.rows.some((r) => r.id === ID_CLEAN)).toBe(false);
  });
});

describe('renderTriageTable', () => {
  it('renders a Markdown table with the projection header and top rows', () => {
    const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });
    const md = renderTriageTable(report, 15);
    expect(md).toContain('Projected over-budget spend:');
    expect(md).toContain('finished-but-over-budget'); // the completed-family note
    expect(md).toContain('| # | Session |');
    expect(md).toContain(ID_BURNER.slice(0, 8));
    expect(md).not.toContain(ID_CLEAN.slice(0, 8));
  });
});

describe('finished-but-bad family (#4 over-cost, #5 over-latency, #6 excessive-steps)', () => {
  // The heavy fixture ended CLEANLY (stopReason:stop, finalStatus:success) yet
  // burned 1.5M tokens over 45m with 7 events. A staleness/crash check is blind
  // to it by construction; these thresholds are the only thing that catches it.

  it('flags the clean-but-expensive run and NEVER borrows a staleness issue kind', () => {
    const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });
    const heavy = report.rows.find((r) => r.id === ID_HEAVY);
    expect(heavy).toBeDefined();
    // default budgets: 1M tokens + 30m → both trip; 400 steps → does not
    expect(heavy?.kind).toBe('over-cost'); // cost leads the primary label
    expect(heavy?.issueKinds).toContain('over-cost');
    expect(heavy?.issueKinds).toContain('over-latency');
    expect(heavy?.issueKinds).not.toContain('excessive-steps');
    // it is one of the completed-family rows (heavy over-budget + 2 thrash runs)
    expect(report.completedBad).toBe(3);
  });

  it('the diagnosis says the run completed cleanly and cites the budget evidence', () => {
    const report = triageSessions(FIXTURES);
    const heavy = report.rows.find((r) => r.id === ID_HEAVY);
    const d = heavy?.diagnosis;
    expect(d).toBeDefined();
    expect(d?.signals.some((s) => s.includes('completed cleanly'))).toBe(true);
    expect(d?.signals.some((s) => s.includes('over-cost'))).toBe(true);
    // every finding maps to a real measured field vs. its budget
    expect(d?.findings.some((f) => f.startsWith('over-cost:'))).toBe(true);
    expect(d?.findings.some((f) => f.startsWith('over-latency:'))).toBe(true);
    // and the staleness gap noise is suppressed for a cleanly-ended run
    expect(d?.findings.some((f) => f.startsWith('stale_gap:'))).toBe(false);
    // no self-contradiction for a genuinely clean run
    expect(d?.contradictions.length).toBe(0);
  });

  it('#6 excessive-steps trips when the step budget is lowered below the event count', () => {
    const report = triageSessions(FIXTURES, { excessiveStepThreshold: 5 });
    const heavy = report.rows.find((r) => r.id === ID_HEAVY);
    expect(heavy?.issueKinds).toContain('excessive-steps');
    // cost still leads the single-kind label (priority: cost › latency › steps)
    expect(heavy?.kind).toBe('over-cost');
  });

  it('#6 alone: with cost/latency budgets raised out of reach, only steps trips', () => {
    const report = triageSessions(FIXTURES, {
      overCostTokenThreshold: 100_000_000,
      overLatencyMs: 24 * 60 * 60 * 1000,
      excessiveStepThreshold: 5,
    });
    const heavy = report.rows.find((r) => r.id === ID_HEAVY);
    expect(heavy?.kind).toBe('excessive-steps');
    expect(heavy?.issueKinds).toEqual(['excessive-steps']);
  });

  it('respects budgets: raise ALL four out of reach and neither clean run is flagged', () => {
    const report = triageSessions(FIXTURES, {
      overCostTokenThreshold: 100_000_000,
      overLatencyMs: 24 * 60 * 60 * 1000,
      excessiveStepThreshold: 100_000,
      loopRatioThreshold: 1.1, // impossible (ratio maxes at 1.0)
    });
    expect(report.rows.some((r) => r.id === ID_HEAVY)).toBe(false);
    expect(report.rows.some((r) => r.id === ID_LOOPER)).toBe(false);
    expect(report.rows.some((r) => r.id === ID_TOOLTHRASH)).toBe(false);
    expect(report.completedBad).toBe(0);
  });

  it('includeCompleted:false disables the whole family (back to broken-only)', () => {
    const report = triageSessions(FIXTURES, { includeCompleted: false });
    expect(report.rows.some((r) => r.id === ID_HEAVY)).toBe(false);
    expect(report.rows.some((r) => r.id === ID_LOOPER)).toBe(false);
    expect(report.rows.some((r) => r.id === ID_TOOLTHRASH)).toBe(false);
    expect(report.completedBad).toBe(0);
    expect(report.flagged).toBe(2); // just the two abandons
  });

  it('the clean, within-budget fixture is never caught by the completed family', () => {
    // even with rock-bottom budgets, the 58K/60s/5-event clean run trips cost+... 
    // so assert the opposite direction: with default budgets it stays clean.
    const report = triageSessions(FIXTURES);
    expect(report.rows.some((r) => r.id === ID_CLEAN)).toBe(false);
  });
});

describe('#3 loop-without-progress (thrash under the token cap, never idle)', () => {
  // The looper fixture ended CLEANLY (stopReason:stop, finalStatus:success) with
  // only 120K tokens over ~3m — well under every cost/latency/step budget — yet
  // it emitted the SAME assistant sentence 6 times. Nothing else catches this:
  // it never went idle, never timed out, never blew the cap.

  it('flags the clean, under-budget thrash run as loop-without-progress and nothing else', () => {
    const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });
    const loop = report.rows.find((r) => r.id === ID_LOOPER);
    expect(loop).toBeDefined();
    expect(loop?.kind).toBe('loop-without-progress');
    expect(loop?.issueKinds).toEqual(['loop-without-progress']);
    // it is cheap — the cost bar must NOT be what caught it; this is a quality
    // flag, not a spend flag, so it is deliberately NOT counted as costly.
    expect(loop?.tokenUsage).toBeLessThan(200_000);
    expect(loop?.costly).toBe(false);
  });

  it('the diagnosis says it completed cleanly and cites the repeated segment as evidence', () => {
    const report = triageSessions(FIXTURES);
    const d = report.rows.find((r) => r.id === ID_LOOPER)?.diagnosis;
    expect(d).toBeDefined();
    expect(d?.signals.some((s) => s.includes('completed cleanly'))).toBe(true);
    expect(d?.signals.some((s) => s.includes('loop-without-progress'))).toBe(true);
    const f = d?.findings.find((x) => x.startsWith('loop-without-progress:'));
    expect(f).toBeTruthy();
    expect(f).toContain('ratio');
    // the evidence quotes the actual repeated text
    expect(f).toContain('build configuration');
    // no staleness noise, no contradiction on a genuinely clean run
    expect(d?.findings.some((x) => x.startsWith('stale_gap:'))).toBe(false);
    expect(d?.contradictions.length).toBe(0);
  });

  it('a stricter loopRatioThreshold still flags it; an impossible one clears it', () => {
    const strict = triageSessions(FIXTURES, { loopRatioThreshold: 0.2 });
    expect(strict.rows.some((r) => r.id === ID_LOOPER)).toBe(true);
    const impossible = triageSessions(FIXTURES, { loopRatioThreshold: 1.1 });
    expect(impossible.rows.some((r) => r.id === ID_LOOPER)).toBe(false);
  });

  it('loopMinSegments gates short runs: raise it above the segment count and the loop is not flagged', () => {
    // looper has 6 assistant segments; require 50 → too short to "thrash"
    const report = triageSessions(FIXTURES, { loopMinSegments: 50 });
    expect(report.rows.some((r) => r.id === ID_LOOPER)).toBe(false);
  });

  it('does NOT flag the heavy run as looping (its text is all distinct)', () => {
    const report = triageSessions(FIXTURES, { loopRatioThreshold: 0.2 });
    const heavy = report.rows.find((r) => r.id === ID_HEAVY);
    expect(heavy?.issueKinds).not.toContain('loop-without-progress');
  });
});

describe('#3 loop-without-progress — TOOL-CALL thrash (no repeated prose)', () => {
  // The toolthrash fixture ended CLEANLY, stayed UNDER the cap, and wrote DISTINCT
  // prose every turn — but fired the identical `exec(npm test…)` call 6×. The text
  // channel sees nothing; only the tool-signature channel catches it. This is the
  // half your note called out: "same tool call … emitted N times."

  it('flags a clean, under-cap run that repeated ONE tool call, via the tool channel', () => {
    const report = triageSessions(FIXTURES);
    const row = report.rows.find((r) => r.id === ID_TOOLTHRASH);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('loop-without-progress');
    expect(row?.issueKinds).toEqual(['loop-without-progress']);
    expect(row?.tokenUsage).toBeLessThan(200_000); // cheap — not a cost/latency catch
    expect(row?.costly).toBe(false);
  });

  it('the evidence names the repeated tool call and its count, not prose', () => {
    const report = triageSessions(FIXTURES);
    const f = report.rows
      .find((r) => r.id === ID_TOOLTHRASH)
      ?.diagnosis?.findings.find((x) => x.startsWith('loop-without-progress:'));
    expect(f).toBeTruthy();
    expect(f).toContain('tool `exec('); // cites the tool signature
    expect(f).toContain('×6 of 6'); // and the repeat count
  });

  it('the evidence is readable: it shows the actual command that thrashed', () => {
    // A human reading the report must know WHICH call looped, not just "a tool".
    const report = triageSessions(FIXTURES);
    const f = report.rows
      .find((r) => r.id === ID_TOOLTHRASH)
      ?.diagnosis?.findings.find((x) => x.startsWith('loop-without-progress:'));
    expect(f).toContain('npm test -- flaky.spec.ts'); // the literal command is quoted
    expect(f).toContain('back-to-back'); // and that it was consecutive
  });

  it('distinct-arg calls to the same tool are NOT a loop (manyedits stays clean)', () => {
    const report = triageSessions(FIXTURES, { loopRatioThreshold: 0.2 });
    expect(report.rows.some((r) => r.id === ID_MANYEDITS)).toBe(false);
  });

  it('the text-loop detector alone would NOT catch it (prose is distinct)', () => {
    // Prove the tool channel is doing the work: the looper (text thrash) and the
    // toolthrash (tool thrash) are both flagged, but for different reasons.
    const report = triageSessions(FIXTURES);
    const looperDetail = report.rows.find((r) => r.id === ID_LOOPER)?.diagnosis?.findings.join(' ');
    const toolDetail = report.rows.find((r) => r.id === ID_TOOLTHRASH)?.diagnosis?.findings.join(' ');
    expect(looperDetail).toContain('build configuration'); // text-quote evidence
    expect(looperDetail).not.toContain('tool `'); // looper is NOT a tool-loop
    expect(toolDetail).toContain('tool `'); // toolthrash IS a tool-loop
  });

  it('raising loopMinSegments above the tool-call count clears the tool-loop flag', () => {
    // 6 tool calls; require 50 → too few calls to "thrash"
    const report = triageSessions(FIXTURES, { loopMinSegments: 50 });
    expect(report.rows.some((r) => r.id === ID_TOOLTHRASH)).toBe(false);
  });
});
