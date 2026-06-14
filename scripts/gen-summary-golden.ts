/**
 * Generator for `docs/step-summary-examples.md` — the human-facing golden doc.
 *
 * It renders the *exact* `$GITHUB_STEP_SUMMARY` Markdown the CI eval step posts
 * to the Action run page, for a passing run and a failing run, straight from the
 * real on-disk execution fixtures the worked-example test already uses. This is
 * the artifact a PR reviewer (or a maintainer evaluating the eval layer) reads to
 * see what the gate *looks like* without standing up a runner.
 *
 * The output is deterministic (fixed clock, committed fixtures), so it doubles as
 * a golden file: `tests/step-summary-golden.test.ts` regenerates it from the same
 * inputs and asserts the committed copy matches byte-for-byte. If the renderer or
 * a fixture changes, the doc must be regenerated — it can never silently drift out
 * of sync with the code it claims to demonstrate.
 *
 * Run:
 *   npx tsx scripts/gen-summary-golden.ts            # write docs/step-summary-examples.md
 *   npx tsx scripts/gen-summary-golden.ts --check    # exit 1 if the committed doc is stale
 *
 * @tier 1+2 — Deterministic + Heuristic (no AI, reproducible, offline)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractCcaRunFromFile } from '../src/action/cca-execution.js';
import { evaluateCiRun } from '../src/action/ci-run.js';
import { renderActionSummary } from '../src/action/adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'cca-runs');
const OUT_PATH = join(REPO_ROOT, 'docs', 'step-summary-examples.md');

/** Logical worker name used on the single-run synthetic scorecard. */
const WORKER = 'claude-review';
/** Fixed clock — keep in lockstep with the worked-example test for stable run-ids. */
const FIXED_NOW = new Date('2026-06-13T12:00:00.000Z');

/**
 * The PR-review prompt the action was given. The execution file does not carry
 * the prompt (the action passes it via a prompt file / `AGENT_PROMPT`), so we
 * supply it exactly as the Mode-A entry point would. Matches the worked-example
 * test verbatim so the golden doc and that test describe the same scenario.
 */
const REVIEW_PROMPT = `Review this pull request that adds rate limiting to the
authentication login endpoint. Check the token bucket implementation for
correctness, verify the Redis cache key expiry is set, and flag any race
conditions in the concurrent request handling.`;

/** Read one execution-file fixture's raw JSON text (as cleanup reads it). */
function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8');
}

/**
 * Run the production chain for one fixture and return the rendered step summary —
 * the precise Markdown `emitActionResult` appends to `$GITHUB_STEP_SUMMARY`.
 */
function renderSummaryFor(fixtureName: string): string {
  const run = extractCcaRunFromFile(loadFixture(fixtureName), { prompt: REVIEW_PROMPT });
  const { evaluation } = evaluateCiRun({
    prompt: run.prompt,
    output: run.output,
    timeline: run.timeline,
    worker: WORKER,
    now: FIXED_NOW,
    action: { gate: 'watch' },
  });
  // Exactly what emitActionResult(..., { title: 'Agent Eval' }) writes.
  return renderActionSummary(evaluation, { title: 'Agent Eval' }).trimEnd();
}

/** One documented scenario: a fixture plus the prose framing around its summary. */
interface Scenario {
  fixture: string;
  heading: string;
  blurb: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    fixture: 'healthy-review',
    heading: 'Passing run — a substantive review',
    blurb:
      'The agent produced a real review of the diff: it names files, points at ' +
      'concrete behaviour, and flags the race condition the prompt asked about. ' +
      'Both Tier 1 checks pass, the gate is green, and the step exits `0`. There ' +
      'is **no Findings section** — nothing failed, so nothing is surfaced.',
  },
  {
    fixture: 'stale-noop',
    heading: 'Failing run — a stale "LGTM" no-op',
    blurb:
      'The run finished "successfully" (the process exited `0`) but said nothing ' +
      'actionable — a bare approval with no file refs, line numbers, code, or ' +
      'findings. A crash check cannot see this; the **staleness** check can. The ' +
      'gate fails, the step exits `1`, and the **Findings** section names the ' +
      'specific reason a maintainer needs to act on — not just "a check failed".',
  },
  {
    fixture: 'abandoned-no-result',
    heading: 'Failing run — abandoned mid-task',
    blurb:
      'A different no-op mode: the agent started, read a file, said it *would* ' +
      'check the Redis usage next — then stopped. The execution log ends on a ' +
      'pending tool call with no result event, so the run was abandoned before it ' +
      'produced anything to act on (the timeout / silently-abandoned-check mode ' +
      'from the open issues). The text is on-topic and non-empty, so completeness ' +
      'still passes — but **staleness** flags the absent actionable output, the ' +
      'gate fails, and the step exits `1`.',
  },
  {
    fixture: 'verbatim-claudemd',
    heading: 'Failing run — guidance file pasted instead of a review',
    blurb:
      'The hardest false-negative: the agent read `CLAUDE.md` and posted the ' +
      'project guidelines back verbatim — "use pnpm", "prefer named exports", ' +
      'commit conventions — instead of reviewing the rate-limiting diff. It is ' +
      'long and well-structured, so **completeness** passes, and it is littered ' +
      'with file paths, inline code, and directive words, so **staleness** sees ' +
      'plenty of actionable-looking artifacts and also passes. Only a ' +
      'reference-aware check catches it: **relevance** compares the output ' +
      'against the prompt the agent was given and finds it shares almost none of ' +
      "the task's vocabulary (nothing about rate limiting, the token bucket, " +
      'Redis expiry, or race conditions). The gate fails on relevance alone, and ' +
      'the **Findings** section says *why* — the topics the output ignored.',
  },
];

