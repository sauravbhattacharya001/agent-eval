# Integrating with `claude-code-action`

This document maps the exact seam where `agent-eval`'s two CI checks
(**completeness**, **staleness**) hook into
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action),
so a CI job can gate on *what the agent produced* before it goes green.

It is grounded in the action's actual code, not a sketch: the relevant entry
point is the unified `src/entrypoints/run.ts`, and the artifact the checks read
is the execution file written by `base-action/src/execution-file.ts`.

> **Thesis.** A `claude-code-action` run can finish with `conclusion: success`
> (the CLI exited 0) and still be a failure *as a unit of work*: it posted an
> empty or stub result, or said *"this looks reasonable, nice work"* with
> nothing a human can act on. **Research-time safety (it ran without crashing)
> is not runtime safety (it did the task).** These two checks are the runtime
> layer, and they are deterministic — Tier 1, no model-as-judge, no API
> cost, no flake.

## Where the action produces the artifact we need

`claude-code-action` v1 merged its previously separate `action.yml` steps
(prepare / install / run / cleanup) into a single TypeScript orchestrator,
`src/entrypoints/run.ts`. Its lifecycle:

1. **Phase 1 — Prepare.** Parse the GitHub context, validate permissions, check
   the trigger, run the mode (`tag` / `agent`). The resolved task lives at
   `context.inputs.prompt` and is written to a prompt file at
   `${RUNNER_TEMP}/claude-prompts/claude-prompt.txt`.
2. **Phase 2 — Install** the Claude Code CLI.
3. **Phase 3 — Run.** `runClaude(...)` executes the CLI and returns a
   `ClaudeRunResult`. The CLI writes a JSON log of the whole run — the **execution
   file** — to `${RUNNER_TEMP}/claude-execution-output.json`
   (`base-action/src/execution-file.ts`, `EXECUTION_FILENAME`). `run.ts` then
   sets the action outputs:

   | Output | Meaning |
   |--------|---------|
   | `execution_file` | **Path to the execution log JSON** — the artifact we read |
   | `conclusion` | `"success"` / `"failure"` — *did the CLI exit cleanly* (not: did it do the task) |
   | `structured_output` | Validated JSON result, when the run used structured outputs |
   | `session_id` | Claude session id |
   | `branch_name`, `github_token` | set during cleanup |

4. **Phase 4 — Cleanup** (the `finally` block — always runs). Two consumers read
   the execution file here, and **this is the seam**:
   - `writeStepSummary(executionFile)` parses the log and calls
     `formatTurnsFromData(data)` (`src/entrypoints/format-turns.ts`) to render the
     "## Claude Code Report" markdown comment.
   - `updateCommentLink({ outputFile: executionFile, ... })`
     (`src/entrypoints/update-comment-link.ts`) reads the **last** array element
     (`type: "result"`) for `total_cost_usd` / `duration_ms` and updates the
     tracking comment.

At cleanup time, everything an eval needs is already on disk in one file: the
agent's final answer text, the full turn stream, and the run's cost/duration.

## The execution-file shape

The execution file is a JSON **array of turns** (`Turn[]` in
`format-turns.ts`). For eval we care about three things across the stream:

- `assistant` turns whose `message.content[]` carries `text` blocks — the visible
  prose the human reads.
- The final `result` turn (`type: "result"`) — its `result` field is the agent's
  **final answer text** (what `updateCommentLink` keys cost/duration off), plus
  `subtype` (`"success"` / `"error_max_turns"` / …), `is_error`, `total_cost_usd`,
  `duration_ms`, `num_turns`.
- `tool_use` / `tool_result` blocks — evidence the agent did work (used for the
  synthesised run timeline).

`agent-eval` models a permissive structural subset of this in
`src/action/cca-execution.ts` (`CcaTurn`, `CcaMessage`, `CcaContentItem`). It is
deliberately tolerant: unknown turn types contribute nothing and a malformed log
parses to `[]` rather than throwing, so an action version skew degrades to a
"no output extracted" verdict instead of crashing the job.

## The mapping

