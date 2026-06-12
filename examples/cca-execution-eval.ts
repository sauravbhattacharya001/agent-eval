/**
 * Example: gate a claude-code-action run on its output quality.
 *
 * `claude-code-action` writes a JSON log of each run to
 * `${RUNNER_TEMP}/claude-execution-output.json` and exposes that path as the
 * `execution_file` GitHub Action output. This script reads that file, projects
 * it into `{ prompt, output, timeline }` with `extractCcaRunFromFile`, and runs
 * `evaluateCiRun` over it — the four Tier 1 / Tier 2 checks (completeness,
 * coverage, relevance, staleness), no model-as-judge — then emits GitHub Action
 * outputs + a step summary and exits non-zero if the run did not address its
 * prompt or produced nothing actionable.
 *
 * It is the out-of-process integration mode described in
 * docs/claude-code-action-integration.md: a downstream workflow step that runs
 * *after* the claude-code-action step.
 *
 *   - name: Run Claude
 *     id: claude
 *     uses: anthropics/claude-code-action@v1
 *     with:
 *       prompt: ${{ steps.prompt.outputs.text }}
 *
 *   - name: Evaluate the run
 *     if: ${{ always() && steps.claude.outputs.execution_file != '' }}
 *     run: npx tsx examples/cca-execution-eval.ts
 *     env:
 *       EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}
 *       AGENT_PROMPT: ${{ steps.prompt.outputs.text }}
 *       AGENT_EVAL_GATE: watch
 *
 * Run locally against a saved log:
 *
 *   EXECUTION_FILE=./claude-execution-output.json \
 *   AGENT_PROMPT="Review the rate-limiting PR ..." \
 *   npx tsx examples/cca-execution-eval.ts
 */

import { readFileSync } from 'node:fs';

import {
  extractCcaRunFromFile,
  evaluateCiRun,
  emitActionResult,
  type GateGrade,
} from '../src/index.js';

function main(): void {
  const executionFile = process.env.EXECUTION_FILE;
  if (!executionFile) {
    console.error(
      'EXECUTION_FILE is not set. Point it at the claude-code-action ' +
        '`execution_file` output (e.g. ${RUNNER_TEMP}/claude-execution-output.json).',
    );
    process.exitCode = 2;
    return;
  }

  // The prompt is not in the execution file (the action passes it via a prompt
  // file), so supply the same prompt the action was given. Without it the
  // coverage/relevance checks have no reference and the gate leans on
  // completeness + staleness only.
  const prompt = process.env.AGENT_PROMPT ?? '';
  const worker = process.env.AGENT_EVAL_WORKER ?? 'claude-code-action';
  const gate = (process.env.AGENT_EVAL_GATE as GateGrade | undefined) ?? 'watch';

  let raw: string;
  try {
    raw = readFileSync(executionFile, 'utf8');
  } catch (error) {
    console.error(`Failed to read execution file at ${executionFile}: ${error}`);
    process.exitCode = 2;
    return;
  }

  const run = extractCcaRunFromFile(raw, { prompt });

  console.log(
    `Extracted run: output via "${run.outputSource}" (${run.output.length} chars), ` +
      `${run.timeline.events?.length ?? 0} timeline events, ` +
      `cost=${run.details.totalCostUsd ?? 'n/a'} duration=${run.details.durationMs ?? 'n/a'}ms ` +
      `error=${run.details.isError}.`,
  );

  const { evaluation } = evaluateCiRun({
    prompt: run.prompt,
    output: run.output,
    timeline: run.timeline,
    // A prior comment on this PR/issue, if you track one, enables verbatim-repost
    // (no-op) detection: previousOutput: process.env.PREVIOUS_OUTPUT,
    worker,
    action: { gate },
  });

  // Writes eval_passed/eval_score/… outputs + the step summary, returns the exit code.
  process.exitCode = emitActionResult(evaluation);
}

main();
