/**
 * End-to-end worked example — the full claude-code-action eval seam, offline.
 *
 * `cca-execution.test.ts` pins the *parser* (turns → `{prompt, output, timeline}`)
 * and `threshold-validation.test.ts` pins the *gate outcome* on the default
 * thresholds. Neither drives the seam all the way to the **runner I/O** a real
 * Action step performs at cleanup time. This suite closes that gap with the
 * exact call chain the eventual contribution to `claude-code-action` will run,
 * end to end and with no AI / network / real runner:
 *
 *     readFileSync(execution_file)            // the on-disk claude-execution-output.json
 *       → extractCcaRunFromFile / parse       // parse turns → eval inputs
 *       → evaluateCiRun({ ...defaults })       // Tier 1+2 completeness + staleness
 *       → emitActionResult(ev, { writer })     // write $GITHUB_OUTPUT + $GITHUB_STEP_SUMMARY, return exit code
 *
 * The assertions are on the two things a downstream workflow actually consumes
 * and a maintainer actually reads:
 *
 *   1. **Action outputs** — the flat `eval_*` map a later `if:` gates on
 *      (`eval_passed`, `eval_score`, `eval_evidence`, …), captured via the
 *      in-memory {@link MemoryWriter} (and, for the real env writer, the heredoc
 *      framing a multiline value needs in `$GITHUB_OUTPUT`).
 *   2. **Rendered step summary** — the Markdown block posted to the Action run
 *      page: the verdict heading, the per-check **Findings** reasons spliced in
 *      by `evaluateCiRun` (`claude-review/staleness: no-op: …`), and the embedded
 *      per-worker scorecard table.
 *
 * This is the "one offline test that demos the whole integration" the PR needs:
 * a real execution file in, a gated pass/fail + human-readable summary out.
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  extractCcaRunFromFile,
  parseCcaExecutionLog,
  extractCcaRun,
} from '../src/action/cca-execution.js';
import { evaluateCiRun } from '../src/action/ci-run.js';
import {
  emitActionResult,
  createMemoryWriter,
  createEnvWriter,
} from '../src/action/runner.js';
import type { ActionEvaluation } from '../src/action/adapter.js';

// ─── FIXTURES ──────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cca-runs');

/** Read one execution-file fixture's raw JSON text (as the action's cleanup reads it). */
function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8');
}

