/**
 * Tests for the GitHub Action Adapter — Phase 4 CI Integration.
 *
 * Three layers, matching the module split:
 *   1. The pure decision logic (evaluateForAction) against hand-built Scorecard
 *      fixtures — exercises the grade gate, no-data policy, gateWorkers
 *      allow-list, score floor, evidence assembly, and exit code.
 *   2. The projections (toActionOutputs, renderActionSummary) — confirms the
 *      flat string outputs and the Markdown step summary are well-formed.
 *   3. The runner (runActionEval / emitActionResult / runAndEmit) end to end
 *      against a temp transcripts tree, with an in-memory writer so no real
 *      GitHub runner is needed.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateForAction,
  renderActionSummary,
  toActionOutputs,
} from '../src/action/adapter.js';
import {
  createEnvWriter,
  createMemoryWriter,
  emitActionResult,
  runActionEval,
  runAndEmit,
} from '../src/action/runner.js';
import type {
  HealthGrade,
  Scorecard,
  ScorecardTotals,
  ScorecardTrend,
  WorkerScorecard,
} from '../src/monitoring/scorecard.js';

// ─── FIXTURE BUILDERS ────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-10T00:00:00.000Z');

function trend(
  direction: ScorecardTrend['direction'],
  degrading = 0,
  improving = 0,
  severity: ScorecardTrend['severity'] = 'none',
): ScorecardTrend {
  const arrow =
    direction === 'degrading'
      ? '↓'
      : direction === 'improving'
        ? '↑'
        : direction === 'stable'
          ? '→'
          : '·';
  return {
    arrow,
    direction,
    severity,
    degrading,
    improving,
    summary:
      degrading === 0 && improving === 0 ? 'steady' : `${degrading} degrading, ${improving} improving`,
  };
}

type TestCheck = 'completeness' | 'staleness' | 'relevance' | 'keyword-coverage';

interface WorkerSpec {
  worker: string;
  grade: HealthGrade;
  passRate?: number;
  meanScore?: number;
  topFailure?: { check: TestCheck; count: number };
  trend?: ScorecardTrend;
}

/** Build a WorkerScorecard line from a terse spec. */
function workerCard(spec: WorkerSpec): WorkerScorecard {
  const passRate = spec.passRate ?? (spec.grade === 'no-data' ? Number.NaN : 1);
  const meanScore = spec.meanScore ?? (spec.grade === 'no-data' ? Number.NaN : 0.9);
  const failureCategories = spec.topFailure ? [spec.topFailure] : [];
  return {
    worker: spec.worker,
    grade: spec.grade,
    runs: spec.grade === 'no-data' ? 0 : 3,
    passRate,
    meanScore,
    worstScore: spec.grade === 'no-data' ? Number.NaN : meanScore,
    runsWithFailures: spec.topFailure ? spec.topFailure.count : 0,
    totalFailures: spec.topFailure ? spec.topFailure.count : 0,
    failureCategories,
    checks: [],
    trend: spec.trend ?? trend('none'),
    summary: `${spec.worker}: ${spec.grade}`,
  };
}

/** Assemble a Scorecard from worker specs, computing totals consistently. */
function scorecard(specs: WorkerSpec[], window?: { fromDate: string; toDate: string }): Scorecard {
  const workers = specs.map(workerCard);
  const grades: Record<HealthGrade, number> = {
    healthy: 0,
    watch: 0,
    'at-risk': 0,
    critical: 0,
    'no-data': 0,
  };
  let degradingTrends = 0;
  let improvingTrends = 0;
  for (const w of workers) {
    grades[w.grade] += 1;
    degradingTrends += w.trend.degrading;
    improvingTrends += w.trend.improving;
  }
  const scored = workers.filter((w) => Number.isFinite(w.meanScore));
  const meanScore =
    scored.length > 0 ? scored.reduce((a, w) => a + w.meanScore, 0) / scored.length : Number.NaN;
  const totals: ScorecardTotals = {
    workers: workers.length,
    runs: workers.reduce((a, w) => a + w.runs, 0),
    passRate: Number.NaN, // not exercised by the adapter
    meanScore,
    grades,
    degradingTrends,
    improvingTrends,
  };
  return { window, generatedAt: FIXED_NOW.toISOString(), workers, totals };
}

// ─── evaluateForAction: the grade gate ───────────────────────────────────────────