`evaluateCiRun({ prompt, output, timeline })` is the single-run evaluator (see
[the README](../README.md#evaluating-a-single-run-one-pr--one-issue)). The
execution file maps onto its inputs directly:

| `evaluateCiRun` input | Source in the claude-code-action run |
|-----------------------|--------------------------------------|
| `output` | The `result` turn's `result` text; falls back to the concatenated assistant `text` blocks (what `formatTurnsFromData` renders) when there is no result turn |
| `timeline` | Synthesised from the turn stream — one event per turn; an `end` event **only** when a `result` turn exists (a missing end is the abandoned/no-op signal) |
| `prompt` | **Not in the execution file** — see the caveat below |
| `previousOutput` *(optional)* | The prior bot comment on this PR/issue, if you track one — enables verbatim-repost (no-op) detection |

`agent-eval` does this projection for you:

```typescript
import { readFileSync } from 'node:fs';
import { extractCcaRunFromFile, evaluateCiRun, emitActionResult } from 'agent-eval';

const run = extractCcaRunFromFile(
  readFileSync(process.env.EXECUTION_FILE!, 'utf8'),  // the execution_file output
  { prompt: process.env.AGENT_PROMPT ?? '' },         // the task the action was given
);

const { evaluation } = evaluateCiRun({
  prompt: run.prompt,
  output: run.output,       // result-turn text, or assembled assistant text
  timeline: run.timeline,   // for the staleness / abandonment check
  worker: 'claude-code-action',
});

process.exitCode = emitActionResult(evaluation);  // outputs + step summary + exit
```

`extractCcaRunFromFile` returns a `CcaRunExtract`: `{ prompt, output,
outputSource, assistantText, resultText, details, timeline }`. `outputSource`
tells you whether the output came from the `result` turn, the assistant text, or
was empty (`'result' | 'assistant-text' | 'none'`); `details` carries the run's
`subtype` / `isError` / `totalCostUsd` / `durationMs` / `numTurns`.

### Caveat: the prompt is not in the execution file

The execution file records the *conversation*, not the task framing — the action
passes the prompt to the CLI via a prompt file (`${RUNNER_TEMP}/claude-prompts/
claude-prompt.txt`), and `run.ts` logs it as `Context prompt: ...`. `evaluateCiRun`
still accepts the prompt (supply it from the same expression you feed
`claude-code-action`'s `prompt:` input, or read the prompt file), but the gate
itself leans on **completeness + staleness** — a meaningful no-op /
empty-output guard that needs no prompt reference.

## Integration mode A — downstream workflow step (recommended)

Run the eval as a separate step *after* the action, reading its `execution_file`
output. No fork of `claude-code-action` required; it composes with the published
action. See [`examples/cca-execution-eval.ts`](../examples/cca-execution-eval.ts).

```yaml
jobs:
  claude:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci

      # The prompt you hand the action — reuse it for the eval's reference.
      - id: prompt
        run: echo "text=Review this PR: $PR_TITLE ..." >> "$GITHUB_OUTPUT"

      - name: Run Claude
        id: claude
        uses: anthropics/claude-code-action@v1
        with:
          prompt: ${{ steps.prompt.outputs.text }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      # Gate on what the agent produced. `always()` so a failed/blank run is
      # still evaluated; skip only when no execution file was emitted.
      - name: Evaluate the run
        if: ${{ always() && steps.claude.outputs.execution_file != '' }}
        run: npx tsx examples/cca-execution-eval.ts
        env:
          EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}
          AGENT_PROMPT: ${{ steps.prompt.outputs.text }}
          AGENT_EVAL_GATE: watch          # worst grade that still passes
          AGENT_EVAL_WORKER: claude-code-action
```

The eval step writes `eval_passed` / `eval_score` / `eval_evidence` / … outputs
and a step summary, then exits non-zero when the run did not address its prompt
or produced nothing actionable. Downstream steps can branch on
`steps.<id>.outputs.eval_passed` without re-running the eval.

[`examples/workflows/pr-review-with-eval.yml`](../examples/workflows/pr-review-with-eval.yml)
is the same wiring as a complete, copy-pasteable workflow file (PR trigger,
permissions, the `claude-code-action` step, the `always()`-guarded eval step, and
a downstream step that branches on `eval_passed`).

## Integration mode B — in-process, inside the action's cleanup

If the checks are upstreamed into `claude-code-action` itself, the natural home
is the same `run.ts` cleanup block that already reads `executionFile`, right
after `writeStepSummary(...)`. The data is already in hand there — the same
`Turn[]` `data` `writeStepSummary` parses, and the prompt from
`context.inputs.prompt`:

```typescript
// run.ts — Phase 4: Cleanup, after writeStepSummary(executionFile)
if (executionFile && existsSync(executionFile)) {
  const run = extractCcaRunFromFile(readFileSync(executionFile, "utf8"), {
    prompt: context?.inputs?.prompt ?? "",
  });
  const { evaluation } = evaluateCiRun({
    prompt: run.prompt,
    output: run.output,
    timeline: run.timeline,
    worker: "claude-code-action",
  });
  core.setOutput("eval_passed", String(evaluation.passed));
  core.setOutput("eval_score", String(evaluation.score));
  core.setOutput("eval_headline", evaluation.headline);
  // Optionally: append renderActionSummary(evaluation) to GITHUB_STEP_SUMMARY,
  // and/or core.setFailed(...) to fail the action when the gate trips.
}
```

This keeps the eval **deterministic and offline** inside the action: no new
network calls, no model-as-judge, no added API cost — it only inspects the bytes
the run already wrote.

## What each check catches here

Both are independent and diverge in practice (see the README's single-run
section for the full rationale and the knobs):

- **Completeness** (Tier 1) — empty / stub / truncated / refusal output. A
  `result` turn with an empty `result` and no assistant text fails here. The
  bytes are the bytes; the agent can't forge "non-empty".
- **Staleness** (Tier 1, no-op) — did the run emit anything **actionable**
  (file refs, line numbers, code suggestions, directives, structured findings)?
  An on-topic, substantive *"looks good to me"* with no artifacts fails here
  alone. The synthesised timeline also folds in **abandonment** (a run with no
  `result` turn → no `end` event) and, with `previousOutput`, **verbatim
  reposts**.

Any one failing trips the gate.

## See also

- [`src/action/cca-execution.ts`](../src/action/cca-execution.ts) — the
  execution-file parser/extractor (`parseCcaExecutionLog`, `extractCcaRun`,
  `extractCcaRunFromFile`).
- [`src/action/ci-run.ts`](../src/action/ci-run.ts) — `evaluateCiRun` and the
  two-check (completeness + staleness) scoring core; surfaces the specific
  failing-check reason in `eval_evidence`.
- [`examples/cca-execution-eval.ts`](../examples/cca-execution-eval.ts) — a
  runnable downstream-step entry point.
- [`examples/workflows/pr-review-with-eval.yml`](../examples/workflows/pr-review-with-eval.yml):
  the same wiring as a complete, copy-pasteable PR-review workflow file.
- [`docs/step-summary-examples.md`](step-summary-examples.md) — the exact step
  summary the gate posts on the run page (a passing run and two failing modes —
  a stale no-op and an abandoned-mid-task run), rendered from fixtures and pinned
  byte-for-byte.
- [README → Evaluating a single run](../README.md#evaluating-a-single-run-one-pr--one-issue)
  — the check semantics and threshold knobs.
