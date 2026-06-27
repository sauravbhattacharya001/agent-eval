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
const ID_CLEAN = 'clean-0000-0000-0000-000000000003'; // clean (known negative)

describe('triageSessions — ranked failed trajectories', () => {
  const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });

  it('scans all logical sessions and flags exactly the two abandons', () => {
    expect(report.scanned).toBe(3);
    expect(report.flagged).toBe(2);
    const ids = report.rows.map((r) => r.id).sort();
    expect(ids).toEqual([ID_BURNER, ID_ABANDON].sort());
  });

  it('EXCLUDES the clean run (the known negative)', () => {
    expect(report.rows.some((r) => r.id === ID_CLEAN)).toBe(false);
  });

  it('ranks the 19.3M-token burner first (worst by cost)', () => {
    expect(report.rows[0]?.id).toBe(ID_BURNER);
    expect(report.rows[0]?.tokenUsage).toBeGreaterThan(15_000_000);
  });

  it('classifies the burners as timeout/abandon failures', () => {
    for (const r of report.rows) {
      expect(['timeout', 'abandoned', 'runaway']).toContain(r.kind);
    }
  });

  it('counts both as costly and projects a non-trivial dollar figure', () => {
    expect(report.costly).toBe(2);
    // 19.3M + 0.49M ≈ 19.8M tokens @ $9/M ≈ $178+
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
    expect(report.flagged).toBe(2);
  });

  it('staleOnly:false broadens to any non-clean run (still excludes the clean one)', () => {
    const built = buildAllSessions(FIXTURES);
    const report = triageBuilt(built, { staleOnly: false });
    expect(report.flagged).toBe(2);
    expect(report.rows.some((r) => r.id === ID_CLEAN)).toBe(false);
  });
});

describe('renderTriageTable', () => {
  it('renders a Markdown table with the projection header and top rows', () => {
    const report = triageSessions(FIXTURES, { dollarsPerMillionTokens: 9 });
    const md = renderTriageTable(report, 15);
    expect(md).toContain('Projected waste:');
    expect(md).toContain('| # | Session |');
    expect(md).toContain(ID_BURNER.slice(0, 8));
    expect(md).not.toContain(ID_CLEAN.slice(0, 8));
  });
});