describe('evaluateForAction — grade gate', () => {
  it('passes when every worker is at or above the default gate (at-risk)', () => {
    const card = scorecard([
      { worker: 'builder', grade: 'healthy' },
      { worker: 'gardener', grade: 'watch' },
    ]);
    const ev = evaluateForAction(card);
    expect(ev.passed).toBe(true);
    expect(ev.exitCode).toBe(0);
    expect(ev.failingWorkers).toBe(0);
    expect(ev.evaluatedWorkers).toBe(2);
    expect(ev.gate).toBe('at-risk');
    expect(ev.headline).toContain('PASS');
  });

  it('fails when any worker is worse than the gate', () => {
    const card = scorecard([
      { worker: 'builder', grade: 'healthy' },
      { worker: 'sentinel', grade: 'at-risk', passRate: 0.5, topFailure: { check: 'completeness', count: 2 } },
    ]);
    const ev = evaluateForAction(card); // default gate at-risk → at-risk PASSES
    expect(ev.passed).toBe(true);

    const strict = evaluateForAction(card, { gate: 'watch' }); // now at-risk FAILS
    expect(strict.passed).toBe(false);
    expect(strict.exitCode).toBe(1);
    expect(strict.failingWorkers).toBe(1);
    const v = strict.verdicts.find((x) => x.worker === 'sentinel');
    expect(v?.passed).toBe(false);
    expect(v?.reason).toContain('worse than gate watch');
  });

  it('critical always fails at the default gate', () => {
    const card = scorecard([{ worker: 'builder', grade: 'critical', passRate: 0.2 }]);
    const ev = evaluateForAction(card);
    expect(ev.passed).toBe(false);
    expect(ev.failingWorkers).toBe(1);
    expect(ev.headline).toContain('FAIL');
  });

  it('a lenient gate lets at-risk through; critical fails only when the gate is stricter', () => {
    const card = scorecard([
      { worker: 'a', grade: 'at-risk', passRate: 0.5 },
      { worker: 'b', grade: 'critical', passRate: 0.1 },
    ]);
    // gate=critical is the most lenient: everything at or above critical passes.
    const lenient = evaluateForAction(card, { gate: 'critical' });
    expect(lenient.verdicts.find((v) => v.worker === 'a')?.passed).toBe(true);
    expect(lenient.verdicts.find((v) => v.worker === 'b')?.passed).toBe(true);
    expect(lenient.passed).toBe(true);

    // gate=at-risk (the default) lets at-risk through but fails critical.
    const def = evaluateForAction(card, { gate: 'at-risk' });
    expect(def.verdicts.find((v) => v.worker === 'a')?.passed).toBe(true);
    expect(def.verdicts.find((v) => v.worker === 'b')?.passed).toBe(false);
    expect(def.passed).toBe(false);
  });

  it('a strict gate of healthy fails anything below healthy', () => {
    const card = scorecard([
      { worker: 'a', grade: 'healthy' },
      { worker: 'b', grade: 'watch', passRate: 0.7 },
    ]);
    const ev = evaluateForAction(card, { gate: 'healthy' });
    expect(ev.failingWorkers).toBe(1);
    expect(ev.verdicts.find((v) => v.worker === 'b')?.passed).toBe(false);
  });
});

// ─── evaluateForAction: no-data policy ───────────────────────────────────────────

describe('evaluateForAction — no-data policy', () => {
  const card = scorecard([
    { worker: 'builder', grade: 'healthy' },
    { worker: 'idle', grade: 'no-data' },
  ]);

  it('defaults to passing no-data workers', () => {
    const ev = evaluateForAction(card);
    expect(ev.passed).toBe(true);
    const v = ev.verdicts.find((x) => x.worker === 'idle');
    expect(v?.passed).toBe(true);
    expect(v?.gated).toBe(true);
    expect(v?.reason).toContain('allowed');
    expect(ev.evaluatedWorkers).toBe(2);
  });

  it('no-data: fail makes an idle worker fail the gate', () => {
    const ev = evaluateForAction(card, { noData: 'fail' });
    expect(ev.passed).toBe(false);
    expect(ev.verdicts.find((x) => x.worker === 'idle')?.passed).toBe(false);
    expect(ev.failingWorkers).toBe(1);
  });

  it('no-data: ignore drops the worker entirely', () => {
    const ev = evaluateForAction(card, { noData: 'ignore' });
    expect(ev.passed).toBe(true);
    expect(ev.verdicts.some((x) => x.worker === 'idle')).toBe(false);
    expect(ev.evaluatedWorkers).toBe(1);
  });
});

