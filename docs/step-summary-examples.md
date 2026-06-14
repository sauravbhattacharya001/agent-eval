# Step summary examples

> **Generated file — do not edit by hand.** Produced by `scripts/gen-summary-golden.ts` from the committed execution fixtures in `tests/fixtures/cca-runs/`, and pinned byte-for-byte by `tests/step-summary-golden.test.ts`. To update it, change the code/fixtures and re-run `npx tsx scripts/gen-summary-golden.ts`.

This page shows the exact Markdown the CI eval step writes to [`$GITHUB_STEP_SUMMARY`](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary) — the block a reviewer sees on the Action run page — for a **passing** run and two distinct **failing** runs (a stale "LGTM" no-op and an abandoned mid-task run). All three are rendered offline by the real `parse → evaluateCiRun → renderActionSummary` chain (Tier 1 completeness + staleness; no model-as-judge, no network). The companion `examples/workflows/pr-review-with-eval.yml` shows the workflow that emits them.

Each example is the output for one fixture under `tests/fixtures/cca-runs/`, scored against the same PR-review prompt with the default thresholds and the `watch` gate the example workflow sets.

## Passing run — a substantive review

_Fixture: `tests/fixtures/cca-runs/healthy-review.json`_

The agent produced a real review of the diff: it names files, points at concrete behaviour, and flags the race condition the prompt asked about. Both Tier 1 checks pass, the gate is green, and the step exits `0`. There is **no Findings section** — nothing failed, so nothing is surfaced.

What the run page renders:

~~~~markdown
## ✅ Agent Eval — passed

> PASS — 1/1 workers within gate (watch), mean score 0.8549

**Gate:** `watch` · **Evaluated:** 1 worker(s) · **Failing:** 0 · **Fleet score:** 0.8549

### Scorecard

**Window:** all-time  
**Generated:** 2026-06-13T12:00:00.000Z  
**Fleet:** 1 worker(s) · 1 run(s) · pass 100% · mean 0.85 · trends ↓0 ↑0

| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |
|---|---|---:|---:|---:|---:|:---:|---|
| claude-review | OK | 100% | 0.85 | 0.85 | 1 | · | — |

## Per-check breakdown

### claude-review — OK ·

| Check | Mean | Pass | Warn | Fail | Runs |
|---|---:|---:|---:|---:|---:|
| relevance | 0.76 | 1 | 0 | 0 | 1 |
| staleness | 0.80 | 1 | 0 | 0 | 1 |
| completeness | 1.00 | 1 | 0 | 0 | 1 |
~~~~

## Failing run — a stale "LGTM" no-op

_Fixture: `tests/fixtures/cca-runs/stale-noop.json`_

The run finished "successfully" (the process exited `0`) but said nothing actionable — a bare approval with no file refs, line numbers, code, or findings. A crash check cannot see this; the **staleness** check can. The gate fails, the step exits `1`, and the **Findings** section names the specific reason a maintainer needs to act on — not just "a check failed".

What the run page renders:

~~~~markdown
## ❌ Agent Eval — failed

> FAIL — 1/1 workers below gate (watch), mean score 0.3333

**Gate:** `watch` · **Evaluated:** 1 worker(s) · **Failing:** 1 · **Fleet score:** 0.3333

### Findings

- 🔴 claude-review/staleness: no-op: run no_progress (1.0s); bare acknowledgement only (bare approval)
- 🟡 claude-review/relevance: weak grounding: short output covers only 0% of the prompt's topics
- 🟡 claude-review: at-risk (0% pass), top failure: staleness (1)

### Scorecard

**Window:** all-time  
**Generated:** 2026-06-13T12:00:00.000Z  
**Fleet:** 1 worker(s) · 1 run(s) · pass 0% · mean 0.33 · trends ↓0 ↑0

| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |
|---|---|---:|---:|---:|---:|:---:|---|
| claude-review | RISK | 0% | 0.33 | 0.33 | 1 | · | staleness (1) |

## Per-check breakdown

### claude-review — RISK ·

| Check | Mean | Pass | Warn | Fail | Runs |
|---|---:|---:|---:|---:|---:|
| staleness | 0.00 | 0 | 0 | 1 | 1 |
| relevance | 0.00 | 0 | 1 | 0 | 1 |
| completeness | 1.00 | 1 | 0 | 0 | 1 |
~~~~

## Failing run — abandoned mid-task

_Fixture: `tests/fixtures/cca-runs/abandoned-no-result.json`_