// The PR-review prompt the action was given. The execution file does NOT carry
// the prompt (the action passes it via a prompt file), so the worked example
// supplies it exactly as the Mode-A entry point would (AGENT_PROMPT).
const REVIEW_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation for
correctness, verify the Redis cache key expiry is set, and flag any race
conditions in the concurrent request handling.`;

const WORKER = 'claude-review';
// Fixed clock so the synthetic run-id / timestamps are deterministic.
const FIXED_NOW = new Date('2026-06-13T12:00:00.000Z');

/**
 * The exact production chain a CI step runs at cleanup, end to end: read the
 * execution file, parse + extract, evaluate with default thresholds, then emit
 * to a captured writer. Returns everything a caller can assert on.
 */
function runWorkedExample(fixtureName: string): {
  evaluation: ActionEvaluation;
  outputs: Record<string, string>;
  summary: string;
  exitCode: 0 | 1;
} {
  // 1. Read the on-disk execution file (the bytes the agent's harness wrote).
  const raw = loadFixture(fixtureName);

  // 2. Parse the turn stream into eval inputs.
  const run = extractCcaRunFromFile(raw, { prompt: REVIEW_PROMPT });

  // 3. Score the single run (Tier 1 completeness + staleness), default
  //    thresholds, only the `watch` gate the Mode-A example sets.
  const { evaluation } = evaluateCiRun({
    prompt: run.prompt,
    output: run.output,
    timeline: run.timeline,
    worker: WORKER,
    now: FIXED_NOW,
    action: { gate: 'watch' },
  });

  // 4. Emit to a captured in-memory writer (stands in for $GITHUB_OUTPUT /
  //    $GITHUB_STEP_SUMMARY) and capture the exit code.
  const writer = createMemoryWriter();
  const exitCode = emitActionResult(evaluation, { writer, title: 'Agent Eval' });

  const outputs: Record<string, string> = {};
  for (const { name, value } of writer.outputs) outputs[name] = value;
  const summary = writer.summaries.join('\n');

  return { evaluation, outputs, summary, exitCode };
}

// ─── HEALTHY RUN — passes, summary reads clean ───────────────────────────────

describe('worked example — healthy review (read → evaluate → emit)', () => {
  it('emits a passing gate with a clean exit code and eval_passed=true', () => {
    const { evaluation, outputs, exitCode } = runWorkedExample('healthy-review');
    expect(evaluation.passed).toBe(true);
    expect(exitCode).toBe(0);
    expect(outputs.eval_passed).toBe('true');
  });

  it('sets the full eval_* output contract a downstream `if:` can gate on', () => {
    const { outputs } = runWorkedExample('healthy-review');
    // Every documented output is present …
    for (const key of [
      'eval_passed',
      'eval_score',
      'eval_gate',
      'eval_failing_workers',
      'eval_evaluated_workers',
      'eval_headline',
      'eval_evidence',
    ]) {
      expect(outputs, `missing output ${key}`).toHaveProperty(key);
    }
    // … and the gate-relevant ones carry the expected values for a clean run.
    expect(outputs.eval_gate).toBe('watch');
    expect(outputs.eval_failing_workers).toBe('0');
    expect(outputs.eval_evaluated_workers).toBe('1');
    expect(Number(outputs.eval_score)).toBeGreaterThan(0);
  });

  it('renders a passing step summary with the worker in the scorecard table', () => {
    const { summary } = runWorkedExample('healthy-review');
    expect(summary).toContain('## ✅ Agent Eval — passed');
    // The embedded per-worker scorecard table + per-check breakdown are present.
    expect(summary).toContain('| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |');
    expect(summary).toContain(WORKER);
    expect(summary).toContain('## Per-check breakdown');
    // A clean run has no Findings section (nothing failed).
    expect(summary).not.toContain('### Findings');
  });

  it('does not invent a result the agent did not produce (output is the result turn)', () => {
    // Provenance: the worked example scores the agent's *final answer* text,
    // exactly what a human sees in the posted comment — not a self-graded summary.
    const run = extractCcaRunFromFile(loadFixture('healthy-review'), { prompt: REVIEW_PROMPT });
    expect(run.outputSource).toBe('result');
    expect(run.output).toContain('race condition');
  });
});

// ─── STALE NO-OP — fails, summary names the specific reason ───────────────────

describe('worked example — stale "LGTM" no-op (read → evaluate → emit)', () => {
  it('fails the gate with a non-zero exit code and eval_passed=false', () => {
    const { evaluation, outputs, exitCode } = runWorkedExample('stale-noop');
    expect(evaluation.passed).toBe(false);
    expect(exitCode).toBe(1);
    expect(outputs.eval_passed).toBe('false');
    expect(outputs.eval_failing_workers).toBe('1');
  });

  it('eval_evidence carries the specific per-check reason, not just the grade', () => {
    const { outputs } = runWorkedExample('stale-noop');
    // The per-check reason `evaluateCiRun` splices into evidence is what makes
    // the gate self-explanatory without a re-run.
    expect(outputs.eval_evidence).toContain(`${WORKER}/staleness`);
    expect(outputs.eval_evidence.toLowerCase()).toContain('no-op');
    // And the worker-level scorecard line still rides along after it.
    expect(outputs.eval_evidence).toContain(`${WORKER}: at-risk`);
  });

  it('renders a failing step summary with a Findings reason a maintainer can act on', () => {
    const { summary } = runWorkedExample('stale-noop');
    expect(summary).toContain('## ❌ Agent Eval — failed');
    expect(summary).toContain('### Findings');
    // The rendered Findings list shows the staleness no-op reason with its icon.
    expect(summary).toMatch(/🔴 .*claude-review\/staleness: no-op:/);
    // The embedded scorecard still lists the worker with a non-clean grade.
    expect(summary).toContain(WORKER);
  });
});

// ─── ABANDONED RUN (#1361) — fails, no terminal result turn ───────────────────

describe('worked example — abandoned run, no result turn (#1361)', () => {
  it('fails the gate (abandoned: assistant-text fallback, no end event)', () => {
    const run = extractCcaRunFromFile(loadFixture('abandoned-no-result'), { prompt: REVIEW_PROMPT });
    // The abandonment signal is structural: output fell back to assistant text
    // and the synthesised timeline never got an `end` event.
    expect(run.outputSource).toBe('assistant-text');
    expect(run.timeline.endedAt).toBeUndefined();

    const { evaluation, outputs, exitCode } = runWorkedExample('abandoned-no-result');
    expect(evaluation.passed).toBe(false);
    expect(exitCode).toBe(1);
    expect(outputs.eval_evidence).toContain(`${WORKER}/staleness`);
  });
});

// ─── REAL on-disk round-trip via a temp execution file ───────────────────────

describe('worked example — round-trips a real on-disk execution file', () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'agent-eval-cca-'));
  });
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes a claude-execution-output.json, reads it back, and gates on it', () => {
    // Stand up the artifact the action writes to ${RUNNER_TEMP} verbatim, then
    // consume it exactly as the cleanup phase does (readFileSync of the path the
    // `execution_file` output points at). This proves the seam works on real
    // file bytes, not just an in-memory string.
    const executionFile = join(workdir, 'claude-execution-output.json');
    writeFileSync(executionFile, loadFixture('healthy-review'), 'utf8');

    const onDisk = readFileSync(executionFile, 'utf8');
    const run = extractCcaRunFromFile(onDisk, { prompt: REVIEW_PROMPT });
    const { evaluation } = evaluateCiRun({
      prompt: run.prompt,
      output: run.output,
      timeline: run.timeline,
      worker: WORKER,
      now: FIXED_NOW,
      action: { gate: 'watch' },
    });

    const writer = createMemoryWriter();
    const exitCode = emitActionResult(evaluation, { writer });

    expect(exitCode).toBe(0);
    expect(writer.outputs.find((o) => o.name === 'eval_passed')?.value).toBe('true');
    expect(writer.summaries.join('\n')).toContain('## ✅ Agent Eval — passed');
    // The temp file still exists (we read, we didn't move/delete it).
    expect(readdirSync(workdir)).toContain('claude-execution-output.json');
  });

  it('the two-step parse (parseCcaExecutionLog → extractCcaRun) matches the one-shot helper', () => {
    // The convenience helper must be exactly equivalent to the explicit two-step
    // parse the action could inline — same output, same provenance.
    const raw = loadFixture('healthy-review');
    const oneShot = extractCcaRunFromFile(raw, { prompt: REVIEW_PROMPT, syntheticStartMs: 1_000_000 });
    const twoStep = extractCcaRun(parseCcaExecutionLog(raw), {
      prompt: REVIEW_PROMPT,
      syntheticStartMs: 1_000_000,
    });
    expect(twoStep.output).toBe(oneShot.output);
    expect(twoStep.outputSource).toBe(oneShot.outputSource);
    expect(twoStep.details).toEqual(oneShot.details);
  });
});

// ─── $GITHUB_OUTPUT framing — multiline evidence needs heredoc safety ─────────

describe('worked example — env writer frames a multiline output safely', () => {
  let workdir: string;

  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), 'agent-eval-out-'));
  });
  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes eval_* to a real $GITHUB_OUTPUT file and frames any newline value with a heredoc', () => {
    // Build an evaluation whose headline/evidence the env writer must serialise
    // into the real `name=value` outputs file. A single-line value is written
    // plainly; a value with a newline must be delimited so it can't corrupt the
    // parser — this pins that the production env writer (not just the memory one)
    // round-trips the eval_* contract a CI runner reads.
    const run = extractCcaRunFromFile(loadFixture('stale-noop'), { prompt: REVIEW_PROMPT });
    const { evaluation } = evaluateCiRun({
      prompt: run.prompt,
      output: run.output,
      timeline: run.timeline,
      worker: WORKER,
      now: FIXED_NOW,
      action: { gate: 'watch' },
    });

    const outputFile = join(workdir, 'gh-output');
    writeFileSync(outputFile, '', 'utf8');
    const summaryFile = join(workdir, 'gh-summary.md');
    writeFileSync(summaryFile, '', 'utf8');

    const writer = createEnvWriter({
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    } as NodeJS.ProcessEnv);
    emitActionResult(evaluation, { writer });

    const outText = readFileSync(outputFile, 'utf8');
    // The simple boolean output is written as a plain key=value line.
    expect(outText).toContain('eval_passed=false');
    // Every output key made it to the file.
    for (const key of ['eval_score', 'eval_gate', 'eval_headline', 'eval_evidence']) {
      expect(outText, `missing ${key} in $GITHUB_OUTPUT`).toContain(key);
    }
    // Any value carrying a newline must be heredoc-delimited (never a bare
    // `name=line1\nline2` that would break the outputs parser).
    for (const line of outText.split('\n')) {
      // A plain `key=value` line must not itself contain an un-delimited newline;
      // multiline values appear as `key<<delim` instead.
      if (/^eval_[a-z_]+=/.test(line)) {
        expect(line.includes('<<')).toBe(false);
      }
    }

    // The summary file got the rendered markdown too.
    const summaryText = readFileSync(summaryFile, 'utf8');
    expect(summaryText).toContain('## ❌ Agent Eval — failed');
    expect(summaryText).toContain('### Findings');
  });
});