// ─── evaluateForAction: gateWorkers allow-list ───────────────────────────────────

describe('evaluateForAction — gateWorkers allow-list', () => {
  it('only gates listed workers; others are reported but never fail', () => {
    const card = scorecard([
      { worker: 'owned', grade: 'critical', passRate: 0.1 },
      { worker: 'other', grade: 'critical', passRate: 0.1 },
    ]);
    const ev = evaluateForAction(card, { gateWorkers: ['owned'] });
    expect(ev.passed).toBe(false); // owned is critical
    expect(ev.failingWorkers).toBe(1);

    const otherV = ev.verdicts.find((v) => v.worker === 'other');
    expect(otherV?.gated).toBe(false);
    expect(otherV?.passed).toBe(true);
    expect(otherV?.reason).toBe('not in gate set');
    expect(ev.evaluatedWorkers).toBe(1);
  });

  it('passes when the only gated worker is healthy even if others are critical', () => {
    const card = scorecard([
      { worker: 'owned', grade: 'healthy' },
      { worker: 'other', grade: 'critical', passRate: 0.1 },
    ]);
    const ev = evaluateForAction(card, { gateWorkers: ['owned'] });
    expect(ev.passed).toBe(true);
  });

  it('an empty gateWorkers list gates everything (treated as unset)', () => {
    const card = scorecard([{ worker: 'a', grade: 'critical', passRate: 0.1 }]);
    const ev = evaluateForAction(card, { gateWorkers: [] });
    expect(ev.passed).toBe(false);
    expect(ev.verdicts[0]?.gated).toBe(true);
  });
});

// ─── evaluateForAction: score floor ──────────────────────────────────────────────

describe('evaluateForAction — fleet score floor', () => {
  it('fails when fleet mean score is below the floor even if grades pass', () => {
    const card = scorecard([
      { worker: 'a', grade: 'watch', passRate: 0.7, meanScore: 0.5 },
      { worker: 'b', grade: 'watch', passRate: 0.7, meanScore: 0.5 },
    ]);
    const ev = evaluateForAction(card, { gate: 'watch', minScore: 0.6 });
    expect(ev.passed).toBe(false);
    expect(ev.evidence[0]?.worker).toBe('fleet');
    expect(ev.evidence[0]?.severity).toBe('critical');
    expect(ev.evidence[0]?.message).toContain('below floor 0.6');
    expect(ev.headline).toContain('floor');
  });

  it('passes when the score floor is met', () => {
    const card = scorecard([{ worker: 'a', grade: 'healthy', meanScore: 0.95 }]);
    const ev = evaluateForAction(card, { minScore: 0.6 });
    expect(ev.passed).toBe(true);
  });

  it('a NaN fleet score (no runs) does not trip the score floor', () => {
    const card = scorecard([{ worker: 'idle', grade: 'no-data' }]);
    const ev = evaluateForAction(card, { minScore: 0.9 });
    expect(Number.isNaN(ev.score)).toBe(true);
    expect(ev.passed).toBe(true);
  });
});

// ─── evaluateForAction: evidence ─────────────────────────────────────────────────

