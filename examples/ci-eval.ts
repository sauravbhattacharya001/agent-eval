/**
 * Example CI entry point: score agent transcripts and gate the job.
 *
 * Run by the example workflow (examples/github-action-eval.yml) as the eval
 * step of a CI pipeline. It reads a transcripts root, builds a fleet scorecard
 * over a rolling window, projects it into a pass/fail decision, writes the
 * GitHub Action outputs + step summary, and exits non-zero when the gate is
 * not met so the workflow can block on output quality.
 *
 * Everything here is Tier 1 + Tier 2 (deterministic + heuristic): no LLM calls,
 * no API keys, fully offline and reproducible.
 *
 * Usage:
 *   npx tsx examples/ci-eval.ts <transcripts-dir>
 *
 * Configuration (env, all optional):
 *   AGENT_EVAL_GATE       healthy | watch | at-risk | critical   (default: at-risk)
 *   AGENT_EVAL_WINDOW     rolling window in days                 (default: 7)
 *   AGENT_EVAL_MIN_SCORE  fleet mean-score floor in [0,1]        (default: none)
 *   AGENT_EVAL_WORKERS    comma-separated worker allow-list      (default: all)
 *   AGENT_EVAL_TITLE      step-summary heading                   (default: Agent Eval)
 */

import { runActionEval, emitActionResult } from '../src/index.js';
import type { GateGrade } from '../src/index.js';

function parseGate(value: string | undefined): GateGrade {
  if (value === 'healthy' || value === 'watch' || value === 'at-risk' || value === 'critical') {
    return value;
  }
  return 'at-risk';
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function main(): void {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: tsx examples/ci-eval.ts <transcripts-dir>');
    process.exit(2);
    return;
  }

  const gate = parseGate(process.env.AGENT_EVAL_GATE);
  const window = parseNumber(process.env.AGENT_EVAL_WINDOW) ?? 7;
  const minScore = parseNumber(process.env.AGENT_EVAL_MIN_SCORE);
  const gateWorkers = process.env.AGENT_EVAL_WORKERS
    ? process.env.AGENT_EVAL_WORKERS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const title = process.env.AGENT_EVAL_TITLE ?? 'Agent Eval';

  const { evaluation, build } = runActionEval(root, {
    window,
    gate,
    title,
    ...(minScore !== undefined ? { minScore } : {}),
    ...(gateWorkers ? { gateWorkers } : {}),
  });

  // Human-readable log line (the step summary has the full table).
  console.log(`agent-eval: ${evaluation.headline}`);
  console.log(`  scored ${build.scored} transcript(s), ${build.failed} failed to parse`);
  for (const e of evaluation.evidence) {
    console.log(`  - ${e.message}`);
  }

  // Writes outputs + step summary to the GitHub runner (no-op locally) and
  // returns the exit code. Setting process.exitCode (rather than process.exit)
  // lets stdout flush first.
  process.exitCode = emitActionResult(evaluation, { title });
}

main();