A different no-op mode: the agent started, read a file, said it *would* check the Redis usage next — then stopped. The execution log ends on a pending tool call with no result event, so the run was abandoned before it produced anything to act on (the timeout / silently-abandoned-check mode from the open issues). The text is on-topic and non-empty, so completeness still passes — but **staleness** flags the absent actionable output, the gate fails, and the step exits `1`.

What the run page renders:

~~~~markdown
## ❌ Agent Eval — failed

> FAIL — 1/1 workers below gate (watch), mean score 0.4510

**Gate:** `watch` · **Evaluated:** 1 worker(s) · **Failing:** 1 · **Fleet score:** 0.4510

### Findings

- 🔴 claude-review/staleness: no-op: no actionable content (no file refs, line numbers, code, directives, or findings)
- 🟡 claude-review: at-risk (0% pass), top failure: staleness (1)

### Scorecard

**Window:** all-time  
**Generated:** 2026-06-13T12:00:00.000Z  
**Fleet:** 1 worker(s) · 1 run(s) · pass 0% · mean 0.45 · trends ↓0 ↑0

| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |
|---|---|---:|---:|---:|---:|:---:|---|
| claude-review | RISK | 0% | 0.45 | 0.45 | 1 | · | staleness (1) |

## Per-check breakdown

### claude-review — RISK ·

| Check | Mean | Pass | Warn | Fail | Runs |
|---|---:|---:|---:|---:|---:|
| staleness | 0.00 | 0 | 0 | 1 | 1 |
| relevance | 0.35 | 1 | 0 | 0 | 1 |
| completeness | 1.00 | 1 | 0 | 0 | 1 |
~~~~

## Failing run — guidance file pasted instead of a review

_Fixture: `tests/fixtures/cca-runs/verbatim-claudemd.json`_

The hardest false-negative: the agent read `CLAUDE.md` and posted the project guidelines back verbatim — "use pnpm", "prefer named exports", commit conventions — instead of reviewing the rate-limiting diff. It is long and well-structured, so **completeness** passes, and it is littered with file paths, inline code, and directive words, so **staleness** sees plenty of actionable-looking artifacts and also passes. Only a reference-aware check catches it: **relevance** compares the output against the prompt the agent was given and finds it shares almost none of the task's vocabulary (nothing about rate limiting, the token bucket, Redis expiry, or race conditions). The gate fails on relevance alone, and the **Findings** section says *why* — the topics the output ignored.

What the run page renders:

~~~~markdown
## ❌ Agent Eval — failed

> FAIL — 1/1 workers below gate (watch), mean score 0.5333

**Gate:** `watch` · **Evaluated:** 1 worker(s) · **Failing:** 1 · **Fleet score:** 0.5333

### Findings

- 🔴 claude-review/relevance: off-task: only 0% of the prompt's topics addressed (0/17); ignores adds, rate, limiting, authentication, login, endpoint
- 🟡 claude-review: at-risk (0% pass), top failure: relevance (1)

### Scorecard

**Window:** all-time  
**Generated:** 2026-06-13T12:00:00.000Z  
**Fleet:** 1 worker(s) · 1 run(s) · pass 0% · mean 0.53 · trends ↓0 ↑0

| Worker | Grade | Pass | Mean | Worst | Runs | Trend | Top failures |
|---|---|---:|---:|---:|---:|:---:|---|
| claude-review | RISK | 0% | 0.53 | 0.53 | 1 | · | relevance (1) |

## Per-check breakdown

### claude-review — RISK ·

| Check | Mean | Pass | Warn | Fail | Runs |
|---|---:|---:|---:|---:|---:|
| relevance | 0.00 | 0 | 0 | 1 | 1 |
| staleness | 0.60 | 1 | 0 | 0 | 1 |
| completeness | 1.00 | 1 | 0 | 0 | 1 |
~~~~

## How to read it

- **Heading** — `✅ … — passed` / `❌ … — failed` mirrors the gate decision and the step exit code.
- **Gate line** — the effective gate grade, how many workers were evaluated, how many failed, and the fleet mean score.
- **Findings** (only when something failed) — the specific per-check reason spliced in by `evaluateCiRun`, e.g. `claude-review/staleness: no-op: bare acknowledgement only …`. This is what makes the gate self-explanatory without re-running the job.
- **Scorecard / Per-check breakdown** — the same per-worker table the fleet monitor emits, here over the single synthetic run, so completeness and staleness each show their score and status.