describe('evaluateForAction — evidence', () => {
  it('lists failing workers with their top failure and trend', () => {
    const card = scorecard([
      {
        worker: 'sentinel',
        grade: 'at-risk',
        passRate: 0.4,
        topFailure: { check: 'completeness', count: 3 },
        trend: trend('degrading', 2, 0, 'critical'),
      },
    ]);
    const ev = evaluateForAction(card, { gate: 'watch' });
    expect(ev.evidence).toHaveLength(1);
    const e = ev.evidence[0];
    expect(e?.worker).toBe('sentinel');
    expect(e?.message).toContain('at-risk');
    expect(e?.message).toContain('40% pass');
    expect(e?.message).toContain('completeness (3)');
    expect(e?.message).toContain('trend ↓');
  });

  it('includes passing-but-degraded workers as context after failures', () => {
    const card = scorecard([
      { worker: 'bad', grade: 'at-risk', passRate: 0.4 },
      { worker: 'meh', grade: 'watch', passRate: 0.7 },
      { worker: 'good', grade: 'healthy' },
    ]);
    const ev = evaluateForAction(card, { gate: 'watch' }); // bad fails; meh passes (watch); good passes
    expect(ev.evidence[0]?.worker).toBe('bad');
    expect(ev.evidence.some((e) => e.worker === 'meh')).toBe(true);
    expect(ev.evidence.some((e) => e.worker === 'good')).toBe(false);
  });

  it('caps evidence at maxEvidenceItems', () => {
    const specs: WorkerSpec[] = Array.from({ length: 8 }, (_, i) => ({
      worker: `w${i}`,
      grade: 'at-risk' as const,
      passRate: 0.3,
    }));
    const ev = evaluateForAction(scorecard(specs), { gate: 'watch', maxEvidenceItems: 3 });
    expect(ev.evidence).toHaveLength(3);
  });

  it('produces no evidence for an all-healthy fleet', () => {
    const card = scorecard([
      { worker: 'a', grade: 'healthy' },
      { worker: 'b', grade: 'healthy' },
    ]);
    const ev = evaluateForAction(card);
    expect(ev.evidence).toHaveLength(0);
  });
});

// ─── toActionOutputs ─────────────────────────────────────────────────────────────

describe('toActionOutputs', () => {
  it('stringifies a passing evaluation', () => {
    const card = scorecard([{ worker: 'a', grade: 'healthy', meanScore: 0.9123 }]);
    const out = toActionOutputs(evaluateForAction(card));
    expect(out.eval_passed).toBe('true');
    expect(out.eval_score).toBe('0.9123');
    expect(out.eval_gate).toBe('at-risk');
    expect(out.eval_failing_workers).toBe('0');
    expect(out.eval_evaluated_workers).toBe('1');
    expect(out.eval_evidence).toBe('');
    expect(out.eval_headline).toContain('PASS');
  });

  it('stringifies a failing evaluation with evidence joined by semicolons', () => {
    const card = scorecard([
      { worker: 'a', grade: 'critical', passRate: 0.1, topFailure: { check: 'staleness', count: 1 } },
      { worker: 'b', grade: 'at-risk', passRate: 0.4 },
    ]);
    const out = toActionOutputs(evaluateForAction(card, { gate: 'watch' }));
    expect(out.eval_passed).toBe('false');
    expect(out.eval_failing_workers).toBe('2'); // critical + at-risk both fail at watch gate
    expect(out.eval_evidence).toContain('a:');
    expect(out.eval_evidence).toContain(';'); // multiple evidence lines joined
  });

  it('emits empty eval_score when fleet score is NaN', () => {
    const card = scorecard([{ worker: 'idle', grade: 'no-data' }]);
    const out = toActionOutputs(evaluateForAction(card));
    expect(out.eval_score).toBe('');
  });
});

// ─── renderActionSummary ─────────────────────────────────────────────────────────

