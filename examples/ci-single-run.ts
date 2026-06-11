/**
 * Example CI entry point: evaluate a SINGLE agent run and gate the step.
 *
 * Where examples/ci-eval.ts gates on a *fleet* scorecard over a window of
 * transcripts ("how healthy is the fleet?"), this gates on one run ("did the
 * agent address THIS prompt?"). It is the shape an eval step in a PR-review or
 * issue-triage Action takes: feed it the prompt the agent was given and the
 * output it produced, and it writes the GitHub Action outputs + step summary and
 * exits non-zero when the run failed to address the prompt.
 *
 * The checks are Tier 1 (completeness) + Tier 2 (keyword coverage + relevance)
 * only — no LLM calls, no API keys, fully offline and reproducible. Coverage and
 * relevance are duals: coverage is recall ("did the output mention the prompt's
 * topics?"), relevance is precision ("is the output *about* THIS PR, or generic
 * advice?").
 *
 * Usage:
 *   # Built-in demo: a good review (passes), boilerplate posted verbatim (fails),
 *   # and generic best-practices advice that ignores the diff (fails on relevance)
 *   npx tsx examples/ci-single-run.ts
 *
 *   # Real inputs from files:
 *   npx tsx examples/ci-single-run.ts <prompt-file> <output-file>
 *
 * Configuration (env, all optional):
 *   AGENT_EVAL_COVERAGE   min prompt-topic coverage [0,1] to pass   (default: 0.4)
 *   AGENT_EVAL_IGNORED    coverage at/under this hard-fails the run (default: 0.15)
 *   AGENT_EVAL_RELEVANCE  min prompt similarity [0,1] to pass       (default: 0.2)
 *   AGENT_EVAL_OFFTOPIC   similarity at/under this hard-fails       (default: 0.08)
 *   AGENT_EVAL_WORKER     logical run name shown in outputs/summary (default: ci-run)
 *   AGENT_EVAL_TITLE      step-summary heading                      (default: PR Review Eval)
 */

import { readFileSync } from 'node:fs';

import { evaluateCiRun, emitActionResult } from '../src/index.js';

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// A built-in demo so the example runs with no arguments. The prompt asks for a
// specific PR review; the "bad" output is a contributing-guide posted verbatim —
// the real failure mode where an agent ignores the diff entirely.
const DEMO_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation for
correctness, verify the Redis cache key expiry is set, and flag any race
conditions in the concurrent request handling.`;

const DEMO_GOOD_OUTPUT = `## Review

The rate limiting implementation looks solid. The token bucket refill logic is
correct (it clamps to capacity). I confirmed the Redis cache key sets an expiry,
though I'd use \`SET ... EX\` atomically to avoid a crash window without a TTL.
There is a race condition in the concurrent request handling — two requests can
read the same bucket count before either writes back; use an \`INCR\`-based atomic
check on the login endpoint. Approving with the Redis note.`;

const DEMO_BAD_OUTPUT = `# Contributing Guidelines

Thank you for your interest in contributing! Please run \`npm run lint\` before
committing and follow the existing code style. Open a pull request against main,
make sure all tests pass, and a maintainer will review your changes. Be kind and
welcoming. We hope this helps and you enjoy contributing here.`;

// The subtler failure mode: substantive, well-formed prose that is generic
// best-practices advice rather than a review of THIS PR. Completeness passes
// (it is non-empty, structured) and it even brushes the prompt's words — but it
// is off-topic, which the relevance check (precision) is what catches.
const DEMO_OFFTOPIC_OUTPUT = `Thanks for the pull request. Here is some general
advice for any change: always write clear, descriptive commit messages, document
your code thoroughly, and add unit tests to keep coverage high. Follow the SOLID
principles, keep functions small and focused, and run the linter and formatter
before pushing. Review your own diff first, be kind in discussions, and keep your
dependencies up to date. Good habits like these make any codebase healthier and
easier to maintain for the whole team over time.`;

function main(): void {
  const worker = process.env.AGENT_EVAL_WORKER ?? 'ci-run';
  const title = process.env.AGENT_EVAL_TITLE ?? 'PR Review Eval';
  const coverageThreshold = parseNumber(process.env.AGENT_EVAL_COVERAGE);
  const ignoredPromptThreshold = parseNumber(process.env.AGENT_EVAL_IGNORED);
  const relevanceThreshold = parseNumber(process.env.AGENT_EVAL_RELEVANCE);
  const offTopicThreshold = parseNumber(process.env.AGENT_EVAL_OFFTOPIC);

  const promptFile = process.argv[2];
  const outputFile = process.argv[3];

  // With file arguments, evaluate the real run. Without, run the built-in demo
  // (good, boilerplate, and off-topic outputs) so the example is self-contained.
  if (promptFile && outputFile) {
    const prompt = readFileSync(promptFile, 'utf8');
    const output = readFileSync(outputFile, 'utf8');
    const { evaluation } = evaluateCiRun({
      prompt,
      output,
      worker,
      ...(coverageThreshold !== undefined ? { coverageThreshold } : {}),
      ...(ignoredPromptThreshold !== undefined ? { ignoredPromptThreshold } : {}),
      ...(relevanceThreshold !== undefined ? { relevanceThreshold } : {}),
      ...(offTopicThreshold !== undefined ? { offTopicThreshold } : {}),
    });
    console.log(`agent-eval: ${evaluation.headline}`);
    for (const e of evaluation.evidence) console.log(`  - ${e.message}`);
    process.exitCode = emitActionResult(evaluation, { title });
    return;
  }

  // Demo mode — show all verdicts, then exit on a failing one to demonstrate a
  // failing gate.
  console.log('No prompt/output files given — running the built-in demo.\n');

  for (const [label, output] of [
    ['GOOD review (addresses the diff)', DEMO_GOOD_OUTPUT],
    ['BAD output (contributing guide posted verbatim)', DEMO_BAD_OUTPUT],
    ['OFF-TOPIC output (generic best-practices advice)', DEMO_OFFTOPIC_OUTPUT],
  ] as const) {
    const { evaluation, checks } = evaluateCiRun({
      prompt: DEMO_PROMPT,
      output,
      worker,
      ...(coverageThreshold !== undefined ? { coverageThreshold } : {}),
      ...(ignoredPromptThreshold !== undefined ? { ignoredPromptThreshold } : {}),
      ...(relevanceThreshold !== undefined ? { relevanceThreshold } : {}),
      ...(offTopicThreshold !== undefined ? { offTopicThreshold } : {}),
    });
    console.log(`── ${label}`);
    console.log(`   ${evaluation.headline}`);
    for (const c of checks) {
      console.log(`   [tier ${c.tier}] ${c.check}: ${c.status} (${c.score.toFixed(2)}) — ${c.summary}`);
    }
    console.log('');
  }

  // Gate on the off-topic run so the example exits non-zero (what CI would do).
  // It is the most interesting failure: completeness passes, but it is not about
  // this PR — exactly what a crash check (exit 0) cannot see.
  const { evaluation } = evaluateCiRun({ prompt: DEMO_PROMPT, output: DEMO_OFFTOPIC_OUTPUT, worker });
  process.exitCode = emitActionResult(evaluation, { title });
}

main();