/**
 * Build the full Markdown document. Exported so the drift-pinning test can
 * regenerate it in-memory and compare against the committed copy without
 * shelling out.
 */
export function buildDoc(): string {
  const lines: string[] = [];

  lines.push('# Step summary examples');
  lines.push('');
  lines.push(
    '> **Generated file — do not edit by hand.** Produced by ' +
      '`scripts/gen-summary-golden.ts` from the committed execution fixtures in ' +
      '`tests/fixtures/cca-runs/`, and pinned byte-for-byte by ' +
      '`tests/step-summary-golden.test.ts`. To update it, change the code/fixtures ' +
      'and re-run `npx tsx scripts/gen-summary-golden.ts`.',
  );
  lines.push('');
  lines.push(
    'This page shows the exact Markdown the CI eval step writes to ' +
      '[`$GITHUB_STEP_SUMMARY`](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary) ' +
      '— the block a reviewer sees on the Action run page — for a **passing** run and ' +
      'two distinct **failing** runs (a stale "LGTM" no-op and an abandoned ' +
      'mid-task run). All three are rendered offline by the real ' +
      '`parse → evaluateCiRun → renderActionSummary` chain (Tier 1 completeness + ' +
      'staleness; no model-as-judge, no network). The companion ' +
      '`examples/workflows/pr-review-with-eval.yml` shows the workflow that emits them.',
  );
  lines.push('');
  lines.push(
    'Each example is the output for one fixture under ' +
      '`tests/fixtures/cca-runs/`, scored against the same PR-review prompt with the ' +
      'default thresholds and the `watch` gate the example workflow sets.',
  );
  lines.push('');

  for (const scenario of SCENARIOS) {
    const summary = renderSummaryFor(scenario.fixture);
    lines.push(`## ${scenario.heading}`);
    lines.push('');
    lines.push(`_Fixture: \`tests/fixtures/cca-runs/${scenario.fixture}.json\`_`);
    lines.push('');
    lines.push(scenario.blurb);
    lines.push('');
    lines.push('What the run page renders:');
    lines.push('');
    // Fence with ~~~~ so the embedded ``` code blocks in the summary survive.
    lines.push('~~~~markdown');
    lines.push(summary);
    lines.push('~~~~');
    lines.push('');
  }

  lines.push('## How to read it');
  lines.push('');
  lines.push(
    '- **Heading** — `✅ … — passed` / `❌ … — failed` mirrors the gate decision ' +
      'and the step exit code.',
  );
  lines.push(
    '- **Gate line** — the effective gate grade, how many workers were evaluated, ' +
      'how many failed, and the fleet mean score.',
  );
  lines.push(
    '- **Findings** (only when something failed) — the specific per-check reason ' +
      'spliced in by `evaluateCiRun`, e.g. `claude-review/staleness: no-op: bare ' +
      'acknowledgement only …`. This is what makes the gate self-explanatory ' +
      'without re-running the job.',
  );
  lines.push(
    '- **Scorecard / Per-check breakdown** — the same per-worker table the fleet ' +
      'monitor emits, here over the single synthetic run, so completeness and ' +
      'staleness each show their score and status.',
  );
  lines.push('');

  return lines.join('\n') + '\n';
}

/** Absolute path of the committed golden doc this script owns. */
export const GOLDEN_DOC_PATH = OUT_PATH;

function main(): void {
  const check = process.argv.includes('--check');
  const doc = buildDoc();

  if (check) {
    let current = '';
    try {
      current = readFileSync(OUT_PATH, 'utf8');
    } catch {
      current = '';
    }
    if (current !== doc) {
      console.error(
        `docs/step-summary-examples.md is stale. Run: npx tsx scripts/gen-summary-golden.ts`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('docs/step-summary-examples.md is up to date.');
    return;
  }

  writeFileSync(OUT_PATH, doc, 'utf8');
  console.log(`Wrote ${OUT_PATH} (${doc.length} bytes).`);
}

// Only run as a CLI when invoked directly (not when imported by the test). The
// generated doc is deterministic, so importing buildDoc() has no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