describe('renderActionSummary', () => {
  it('renders a passing summary with the check icon and embedded scorecard', () => {
    const card = scorecard([{ worker: 'a', grade: 'healthy', meanScore: 0.95 }]);
    const md = renderActionSummary(evaluateForAction(card));
    expect(md).toContain('## ✅ Agent Eval — passed');
    expect(md).toContain('**Gate:** `at-risk`');
    expect(md).toContain('### Scorecard'); // embedded scorecard H1 demoted to H3
    expect(md).not.toMatch(/^# /m); // no top-level H1 leaks through
  });

  it('renders a failing summary with a Findings section', () => {
    const card = scorecard([
      { worker: 'sentinel', grade: 'critical', passRate: 0.2, topFailure: { check: 'completeness', count: 4 } },
    ]);
    const md = renderActionSummary(evaluateForAction(card));
    expect(md).toContain('## ❌ Agent Eval — failed');
    expect(md).toContain('### Findings');
    expect(md).toContain('🔴'); // critical marker
    expect(md).toContain('completeness (4)');
  });

  it('honors a custom title', () => {
    const card = scorecard([{ worker: 'a', grade: 'healthy' }]);
    const md = renderActionSummary(evaluateForAction(card), { title: 'PR Review Quality' });
    expect(md).toContain('## ✅ PR Review Quality — passed');
  });
});

// ─── writers: createMemoryWriter / createEnvWriter ───────────────────────────────

describe('emitActionResult — writers', () => {
  it('writes every output and the summary to a memory writer and returns the exit code', () => {
    const card = scorecard([{ worker: 'a', grade: 'healthy', meanScore: 0.95 }]);
    const ev = evaluateForAction(card);
    const writer = createMemoryWriter();
    const code = emitActionResult(ev, { writer });
    expect(code).toBe(0);

    const names = writer.outputs.map((o) => o.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'eval_passed',
        'eval_score',
        'eval_gate',
        'eval_failing_workers',
        'eval_evaluated_workers',
        'eval_headline',
        'eval_evidence',
      ]),
    );
    expect(writer.outputs.find((o) => o.name === 'eval_passed')?.value).toBe('true');
    expect(writer.summaries).toHaveLength(1);
    expect(writer.summaries[0]).toContain('## ✅ Agent Eval — passed');
  });

  it('returns exit code 1 for a failing evaluation', () => {
    const card = scorecard([{ worker: 'a', grade: 'critical', passRate: 0.1 }]);
    const code = emitActionResult(evaluateForAction(card), { writer: createMemoryWriter() });
    expect(code).toBe(1);
  });

  it('createEnvWriter is a no-op when the env files are unset (local run)', () => {
    const writer = createEnvWriter({});
    // Should not throw even though there is no GITHUB_OUTPUT / GITHUB_STEP_SUMMARY.
    expect(() => {
      writer.setOutput('eval_passed', 'true');
      writer.appendSummary('## hi');
    }).not.toThrow();
  });

  it('createEnvWriter appends outputs and summary to the configured files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-eval-envwriter-'));
    const outputFile = join(dir, 'out.txt');
    const summaryFile = join(dir, 'summary.md');
    writeFileSync(outputFile, '', 'utf8');
    writeFileSync(summaryFile, '', 'utf8');
    try {
      const writer = createEnvWriter({
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      });
      writer.setOutput('eval_passed', 'true');
      writer.setOutput('eval_score', '0.9500');
      // A multiline value must be heredoc-delimited, not a bare name=value.
      writer.setOutput('eval_multi', 'line1\nline2');
      writer.appendSummary('## summary block\n');

      const outText = readFileSync(outputFile, 'utf8');
      expect(outText).toContain('eval_passed=true');
      expect(outText).toContain('eval_score=0.9500');
      expect(outText).toContain('eval_multi<<');
      expect(outText).toContain('line1\nline2');
      expect(outText).not.toContain('eval_multi=line1'); // not the bare form

      const sumText = readFileSync(summaryFile, 'utf8');
      expect(sumText).toContain('## summary block');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── runner: end-to-end against a temp transcripts tree ───────────────────────

const HHMM = ['0900', '1000', '1100', '1200', '1300', '1400', '1500'] as const;

/** Write one transcript markdown file for a worker on a given date. */
function writeTranscript(
  root: string,
  worker: string,
  date: string,
  idx: number,
  opts: { task: string; actions: string; outputs: string; outcome: string; start: string; end: string },
): void {
  const dir = join(root, worker);
  mkdirSync(dir, { recursive: true });
  const hhmm = HHMM[idx % HHMM.length];
  const body = `# ${worker} Run — ${date} ${hhmm} PT

## Task
${opts.task}

## Actions Taken
${opts.actions}

## Key Outputs
${opts.outputs}

## Outcome
${opts.outcome}

## Duration
${opts.start} → ${opts.end}
`;
  writeFileSync(join(dir, `${date}-${hhmm}.md`), body, 'utf8');
}

const WINDOW_DAYS = ['2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'];

describe('runActionEval / runAndEmit — end to end', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-eval-action-'));

    // A healthy worker: substantive, on-task, finished promptly, across days.
    WINDOW_DAYS.forEach((d, i) => {
      writeTranscript(root, 'builder', d, i, {
        task: 'Add a TypeScript utility that reverses a string and write unit tests for it',
        actions:
          '1. Implemented reverseString in src/strings.ts with a clear return type. ' +
          '2. Added Vitest unit tests covering empty, ascii, and unicode inputs. ' +
          '3. Ran the build and the full test suite; everything passes locally.',
        outputs:
          'Committed the reverseString utility and its tests. The function reverses a ' +
          'string by unicode code point and the tests cover the documented edge cases.',
        outcome: 'pass',
        start: `${d} 10:00 PT`,
        end: `${d} 10:18 PT`,
      });
    });

    // A flaky worker: empty/stub output, abandoned almost immediately, repeatedly.
    WINDOW_DAYS.forEach((d, i) => {
      writeTranscript(root, 'flaky', d, i, {
        task: 'Investigate the failing integration test and propose a concrete fix',
        actions: 'Started looking.',
        outputs: 'TODO',
        outcome: 'partial',
        start: `${d} 09:00 PT`,
        end: `${d} 09:01 PT`,
      });
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a scorecard from transcripts and evaluates both workers', () => {
    const { evaluation, build, outputs, summary } = runActionEval(root, {
      window: 10,
      now: FIXED_NOW,
      gate: 'watch',
    });
    expect(build.scored).toBeGreaterThan(0);
    expect(build.failed).toBe(0);

    const flaky = evaluation.verdicts.find((v) => v.worker === 'flaky');
    const builder = evaluation.verdicts.find((v) => v.worker === 'builder');
    expect(flaky).toBeDefined();
    expect(builder).toBeDefined();

    // The flaky worker is the weakest line: it should not outrank the builder.
    expect(flaky?.passRate ?? 1).toBeLessThanOrEqual(builder?.passRate ?? 0);

    // Outputs and summary are wired from the same evaluation.
    expect(outputs.eval_passed).toBe(String(evaluation.passed));
    expect(summary).toContain(evaluation.passed ? 'passed' : 'failed');
    expect(summary).toContain('### Scorecard');
  });

  it('does NOT persist scores.jsonl by default (a report must not mutate the record)', () => {
    runActionEval(root, { window: 10, now: FIXED_NOW });
    expect(() => readFileSync(join(root, 'builder', 'scores.jsonl'), 'utf8')).toThrow();
    expect(() => readFileSync(join(root, 'flaky', 'scores.jsonl'), 'utf8')).toThrow();
  });

  it('gateWorkers can scope the gate to a single worker end to end', () => {
    const onlyBuilder = runActionEval(root, {
      window: 10,
      now: FIXED_NOW,
      gate: 'healthy',
      gateWorkers: ['builder'],
    });
    // 'flaky' may be ugly, but it is not gated, so only builder decides pass/fail.
    const flakyV = onlyBuilder.evaluation.verdicts.find((v) => v.worker === 'flaky');
    expect(flakyV?.gated).toBe(false);
    expect(onlyBuilder.evaluation.evaluatedWorkers).toBe(1);
  });

  it('runAndEmit writes to the provided writer and returns the exit code', () => {
    const writer = createMemoryWriter();
    const { result, exitCode } = runAndEmit(root, {
      window: 10,
      now: FIXED_NOW,
      gate: 'watch',
      writer,
    });
    expect(exitCode).toBe(result.evaluation.exitCode);
    expect(writer.outputs.length).toBeGreaterThan(0);
    expect(writer.summaries).toHaveLength(1);
    expect(writer.summaries[0]).toContain('Agent Eval');
  });

  it('an empty transcripts root evaluates to a clean, passing, no-data result', () => {
    const empty = mkdtempSync(join(tmpdir(), 'agent-eval-empty-'));
    try {
      const { evaluation } = runActionEval(empty, { now: FIXED_NOW });
      expect(evaluation.passed).toBe(true);
      expect(evaluation.evaluatedWorkers).toBe(0);
      expect(evaluation.verdicts).toHaveLength(0);
      expect(evaluation.headline).toContain('no workers to gate');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ─── package-root API smoke ────────────────────────────────────────────

describe('action API — package-root exports', () => {
  it('re-exports the action surface from the package root', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.evaluateForAction).toBe('function');
    expect(typeof mod.toActionOutputs).toBe('function');
    expect(typeof mod.renderActionSummary).toBe('function');
    expect(typeof mod.runActionEval).toBe('function');
    expect(typeof mod.emitActionResult).toBe('function');
    expect(typeof mod.runAndEmit).toBe('function');
    expect(typeof mod.createEnvWriter).toBe('function');
    expect(typeof mod.createMemoryWriter).toBe('function');
  });

  it('re-exports the action surface from the monitoring-adjacent action barrel', async () => {
    const mod = await import('../src/action/index.js');
    expect(typeof mod.evaluateForAction).toBe('function');
    expect(typeof mod.runActionEval).toBe('function');
  });
});
